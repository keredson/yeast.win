import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import { fetchApi } from './api.ts';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { nanoid } from 'nanoid';
import { boilOffKinds, capacityKinds, equipmentKinds, measurementRangeUnits, temperatureCalibrationKinds } from '../shared/equipment.ts';
import { equipmentSlug } from './equipmentRoutes.ts';
import type { CatalogEquipment } from '../shared/catalog.ts';
import { changeColumns, indexStatements, nowSeconds, replicatedTables, schemaStatements, workspaceSchemaVersion, type SyncRequest, type SyncResponse } from '../shared/schema.ts';
import { decodeChange, encodeChange, type SqlChangeRow } from '../shared/wire.ts';
import { convertUnit, formatQuantity, storageUnit } from '../shared/units.ts';
import type { ImportedRecipe } from './recipeImport.ts';
import { mashEfficiencyPct, type MashGrain } from './mashEfficiency.ts';

export type LocalDb = DB;
export interface Batch { id: string; name: string; description: string | null; status: string; created_at: number }
export type RecipeType = 'beer' | 'wine' | 'mead' | 'cider';
export interface Recipe { id: string; name: string; description: string | null; recipe_type: RecipeType | null }
export interface BatchEvent {
  id: string; batch_id: string; event_type: string; title: string; planned_at: number | null;
  anchor_event_id: string | null; offset_seconds: number | null; details: PlanDetails;
  actual_at: number | null; skipped_at: number | null; note: string | null;
  source_id: string | null; ended_at?: number | null;
}
export type Plan = BatchEvent;
export type ActualEvent = BatchEvent;
export interface PlanDetails {
  anchor_point?: string; duration_seconds?: number; note?: string;
  phase?: string; mode?: string; target_value?: number; target_unit?: string;
  item_category?: string; item_name?: string; catalog_item_id?: string; inventory_item_id?: string;
  quantity?: number; unit?: string; display_unit?: string;
  measurement_kind?: string; to_vessel_id?: string; to_vessel_name?: string;
  purpose?: string; mash_equipment_id?: string; equipment_id?: string;
  container_name?: string; container_size?: number; container_count?: number; container_unit?: string;
}
export interface Equipment { id: string; name: string; kind: string; specification_json: string | null }
export interface InventoryItem { id: string; name: string; category: string; default_unit: string; display_unit: string;
  location_id: string | null; location_name?: string | null;
  yield_pct?: number | null; color_lovibond?: number | null; alpha_acid_pct?: number | null;
  hop_form?: IngredientProperties['hop_form'] | null; attenuation_pct?: number | null }
export interface IngredientProperties { yield_pct?: number; color_lovibond?: number; alpha_acid_pct?: number;
  hop_form?: 'pellet' | 'whole' | 'plug'; attenuation_pct?: number }
const ingredientPropertyColumns = ['yield_pct', 'color_lovibond', 'alpha_acid_pct', 'hop_form', 'attenuation_pct'] as const;
const equipmentAssumptionColumns = ['mash_efficiency_pct', 'grain_absorption_l_per_kg', 'mash_deadspace_liters', 'kettle_retention_liters'] as const;

function sourceNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceIngredientProperties(inputs: Record<string, unknown>): IngredientProperties {
  const form = String(inputs.form || '').toLowerCase();
  return {
    ...(sourceNumber(inputs.yield) != null ? { yield_pct: sourceNumber(inputs.yield)! } : {}),
    ...(sourceNumber(inputs.color) != null ? { color_lovibond: sourceNumber(inputs.color)! } : {}),
    ...(sourceNumber(inputs.alpha) != null ? { alpha_acid_pct: sourceNumber(inputs.alpha)! } : {}),
    ...(['pellet', 'whole', 'plug'].includes(form) ? { hop_form: form as IngredientProperties['hop_form'] } : {}),
    ...(sourceNumber(inputs.attenuation) != null ? { attenuation_pct: sourceNumber(inputs.attenuation)! } : {})
  };
}

export function ingredientProperties(item: InventoryItem | null | undefined): IngredientProperties {
  if (!item) return {};
  return Object.fromEntries(ingredientPropertyColumns.filter(column => item[column] != null)
    .map(column => [column, item[column]])) as IngredientProperties;
}

