import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { nanoid } from 'nanoid';
import { changeColumns, indexStatements, nowSeconds, replicatedTables, schemaStatements, type SyncRequest, type SyncResponse } from '../shared/schema.ts';
import { decodeChange, encodeChange, type SqlChangeRow } from '../shared/wire.ts';

export type LocalDb = DB;
export interface Batch { id: string; name: string; description: string | null; status: string; created_at: number }
export interface Recipe { id: string; name: string; description: string | null }
export interface Plan {
  id: string; batch_id: string; event_type: string; title: string; planned_at: number | null;
  anchor_event_id: string | null; offset_seconds: number | null; details_json: string | null;
}
export interface ActualEvent {
  id: string; batch_id: string; event_type: string; actual_at: number; planned_event_id: string | null;
  note: string | null; source_id: string | null;
}
export interface Equipment { id: string; name: string; kind: string }
export interface InventoryItem { id: string; name: string; category: string; default_unit: string }

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
          await tx.exec('INSERT INTO schema_meta(version) VALUES (1)');
        });
      } else if (version[0].version !== 1) {
        throw new Error(`Unsupported local schema ${version[0].version}`);
      }
      return db;
    })();
    opened.set(workspaceId, pending);
  }
  return pending;
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
  return db.execO<Recipe>('SELECT id, name, description FROM recipes ORDER BY name COLLATE NOCASE');
}

export async function createRecipe(db: DB, name: string, description: string): Promise<string> {
  const id = nanoid();
  const now = nowSeconds();
  await db.exec('INSERT INTO recipes(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, name, description || null, now, now]);
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

export async function addBatchPlan(db: DB, batchId: string, input: PlanInput, accountId: string): Promise<string> {
  const id = nanoid();
  await db.exec(`INSERT INTO batch_planned_events(id, batch_id, event_type, title, planned_at, anchor_event_id,
    offset_seconds, details_json, created_at, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, batchId, input.event_type, input.title, input.planned_at ?? null, input.anchor_event_id ?? null,
      input.offset_seconds ?? null, input.details_json ?? null, nowSeconds(), accountId]);
  return id;
}

export async function startBatchFromRecipe(db: DB, recipe: Recipe, name: string, accountId: string): Promise<string> {
  const plans = await listRecipePlans(db, recipe.id);
  const batchId = nanoid();
  const now = nowSeconds();
  const ids = new Map(plans.map(plan => [plan.id, nanoid()]));
  await db.tx(async tx => {
    await tx.exec('INSERT INTO batches(id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [batchId, name, recipe.description, 'active', now, now]);
    for (const plan of plans) {
      await tx.exec(`INSERT INTO batch_planned_events(id, batch_id, recipe_event_id, event_type, title, planned_at,
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
  return db.execO<Plan>(`SELECT id, batch_id, event_type, title, planned_at, anchor_event_id, offset_seconds, details_json
    FROM batch_planned_events WHERE batch_id = ? ORDER BY created_at, id`, [batchId]);
}

export async function listEvents(db: DB, batchId: string): Promise<ActualEvent[]> {
  return db.execO<ActualEvent>(`SELECT id, batch_id, event_type, actual_at, planned_event_id, note, source_id
    FROM batch_events WHERE batch_id = ? ORDER BY actual_at DESC, id DESC`, [batchId]);
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
  plannedEventId?: string | null;
  note?: string;
  accountId: string;
  payload?: Record<string, string | number | null>;
  measurementKind?: MeasurementKind;
}

export async function recordEvent(db: DB, input: EventInput): Promise<string> {
  const id = nanoid();
  await db.tx(async tx => {
    await tx.exec(`INSERT INTO batch_events(id, batch_id, event_type, actual_at, planned_event_id, note, created_by_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.batchId, input.eventType, input.actualAt, input.plannedEventId ?? null, input.note || null, input.accountId]);
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

export async function eventDetails(db: DB, event: ActualEvent): Promise<string> {
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
    return rows.length ? `${rows[0].quantity} ${rows[0].unit} ${rows[0].item_name}` : '';
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
  return db.execO<Equipment>('SELECT id, name, kind FROM equipment ORDER BY name COLLATE NOCASE');
}

export async function createEquipment(db: DB, name: string, kind: string): Promise<void> {
  await db.exec('INSERT INTO equipment(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
    [nanoid(), name, kind, nowSeconds()]);
}

export async function listInventory(db: DB): Promise<InventoryItem[]> {
  return db.execO<InventoryItem>('SELECT id, name, category, default_unit FROM inventory_items ORDER BY name COLLATE NOCASE');
}

export async function createInventoryItem(db: DB, name: string, category: string, defaultUnit: string): Promise<void> {
  await db.exec('INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)',
    [nanoid(), name, category, defaultUnit, nowSeconds()]);
}

export async function addInventoryEntry(db: DB, itemId: string, kind: 'purchase' | 'count', quantity: number, unit: string, accountId: string): Promise<void> {
  const now = nowSeconds();
  if (kind === 'purchase') {
    await db.exec('INSERT INTO inventory_purchases(id, inventory_item_id, quantity, unit, purchased_at) VALUES (?, ?, ?, ?, ?)',
      [nanoid(), itemId, quantity, unit, now]);
  } else {
    await db.exec('INSERT INTO inventory_counts(id, inventory_item_id, quantity, unit, counted_at, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?)',
      [nanoid(), itemId, quantity, unit, now, accountId]);
  }
}

export async function addPhoto(db: DB, batchId: string, file: File, accountId: string): Promise<void> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image');
  if (file.size > 5 * 1024 * 1024) throw new Error('Image exceeds 5 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  await db.exec('INSERT INTO photos(id, batch_id, mime_type, byte_count, image, created_at, created_by_account_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [nanoid(), batchId, file.type, bytes.length, bytes, nowSeconds(), accountId]);
}

export async function listPhotos(db: DB, batchId: string): Promise<{ id: string; mime_type: string; image: Uint8Array }[]> {
  return db.execO('SELECT id, mime_type, image FROM photos WHERE batch_id = ? ORDER BY created_at DESC', [batchId]);
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
  const response = await fetch(`/api/workspaces/${workspaceId}/sync`, {
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
