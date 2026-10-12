import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import { fetchApi } from './api.ts';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { nanoid } from 'nanoid';
import { capacityKinds, equipmentKinds, measurementRangeUnits } from '../shared/equipment.ts';
import type { CatalogEquipment } from '../shared/catalog.ts';
import { changeColumns, indexStatements, nowSeconds, replicatedTables, schemaStatements, workspaceSchemaVersion, type SyncRequest, type SyncResponse } from '../shared/schema.ts';
import { decodeChange, encodeChange, type SqlChangeRow } from '../shared/wire.ts';
import { convertUnit, formatQuantity } from '../shared/units.ts';

export type LocalDb = DB;
export interface Batch { id: string; name: string; description: string | null; status: string; created_at: number }
export type RecipeType = 'beer' | 'wine' | 'mead';
export interface Recipe { id: string; name: string; description: string | null; recipe_type: RecipeType | null }
export interface BatchEvent {
  id: string; batch_id: string; event_type: string; title: string; planned_at: number | null;
  anchor_event_id: string | null; offset_seconds: number | null; details_json: string | null;
  actual_at: number | null; skipped_at: number | null; note: string | null;
  source_id: string | null; ended_at?: number | null;
}
export type Plan = BatchEvent;
export type ActualEvent = BatchEvent;
export interface Equipment { id: string; name: string; kind: string; specification_json: string | null }
export interface InventoryItem { id: string; name: string; category: string; default_unit: string; display_unit: string }
export interface InventoryMovement { id: string; kind: 'Purchased' | 'Counted' | 'Used' | 'Discarded'; quantity: number; unit: string; at: number }

const inventoryMassInGrams: Record<string, number> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237, 'lb + oz': 28.349523125 };
const inventoryVolumeInLiters: Record<string, number> = { mL: 0.001, L: 1, 'US fl oz': 0.0295735295625, 'US gal': 3.785411784 };

export function convertInventoryUnit(quantity: number, from: string, to: string): number | null {
  if (!Number.isFinite(quantity)) return null;
  if (from === to) return quantity;
  for (const factors of [inventoryMassInGrams, inventoryVolumeInLiters]) {
    if (factors[from] && factors[to]) return Number((quantity * factors[from] / factors[to]).toFixed(6));
  }
  return null;
}

let sqlitePromise: ReturnType<typeof initWasm> | undefined;
const opened = new Map<string, Promise<DB>>();

export async function openLocalDb(workspaceId: string): Promise<DB> {
  let pending = opened.get(workspaceId);
  if (!pending) {
    pending = (async () => {
      const sqlite = await (sqlitePromise ||= initWasm(() => wasmUrl));
      const db = await sqlite.open(`brewlog-${workspaceId}`);
      await db.exec('CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL)');
      const version = await db.execO<{ version: number }>('SELECT version FROM schema_meta LIMIT 1');
      if (!version.length) {
        await db.tx(async tx => {
          for (const statement of schemaStatements) await tx.exec(statement);
          for (const table of replicatedTables) await tx.exec('SELECT crsql_as_crr(?)', [table]);
          for (const statement of indexStatements) await tx.exec(statement);
          await tx.exec('CREATE TABLE sync_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
          await tx.exec('INSERT INTO schema_meta(version) VALUES (?)', [workspaceSchemaVersion]);
        });
      } else if (version[0].version !== workspaceSchemaVersion) {
        throw new Error(`This proof-of-concept database uses schema ${version[0].version}; create a fresh database for schema ${workspaceSchemaVersion}`);
      }
      return db;
    })();
    opened.set(workspaceId, pending);
  }
  return pending;
}

export async function forgetLocalDb(workspaceId: string): Promise<void> {
  const pending = opened.get(workspaceId);
  opened.delete(workspaceId);
  if (pending) {
    const db = await pending;
    await syncQueues.get(db)?.catch(() => undefined);
    await db.close();
  }
  // The current wa-sqlite VFS keeps all brewery files in one IndexedDB store.
  // Remove only blocks for this file, leaving other breweries and the catalog.
  const request = indexedDB.open('idb-batch-atomic');
  const idb = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!idb.objectStoreNames.contains('blocks')) return;
    const path = `/brewlog-${workspaceId}`;
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction('blocks', 'readwrite');
      const range = IDBKeyRange.bound([path], [path, []]);
      const blocks = tx.objectStore('blocks');
      const keys = blocks.getAllKeys(range);
      keys.onsuccess = () => { for (const key of keys.result) blocks.delete(key); };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { idb.close(); }
}