async function writeIngredientProperties(db: Pick<DB, 'exec'>, id: string, values: IngredientProperties): Promise<void> {
  const columns = ingredientPropertyColumns;
  await db.exec(`INSERT INTO inventory_ingredient_properties(id, ${columns.join(', ')})
    VALUES (?, ${columns.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
  [id, ...columns.map(column => values[column] ?? null)]);
}
export interface InventoryLocation { id: string; name: string; parent_id: string | null }
export interface InventoryMovement { id: string; kind: 'Purchased' | 'Counted' | 'Used' | 'Discarded' | 'Moved in' | 'Moved out'; quantity: number; unit: string; at: number }

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
      } else if (version[0].version < workspaceSchemaVersion) {
        await db.tx(async tx => {
          for (const table of replicatedTables) {
            const exists = await tx.execO<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
            if (!exists.length) continue;
            await tx.exec('SELECT crsql_as_table(?)', [table]);
            await tx.exec(`DROP TABLE "${table}"`);
          }
          for (const statement of schemaStatements) await tx.exec(statement);
          for (const table of replicatedTables) await tx.exec('SELECT crsql_as_crr(?)', [table]);
          for (const statement of indexStatements) await tx.exec(statement);
          await tx.exec('CREATE TABLE IF NOT EXISTS sync_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
          await tx.exec('DELETE FROM sync_state');
          await tx.exec('UPDATE schema_meta SET version = ?', [workspaceSchemaVersion]);
        });
      } else if (version[0].version > workspaceSchemaVersion) {
        throw new Error(`This app cannot open workspace schema ${version[0].version}; update Brewlog first.`);
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

export async function recipeTargetVolume(db: DB, recipeId: string): Promise<number | null> {
  const rows = await db.execO<{ target_fermenter_volume_liters: number | null }>(
    'SELECT target_fermenter_volume_liters FROM recipe_inputs WHERE id = ?', [recipeId]);
  return rows[0]?.target_fermenter_volume_liters ?? null;
}

export async function updateRecipeTargetVolume(db: DB, recipeId: string, liters: number | null): Promise<void> {
  if (liters != null && (!Number.isFinite(liters) || liters <= 0)) throw new Error('Enter a positive target volume');
  await db.exec(`INSERT INTO recipe_inputs(id, target_fermenter_volume_liters) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET target_fermenter_volume_liters = excluded.target_fermenter_volume_liters`, [recipeId, liters]);
}

export async function updateRecipe(db: DB, recipeId: string, name: string, description: string, recipeType: RecipeType): Promise<void> {
  if (!name.trim() || name.trim().length > 100) throw new Error('Recipe name must be 1–100 characters');
  if (!['beer', 'wine', 'mead', 'cider'].includes(recipeType)) throw new Error('Choose a recipe type');
  await db.tx(async tx => {
    const recipes = await tx.execO<{ id: string }>('SELECT id FROM recipes WHERE id = ?', [recipeId]);
    if (!recipes.length) throw new Error('Recipe not found');
    await tx.exec('UPDATE recipes SET name = ?, description = ?, updated_at = ? WHERE id = ?',
      [name.trim(), description.trim() || null, nowSeconds(), recipeId]);
    const types = await tx.execO<{ id: string }>('SELECT id FROM recipe_types WHERE id = ?', [recipeId]);
    if (types.length) await tx.exec('UPDATE recipe_types SET recipe_type = ? WHERE id = ?', [recipeType, recipeId]);
    else await tx.exec('INSERT INTO recipe_types(id, recipe_type) VALUES (?, ?)', [recipeId, recipeType]);
  });
}

export async function deleteRecipe(db: DB, recipeId: string): Promise<void> {
  await db.tx(async tx => {
    const recipes = await tx.execO<{ id: string }>('SELECT id FROM recipes WHERE id = ?', [recipeId]);
    if (!recipes.length) throw new Error('Recipe not found');
    const events = await tx.execO<{ id: string }>('SELECT id FROM recipe_events WHERE recipe_id = ?', [recipeId]);
    for (const event of events) {
      await tx.exec('DELETE FROM recipe_event_inputs WHERE id = ?', [event.id]);
      for (const [table] of Object.values(planPayloads.recipe)) await tx.exec(`DELETE FROM ${table} WHERE event_id = ?`, [event.id]);
    }
    await tx.exec('DELETE FROM recipe_events WHERE recipe_id = ?', [recipeId]);
    await tx.exec('DELETE FROM recipe_inputs WHERE id = ?', [recipeId]);
    const links = await tx.execO<{ source_id: string }>('SELECT source_id FROM recipe_import_links WHERE id = ?', [recipeId]);
    await tx.exec('DELETE FROM recipe_import_links WHERE id = ?', [recipeId]);
    for (const link of links) {
      const others = await tx.execO<{ id: string }>('SELECT id FROM recipe_import_links WHERE source_id = ? LIMIT 1', [link.source_id]);
      if (!others.length) await tx.exec('DELETE FROM recipe_import_sources WHERE id = ?', [link.source_id]);
    }
    await tx.exec('DELETE FROM recipe_types WHERE id = ?', [recipeId]);
    await tx.exec('DELETE FROM recipes WHERE id = ?', [recipeId]);
  });
}

export type IngredientImportChoice = { mode: 'unlinked' } | { mode: 'existing'; inventoryItemId: string }
  | { mode: 'create'; unit: string };

const planPayloads = {
  recipe: {
    addition: ['recipe_additions', ['item_category', 'item_name', 'catalog_item_id', 'inventory_item_id', 'quantity', 'unit', 'display_unit']],
    temperature_control: ['recipe_temperature_control_events', ['phase', 'mode', 'target_value', 'target_unit', 'equipment_id']],
    pressure_control: ['recipe_pressure_control_events', ['target_value', 'target_unit', 'equipment_id']],
    measurement: ['recipe_measurement_targets', ['measurement_kind', 'target_value', 'target_unit']],
    transfer: ['recipe_transfers', ['purpose', 'mash_equipment_id', 'to_vessel_id', 'to_vessel_name', 'quantity', 'unit']],
    packaging: ['recipe_packaging', ['container_name', 'container_size', 'container_count', 'container_unit']]
  },
  batch: {
    addition: ['additions', ['item_category', 'item_name', 'catalog_item_id', 'inventory_item_id', 'quantity', 'unit', 'display_unit']],
    temperature_control: ['temperature_control_events', ['phase', 'mode', 'target_value', 'target_unit', 'equipment_id']],
    pressure_control: ['pressure_control_events', ['target_value', 'target_unit', 'equipment_id']],
    measurement: ['batch_measurement_targets', ['measurement_kind', 'target_value', 'target_unit']],
    transfer: ['transfers', ['purpose', 'mash_equipment_id', 'to_vessel_id', 'to_vessel_name', 'quantity', 'unit']],
    packaging: ['packaging', ['container_name', 'container_size', 'container_count', 'container_unit']]
  }
} as const;
type PlanScope = keyof typeof planPayloads;

function payloadFor(scope: PlanScope, eventType: string): readonly [string, readonly string[]] | undefined {
  return (planPayloads[scope] as Record<string, readonly [string, readonly string[]]>)[eventType];
}

async function writePlanPayload(db: Pick<DB, 'exec'>, scope: PlanScope, id: string, eventType: string, details: PlanDetails): Promise<void> {
  const payload = payloadFor(scope, eventType);
  for (const [kind, [table]] of Object.entries(planPayloads[scope])) {
    if (kind !== eventType) await db.exec(`DELETE FROM ${table} WHERE event_id = ?`, [id]);
  }
  if (!payload) return;
  const [table, columns] = payload;
  const values = columns.map(column => details[column as keyof PlanDetails] ?? null);
  await db.exec(`INSERT INTO ${table}(event_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
    ON CONFLICT(event_id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
  [id, ...values]);
}

type StoredPlan = { id: string; event_type: string; anchor_point: string | null;
  duration_seconds: number | null; instructions: string | null; details: PlanDetails };

async function fillPlanDetails<T extends StoredPlan>(db: Pick<DB, 'execO'>, scope: PlanScope, rows: T[]): Promise<T[]> {
  for (const row of rows) {
    row.details = {
      ...(row.anchor_point ? { anchor_point: row.anchor_point } : {}),
      ...(row.duration_seconds != null ? { duration_seconds: row.duration_seconds } : {}),
      ...(row.instructions ? { note: row.instructions } : {})
    };
  }
  for (const [kind, [table]] of Object.entries(planPayloads[scope])) {
    const selected = rows.filter(row => row.event_type === kind);
    if (!selected.length) continue;
    const payloads = await db.execO<Record<string, string | number | null>>(
      `SELECT * FROM ${table} WHERE event_id IN (${selected.map(() => '?').join(', ')})`, selected.map(row => row.id));
    const byId = new Map(payloads.map(payload => [payload.event_id, payload]));
    for (const row of selected) {
      const payload = byId.get(row.id);
      if (!payload) continue;
      for (const [key, value] of Object.entries(payload)) {
        // Only the columns declared for this plan kind belong to its editable details.
        if (value != null && payloadFor(scope, kind)?.[1].includes(key)) {
          (row.details as Record<string, string | number>)[key] = value;
        }
      }
    }
  }
  return rows;
}

export async function importRecipes(db: DB, source: {
  filename: string; format: 'beerxml' | 'brewfather_json'; bytes: Uint8Array; sha256: string;
}, selected: ImportedRecipe[], choices: Record<string, IngredientImportChoice>): Promise<string[]> {
  if (!selected.length) throw new Error('Choose at least one recipe');
  if (source.bytes.byteLength > 10 * 1024 * 1024) throw new Error('Import file exceeds 10 MB');
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('Invalid import hash');
  const sourceId = nanoid();
  const now = nowSeconds();
  const ids: string[] = [];
  await db.tx(async tx => {
    await tx.exec(`INSERT INTO recipe_import_sources(id, filename, format, sha256, byte_count, content, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [sourceId, source.filename, source.format, source.sha256,
      source.bytes.byteLength, source.bytes, now]);
    const ingredientIds = new Map<string, string>();
    for (const ingredient of new Map(selected.flatMap(recipe => recipe.ingredients.map(item => [item.key, item] as const))).values()) {
      const choice = choices[ingredient.key];
      if (!choice || choice.mode === 'unlinked') continue;
      if (choice.mode === 'existing') {
        const rows = await tx.execO<{ id: string }>('SELECT id FROM inventory_items WHERE id = ? AND category = ?',
          [choice.inventoryItemId, ingredient.category]);
        if (!rows.length) throw new Error(`Choose an inventory item for ${ingredient.name}`);
        ingredientIds.set(ingredient.key, choice.inventoryItemId);
      } else {
        const id = nanoid();
        if (!choice.unit) throw new Error(`Choose a unit for ${ingredient.name}`);
        await tx.exec('INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)',
          [id, ingredient.name, ingredient.category, storageUnit(choice.unit), now]);
        const example = selected.flatMap(recipe => recipe.actions).find(action => action.ingredientKey === ingredient.key);
        const source = example?.inputs || {};
        const numeric = (key: string) => source[key] == null || source[key] === '' ? undefined : Number(source[key]);
        const properties: IngredientProperties = ['Grain', 'Adjunct'].includes(ingredient.category)
          ? { yield_pct: numeric('yield'), color_lovibond: numeric('color') }
          : ingredient.category === 'Hops'
            ? { alpha_acid_pct: numeric('alpha'), hop_form: ['pellet', 'whole', 'plug'].includes(String(source.form).toLowerCase())
              ? String(source.form).toLowerCase() as IngredientProperties['hop_form'] : undefined }
            : ingredient.category === 'Yeast' ? { attenuation_pct: numeric('attenuation') } : {};
        const validProperties = Object.fromEntries(Object.entries(properties).filter(([, value]) => value != null
          && (typeof value !== 'number' || Number.isFinite(value)))) as IngredientProperties;
        if (Object.keys(validProperties).length) await writeIngredientProperties(tx, id, validProperties);
        if (choice.unit !== storageUnit(choice.unit)) await tx.exec(
          'INSERT INTO inventory_display_units(id, display_unit) VALUES (?, ?)', [id, choice.unit]);
        ingredientIds.set(ingredient.key, id);
      }
    }
    for (const recipe of selected) {
      const recipeId = nanoid();
      ids.push(recipeId);
      await tx.exec('INSERT INTO recipes(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [recipeId, recipe.name.slice(0, 100), recipe.description || null, now, now]);
      await tx.exec('INSERT INTO recipe_types(id, recipe_type) VALUES (?, ?)', [recipeId, recipe.type]);
      await tx.exec('INSERT INTO recipe_import_links(id, source_id, source_index, external_id) VALUES (?, ?, ?, ?)',
        [recipeId, sourceId, recipe.sourceIndex, recipe.externalId || null]);
      const targetLiters = sourceNumber(recipe.inputs.batch_size ?? recipe.inputs.batchSize);
      const brewhouseEfficiency = sourceNumber(recipe.inputs.efficiency);
      await tx.exec(`INSERT INTO recipe_inputs(id, target_fermenter_volume_liters, brewhouse_efficiency_pct)
        VALUES (?, ?, ?)`, [recipeId, targetLiters, brewhouseEfficiency]);
      const eventIds = new Map(recipe.actions.map(action => [action.key, nanoid()]));
      for (const [order, action] of recipe.actions.entries()) {
        const eventId = eventIds.get(action.key)!;
        const details = { ...action.details };
        const inventoryId = action.ingredientKey && ingredientIds.get(action.ingredientKey);
        if (inventoryId) details.inventory_item_id = inventoryId;
        await tx.exec(`INSERT INTO recipe_events(id, recipe_id, event_type, title, planned_at, anchor_event_id,
          offset_seconds, anchor_point, duration_seconds, instructions, sort_order) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [eventId, recipeId, action.eventType, action.title, action.anchorKey ? eventIds.get(action.anchorKey) || null : null,
          action.offsetSeconds, details.anchor_point ?? null, details.duration_seconds ?? null, details.note ?? null, order + 1]);
        await writePlanPayload(tx, 'recipe', eventId, action.eventType, details as PlanDetails);
        const sourceProperties = sourceIngredientProperties(action.inputs);
        if (Object.keys(sourceProperties).length) await tx.exec(`INSERT INTO recipe_event_inputs(id, ${ingredientPropertyColumns.join(', ')})
          VALUES (?, ${ingredientPropertyColumns.map(() => '?').join(', ')})`,
        [eventId, ...ingredientPropertyColumns.map(column => sourceProperties[column] ?? null)]);
      }
    }
  });
  return ids;
}

export async function recipeImportSource(db: DB, recipeId: string): Promise<{
  filename: string; format: string; content: Uint8Array;
} | null> {
  const rows = await db.execO<{ filename: string; format: string; content: Uint8Array }>(`
    SELECT s.filename, s.format, s.content FROM recipe_import_links l
      JOIN recipe_import_sources s ON s.id = l.source_id WHERE l.id = ?`, [recipeId]);
  return rows[0] || null;
}

export async function hasRecipeImport(db: DB, recipeId: string): Promise<boolean> {
  return (await db.execO<{ id: string }>('SELECT id FROM recipe_import_links WHERE id = ?', [recipeId])).length > 0;
}

export async function createRecipe(db: DB, name: string, description: string, recipeType: RecipeType,
  temperatureUnit: '°C' | '°F' = '°C'): Promise<string> {
  const id = nanoid();
  const now = nowSeconds();
  if (!['beer', 'wine', 'mead', 'cider'].includes(recipeType)) throw new Error('Choose a recipe type');
  await db.tx(async tx => {
    await tx.exec('INSERT INTO recipes(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [id, name, description || null, now, now]);
    await tx.exec('INSERT INTO recipe_types(id, recipe_type) VALUES (?, ?)', [id, recipeType]);
    const mashId = nanoid();
    const drainId = nanoid();
    const boilId = nanoid();
    const chillId = nanoid();
    const transferId = nanoid();
    const insert = async (eventId: string, eventType: string, title: string, anchorId: string | null,
      details: PlanDetails, order: number, offsetSeconds = 0) => {
      await tx.exec(`INSERT INTO recipe_events
        (id, recipe_id, event_type, title, planned_at, anchor_event_id, offset_seconds, anchor_point, duration_seconds, instructions, sort_order)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [eventId, id, eventType, title, anchorId, offsetSeconds, details.anchor_point ?? null,
        details.duration_seconds ?? null, details.note ?? null, order]);
      await writePlanPayload(tx, 'recipe', eventId, eventType, details);
    };
    if (recipeType === 'beer') {
      await insert(mashId, 'temperature_control', 'Mash', null,
        { phase: 'mash', mode: 'hold', target_value: convertUnit(67, '°C', temperatureUnit)!, target_unit: temperatureUnit, duration_seconds: 1800 }, 2);
      await insert(nanoid(), 'addition', 'Add fermentable', mashId,
        { item_category: 'Grain', anchor_point: 'start' }, 1);
      await insert(drainId, 'transfer', 'Drain grain', mashId,
        { purpose: 'drain_grain', anchor_point: 'end' }, 3);
      await insert(nanoid(), 'measurement', 'Measure pre-boil gravity', drainId,
        { measurement_kind: 'gravity', target_unit: 'SG' }, 4);
      await insert(boilId, 'temperature_control', 'Boil', drainId,
        { phase: 'boil', mode: 'heat', target_value: convertUnit(100, '°C', temperatureUnit)!, target_unit: temperatureUnit, duration_seconds: 3600 }, 5);
      await insert(chillId, 'temperature_control', 'Chill', boilId,
        { phase: 'chill', mode: 'chill', target_value: convertUnit(20, '°C', temperatureUnit)!, target_unit: temperatureUnit,
          anchor_point: 'end' }, 6);
      await insert(transferId, 'transfer', 'Transfer to fermenter', chillId,
        { anchor_point: 'end' }, 7);
    }
    const gravityId = nanoid();
    await insert(gravityId, 'measurement', 'Measure original specific gravity', recipeType === 'beer' ? transferId : null,
      { measurement_kind: 'gravity', target_unit: 'SG' }, recipeType === 'beer' ? 8 : 1);
    const pitchId = nanoid();
    await insert(pitchId, 'addition', 'Pitch yeast', recipeType === 'beer' ? chillId : gravityId,
      { item_category: 'Yeast', ...(recipeType === 'beer' ? { anchor_point: 'end' } : {}) }, recipeType === 'beer' ? 9 : 2);
    const packagingDays: Record<RecipeType, number> = { beer: 21, cider: 28, wine: 60, mead: 60 };
    await insert(nanoid(), 'packaging', 'Package batch', pitchId,
      {}, recipeType === 'beer' ? 10 : 3, packagingDays[recipeType] * 86400);
  });
  return id;
}

export interface PlanInput {
  event_type: string;
  title: string;
  planned_at?: number | null;
  anchor_event_id?: string | null;
  offset_seconds?: number | null;
  details: PlanDetails;
}

export async function addRecipePlan(db: DB, recipeId: string, input: PlanInput): Promise<string> {
  const id = nanoid();
  const order = await db.execO<{ next_order: number }>(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM recipe_events WHERE recipe_id = ?', [recipeId]);
  await db.tx(async tx => {
    await tx.exec(`INSERT INTO recipe_events(id, recipe_id, event_type, title, planned_at, anchor_event_id, offset_seconds,
      anchor_point, duration_seconds, instructions, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, recipeId, input.event_type, input.title, input.planned_at ?? null, input.anchor_event_id ?? null,
        input.offset_seconds ?? null, input.details.anchor_point ?? null, input.details.duration_seconds ?? null,
        input.details.note ?? null, order[0].next_order]);
    await writePlanPayload(tx, 'recipe', id, input.event_type, input.details);
  });
  return id;
}

export async function listRecipePlans(db: DB, recipeId: string): Promise<(PlanInput & { id: string })[]> {
  const rows = await db.execO<(PlanInput & StoredPlan)>(
    `SELECT id, event_type, title, planned_at, anchor_event_id, offset_seconds, anchor_point,
      duration_seconds, instructions FROM recipe_events WHERE recipe_id = ? ORDER BY sort_order, id`, [recipeId]);
  return fillPlanDetails(db, 'recipe', rows);
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
  await db.tx(async tx => {
    await tx.exec(`UPDATE recipe_events SET event_type = ?, title = ?, planned_at = ?, anchor_event_id = ?,
      offset_seconds = ?, anchor_point = ?, duration_seconds = ?, instructions = ? WHERE id = ? AND recipe_id = ?`,
    [input.event_type, input.title, input.planned_at ?? null, input.anchor_event_id ?? null,
      input.offset_seconds ?? null, input.details.anchor_point ?? null, input.details.duration_seconds ?? null,
      input.details.note ?? null, planId, recipeId]);
    await writePlanPayload(tx, 'recipe', planId, input.event_type, input.details);
  });
}

export async function deleteRecipePlan(db: DB, recipeId: string, planId: string): Promise<void> {
  const plans = await listRecipePlans(db, recipeId);
  if (!plans.some(plan => plan.id === planId)) throw new Error('Recipe event not found');
  const children = plans.filter(plan => plan.anchor_event_id === planId);
  const effectiveOffset = (plan: PlanInput & { id: string }, visited = new Set<string>()): number => {
    if (visited.has(plan.id)) throw new Error('Timing cannot create a cycle');
    visited.add(plan.id);
    if (!plan.anchor_event_id) return plan.offset_seconds || 0;
    const anchor = plans.find(item => item.id === plan.anchor_event_id);
    if (!anchor) return plan.offset_seconds || 0;
    return effectiveOffset(anchor, visited) + (plan.details.anchor_point === 'end' ? anchor.details.duration_seconds || 0 : 0)
      + (plan.offset_seconds || 0);
  };
  await db.tx(async tx => {
    for (const child of children) {
      await tx.exec(`UPDATE recipe_events SET anchor_event_id = NULL, offset_seconds = ?, anchor_point = NULL
        WHERE id = ? AND recipe_id = ?`, [effectiveOffset(child), child.id, recipeId]);
    }
    await tx.exec('DELETE FROM recipe_event_inputs WHERE id = ?', [planId]);
    for (const [table] of Object.values(planPayloads.recipe)) await tx.exec(`DELETE FROM ${table} WHERE event_id = ?`, [planId]);
    await tx.exec('DELETE FROM recipe_events WHERE id = ? AND recipe_id = ?', [planId, recipeId]);
  });
}

export async function addBatchPlan(db: DB, batchId: string, input: PlanInput, accountId: string): Promise<string> {
  const id = nanoid();
  await db.tx(async tx => {
    await tx.exec(`INSERT INTO batch_events(id, batch_id, event_type, title, planned_at, anchor_event_id,
      offset_seconds, anchor_point, duration_seconds, instructions, created_at, created_by_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, batchId, input.event_type, input.title, input.planned_at ?? null, input.anchor_event_id ?? null,
        input.offset_seconds ?? null, input.details.anchor_point ?? null, input.details.duration_seconds ?? null,
        input.details.note ?? null, nowSeconds(), accountId]);
    await writePlanPayload(tx, 'batch', id, input.event_type, input.details);
  });
  return id;
}

export async function updateBatchPlan(db: DB, batchId: string, planId: string, input: PlanInput): Promise<void> {
  await validatePlanAnchor(db, 'batch_events', 'batch_id', batchId, planId, input.anchor_event_id);
  await db.tx(async tx => {
    await tx.exec(`UPDATE batch_events SET event_type = ?, title = ?, planned_at = ?, anchor_event_id = ?,
      offset_seconds = ?, anchor_point = ?, duration_seconds = ?, instructions = ? WHERE id = ? AND batch_id = ?`,
    [input.event_type, input.title, input.planned_at ?? null, input.anchor_event_id ?? null,
      input.offset_seconds ?? null, input.details.anchor_point ?? null, input.details.duration_seconds ?? null,
      input.details.note ?? null, planId, batchId]);
    await writePlanPayload(tx, 'batch', planId, input.event_type, input.details);
  });
}

export async function startBatchFromRecipe(db: DB, recipe: Recipe, name: string, accountId: string,
  description = recipe.description || ''): Promise<string> {
  const plans = await listRecipePlans(db, recipe.id);
  const latestEfficiencies = new Map<string, number | null>();
  for (const plan of plans) {
    const details = plan.details;
    const mashEquipmentId = details.purpose === 'drain_grain' ? details.mash_equipment_id : null;
    if (typeof mashEquipmentId === 'string' && !latestEfficiencies.has(mashEquipmentId)) {
      latestEfficiencies.set(mashEquipmentId, await latestMeasuredMashEfficiency(db, mashEquipmentId));
    }
  }
  const batchId = nanoid();
  const now = nowSeconds();
  const ids = new Map(plans.map(plan => [plan.id, nanoid()]));
  await db.tx(async tx => {
    await tx.exec('INSERT INTO batches(id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [batchId, name, description, 'active', now, now]);
    const recipeInputs = await tx.execO<{ target_fermenter_volume_liters: number | null; brewhouse_efficiency_pct: number | null }>(
      'SELECT target_fermenter_volume_liters, brewhouse_efficiency_pct FROM recipe_inputs WHERE id = ?', [recipe.id]);
    if (recipeInputs.length) await tx.exec(`INSERT INTO batch_recipe_inputs(id, target_fermenter_volume_liters, brewhouse_efficiency_pct)
      VALUES (?, ?, ?)`, [batchId, recipeInputs[0].target_fermenter_volume_liters, recipeInputs[0].brewhouse_efficiency_pct]);
    for (const plan of plans) {
      await tx.exec(`INSERT INTO batch_events(id, batch_id, recipe_event_id, event_type, title, planned_at,
        anchor_event_id, offset_seconds, anchor_point, duration_seconds, instructions, created_at, created_by_account_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ids.get(plan.id)!, batchId, plan.id, plan.event_type, plan.title, plan.planned_at ?? null,
          plan.anchor_event_id ? ids.get(plan.anchor_event_id) ?? null : null,
          plan.offset_seconds ?? null, plan.details.anchor_point ?? null, plan.details.duration_seconds ?? null,
          plan.details.note ?? null, now, accountId]);
      await writePlanPayload(tx, 'batch', ids.get(plan.id)!, plan.event_type, plan.details);
      const eventInputs = await tx.execO<IngredientProperties>('SELECT * FROM recipe_event_inputs WHERE id = ?', [plan.id]);
      const snapshot: Record<string, string | number | null> = {};
      if (eventInputs.length) for (const column of ingredientPropertyColumns) snapshot[column] = eventInputs[0][column] ?? null;
      const details = plan.details;
      const assumptionEquipmentId = details.purpose === 'drain_grain' ? details.mash_equipment_id : details.equipment_id;
      if (typeof assumptionEquipmentId === 'string') {
        const rows = await tx.execO<{ specification_json: string | null }>('SELECT specification_json FROM equipment WHERE id = ?', [assumptionEquipmentId]);
        if (rows.length) {
          const specs = JSON.parse(rows[0].specification_json || '{}') as EquipmentSpecifications;
          for (const column of equipmentAssumptionColumns) snapshot[column] = specs[column] ?? null;
          if (details.purpose === 'drain_grain' && specs.mash_efficiency_pct == null) {
            const recent = latestEfficiencies.get(assumptionEquipmentId);
            if (recent != null) snapshot.mash_efficiency_pct = recent;
          }
        }
      }
      if (typeof details.inventory_item_id === 'string') {
        // A linked inventory item supplies the calculation defaults. Imported values
        // remain in the original file, even when the item has no property set.
        for (const column of ingredientPropertyColumns) snapshot[column] = null;
        const rows = await tx.execO<InventoryItem>(
          'SELECT * FROM inventory_ingredient_properties WHERE id = ?', [details.inventory_item_id]);
        if (rows.length) for (const [column, value] of Object.entries(ingredientProperties(rows[0]))) snapshot[column] = value;
      }
      if (Object.values(snapshot).some(value => value != null)) {
        const columns = [...ingredientPropertyColumns, ...equipmentAssumptionColumns];
        await tx.exec(`INSERT INTO batch_event_inputs(id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`,
          [ids.get(plan.id)!, ...columns.map(column => snapshot[column] ?? null)]);
      }
    }
  });
  return batchId;
}

export async function listPlans(db: DB, batchId: string): Promise<Plan[]> {
  return listEvents(db, batchId);
}

export async function listEvents(db: DB, batchId: string): Promise<ActualEvent[]> {
  const rows = await db.execO<ActualEvent & StoredPlan>(`SELECT e.id, e.batch_id, e.event_type, e.title, e.planned_at, e.anchor_event_id,
    e.offset_seconds, e.anchor_point, e.duration_seconds, e.instructions, e.actual_at, e.skipped_at, e.note, e.source_id, x.ended_at
    FROM batch_events e LEFT JOIN event_ends x ON x.id = e.id
    WHERE e.batch_id = ? ORDER BY e.created_at, e.id`, [batchId]);
  return fillPlanDetails(db, 'batch', rows);
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
    if (input.endedAt != null) await tx.exec('UPDATE batch_events SET duration_seconds = NULL WHERE id = ?', [id]);
    const payload = input.payload;
    if (!payload) return;
    const table = input.measurementKind ? measurementTables[input.measurementKind] : {
      addition: 'additions', temperature_control: 'temperature_control_events', pressure_control: 'pressure_control_events',
      transfer: 'transfers', packaging: 'packaging'
    }[input.eventType];
    if (!table) throw new Error('Unsupported event payload');
    const columns = Object.keys(payload);
    await tx.exec(`INSERT INTO ${table}(event_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
      ON CONFLICT(event_id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
      [id, ...Object.values(payload)]);
    if (input.eventType === 'addition' && typeof payload.item_name === 'string') {
      await tx.exec('UPDATE batch_events SET title = ? WHERE id = ?', [payload.item_name, id]);
    }
    if (input.eventType === 'transfer') await updateTransferName(tx, id, payload.to_vessel_id);
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
    if (input.endedAt != null) await tx.exec('UPDATE batch_events SET duration_seconds = NULL WHERE id = ?', [event.id]);
    const table = input.measurementKind ? measurementTables[input.measurementKind] : eventPayloadTables[input.eventType];
    if (!table) throw new Error('Unsupported event payload');
    const columns = Object.keys(input.payload);
    await tx.exec(`UPDATE ${table} SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE event_id = ?`,
      [...Object.values(input.payload), event.id]);
    if (input.eventType === 'addition' && typeof input.payload.item_name === 'string') {
      await tx.exec('UPDATE batch_events SET title = ? WHERE id = ?', [input.payload.item_name, event.id]);
    }
    if (input.eventType === 'transfer') {
      await tx.exec('UPDATE transfers SET from_vessel_id = NULL WHERE event_id = ?', [event.id]);
      await updateTransferName(tx, event.id, input.payload.to_vessel_id);
    }
  });
}

async function updateTransferName(db: Pick<DB, 'execO' | 'exec'>, id: string, destination: unknown): Promise<void> {
  const equipment = typeof destination === 'string'
    ? await db.execO<{ name: string }>('SELECT name FROM equipment WHERE id = ?', [destination]) : [];
  await db.exec('UPDATE transfers SET to_vessel_name = ? WHERE event_id = ?', [equipment[0]?.name ?? null, id]);
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
      if (rows.length) {
        const scaleOrUnit = kind === 'gravity' && rows[0].unit === 'SG' ? '' : ` ${rows[0].unit}`;
        parts.push(`${kind.replaceAll('_', ' ')} ${rows[0].value}${scaleOrUnit}${rows[0].uncertainty == null ? '' : ` ±${rows[0].uncertainty}`}`);
      }
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
  slug?: string;
  capacity_liters?: number;
  built_in_temperature_control?: boolean;
  max_pressure_kpa?: number;
  measurement_min?: number;
  measurement_max?: number;
  measurement_unit?: string;
  boil_heat_loss_watts?: number;
  rated_power_watts?: number;
  mash_efficiency_pct?: number;
  grain_absorption_l_per_kg?: number;
  mash_deadspace_liters?: number;
  kettle_retention_liters?: number;
  temperature_offset_c?: number;
  current_calibration?: Record<string, number>;
}

export async function updateBrewingLosses(db: DB, item: Equipment, values: Pick<EquipmentSpecifications,
  'mash_efficiency_pct' | 'grain_absorption_l_per_kg' | 'mash_deadspace_liters' | 'kettle_retention_liters'>): Promise<void> {
  if (!['all_in_one', 'mash_tun', 'kettle', 'electric_kettle'].includes(item.kind)) throw new Error('Choose brewing equipment');
  for (const [key, value] of Object.entries(values)) {
    if (value != null && (!Number.isFinite(value) || value < 0 || key === 'mash_efficiency_pct' && value > 100)) {
      throw new Error(`Enter a valid ${key.replaceAll('_', ' ')}`);
    }
  }
  const specification = JSON.parse(item.specification_json || '{}') as EquipmentSpecifications;
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete (specification as Record<string, unknown>)[key];
    else (specification as Record<string, unknown>)[key] = value;
  }
  await db.exec('UPDATE equipment SET specification_json = ? WHERE id = ?', [JSON.stringify(specification), item.id]);
}

export async function latestMeasuredMashEfficiency(db: DB, equipmentId: string): Promise<number | null> {
  const drains = await db.execO<{ id: string; batch_id: string; actual_at: number }>(`SELECT d.id, d.batch_id, d.actual_at FROM batch_events d
    JOIN transfers t ON t.event_id = d.id
    LEFT JOIN batch_events m ON m.id = d.anchor_event_id
    LEFT JOIN temperature_control_events mc ON mc.event_id = m.id
    WHERE d.event_type = 'transfer' AND d.actual_at IS NOT NULL
      AND t.purpose = 'drain_grain'
      AND COALESCE(t.mash_equipment_id, mc.equipment_id) = ?
    ORDER BY d.actual_at DESC, d.id DESC LIMIT 30`, [equipmentId]);
  for (const drain of drains) {
    const collected = await db.execO<{ quantity: number | null; unit: string | null }>(
      'SELECT quantity, unit FROM transfers WHERE event_id = ?', [drain.id]);
    const volumes = await db.execO<{ value: number; unit: string }>(`SELECT v.value, v.unit FROM volume_measurements v
      JOIN batch_events e ON e.id = v.event_id WHERE e.anchor_event_id = ? AND e.actual_at IS NOT NULL
      ORDER BY e.actual_at DESC LIMIT 1`, [drain.id]);
    const gravities = await db.execO<{ value: number; unit: string }>(`SELECT g.value, g.unit FROM gravity_measurements g
      JOIN batch_events e ON e.id = g.event_id WHERE e.anchor_event_id = ? AND e.actual_at IS NOT NULL
      ORDER BY e.actual_at DESC LIMIT 1`, [drain.id]);
    const volume = collected[0]?.quantity != null && collected[0].unit
      ? { value: collected[0].quantity, unit: collected[0].unit } : volumes[0];
    if (!volume || !gravities.length) continue;
    const additions = await db.execO<{ quantity: number; unit: string; yield_pct: number | null }>(`SELECT a.quantity, a.unit,
      i.yield_pct FROM additions a JOIN batch_events e ON e.id = a.event_id
      LEFT JOIN inventory_items item ON item.id = a.inventory_item_id
      LEFT JOIN batch_event_inputs i ON i.id = e.id
      WHERE e.batch_id = ? AND e.actual_at IS NOT NULL AND e.actual_at <= ?
        AND (item.category = 'Grain' OR a.item_category = 'Grain')`, [drain.batch_id, drain.actual_at]);
    const grains: MashGrain[] = additions.map(row => ({ quantity: row.quantity, unit: row.unit,
      yieldPct: Number(row.yield_pct) }));
    if (!grains.length) continue;
    const result = mashEfficiencyPct(grains, volume.value, volume.unit, gravities[0].value, gravities[0].unit);
    if (result != null) return result;
  }
  return null;
}

export async function updateEquipmentIdentity(db: DB, item: Equipment, name: string, slug: string,
  equipment: Equipment[]): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120) throw new Error('Enter an equipment name');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) throw new Error('Enter a valid slug');
  if (equipment.some(row => row.id !== item.id && (equipmentSlug(row) === slug || row.id === slug))) {
    throw new Error('That slug is already used by another equipment item');
  }
  const specification = JSON.parse(item.specification_json || '{}') as Record<string, unknown>;
  specification.slug = slug;
  await db.exec('UPDATE equipment SET name = ?, specification_json = ? WHERE id = ?',
    [trimmed, JSON.stringify(specification), item.id]);
}

export async function createEquipment(db: DB, name: string, kind: string, catalogModel?: CatalogEquipment,
  overrides: EquipmentSpecifications = {}): Promise<string> {
  if (!equipmentKinds.some(item => item.value === kind)) throw new Error('Choose a valid equipment kind');
  if (catalogModel && catalogModel.kind !== kind) throw new Error('Catalog kind does not match equipment kind');
  const id = nanoid();
  const specification = JSON.parse(catalogModel?.specification_json || '{}') as Record<string, unknown>;
  Object.assign(specification, overrides);
  delete specification.working_volume_liters;
  if (!capacityKinds.has(kind)) delete specification.capacity_liters;
  if (kind !== 'fermenter') {
    delete specification.built_in_temperature_control;
    delete specification.max_pressure_kpa;
  }
  delete specification.boil_off_liters_per_hour;
  if (!boilOffKinds.has(kind)) delete specification.boil_heat_loss_watts;
  if (!temperatureCalibrationKinds.has(kind) && !(kind === 'fermenter' && specification.built_in_temperature_control)) {
    delete specification.temperature_offset_c;
  }
  if (!measurementRangeUnits[kind]) {
    delete specification.measurement_min;
    delete specification.measurement_max;
    delete specification.measurement_unit;
  }
  await db.exec('INSERT INTO equipment(id, name, kind, catalog_model_id, specification_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, kind, catalogModel?.id || null, Object.keys(specification).length ? JSON.stringify(specification) : null, nowSeconds()]);
  return id;
}

export async function updateFermenterCapabilities(db: DB, item: Equipment,
  builtInTemperatureControl: boolean, maxPressureKpa: number | null): Promise<void> {
  if (item.kind !== 'fermenter') throw new Error('These settings apply only to fermenters');
  if (maxPressureKpa != null && (!Number.isFinite(maxPressureKpa) || maxPressureKpa <= 0)) {
    throw new Error('Enter a positive pressure rating');
  }
  const specification = JSON.parse(item.specification_json || '{}') as Record<string, unknown>;
  if (builtInTemperatureControl) specification.built_in_temperature_control = true;
  else delete specification.built_in_temperature_control;
  if (maxPressureKpa == null) delete specification.max_pressure_kpa;
  else specification.max_pressure_kpa = maxPressureKpa;
  await db.exec('UPDATE equipment SET specification_json = ? WHERE id = ?',
    [Object.keys(specification).length ? JSON.stringify(specification) : null, item.id]);
}

export async function updateEquipmentCapacity(db: DB, item: Equipment, capacityLiters: number | null): Promise<void> {
  const specification = JSON.parse(item.specification_json || '{}') as Record<string, unknown>;
  if (capacityLiters == null) delete specification.capacity_liters;
  else specification.capacity_liters = capacityLiters;
  await db.exec('UPDATE equipment SET specification_json = ? WHERE id = ?',
    [Object.keys(specification).length ? JSON.stringify(specification) : null, item.id]);
}

export async function updateEquipmentBoilHeatLoss(db: DB, item: Equipment, watts: number): Promise<void> {
  if (!boilOffKinds.has(item.kind)) throw new Error('Boil calibration applies to electric kettles and all-in-one systems');
  if (!Number.isFinite(watts) || watts < 0) throw new Error('Enter a valid heat loss');
  const specification = JSON.parse(item.specification_json || '{}') as Record<string, unknown>;
  specification.boil_heat_loss_watts = watts;
  delete specification.boil_off_liters_per_hour;
  await db.exec('UPDATE equipment SET specification_json = ? WHERE id = ?',
    [JSON.stringify(specification), item.id]);
}

export async function updateEquipmentTemperatureOffset(db: DB, item: Equipment, offsetC: number): Promise<void> {
  const current = JSON.parse(item.specification_json || '{}') as EquipmentSpecifications;
  if (!temperatureCalibrationKinds.has(item.kind) && !(item.kind === 'fermenter' && current.built_in_temperature_control)) {
    throw new Error('This equipment has no temperature reading to calibrate');
  }
  if (!Number.isFinite(offsetC)) throw new Error('Enter valid temperatures');
  const specification = JSON.parse(item.specification_json || '{}') as Record<string, unknown>;
  specification.temperature_offset_c = offsetC;
  await db.exec('UPDATE equipment SET specification_json = ? WHERE id = ?', [JSON.stringify(specification), item.id]);
}

export async function updateEquipmentCalibration(db: DB, item: Equipment, values: Record<string, number>): Promise<void> {
  if (!Object.keys(values).length || Object.values(values).some(value => !Number.isFinite(value))) {
    throw new Error('Enter valid calibration values');
  }
  const specification = JSON.parse(item.specification_json || '{}') as Record<string, unknown>;
  specification.current_calibration = values;
  await db.exec('UPDATE equipment SET specification_json = ? WHERE id = ?', [JSON.stringify(specification), item.id]);
}

export async function updateEquipmentRatedPower(db: DB, item: Equipment, watts: number | null): Promise<void> {
  if (!boilOffKinds.has(item.kind)) throw new Error('Rated power applies to electric kettles and all-in-one systems');
  if (watts != null && (!Number.isFinite(watts) || watts <= 0)) throw new Error('Enter a positive power');
  const specification = JSON.parse(item.specification_json || '{}') as Record<string, unknown>;
  if (watts == null) delete specification.rated_power_watts;
  else specification.rated_power_watts = watts;
  await db.exec('UPDATE equipment SET specification_json = ? WHERE id = ?', [JSON.stringify(specification), item.id]);
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
    used ||= await referenced('recipe_transfers', 'to_vessel_id = ?', [id]);
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
    COALESCE(d.display_unit, i.default_unit) AS display_unit, l.location_id, places.name AS location_name,
    p.yield_pct, p.color_lovibond, p.alpha_acid_pct, p.hop_form, p.attenuation_pct FROM inventory_items i
    LEFT JOIN inventory_ingredient_properties p ON p.id = i.id
    LEFT JOIN inventory_display_units d ON d.id = i.id
    LEFT JOIN inventory_item_locations l ON l.id = i.id
    LEFT JOIN inventory_locations places ON places.id = l.location_id ORDER BY i.name COLLATE NOCASE`);
}

export async function updateIngredientProperties(db: DB, item: InventoryItem, properties: IngredientProperties): Promise<void> {
  const allowed: Record<string, (keyof IngredientProperties)[]> = {
    Grain: ['yield_pct', 'color_lovibond'], Adjunct: ['yield_pct', 'color_lovibond'],
    Hops: ['alpha_acid_pct', 'hop_form'], Yeast: ['attenuation_pct']
  };
  if (!allowed[item.category]) throw new Error('This inventory category has no calculation properties');
  const values = Object.fromEntries(allowed[item.category].filter(key => properties[key] != null)
    .map(key => [key, properties[key]])) as IngredientProperties;
  for (const [key, value] of Object.entries(values)) {
    if (key === 'hop_form') {
      if (!['pellet', 'whole', 'plug'].includes(String(value))) throw new Error('Choose a hop form');
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || key !== 'color_lovibond' && value > 100) throw new Error(`Enter a valid ${key.replaceAll('_', ' ')}`);
  }
  if (Object.keys(values).length) await writeIngredientProperties(db, item.id, values);
  else await db.exec('DELETE FROM inventory_ingredient_properties WHERE id = ?', [item.id]);
}

export async function listInventoryLocations(db: DB): Promise<InventoryLocation[]> {
  return db.execO<InventoryLocation>('SELECT id, name, parent_id FROM inventory_locations ORDER BY name COLLATE NOCASE, id');
}

export function inventoryLocationPath(locationId: string | null, locations: InventoryLocation[]): string {
  if (!locationId) return '';
  const byId = new Map(locations.map(location => [location.id, location]));
  const names: string[] = [];
  const seen = new Set<string>();
  let current: string | null = locationId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const location: InventoryLocation | undefined = byId.get(current);
    if (!location) break;
    names.unshift(location.name);
    current = location.parent_id;
  }
  return names.join(' / ') || 'Unknown location';
}