export async function listBatches(db: DB): Promise<Batch[]> {
  return db.execO<Batch>('SELECT id, name, description, status, created_at FROM batches ORDER BY created_at DESC, id DESC');
}

export async function createBatch(db: DB, name: string, description: string, accountId: string): Promise<string> {
  const id = nanoid();
  const now = nowSeconds();
  await db.exec('INSERT INTO batches(id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, description || null, 'active', now, now]);
  return id;
}

export async function listRecipes(db: DB): Promise<Recipe[]> {
  return db.execO<Recipe>(`SELECT r.id, r.name, r.description, t.recipe_type FROM recipes r
    LEFT JOIN recipe_types t ON t.id = r.id ORDER BY r.name COLLATE NOCASE`);
}

export async function createRecipe(db: DB, name: string, description: string, recipeType: RecipeType,
  temperatureUnit: '°C' | '°F' = '°C'): Promise<string> {
  const id = nanoid();
  const now = nowSeconds();
  if (!['beer', 'wine', 'mead'].includes(recipeType)) throw new Error('Choose a recipe type');
  await db.tx(async tx => {
    await tx.exec('INSERT INTO recipes(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [id, name, description || null, now, now]);
    await tx.exec('INSERT INTO recipe_types(id, recipe_type) VALUES (?, ?)', [id, recipeType]);
    const mashId = nanoid();
    const boilId = nanoid();
    const insert = async (eventId: string, eventType: string, title: string, anchorId: string | null,
      details: Record<string, string | number>, order: number) => tx.exec(`INSERT INTO recipe_events
      (id, recipe_id, event_type, title, planned_at, anchor_event_id, offset_seconds, details_json, sort_order)
      VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?)`, [eventId, id, eventType, title, anchorId, JSON.stringify(details), order]);
    if (recipeType === 'beer') {
      await insert(mashId, 'temperature_control', 'Mash', null,
        { phase: 'mash', mode: 'hold', target_value: convertUnit(67, '°C', temperatureUnit)!, target_unit: temperatureUnit, duration_seconds: 1800 }, 1);
      await insert(boilId, 'temperature_control', 'Boil', mashId,
        { phase: 'boil', mode: 'heat', target_value: convertUnit(100, '°C', temperatureUnit)!, target_unit: temperatureUnit, duration_seconds: 3600, anchor_point: 'end' }, 2);
    }
    await insert(nanoid(), 'addition', 'Pitch yeast', recipeType === 'beer' ? boilId : null,
      { item_category: 'Yeast', item_name: 'Yeast', ...(recipeType === 'beer' ? { anchor_point: 'end' } : {}) }, recipeType === 'beer' ? 3 : 1);
  });
  return id;
}

export interface PlanInput {
  event_type: string;
  title: string;
  planned_at?: number | null;
  anchor_event_id?: string | null;
  offset_seconds?: number | null;
  details_json?: string | null;
}

export async function addRecipePlan(db: DB, recipeId: string, input: PlanInput): Promise<string> {
  const id = nanoid();
  const order = await db.execO<{ next_order: number }>(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM recipe_events WHERE recipe_id = ?', [recipeId]);
  await db.exec(`INSERT INTO recipe_events(id, recipe_id, event_type, title, planned_at, anchor_event_id, offset_seconds, details_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, recipeId, input.event_type, input.title, input.planned_at ?? null, input.anchor_event_id ?? null,
      input.offset_seconds ?? null, input.details_json ?? null, order[0].next_order]);
  return id;
}

export async function listRecipePlans(db: DB, recipeId: string): Promise<(PlanInput & { id: string })[]> {
  return db.execO<(PlanInput & { id: string })>(
    'SELECT id, event_type, title, planned_at, anchor_event_id, offset_seconds, details_json FROM recipe_events WHERE recipe_id = ? ORDER BY sort_order, id',
    [recipeId]);
}

async function validatePlanAnchor(db: DB, table: 'recipe_events' | 'batch_events',
  ownerColumn: 'recipe_id' | 'batch_id', ownerId: string, planId: string, anchorId: string | null | undefined) {
  if (!anchorId) return;
  const rows = await db.execO<{ id: string; anchor_event_id: string | null }>(
    `SELECT id, anchor_event_id FROM ${table} WHERE ${ownerColumn} = ?`, [ownerId]);
  const parent = new Map(rows.map(row => [row.id, row.anchor_event_id]));
  let current: string | null = anchorId;
  const seen = new Set<string>();
  while (current) {
    if (current === planId || seen.has(current)) throw new Error('Timing cannot create a cycle');
    if (!parent.has(current)) throw new Error('Choose an event from this plan');
    seen.add(current);
    current = parent.get(current) || null;
  }
}

export async function updateRecipePlan(db: DB, recipeId: string, planId: string, input: PlanInput): Promise<void> {
  await validatePlanAnchor(db, 'recipe_events', 'recipe_id', recipeId, planId, input.anchor_event_id);
  await db.exec(`UPDATE recipe_events SET event_type = ?, title = ?, planned_at = ?, anchor_event_id = ?,
    offset_seconds = ?, details_json = ? WHERE id = ? AND recipe_id = ?`,
  [input.event_type, input.title, input.planned_at ?? null, input.anchor_event_id ?? null,
    input.offset_seconds ?? null, input.details_json ?? null, planId, recipeId]);
}

export async function deleteRecipePlan(db: DB, recipeId: string, planId: string): Promise<void> {
  const plans = await listRecipePlans(db, recipeId);
  if (!plans.some(plan => plan.id === planId)) throw new Error('Recipe event not found');
  const removed = new Set([planId]);
  let size = 0;
  while (removed.size !== size) {
    size = removed.size;
    for (const plan of plans) if (plan.anchor_event_id && removed.has(plan.anchor_event_id)) removed.add(plan.id);
  }
  await db.tx(async tx => {
    for (const id of [...removed].reverse()) await tx.exec('DELETE FROM recipe_events WHERE id = ? AND recipe_id = ?', [id, recipeId]);
  });
}

export async function addBatchPlan(db: DB, batchId: string, input: PlanInput, accountId: string): Promise<string> {
  const id = nanoid();
  await db.exec(`INSERT INTO batch_events(id, batch_id, event_type, title, planned_at, anchor_event_id,
    offset_seconds, details_json, created_at, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, batchId, input.event_type, input.title, input.planned_at ?? null, input.anchor_event_id ?? null,
      input.offset_seconds ?? null, input.details_json ?? null, nowSeconds(), accountId]);
  return id;
}

export async function updateBatchPlan(db: DB, batchId: string, planId: string, input: PlanInput): Promise<void> {
  await validatePlanAnchor(db, 'batch_events', 'batch_id', batchId, planId, input.anchor_event_id);
  await db.exec(`UPDATE batch_events SET event_type = ?, title = ?, planned_at = ?, anchor_event_id = ?,
    offset_seconds = ?, details_json = ? WHERE id = ? AND batch_id = ?`,
  [input.event_type, input.title, input.planned_at ?? null, input.anchor_event_id ?? null,
    input.offset_seconds ?? null, input.details_json ?? null, planId, batchId]);
}

export async function startBatchFromRecipe(db: DB, recipe: Recipe, name: string, accountId: string,
  description = recipe.description || ''): Promise<string> {
  const plans = await listRecipePlans(db, recipe.id);
  const batchId = nanoid();
  const now = nowSeconds();
  const ids = new Map(plans.map(plan => [plan.id, nanoid()]));
  await db.tx(async tx => {
    await tx.exec('INSERT INTO batches(id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [batchId, name, description, 'active', now, now]);
    for (const plan of plans) {
      await tx.exec(`INSERT INTO batch_events(id, batch_id, recipe_event_id, event_type, title, planned_at,
        anchor_event_id, offset_seconds, details_json, created_at, created_by_account_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ids.get(plan.id)!, batchId, plan.id, plan.event_type, plan.title, plan.planned_at ?? null,
          plan.anchor_event_id ? ids.get(plan.anchor_event_id) ?? null : null,
          plan.offset_seconds ?? null, plan.details_json ?? null, now, accountId]);
    }
  });
  return batchId;
}

export async function listPlans(db: DB, batchId: string): Promise<Plan[]> {
  return listEvents(db, batchId);
}

export async function listEvents(db: DB, batchId: string): Promise<ActualEvent[]> {
  return db.execO<ActualEvent>(`SELECT e.id, e.batch_id, e.event_type, e.title, e.planned_at, e.anchor_event_id,
    e.offset_seconds, e.details_json, e.actual_at, e.skipped_at, e.note, e.source_id, x.ended_at
    FROM batch_events e LEFT JOIN event_ends x ON x.id = e.id
    WHERE e.batch_id = ? ORDER BY e.created_at, e.id`, [batchId]);
}

export const measurementTables = {
  temperature: 'temperature_measurements', ph: 'ph_measurements', gravity: 'gravity_measurements',
  volume: 'volume_measurements', pressure: 'pressure_measurements',
  carbonation: 'carbonation_measurements', dissolved_oxygen: 'dissolved_oxygen_measurements'
} as const;
export type MeasurementKind = keyof typeof measurementTables;

export interface EventInput {
  batchId: string;
  eventType: string;
  actualAt: number;
  endedAt?: number | null;
  eventId?: string | null;
  note?: string;
  accountId: string;
  payload?: Record<string, string | number | null>;
  measurementKind?: MeasurementKind;
}

export async function recordEvent(db: DB, input: EventInput): Promise<string> {
  const id = input.eventId || nanoid();
  if (input.endedAt != null && input.endedAt < input.actualAt) throw new Error('End must be after start');
  await db.tx(async tx => {
    if (input.eventId) {
      await tx.exec(`UPDATE batch_events SET actual_at = ?, note = ?, recorded_by_account_id = ? WHERE id = ? AND batch_id = ?`,
        [input.actualAt, input.note || null, input.accountId, id, input.batchId]);
    } else {
      await tx.exec(`INSERT INTO batch_events(id, batch_id, event_type, title, actual_at, note, created_at, created_by_account_id, recorded_by_account_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.batchId, input.eventType, input.eventType, input.actualAt, input.note || null, nowSeconds(), input.accountId, input.accountId]);
    }
    if (input.endedAt != null) await tx.exec('INSERT INTO event_ends(id, ended_at) VALUES (?, ?)', [id, input.endedAt]);
    if (input.payload) await updateEventDetails(tx, id, input.payload, input.endedAt);
    const payload = input.payload;
    if (!payload) return;
    const table = input.measurementKind ? measurementTables[input.measurementKind] : {
      addition: 'additions', temperature_control: 'temperature_control_events', pressure_control: 'pressure_control_events',
      transfer: 'transfers', packaging: 'packaging'
    }[input.eventType];
    if (!table) throw new Error('Unsupported event payload');
    const columns = Object.keys(payload);
    await tx.exec(`INSERT INTO ${table}(event_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`,
      [id, ...Object.values(payload)]);
  });
  return id;
}

const eventPayloadTables: Record<string, string> = {
  addition: 'additions', temperature_control: 'temperature_control_events', pressure_control: 'pressure_control_events',
  transfer: 'transfers', packaging: 'packaging'
};

export async function eventFormData(db: DB, event: ActualEvent): Promise<{ measurementKind?: MeasurementKind; payload: Record<string, string | number | null> }> {
  if (event.event_type === 'measurement') {
    for (const [kind, table] of Object.entries(measurementTables)) {
      const rows = await db.execO<Record<string, string | number | null>>(`SELECT * FROM ${table} WHERE event_id = ?`, [event.id]);
      if (rows.length) return { measurementKind: kind as MeasurementKind, payload: rows[0] };
    }
  }
  const table = eventPayloadTables[event.event_type];
  if (table) {
    const rows = await db.execO<Record<string, string | number | null>>(`SELECT * FROM ${table} WHERE event_id = ?`, [event.id]);
    if (rows.length) return { payload: rows[0] };
  }
  return { payload: {} };
}

export async function updateEvent(db: DB, event: ActualEvent, input: EventInput): Promise<void> {
  if (event.batch_id !== input.batchId || event.event_type !== input.eventType) throw new Error('Event type cannot be changed');
  if (input.endedAt != null && input.endedAt < input.actualAt) throw new Error('End must be after start');
  await db.tx(async tx => {
    await tx.exec('UPDATE batch_events SET actual_at = ?, note = ?, recorded_by_account_id = ? WHERE id = ? AND batch_id = ?',
      [input.actualAt, input.note || null, input.accountId, event.id, event.batch_id]);
    if (input.endedAt == null) await tx.exec('DELETE FROM event_ends WHERE id = ?', [event.id]);
    else await tx.exec('INSERT INTO event_ends(id, ended_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at',
      [event.id, input.endedAt]);
    if (!input.payload) return;
    await updateEventDetails(tx, event.id, input.payload, input.endedAt);
    const table = input.measurementKind ? measurementTables[input.measurementKind] : eventPayloadTables[input.eventType];
    if (!table) throw new Error('Unsupported event payload');
    const columns = Object.keys(input.payload);
    await tx.exec(`UPDATE ${table} SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE event_id = ?`,
      [...Object.values(input.payload), event.id]);
  });
}

async function updateEventDetails(db: Pick<DB, 'execO' | 'exec'>, id: string, payload: Record<string, string | number | null>, endedAt?: number | null): Promise<void> {
  const rows = await db.execO<{ details_json: string | null; event_type: string }>('SELECT details_json, event_type FROM batch_events WHERE id = ?', [id]);
  const details = JSON.parse(rows[0]?.details_json || '{}') as Record<string, string | number | null>;
  for (const [key, value] of Object.entries(payload)) {
    if (key !== 'event_id') details[key] = value;
  }
  if (endedAt != null) delete details.duration_seconds;
  // Once an addition happened, its typed payload is the single source for the
  // quantity and item. Pending actions keep those values in details_json.
  if (rows[0]?.event_type === 'addition') {
    for (const key of ['item_name', 'inventory_item_id', 'quantity', 'unit', 'display_unit']) delete details[key];
  }
  await db.exec('UPDATE batch_events SET details_json = ? WHERE id = ?', [JSON.stringify(details), id]);
  if (rows[0]?.event_type === 'addition' && typeof payload.item_name === 'string') {
    await db.exec('UPDATE batch_events SET title = ? WHERE id = ?', [payload.item_name, id]);
  }
}

export async function skipBatchEvent(db: DB, eventId: string, at: number, accountId: string): Promise<void> {
  await db.exec('UPDATE batch_events SET skipped_at = ?, recorded_by_account_id = ? WHERE id = ?', [at, accountId, eventId]);
}

export async function updatePhotoEvent(db: DB, event: ActualEvent, actualAt: number,
  note: string, file: File | null): Promise<void> {
  if (event.event_type !== 'photo') throw new Error('Choose a photo event');
  if (file && (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024)) throw new Error('Choose an image under 5 MB');
  const bytes = file ? new Uint8Array(await file.arrayBuffer()) : null;
  await db.tx(async tx => {
    await tx.exec('UPDATE batch_events SET actual_at = ?, note = ? WHERE id = ?',
      [actualAt, note || null, event.id]);
    if (bytes && file) await tx.exec('UPDATE photos SET mime_type = ?, byte_count = ?, image = ? WHERE batch_event_id = ?',
      [file.type, bytes.length, bytes, event.id]);
  });
}

export async function eventDetails(db: DB, event: ActualEvent, preferredMassUnit?: string): Promise<string> {
  if (event.event_type === 'measurement') {
    const parts: string[] = [];
    for (const [kind, table] of Object.entries(measurementTables)) {
      const rows = await db.execO<{ value: number; unit: string; uncertainty: number | null }>(
        `SELECT value, unit, uncertainty FROM ${table} WHERE event_id = ?`, [event.id]);
      if (rows.length) parts.push(`${kind.replaceAll('_', ' ')} ${rows[0].value} ${rows[0].unit}${rows[0].uncertainty == null ? '' : ` ±${rows[0].uncertainty}`}`);
    }
    return parts.join(' · ');
  }
  if (event.event_type === 'addition') {
    const rows = await db.execO<{ item_name: string; quantity: number; unit: string }>(
      'SELECT item_name, quantity, unit FROM additions WHERE event_id = ?', [event.id]);
    return rows.length ? `${formatQuantity(rows[0].quantity, rows[0].unit, preferredMassUnit)} ${rows[0].item_name}` : '';
  }
  if (event.event_type === 'temperature_control') {
    const rows = await db.execO<{ mode: string; target_value: number | null; target_unit: string | null; power_watts: number | null }>(
      'SELECT mode, target_value, target_unit, power_watts FROM temperature_control_events WHERE event_id = ?', [event.id]);
    return rows.length ? [rows[0].mode, rows[0].target_value == null ? '' : `${rows[0].target_value} ${rows[0].target_unit}`,
      rows[0].power_watts == null ? '' : `${rows[0].power_watts} W`].filter(Boolean).join(' · ') : '';
  }
  return event.note || '';
}

export async function listEquipment(db: DB): Promise<Equipment[]> {
  return db.execO<Equipment>(`SELECT id, name, kind, specification_json FROM equipment
    WHERE id NOT IN (SELECT equipment_id FROM equipment_archives) ORDER BY name COLLATE NOCASE`);
}

export interface EquipmentSpecifications {
  capacity_liters?: number;
  measurement_min?: number;
  measurement_max?: number;
  measurement_unit?: string;
  working_volume_liters?: number;
}

export async function createEquipment(db: DB, name: string, kind: string, catalogModel?: CatalogEquipment,
  overrides: EquipmentSpecifications = {}): Promise<string> {
  if (!equipmentKinds.some(item => item.value === kind)) throw new Error('Choose a valid equipment kind');
  if (catalogModel && catalogModel.kind !== kind) throw new Error('Catalog kind does not match equipment kind');
  const id = nanoid();
  const specification = JSON.parse(catalogModel?.specification_json || '{}') as Record<string, unknown>;
  Object.assign(specification, overrides);
  if (!capacityKinds.has(kind)) delete specification.capacity_liters;
  if (!measurementRangeUnits[kind]) {
    delete specification.measurement_min;
    delete specification.measurement_max;
    delete specification.measurement_unit;
  }
  await db.exec('INSERT INTO equipment(id, name, kind, catalog_model_id, specification_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, kind, catalogModel?.id || null, Object.keys(specification).length ? JSON.stringify(specification) : null, nowSeconds()]);
  return id;
}

export async function updateEquipmentCapacity(db: DB, item: Equipment, capacityLiters: number | null): Promise<void> {
  const specification = JSON.parse(item.specification_json || '{}') as Record<string, unknown>;
  if (capacityLiters == null) delete specification.capacity_liters;
  else specification.capacity_liters = capacityLiters;
  await db.exec('UPDATE equipment SET specification_json = ? WHERE id = ?',
    [Object.keys(specification).length ? JSON.stringify(specification) : null, item.id]);
}

export async function updateEquipmentMeasurementRange(db: DB, item: Equipment,
  range: { min: number; max: number; unit: string } | null): Promise<void> {
  const specification = JSON.parse(item.specification_json || '{}') as Record<string, unknown>;
  if (range) {
    specification.measurement_min = range.min;
    specification.measurement_max = range.max;
    specification.measurement_unit = range.unit;
    delete specification.capacity_liters;
  } else {
    delete specification.measurement_min;
    delete specification.measurement_max;
    delete specification.measurement_unit;
  }
  await db.exec('UPDATE equipment SET specification_json = ? WHERE id = ?',
    [Object.keys(specification).length ? JSON.stringify(specification) : null, item.id]);
}

export async function deleteEquipment(db: DB, id: string): Promise<void> {
  await db.tx(async tx => {
    const referenced = async (table: string, where: string, binds: string[]) =>
      (await tx.execO<{ used: number }>(`SELECT 1 AS used FROM ${table} WHERE ${where} LIMIT 1`, binds)).length > 0;
    let used = false;
    for (const table of Object.values(measurementTables)) {
      if (await referenced(table, 'equipment_id = ? OR calibration_id IN (SELECT id FROM equipment_calibrations WHERE equipment_id = ?)', [id, id])) {
        used = true;
        break;
      }
    }
    used ||= await referenced('temperature_control_events', 'equipment_id = ?', [id])
      || await referenced('pressure_control_events', 'equipment_id = ?', [id])
      || await referenced('transfers', 'from_vessel_id = ? OR to_vessel_id = ?', [id, id]);
    if (used) {
      await tx.exec('INSERT INTO equipment_archives(id, equipment_id, archived_at) VALUES (?, ?, ?)',
        [nanoid(), id, nowSeconds()]);
      return;
    }
    await tx.exec('DELETE FROM equipment_calibrations WHERE equipment_id = ?', [id]);
    await tx.exec('DELETE FROM equipment_characterization_observations WHERE equipment_id = ?', [id]);
    await tx.exec('DELETE FROM equipment WHERE id = ?', [id]);
  });
}

export async function listInventory(db: DB): Promise<InventoryItem[]> {
  return db.execO<InventoryItem>(`SELECT i.id, i.name, i.category, i.default_unit,
    COALESCE(d.display_unit, i.default_unit) AS display_unit FROM inventory_items i
    LEFT JOIN inventory_display_units d ON d.id = i.id ORDER BY i.name COLLATE NOCASE`);
}

export async function listInventoryMovements(db: DB, itemId: string): Promise<InventoryMovement[]> {
  return db.execO<InventoryMovement>(`
    SELECT id, 'Purchased' AS kind, quantity, unit, purchased_at AS at FROM inventory_purchases WHERE inventory_item_id = ?
    UNION ALL SELECT id, 'Counted' AS kind, quantity, unit, counted_at AS at FROM inventory_counts WHERE inventory_item_id = ?
    UNION ALL SELECT id, 'Discarded' AS kind, quantity, unit, discarded_at AS at FROM inventory_discards WHERE inventory_item_id = ?
    UNION ALL SELECT a.event_id AS id, 'Used' AS kind, a.quantity, a.unit, e.actual_at AS at
      FROM additions a JOIN batch_events e ON e.id = a.event_id WHERE a.inventory_item_id = ? AND e.actual_at IS NOT NULL
    ORDER BY at DESC, id DESC`, [itemId, itemId, itemId, itemId]);
}

export async function listInventoryBalances(db: DB, items: InventoryItem[]): Promise<Record<string, number | null>> {
  if (!items.length) return {};
  const rows = await db.execO<InventoryMovement & { inventory_item_id: string }>(`
    SELECT id, inventory_item_id, 'Purchased' AS kind, quantity, unit, purchased_at AS at FROM inventory_purchases
    UNION ALL SELECT id, inventory_item_id, 'Counted' AS kind, quantity, unit, counted_at AS at FROM inventory_counts
    UNION ALL SELECT id, inventory_item_id, 'Discarded' AS kind, quantity, unit, discarded_at AS at FROM inventory_discards
    UNION ALL SELECT a.event_id AS id, a.inventory_item_id, 'Used' AS kind, a.quantity, a.unit, e.actual_at AS at
      FROM additions a JOIN batch_events e ON e.id = a.event_id WHERE a.inventory_item_id IS NOT NULL AND e.actual_at IS NOT NULL
    ORDER BY inventory_item_id, at DESC, id DESC`);
  const byItem = new Map<string, InventoryMovement[]>();
  for (const row of rows) {
    const movements = byItem.get(row.inventory_item_id) || [];
    movements.push(row);
    byItem.set(row.inventory_item_id, movements);
  }
  return Object.fromEntries(items.map(item => [item.id, inventoryBalance(byItem.get(item.id) || [], item.default_unit)]));
}

export function inventoryBalance(rows: InventoryMovement[], unit: string): number | null {
  const currentCount = rows.find(row => row.kind === 'Counted');
  const afterAnchor = currentCount ? rows.filter(row => row.at > currentCount.at) : rows;
  const anchor = currentCount ? convertInventoryUnit(currentCount.quantity, currentCount.unit, unit) : 0;
  if (anchor == null) return null;
  let balance = anchor;
  for (const row of afterAnchor) {
    const amount = convertInventoryUnit(row.quantity, row.unit, unit);
    if (amount == null) return null;
    if (row.kind === 'Purchased') balance += amount;
    else if (row.kind === 'Used' || row.kind === 'Discarded') balance -= amount;
  }
  return balance;
}

export async function createInventoryItem(db: DB, name: string, category: string, defaultUnit: string,
  startingQuantity: number | null = null, accountId: string | null = null, displayUnit = defaultUnit): Promise<string> {
  const id = nanoid();
  const now = nowSeconds();
  await db.tx(async tx => {
    await tx.exec('INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, name, category, defaultUnit, now]);
    if (displayUnit !== defaultUnit) await tx.exec('INSERT INTO inventory_display_units(id, display_unit) VALUES (?, ?)',
      [id, displayUnit]);
    if (startingQuantity != null) await tx.exec(`INSERT INTO inventory_counts(id, inventory_item_id, quantity, unit, counted_at, created_by_account_id)
      VALUES (?, ?, ?, ?, ?, ?)`, [nanoid(), id, startingQuantity, defaultUnit, now, accountId]);
  });
  return id;
}

export async function addInventoryEntry(db: DB, itemId: string, kind: 'purchase' | 'count' | 'discard', quantity: number, unit: string, accountId: string): Promise<void> {
  if (!Number.isFinite(quantity) || quantity < 0 || kind !== 'count' && quantity === 0) throw new Error('Enter a positive quantity');
  const latest = await db.execO<{ at: number | null }>(`SELECT MAX(at) AS at FROM (
    SELECT purchased_at AS at FROM inventory_purchases WHERE inventory_item_id = ?
    UNION ALL SELECT counted_at AS at FROM inventory_counts WHERE inventory_item_id = ?
    UNION ALL SELECT discarded_at AS at FROM inventory_discards WHERE inventory_item_id = ?)`, [itemId, itemId, itemId]);
  const now = Math.max(nowSeconds(), (latest[0]?.at ?? 0) + 1);
  if (kind === 'purchase') {
    await db.exec('INSERT INTO inventory_purchases(id, inventory_item_id, quantity, unit, purchased_at) VALUES (?, ?, ?, ?, ?)',
      [nanoid(), itemId, quantity, unit, now]);
  } else if (kind === 'discard') {
    await db.exec('INSERT INTO inventory_discards(id, inventory_item_id, quantity, unit, discarded_at, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?)',
      [nanoid(), itemId, quantity, unit, now, accountId]);
  } else {
    await db.exec('INSERT INTO inventory_counts(id, inventory_item_id, quantity, unit, counted_at, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?)',
      [nanoid(), itemId, quantity, unit, now, accountId]);
  }
}

export async function addPhoto(db: DB, batchId: string, file: File, accountId: string,
  actualAt = nowSeconds(), eventId: string | null = null, note = ''): Promise<void> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image');
  if (file.size > 5 * 1024 * 1024) throw new Error('Image exceeds 5 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  eventId ||= nanoid();
  await db.tx(async tx => {
    const existing = await tx.execO<{ id: string }>('SELECT id FROM batch_events WHERE id = ?', [eventId]);
    if (existing.length) await tx.exec('UPDATE batch_events SET actual_at = ?, note = ?, recorded_by_account_id = ? WHERE id = ?',
      [actualAt, note || file.name, accountId, eventId]);
    else await tx.exec(`INSERT INTO batch_events(id, batch_id, event_type, title, actual_at, note, created_at, created_by_account_id, recorded_by_account_id)
      VALUES (?, ?, 'photo', 'Photo', ?, ?, ?, ?, ?)`, [eventId, batchId, actualAt, note || file.name, actualAt, accountId, accountId]);
    await tx.exec(`INSERT INTO photos(id, batch_id, batch_event_id, mime_type, byte_count, image, created_at, created_by_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [nanoid(), batchId, eventId, file.type, bytes.length, bytes, actualAt, accountId]);
  });
}

export async function listPhotos(db: DB, batchId: string): Promise<{
  id: string; batch_event_id: string | null; created_at: number; mime_type: string; image: Uint8Array
}[]> {
  return db.execO('SELECT id, batch_event_id, created_at, mime_type, image FROM photos WHERE batch_id = ? ORDER BY created_at DESC', [batchId]);
}

function stateValue(db: DB, key: string): Promise<string> {
  return db.execO<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', [key])
    .then(rows => rows[0]?.value || '0');
}

const syncQueues = new WeakMap<DB, Promise<void>>();

export function syncNow(db: DB, workspaceId: string): Promise<number> {
  const previous = syncQueues.get(db) || Promise.resolve();
  const current = previous.catch(() => undefined).then(() => performSync(db, workspaceId));
  syncQueues.set(db, current.then(() => undefined, () => undefined));
  return current;
}

async function performSync(db: DB, workspaceId: string): Promise<number> {
  const [serverCursor, localCursor] = await Promise.all([
    stateValue(db, 'serverCursor'), stateValue(db, 'localCursor')
  ]);
  const rows = await db.execO<SqlChangeRow>(`SELECT "table", pk, cid, val, col_version, db_version,
    COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq FROM crsql_changes
    WHERE db_version > ? AND site_id = crsql_site_id() ORDER BY db_version, seq`, [BigInt(localCursor)]);
  const request: SyncRequest = { serverCursor, localCursor, changes: rows.map(encodeChange) };
  const response = await fetchApi(`/api/workspaces/${workspaceId}/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(request)
  });
  if (!response.ok) throw new Error((await response.json() as { error?: string }).error || 'Sync failed');
  const result = await response.json() as SyncResponse;
  const insert = `INSERT INTO crsql_changes (${changeColumns.map(name => `"${name}"`).join(', ')}) VALUES (${changeColumns.map(() => '?').join(', ')})`;
  await db.tx(async tx => {
    for (const change of result.changes) await tx.exec(insert, decodeChange(change));
    await tx.exec('INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['serverCursor', result.serverCursor]);
    await tx.exec('INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['localCursor', result.acceptedLocalCursor]);
  });
  return result.changes.length;
}