export async function saveInventoryLocation(db: DB, name: string, parentId: string | null, id?: string): Promise<string> {
  const clean = name.trim();
  if (!clean) throw new Error('Enter a location name');
  const locations = await listInventoryLocations(db);
  if (parentId && !locations.some(location => location.id === parentId)) throw new Error('Parent location not found');
  if (locations.some(location => location.id !== id && location.parent_id === parentId && location.name.toLowerCase() === clean.toLowerCase()))
    throw new Error('A location with this name already exists here');
  if (id) {
    let current = parentId;
    while (current) {
      if (current === id) throw new Error('A location cannot contain itself');
      current = locations.find(location => location.id === current)?.parent_id || null;
    }
    await db.exec('UPDATE inventory_locations SET name = ?, parent_id = ? WHERE id = ?', [clean, parentId, id]);
    return id;
  }
  const nextId = nanoid();
  await db.exec('INSERT INTO inventory_locations(id, name, parent_id, created_at) VALUES (?, ?, ?, ?)', [nextId, clean, parentId, nowSeconds()]);
  return nextId;
}

export async function deleteInventoryLocation(db: DB, id: string): Promise<void> {
  const [children, stock] = await Promise.all([
    db.execO('SELECT id FROM inventory_locations WHERE parent_id = ? LIMIT 1', [id]),
    db.execO('SELECT id FROM inventory_item_locations WHERE location_id = ? LIMIT 1', [id])
  ]);
  if (children.length || stock.length) throw new Error('Move stock and child locations before deleting this location');
  await db.exec('DELETE FROM inventory_locations WHERE id = ?', [id]);
}

function sameInventoryProduct(item: InventoryItem, name: string, category: string): boolean {
  return item.category === category && item.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase();
}

export function stockAtLocation(items: InventoryItem[], name: string, category: string, locationId: string | null): InventoryItem | undefined {
  return items.find(item => sameInventoryProduct(item, name, category) && item.location_id === locationId);
}

export async function listInventoryMovements(db: DB, itemId: string): Promise<InventoryMovement[]> {
  return db.execO<InventoryMovement>(`
    SELECT id, 'Purchased' AS kind, quantity, unit, purchased_at AS at FROM inventory_purchases WHERE inventory_item_id = ?
    UNION ALL SELECT id, 'Counted' AS kind, quantity, unit, counted_at AS at FROM inventory_counts WHERE inventory_item_id = ?
    UNION ALL SELECT id, 'Discarded' AS kind, quantity, unit, discarded_at AS at FROM inventory_discards WHERE inventory_item_id = ?
    UNION ALL SELECT id, 'Moved in' AS kind, quantity, unit, moved_at AS at FROM inventory_moves WHERE to_item_id = ?
    UNION ALL SELECT id, 'Moved out' AS kind, quantity, unit, moved_at AS at FROM inventory_moves WHERE from_item_id = ?
    UNION ALL SELECT a.event_id AS id, 'Used' AS kind, a.quantity, a.unit, e.actual_at AS at
      FROM additions a JOIN batch_events e ON e.id = a.event_id WHERE a.inventory_item_id = ? AND e.actual_at IS NOT NULL
    ORDER BY at DESC, id DESC`, [itemId, itemId, itemId, itemId, itemId, itemId]);
}

export async function listInventoryBalances(db: DB, items: InventoryItem[]): Promise<Record<string, number | null>> {
  if (!items.length) return {};
  const rows = await db.execO<InventoryMovement & { inventory_item_id: string }>(`
    SELECT id, inventory_item_id, 'Purchased' AS kind, quantity, unit, purchased_at AS at FROM inventory_purchases
    UNION ALL SELECT id, inventory_item_id, 'Counted' AS kind, quantity, unit, counted_at AS at FROM inventory_counts
    UNION ALL SELECT id, inventory_item_id, 'Discarded' AS kind, quantity, unit, discarded_at AS at FROM inventory_discards
    UNION ALL SELECT id, to_item_id AS inventory_item_id, 'Moved in' AS kind, quantity, unit, moved_at AS at FROM inventory_moves
    UNION ALL SELECT id, from_item_id AS inventory_item_id, 'Moved out' AS kind, quantity, unit, moved_at AS at FROM inventory_moves
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
    if (row.kind === 'Purchased' || row.kind === 'Moved in') balance += amount;
    else if (row.kind === 'Used' || row.kind === 'Discarded' || row.kind === 'Moved out') balance -= amount;
  }
  return balance;
}

export async function createInventoryItem(db: DB, name: string, category: string, defaultUnit: string,
  startingQuantity: number | null = null, accountId: string | null = null, displayUnit = defaultUnit,
  locationId: string | null = null): Promise<string> {
  const items = await listInventory(db);
  if (stockAtLocation(items, name, category, locationId)) throw new Error('This item already exists at that location');
  if (items.some(item => sameInventoryProduct(item, name, category)) && (!startingQuantity || startingQuantity <= 0))
    throw new Error('Enter a positive quantity to add this existing item');
  if (locationId && !(await listInventoryLocations(db)).some(location => location.id === locationId)) throw new Error('Location not found');
  const id = nanoid();
  const now = nowSeconds();
  await db.tx(async tx => {
    await tx.exec('INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, name, category, defaultUnit, now]);
    if (locationId) await tx.exec('INSERT INTO inventory_item_locations(id, location_id) VALUES (?, ?)', [id, locationId]);
    if (displayUnit !== defaultUnit) await tx.exec('INSERT INTO inventory_display_units(id, display_unit) VALUES (?, ?)',
      [id, displayUnit]);
    if (startingQuantity != null) await tx.exec(`INSERT INTO inventory_counts(id, inventory_item_id, quantity, unit, counted_at, created_by_account_id)
      VALUES (?, ?, ?, ?, ?, ?)`, [nanoid(), id, startingQuantity, defaultUnit, now, accountId]);
  });
  return id;
}

export async function moveInventoryStock(db: DB, source: InventoryItem, destinationId: string | null,
  quantity: number, unit: string): Promise<string> {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Enter a positive quantity');
  if (source.location_id === destinationId) throw new Error('Choose another location');
  if (destinationId && !(await listInventoryLocations(db)).some(location => location.id === destinationId)) throw new Error('Location not found');
  const available = inventoryBalance(await listInventoryMovements(db, source.id), source.default_unit);
  const converted = convertInventoryUnit(quantity, unit, source.default_unit);
  if (converted == null) throw new Error('Choose a compatible unit');
  if (available == null || converted > available + 1e-9) throw new Error('Cannot move more than the available stock');
  let target = stockAtLocation(await listInventory(db), source.name, source.category, destinationId);
  if (target && convertInventoryUnit(quantity, unit, target.default_unit) == null) throw new Error('Destination uses an incompatible unit');
  if (!target) target = { ...source, id: nanoid(), location_id: destinationId };
  const latest = await db.execO<{ at: number | null }>(`SELECT MAX(at) AS at FROM (
    SELECT purchased_at AS at FROM inventory_purchases WHERE inventory_item_id IN (?, ?)
    UNION ALL SELECT counted_at FROM inventory_counts WHERE inventory_item_id IN (?, ?)
    UNION ALL SELECT discarded_at FROM inventory_discards WHERE inventory_item_id IN (?, ?)
    UNION ALL SELECT moved_at FROM inventory_moves WHERE from_item_id IN (?, ?) OR to_item_id IN (?, ?)
    UNION ALL SELECT e.actual_at FROM additions a JOIN batch_events e ON e.id = a.event_id
      WHERE a.inventory_item_id IN (?, ?) AND e.actual_at IS NOT NULL)`,
  [source.id, target.id, source.id, target.id, source.id, target.id, source.id, target.id, source.id, target.id, source.id, target.id]);
  await db.tx(async tx => {
    if (!(await tx.execO('SELECT id FROM inventory_items WHERE id = ?', [target.id])).length) {
      await tx.exec('INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)',
        [target.id, target.name, target.category, target.default_unit, nowSeconds()]);
      if (destinationId) await tx.exec('INSERT INTO inventory_item_locations(id, location_id) VALUES (?, ?)', [target.id, destinationId]);
      if (target.display_unit !== target.default_unit) await tx.exec('INSERT INTO inventory_display_units(id, display_unit) VALUES (?, ?)',
        [target.id, target.display_unit]);
      await tx.exec(`INSERT INTO inventory_ingredient_properties(id, ${ingredientPropertyColumns.join(', ')})
        SELECT ?, ${ingredientPropertyColumns.join(', ')} FROM inventory_ingredient_properties WHERE id = ?`, [target.id, source.id]);
    }
    await tx.exec('INSERT INTO inventory_moves(id, from_item_id, to_item_id, quantity, unit, moved_at) VALUES (?, ?, ?, ?, ?, ?)',
      [nanoid(), source.id, target.id, quantity, unit, Math.max(nowSeconds(), (latest[0]?.at ?? 0) + 1)]);
  });
  return target.id;
}

export async function addInventoryEntry(db: DB, itemId: string, kind: 'purchase' | 'count' | 'discard', quantity: number, unit: string, accountId: string): Promise<void> {
  if (!Number.isFinite(quantity) || quantity < 0 || kind !== 'count' && quantity === 0) throw new Error('Enter a positive quantity');
  const latest = await db.execO<{ at: number | null }>(`SELECT MAX(at) AS at FROM (
    SELECT purchased_at AS at FROM inventory_purchases WHERE inventory_item_id = ?
    UNION ALL SELECT counted_at AS at FROM inventory_counts WHERE inventory_item_id = ?
    UNION ALL SELECT discarded_at AS at FROM inventory_discards WHERE inventory_item_id = ?
    UNION ALL SELECT moved_at AS at FROM inventory_moves WHERE from_item_id = ? OR to_item_id = ?
    UNION ALL SELECT e.actual_at AS at FROM additions a JOIN batch_events e ON e.id = a.event_id
      WHERE a.inventory_item_id = ? AND e.actual_at IS NOT NULL)`, [itemId, itemId, itemId, itemId, itemId, itemId]);
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
