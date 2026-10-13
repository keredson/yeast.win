import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import { fetchApi } from './api.ts';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { nanoid } from 'nanoid';
import { boilOffKinds, capacityKinds, equipmentKinds, measurementRangeUnits, temperatureCalibrationKinds } from '../shared/equipment.ts';
import { equipmentSlug } from './equipmentRoutes.ts';
import { openLocalCatalog } from './catalog.ts';
import { hasGeneratedLocationSuffix, locationSlug } from './locationSlug.ts';
import type { CatalogEquipment, MeasurementChannel } from '../shared/catalog.ts';
import { changeColumns, indexStatements, legacyEquipmentCopyStatements, legacyEquipmentModelStatements, supplyMigrationStatements, nowSeconds, replicatedTables, retiredReplicatedTables, schemaStatements,
  workspaceSchemaVersion, workspaceTableColumns } from '../shared/schema.ts';
import type { SqlChangeRow } from '../shared/wire.ts';
import { changeTuple, decodeItem, encodeItem, maxSequence, readSequence, syncContentType,
  syncProtocolVersion, validChangeTuple, type ChangeTuple } from '../shared/cborSync.ts';
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
  item_category?: string; item_name?: string; catalog_item_id?: string; inventory_item_id?: string; supply_id?: string;
  quantity?: number; unit?: string; display_unit?: string;
  measurement_kind?: string; to_vessel_id?: string; to_vessel_name?: string;
  purpose?: string; mash_equipment_id?: string; equipment_id?: string;
  container_name?: string; container_size?: number; container_count?: number; container_unit?: string;
}
export interface EquipmentSpecifications {
  slug?: string | null; capacity_liters?: number | null; built_in_temperature_control?: number | boolean | null;
  has_liquid_containment?: boolean; has_pressure_rating?: boolean;
  has_heating?: boolean; has_cooling?: boolean; has_temperature_control?: boolean;
  max_pressure_kpa?: number | null; measurement_min?: number | null; measurement_max?: number | null;
  measurement_unit?: string | null; boil_heat_loss_watts?: number | null; rated_power_watts?: number | null;
  unit_boil_heat_loss_watts?: number | null; workspace_model_boil_heat_loss_watts?: number | null;
  catalog_model_boil_heat_loss_watts?: number | null;
  rated_heat_removal_watts?: number | null; min_temperature_c?: number | null; max_temperature_c?: number | null;
  mash_efficiency_pct?: number | null; grain_absorption_l_per_kg?: number | null;
  temperature_offset_c?: number | null;
  buffer_4_observed?: number | null; buffer_7_observed?: number | null;
  reference_sg?: number | null; observed_sg?: number | null;
  reference_brix?: number | null; observed_brix?: number | null;
  reference_g?: number | null; observed_g?: number | null;
  reference_kpa?: number | null; observed_kpa?: number | null;
  reference_volumes?: number | null; observed_volumes?: number | null;
  reference_mg_l?: number | null; observed_mg_l?: number | null;
}
export interface Equipment extends EquipmentSpecifications { id: string; name: string; kind: string;
  model_id?: string; model_name?: string; stock_id?: string | null; added_at?: number | null; removed_at?: number | null;
  catalog_model_id?: string | null; catalog_model?: CatalogEquipment;
  measurement_channels?: MeasurementChannel[] }
export interface EquipmentUse { id: string; equipment_id: string; batch_id: string; batch_name: string; assigned_at: number }
const equipmentCalibrationColumns = ['buffer_4_observed', 'buffer_7_observed', 'reference_sg', 'observed_sg',
  'reference_brix', 'observed_brix', 'reference_g', 'observed_g', 'reference_kpa', 'observed_kpa',
  'reference_volumes', 'observed_volumes', 'reference_mg_l', 'observed_mg_l'] as const;
export interface InventoryItem { id: string; name: string; category: string; default_unit: string; display_unit: string;
  supply_id?: string | null; lot_id?: string | null; lot_code?: string | null; catalog_supply_id?: string | null;
  location_id: string | null; location_name?: string | null;
  yield_pct?: number | null; color_lovibond?: number | null; alpha_acid_pct?: number | null;
  hop_form?: IngredientProperties['hop_form'] | null; attenuation_pct?: number | null }
export interface IngredientProperties { yield_pct?: number; color_lovibond?: number; alpha_acid_pct?: number;
  hop_form?: 'pellet' | 'whole' | 'plug'; attenuation_pct?: number }
const ingredientPropertyColumns = ['yield_pct', 'color_lovibond', 'alpha_acid_pct', 'hop_form', 'attenuation_pct'] as const;
const equipmentAssumptionColumns = ['mash_efficiency_pct', 'grain_absorption_l_per_kg'] as const;

function measurementKindForEquipment(kind: string): string | null {
  const kinds: Record<string, string> = { hydrometer: 'gravity', refractometer: 'gravity', thermometer: 'temperature', ph_meter: 'ph',
    pressure_gauge: 'pressure', carbonation_meter: 'carbonation', dissolved_oxygen_meter: 'dissolved_oxygen',
    scale: 'mass' };
  return kinds[kind] || null;
}

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

export interface InventoryLocation { id: string; name: string; parent_id: string | null; slug: string; address: string | null }
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

// TEMP views can refer to the attached catalog without becoming replicated
// workspace schema. SQLite reevaluates inherited values after catalog sync.
const effectiveEquipmentView = `CREATE TEMP VIEW effective_equipment AS
  SELECT e.*, workspace_model.kind, workspace_model.catalog_model_id, workspace_model.name AS model_name,
    COALESCE(liquid.capacity_liters, workspace_model.capacity_liters, model_liquid.capacity_liters) AS capacity_liters,
    COALESCE(pressure.max_pressure_kpa, workspace_model.max_pressure_kpa, model_pressure.max_pressure_kpa) AS max_pressure_kpa,
    COALESCE(heat.rated_power_watts, workspace_model.rated_power_watts, model_heat.rated_power_watts) AS rated_power_watts,
    COALESCE(cool.rated_heat_removal_watts, workspace_model.rated_heat_removal_watts, model_cool.rated_heat_removal_watts) AS rated_heat_removal_watts,
    COALESCE(control.min_temperature_c, workspace_model.min_temperature_c, model_control.min_temperature_c) AS min_temperature_c,
    COALESCE(control.max_temperature_c, workspace_model.max_temperature_c, model_control.max_temperature_c) AS max_temperature_c,
    CASE WHEN liquid.equipment_id IS NOT NULL OR workspace_model.has_liquid_containment = 1 OR model_liquid.model_id IS NOT NULL THEN 1 ELSE NULL END AS has_liquid_containment,
    CASE WHEN pressure.equipment_id IS NOT NULL OR workspace_model.has_pressure_rating = 1 OR model_pressure.model_id IS NOT NULL THEN 1 ELSE NULL END AS has_pressure_rating,
    CASE WHEN heat.equipment_id IS NOT NULL OR workspace_model.has_heating = 1 OR model_heat.model_id IS NOT NULL THEN 1 ELSE NULL END AS has_heating,
    CASE WHEN cool.equipment_id IS NOT NULL OR workspace_model.has_cooling = 1 OR model_cool.model_id IS NOT NULL THEN 1 ELSE NULL END AS has_cooling,
    CASE WHEN control.equipment_id IS NOT NULL OR workspace_model.has_temperature_control = 1 OR model_control.model_id IS NOT NULL THEN 1 ELSE NULL END AS has_temperature_control,
    CASE WHEN control.equipment_id IS NOT NULL OR workspace_model.has_temperature_control = 1 OR model_control.model_id IS NOT NULL THEN 1 ELSE NULL END AS built_in_temperature_control,
    COALESCE(boil.heat_loss_watts, workspace_boil.heat_loss_watts, model_boil.heat_loss_watts) AS boil_heat_loss_watts,
    boil.heat_loss_watts AS unit_boil_heat_loss_watts,
    workspace_boil.heat_loss_watts AS workspace_model_boil_heat_loss_watts,
    model_boil.heat_loss_watts AS catalog_model_boil_heat_loss_watts,
    temp.offset_c AS temperature_offset_c,
    COALESCE(mash.mash_efficiency_pct, workspace_model.mash_efficiency_pct) AS mash_efficiency_pct,
    COALESCE(mash.grain_absorption_l_per_kg, workspace_model.grain_absorption_l_per_kg) AS grain_absorption_l_per_kg,
    model.model_name AS catalog_model_name, model.manufacturer AS catalog_manufacturer,
    COALESCE(workspace_model.capacity_liters, model_liquid.capacity_liters) AS model_capacity_liters,
    COALESCE(workspace_model.max_pressure_kpa, model_pressure.max_pressure_kpa) AS model_max_pressure_kpa,
    COALESCE(workspace_model.rated_power_watts, model_heat.rated_power_watts) AS model_rated_power_watts,
    COALESCE(workspace_model.rated_heat_removal_watts, model_cool.rated_heat_removal_watts) AS model_rated_heat_removal_watts,
    model_liquid.model_id AS model_liquid_id, model_pressure.model_id AS model_pressure_id,
    model_heat.model_id AS model_heat_id, model_cool.model_id AS model_cool_id,
    model_control.model_id AS model_control_id,
    COALESCE(workspace_model.min_temperature_c, model_control.min_temperature_c) AS model_min_temperature_c,
    COALESCE(workspace_model.max_temperature_c, model_control.max_temperature_c) AS model_max_temperature_c
  FROM main.equipment e
  JOIN main.equipment_models workspace_model ON workspace_model.id = e.model_id
  LEFT JOIN main.equipment_liquid_containment liquid ON liquid.equipment_id = e.id
  LEFT JOIN main.equipment_pressure_rating pressure ON pressure.equipment_id = e.id
  LEFT JOIN main.equipment_heating heat ON heat.equipment_id = e.id
  LEFT JOIN main.equipment_cooling cool ON cool.equipment_id = e.id
  LEFT JOIN main.equipment_temperature_control control ON control.equipment_id = e.id
  LEFT JOIN main.equipment_boil_calibration boil ON boil.equipment_id = e.id
  LEFT JOIN main.equipment_model_boil_characterization workspace_boil ON workspace_boil.model_id = workspace_model.id
  LEFT JOIN main.equipment_temperature_calibration temp ON temp.equipment_id = e.id
  LEFT JOIN main.equipment_mash_assumptions mash ON mash.equipment_id = e.id
  LEFT JOIN catalog.equipment_models model ON model.id = workspace_model.catalog_model_id
  LEFT JOIN catalog.model_liquid_containment model_liquid ON model_liquid.model_id = model.id
  LEFT JOIN catalog.model_pressure_rating model_pressure ON model_pressure.model_id = model.id
  LEFT JOIN catalog.model_heating model_heat ON model_heat.model_id = model.id
  LEFT JOIN catalog.model_boil_characterization model_boil ON model_boil.model_id = model.id
  LEFT JOIN catalog.model_cooling model_cool ON model_cool.model_id = model.id
  LEFT JOIN catalog.model_temperature_control model_control ON model_control.model_id = model.id`;

const effectiveMeasurementChannelsView = `CREATE TEMP VIEW effective_measurement_channels AS
  WITH channel_kinds AS (
    SELECT e.id AS equipment_id, c.measurement_kind FROM main.equipment e
      JOIN main.equipment_measurement_channels c ON c.equipment_id = e.id
    UNION SELECT e.id, c.measurement_kind FROM main.equipment e
      JOIN main.equipment_model_measurement_channels c ON c.model_id = e.model_id
    UNION SELECT e.id, c.measurement_kind FROM main.equipment e
      JOIN main.equipment_models m ON m.id = e.model_id
      JOIN catalog.model_measurement_channels c ON c.model_id = m.catalog_model_id
  )
  SELECT k.equipment_id, COALESCE(unit.id, workspace_model.id, catalog_model.id) AS id,
    k.measurement_kind,
    COALESCE(unit.measurement_min, workspace_model.measurement_min, catalog_model.measurement_min) AS measurement_min,
    COALESCE(unit.measurement_max, workspace_model.measurement_max, catalog_model.measurement_max) AS measurement_max,
    COALESCE(unit.measurement_unit, workspace_model.measurement_unit, catalog_model.measurement_unit) AS measurement_unit,
    COALESCE(unit.measurement_scale, workspace_model.measurement_scale, catalog_model.measurement_scale) AS measurement_scale
  FROM channel_kinds k JOIN main.equipment e ON e.id = k.equipment_id
  JOIN main.equipment_models m ON m.id = e.model_id
  LEFT JOIN main.equipment_measurement_channels unit
    ON unit.equipment_id = e.id AND unit.measurement_kind = k.measurement_kind
  LEFT JOIN main.equipment_model_measurement_channels workspace_model
    ON workspace_model.model_id = m.id AND workspace_model.measurement_kind = k.measurement_kind
  LEFT JOIN catalog.model_measurement_channels catalog_model
    ON catalog_model.model_id = m.catalog_model_id AND catalog_model.measurement_kind = k.measurement_kind`;

export async function openLocalDb(workspaceId: string): Promise<DB> {
  let pending = opened.get(workspaceId);
  if (!pending) {
    pending = (async () => {
      const sqlite = await (sqlitePromise ||= initWasm(() => wasmUrl));
      const db = await sqlite.open(`brewlog-${workspaceId}`);
      const storedVersion = (await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version;
      const legacyMeta = await db.execO<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'");
      const legacyVersion = legacyMeta.length
        ? (await db.execO<{ version: number }>('SELECT version FROM schema_meta LIMIT 1'))[0]?.version : undefined;
      const version = storedVersion || legacyVersion || 0;
      const existingTables = new Set((await db.execO<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'")).map(row => row.name));
      const hasWorkspaceTables = [...existingTables].some(name => replicatedTables.includes(name));
      const legacyLossValues: number[] = [];
      const legacyBatchLosses: { batch_id: string; wort_loss_liters: number }[] = [];
      if (version < 23 && hasWorkspaceTables) {
        for (const table of ['equipment_models', 'equipment_mash_assumptions', 'equipment']) {
          if (!existingTables.has(table) || !(await db.execO<{ name: string }>(`PRAGMA table_info("${table}")`))
            .some(column => column.name === 'kettle_retention_liters')) continue;
          legacyLossValues.push(...(await db.execO<{ value: number }>(
            `SELECT DISTINCT kettle_retention_liters AS value FROM "${table}"
              WHERE kettle_retention_liters IS NOT NULL`)).map(row => row.value));
        }
        if (existingTables.has('batch_event_inputs') && existingTables.has('batch_events')
          && (await db.execO<{ name: string }>('PRAGMA table_info(batch_event_inputs)'))
            .some(column => column.name === 'kettle_retention_liters')) {
          legacyBatchLosses.push(...await db.execO<{ batch_id: string; wort_loss_liters: number }>(
            `SELECT e.batch_id, MIN(i.kettle_retention_liters) AS wort_loss_liters
              FROM batch_event_inputs i JOIN batch_events e ON e.id = i.id
              WHERE i.kettle_retention_liters IS NOT NULL GROUP BY e.batch_id
              HAVING MIN(i.kettle_retention_liters) = MAX(i.kettle_retention_liters)`));
        }
      }
      if (version === 0 && !hasWorkspaceTables) {
        await db.tx(async tx => {
          for (const statement of schemaStatements) await tx.exec(statement);
          for (const table of replicatedTables) await tx.exec('SELECT crsql_as_crr(?)', [table]);
          for (const statement of indexStatements) await tx.exec(statement);
          await tx.exec('CREATE TABLE sync_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
          if (legacyMeta.length) await tx.exec('DROP TABLE schema_meta');
          await tx.exec(`PRAGMA user_version = ${workspaceSchemaVersion}`);
        });
      } else if (version > workspaceSchemaVersion) {
        throw new Error(`This app cannot open workspace schema ${version}; update Brewlog first.`);
      } else {
        await db.tx(async tx => {
          const existing = new Set((await tx.execO<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table'")).map(row => row.name));
          let changed = version < workspaceSchemaVersion;
          for (const [index, table] of replicatedTables.entries()) {
            const expected = workspaceTableColumns[table];
            if (existing.has(table)) {
              const actual = (await tx.execO<{ name: string }>(`PRAGMA table_info("${table}")`)).map(row => row.name);
              if (actual.join(',') === expected.join(',')) {
                if (!existing.has(`${table}__crsql_clock`)) {
                  await tx.exec('SELECT crsql_as_crr(?)', [table]);
                  changed = true;
                }
                continue;
              }
              const common = expected.filter(column => actual.includes(column));
              const snapshot = `migration_${table}`;
              if (table === 'equipment' && actual.some(column => !expected.includes(column))
                && !existing.has('equipment_legacy_migration')) {
                await tx.exec('CREATE TABLE equipment_legacy_migration AS SELECT * FROM equipment');
              }
              if (common.length) await tx.exec(`CREATE TEMP TABLE "${snapshot}" AS SELECT ${common.join(', ')} FROM "${table}"`);
              if (existing.has(`${table}__crsql_clock`)) await tx.exec('SELECT crsql_as_table(?)', [table]);
              await tx.exec(`DROP TABLE "${table}"`);
              await tx.exec(schemaStatements[index]);
              await tx.exec('SELECT crsql_as_crr(?)', [table]);
              if (common.length) {
                await tx.exec(`INSERT INTO "${table}" (${common.join(', ')}) SELECT ${common.join(', ')} FROM "${snapshot}"`);
                await tx.exec(`DROP TABLE "${snapshot}"`);
              }
            } else {
              await tx.exec(schemaStatements[index]);
              await tx.exec('SELECT crsql_as_crr(?)', [table]);
            }
            changed = true;
          }
          for (const table of retiredReplicatedTables) if (existing.has(table)) {
            if (existing.has(`${table}__crsql_clock`)) await tx.exec('SELECT crsql_as_table(?)', [table]);
            await tx.exec(`DROP TABLE "${table}"`);
            changed = true;
          }
          for (const statement of indexStatements) await tx.exec(statement);
          await tx.exec('CREATE TABLE IF NOT EXISTS sync_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
          if (changed) await tx.exec('DELETE FROM sync_state');
          if (legacyMeta.length) await tx.exec('DROP TABLE schema_meta');
          await tx.exec(`PRAGMA user_version = ${workspaceSchemaVersion}`);
        });
      }
      const legacyEquipment = await db.execO<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'equipment_legacy_migration'");
      if (legacyEquipment.length) await db.tx(async tx => {
        const columns = (await tx.execO<{ name: string }>('PRAGMA table_info(equipment_legacy_migration)'))
          .map(row => row.name);
        for (const statement of legacyEquipmentCopyStatements(columns)) await tx.exec(statement);
        for (const statement of legacyEquipmentModelStatements(columns)) await tx.exec(statement);
        await tx.exec('DROP TABLE equipment_legacy_migration');
      });
      await db.tx(async tx => { for (const statement of supplyMigrationStatements) await tx.exec(statement); });
      const uniqueLegacyLosses = [...new Set(legacyLossValues)];
      if (uniqueLegacyLosses.length === 1 || legacyBatchLosses.length) await db.tx(async tx => {
        if (uniqueLegacyLosses.length === 1) await tx.exec(`INSERT INTO brewery_process_defaults(id, wort_loss_liters)
          VALUES ('brewery', ?) ON CONFLICT(id) DO UPDATE SET
            wort_loss_liters = COALESCE(brewery_process_defaults.wort_loss_liters, excluded.wort_loss_liters)`,
        [uniqueLegacyLosses[0]]);
        for (const row of legacyBatchLosses) await tx.exec(`INSERT INTO batch_recipe_inputs(id, wort_loss_liters)
          VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET
            wort_loss_liters = COALESCE(batch_recipe_inputs.wort_loss_liters, excluded.wort_loss_liters)`,
        [row.batch_id, row.wort_loss_liters]);
      });
      await db.exec('UPDATE equipment SET added_at = COALESCE(added_at, created_at) WHERE added_at IS NULL');
      await db.exec(`UPDATE equipment SET removed_at =
        (SELECT archived_at FROM equipment_archives WHERE equipment_id = equipment.id ORDER BY archived_at LIMIT 1)
        WHERE removed_at IS NULL AND id IN (SELECT equipment_id FROM equipment_archives)`);
      await openLocalCatalog();
      await db.exec("ATTACH DATABASE 'brewlog-catalog' AS catalog");
      await db.exec(effectiveEquipmentView);
      await db.exec(effectiveMeasurementChannelsView);
      return db;
    })().catch(cause => { opened.delete(workspaceId); throw cause; });
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

export async function listCurrentEquipmentUses(db: DB): Promise<EquipmentUse[]> {
  return db.execO<EquipmentUse>(`SELECT e.id, u.equipment_id, e.batch_id, b.name AS batch_name, e.actual_at AS assigned_at
    FROM batch_events e JOIN equipment_use_events u ON u.event_id = e.id
    JOIN batches b ON b.id = e.batch_id LEFT JOIN event_ends x ON x.id = e.id
    WHERE e.actual_at IS NOT NULL AND e.skipped_at IS NULL AND x.id IS NULL
    ORDER BY e.actual_at DESC, e.id DESC`);
}

export async function assignEquipmentToBatch(db: DB, equipmentId: string, batchId: string, accountId: string): Promise<void> {
  await db.tx(async tx => {
    const equipment = await tx.execO<{ id: string; name: string }>(`SELECT id, name FROM equipment WHERE id = ?
      AND removed_at IS NULL`, [equipmentId]);
    const batch = await tx.execO<{ id: string }>('SELECT id FROM batches WHERE id = ?', [batchId]);
    if (!equipment.length || !batch.length) throw new Error('Choose available equipment and a batch');
    const existing = await tx.execO<{ id: string }>(`SELECT e.id FROM batch_events e
      JOIN equipment_use_events u ON u.event_id = e.id LEFT JOIN event_ends x ON x.id = e.id
      WHERE u.equipment_id = ? AND e.batch_id = ? AND e.actual_at IS NOT NULL AND x.id IS NULL LIMIT 1`, [equipmentId, batchId]);
    if (!existing.length) {
      const id = nanoid();
      const now = nowSeconds();
      await tx.exec(`INSERT INTO batch_events(id, batch_id, event_type, title, actual_at, created_at,
        created_by_account_id, recorded_by_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, batchId, 'equipment_use', `Use ${equipment[0].name}`, now, now, accountId, accountId]);
      await tx.exec('INSERT INTO equipment_use_events(event_id, equipment_id) VALUES (?, ?)', [id, equipmentId]);
    }
  });
}

export async function releaseEquipmentUse(db: DB, useId: string): Promise<void> {
  await db.exec(`INSERT INTO event_ends(id, ended_at) SELECT e.id, ? FROM batch_events e
    JOIN equipment_use_events u ON u.event_id = e.id LEFT JOIN event_ends x ON x.id = e.id
    WHERE e.id = ? AND e.actual_at IS NOT NULL AND x.id IS NULL`, [nowSeconds(), useId]);
}

export async function createBatch(db: DB, name: string, description: string, accountId: string): Promise<string> {
  const id = nanoid();
  const now = nowSeconds();
  await db.tx(async tx => {
    await tx.exec('INSERT INTO batches(id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name, description || null, 'active', now, now]);
    await tx.exec(`INSERT INTO batch_recipe_inputs(id, wort_loss_liters)
      VALUES (?, (SELECT wort_loss_liters FROM brewery_process_defaults WHERE id = 'brewery'))`, [id]);
  });
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

function validWortLoss(liters: number | null): void {
  if (liters != null && (!Number.isFinite(liters) || liters < 0)) throw new Error('Enter a valid wort loss');
}

export async function breweryWortLoss(db: DB): Promise<number | null> {
  const rows = await db.execO<{ wort_loss_liters: number | null }>(
    "SELECT wort_loss_liters FROM brewery_process_defaults WHERE id = 'brewery'");
  return rows[0]?.wort_loss_liters ?? null;
}

export async function updateBreweryWortLoss(db: DB, liters: number | null): Promise<void> {
  validWortLoss(liters);
  await db.exec(`INSERT INTO brewery_process_defaults(id, wort_loss_liters) VALUES ('brewery', ?)
    ON CONFLICT(id) DO UPDATE SET wort_loss_liters = excluded.wort_loss_liters`, [liters]);
}

export async function recipeWortLoss(db: DB, recipeId: string): Promise<number | null> {
  const rows = await db.execO<{ wort_loss_liters: number | null }>(
    'SELECT wort_loss_liters FROM recipe_inputs WHERE id = ?', [recipeId]);
  return rows[0]?.wort_loss_liters ?? null;
}

export async function updateRecipeWortLoss(db: DB, recipeId: string, liters: number | null): Promise<void> {
  validWortLoss(liters);
  await db.exec(`INSERT INTO recipe_inputs(id, wort_loss_liters) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET wort_loss_liters = excluded.wort_loss_liters`, [recipeId, liters]);
}

export async function batchWortLoss(db: DB, batchId: string): Promise<number | null> {
  const rows = await db.execO<{ wort_loss_liters: number | null }>(
    'SELECT wort_loss_liters FROM batch_recipe_inputs WHERE id = ?', [batchId]);
  return rows[0]?.wort_loss_liters ?? null;
}

export async function updateBatchWortLoss(db: DB, batchId: string, liters: number | null): Promise<void> {
  validWortLoss(liters);
  await db.exec(`INSERT INTO batch_recipe_inputs(id, wort_loss_liters) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET wort_loss_liters = excluded.wort_loss_liters`, [batchId, liters]);
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
    addition: ['recipe_additions', ['item_category', 'item_name', 'catalog_item_id', 'inventory_item_id', 'supply_id', 'quantity', 'unit', 'display_unit']],
    temperature_control: ['recipe_temperature_control_events', ['phase', 'mode', 'target_value', 'target_unit', 'equipment_id']],
    pressure_control: ['recipe_pressure_control_events', ['target_value', 'target_unit', 'equipment_id']],
    measurement: ['recipe_measurement_targets', ['measurement_kind', 'target_value', 'target_unit']],
    transfer: ['recipe_transfers', ['purpose', 'mash_equipment_id', 'to_vessel_id', 'to_vessel_name', 'quantity', 'unit']],
    packaging: ['recipe_packaging', ['container_name', 'container_size', 'container_count', 'container_unit']]
  },
  batch: {
    addition: ['additions', ['item_category', 'item_name', 'catalog_item_id', 'inventory_item_id', 'supply_id', 'quantity', 'unit', 'display_unit']],
    temperature_control: ['temperature_control_events', ['phase', 'mode', 'target_value', 'target_unit', 'equipment_id']],
    pressure_control: ['pressure_control_events', ['target_value', 'target_unit', 'equipment_id']],
    measurement: ['batch_measurement_targets', ['measurement_kind', 'target_value', 'target_unit']],
    transfer: ['transfers', ['purpose', 'mash_equipment_id', 'to_vessel_id', 'to_vessel_name', 'quantity', 'unit']],
    packaging: ['packaging', ['container_name', 'container_size', 'container_count', 'container_unit']],
    equipment_use: ['equipment_use_events', ['equipment_id']]
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
        const supplyId = nanoid();
        const lotId = nanoid();
        if (!choice.unit) throw new Error(`Choose a unit for ${ingredient.name}`);
        await tx.exec('INSERT INTO supplies(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)',
          [supplyId, ingredient.name, ingredient.category, storageUnit(choice.unit), now]);
        await tx.exec('INSERT INTO supply_lots(id, supply_id, created_at) VALUES (?, ?, ?)', [lotId, supplyId, now]);
        await tx.exec(`INSERT INTO inventory_items(id, name, category, default_unit, supply_id, lot_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, ingredient.name, ingredient.category, storageUnit(choice.unit), supplyId, lotId, now]);
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
        if (Object.keys(validProperties).length) {
          const table = ingredient.category === 'Hops' ? 'supply_hop_specs' : ingredient.category === 'Yeast'
            ? 'supply_yeast_specs' : 'supply_grain_specs';
          const columns = ingredient.category === 'Hops' ? ['alpha_acid_pct', 'hop_form']
            : ingredient.category === 'Yeast' ? ['attenuation_pct'] : ['yield_pct', 'color_lovibond'];
          if (['Grain', 'Adjunct', 'Hops', 'Yeast'].includes(ingredient.category)) await tx.exec(
            `INSERT INTO ${table}(supply_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`,
            [supplyId, ...columns.map(column => validProperties[column as keyof IngredientProperties] ?? null)]);
        }
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
        if (inventoryId) {
          const linked = await tx.execO<{ supply_id: string | null }>('SELECT supply_id FROM inventory_items WHERE id = ?', [inventoryId]);
          if (linked[0]?.supply_id) details.supply_id = linked[0].supply_id;
        }
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

async function resolveRecipeSupply(db: Pick<DB, 'exec' | 'execO'>, input: PlanInput): Promise<PlanInput> {
  if (input.event_type !== 'addition' || input.details.supply_id) return input;
  const catalogId = input.details.catalog_item_id;
  const known = catalogId ? await db.execO<{ name: string; category: string; unit: string }>(
    'SELECT name, category, unit FROM catalog.supplies WHERE id = ?', [catalogId]) : [];
  const name = known[0]?.name || input.details.item_name?.trim();
  const category = known[0]?.category || input.details.item_category;
  if (!name || !category) return input;
  const existing = catalogId && known.length ? await db.execO<{ id: string }>(
    'SELECT id FROM supplies WHERE catalog_supply_id = ?', [catalogId]) : await db.execO<{ id: string }>(
    'SELECT id FROM supplies WHERE category = ? AND lower(trim(name)) = lower(trim(?)) LIMIT 1', [category, name]);
  const supplyId = existing[0]?.id || nanoid();
  if (!existing.length) await db.exec(`INSERT INTO supplies(id, name, category, default_unit, catalog_supply_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [supplyId, name, category, known[0]?.unit || storageUnit(input.details.unit || 'each'),
      known.length ? catalogId || null : null, nowSeconds()]);
  return { ...input, details: { ...input.details, supply_id: supplyId, inventory_item_id: undefined } };
}

export async function addRecipePlan(db: DB, recipeId: string, input: PlanInput): Promise<string> {
  const id = nanoid();
  const order = await db.execO<{ next_order: number }>(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM recipe_events WHERE recipe_id = ?', [recipeId]);
  await db.tx(async tx => {
    input = await resolveRecipeSupply(tx, input);
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
    input = await resolveRecipeSupply(tx, input);
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
  description = recipe.description || '', unitIds: Record<string, string> = {}): Promise<string> {
  const plans = await listRecipePlans(db, recipe.id);
  const stock = await listInventory(db);
  const suppliesForRecipe = await listSupplies(db);
  const referencedModels = new Set(plans.flatMap(plan =>
    [plan.details.equipment_id, plan.details.mash_equipment_id, plan.details.to_vessel_id]
      .filter((id): id is string => typeof id === 'string' && !!id)));
  const units = await db.execO<{ id: string; model_id: string; name: string }>(
    'SELECT id, model_id, name FROM equipment WHERE removed_at IS NULL');
  const modelToUnit = new Map<string, string>();
  for (const modelId of referencedModels) {
    const matches = units.filter(unit => unit.model_id === modelId);
    const choice = unitIds[modelId] || (matches.length === 1 ? matches[0].id : null);
    if (!choice || !matches.some(unit => unit.id === choice)) {
      throw new Error(matches.length ? 'Choose a specific equipment unit for this recipe model'
        : 'Add a physical unit for each equipment model used by the recipe');
    }
    modelToUnit.set(modelId, choice);
  }
  const physicalDetails = (details: PlanDetails): PlanDetails => {
    const matchingStock = details.supply_id ? stock.filter(item => item.supply_id === details.supply_id) : [];
    return { ...details,
      inventory_item_id: matchingStock.length === 1 ? matchingStock[0].id : undefined,
      equipment_id: details.equipment_id ? modelToUnit.get(details.equipment_id) : undefined,
      mash_equipment_id: details.mash_equipment_id ? modelToUnit.get(details.mash_equipment_id) : undefined,
      to_vessel_id: details.to_vessel_id ? modelToUnit.get(details.to_vessel_id) : undefined };
  };
  const latestEfficiencies = new Map<string, number | null>();
  for (const plan of plans) {
    const details = physicalDetails(plan.details);
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
    await tx.exec(`INSERT INTO batch_recipe_inputs(id, target_fermenter_volume_liters, brewhouse_efficiency_pct, wort_loss_liters)
      SELECT ?, r.target_fermenter_volume_liters, r.brewhouse_efficiency_pct,
        COALESCE(r.wort_loss_liters, (SELECT wort_loss_liters FROM brewery_process_defaults WHERE id = 'brewery'))
      FROM recipe_inputs r WHERE r.id = ?`, [batchId, recipe.id]);
    await tx.exec(`INSERT OR IGNORE INTO batch_recipe_inputs(id, wort_loss_liters)
      VALUES (?, (SELECT wort_loss_liters FROM brewery_process_defaults WHERE id = 'brewery'))`, [batchId]);
    for (const plan of plans) {
      await tx.exec(`INSERT INTO batch_events(id, batch_id, recipe_event_id, event_type, title, planned_at,
        anchor_event_id, offset_seconds, anchor_point, duration_seconds, instructions, created_at, created_by_account_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ids.get(plan.id)!, batchId, plan.id, plan.event_type, plan.title, plan.planned_at ?? null,
          plan.anchor_event_id ? ids.get(plan.anchor_event_id) ?? null : null,
          plan.offset_seconds ?? null, plan.details.anchor_point ?? null, plan.details.duration_seconds ?? null,
          plan.details.note ?? null, now, accountId]);
      await writePlanPayload(tx, 'batch', ids.get(plan.id)!, plan.event_type, physicalDetails(plan.details));
      const eventInputs = await tx.execO<IngredientProperties>('SELECT * FROM recipe_event_inputs WHERE id = ?', [plan.id]);
      const snapshot: Record<string, string | number | null> = {};
      if (eventInputs.length) for (const column of ingredientPropertyColumns) snapshot[column] = eventInputs[0][column] ?? null;
      const details = physicalDetails(plan.details);
      const assumptionEquipmentId = details.purpose === 'drain_grain' ? details.mash_equipment_id : details.equipment_id;
      if (typeof assumptionEquipmentId === 'string') {
        const rows = await tx.execO<EquipmentSpecifications>(
          `SELECT COALESCE(a.mash_efficiency_pct, m.mash_efficiency_pct) AS mash_efficiency_pct,
            COALESCE(a.grain_absorption_l_per_kg, m.grain_absorption_l_per_kg) AS grain_absorption_l_per_kg
            FROM equipment e JOIN equipment_models m ON m.id = e.model_id
            LEFT JOIN equipment_mash_assumptions a ON a.equipment_id = e.id WHERE e.id = ?`, [assumptionEquipmentId]);
        if (rows.length) {
          const specs = rows[0];
          for (const column of equipmentAssumptionColumns) snapshot[column] = specs[column] ?? null;
          if (details.purpose === 'drain_grain' && specs.mash_efficiency_pct == null) {
            const recent = latestEfficiencies.get(assumptionEquipmentId);
            if (recent != null) snapshot.mash_efficiency_pct = recent;
          }
        }
      }
      if (typeof details.supply_id === 'string') {
        // Snapshot the effective lot when one stock row is known; otherwise use
        // the brewery supply defaults until a particular lot is recorded.
        const source = stock.find(item => item.id === details.inventory_item_id)
          || suppliesForRecipe.find(item => item.id === details.supply_id);
        if (source) for (const [column, value] of Object.entries(ingredientProperties(source))) snapshot[column] = value;
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
    if (!input.payload) return;
    const payload = input.eventType === 'addition' ? await resolvedAdditionPayload(tx, input.payload) : input.payload;
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
      await snapshotAdditionLot(tx, id, payload.inventory_item_id);
    }
    if (input.eventType === 'transfer') await updateTransferName(tx, id, payload.to_vessel_id);
  });
  return id;
}

const eventPayloadTables: Record<string, string> = {
  addition: 'additions', temperature_control: 'temperature_control_events', pressure_control: 'pressure_control_events',
  transfer: 'transfers', packaging: 'packaging'
};

async function resolvedAdditionPayload(db: Pick<DB, 'execO'>, payload: NonNullable<EventInput['payload']>): Promise<NonNullable<EventInput['payload']>> {
  const itemId = payload?.inventory_item_id;
  if (typeof itemId !== 'string') return payload;
  const rows = await db.execO<{ supply_id: string | null }>('SELECT supply_id FROM inventory_items WHERE id = ?', [itemId]);
  if (!rows.length) throw new Error('Inventory stock not found');
  return { ...payload, supply_id: rows[0].supply_id };
}

async function snapshotAdditionLot(db: Pick<DB, 'exec' | 'execO'>, eventId: string, itemId: unknown): Promise<void> {
  if (typeof itemId !== 'string') return;
  const stock = (await listInventory(db)).find(item => item.id === itemId);
  if (!stock) return;
  const properties = ingredientProperties(stock);
  if (!Object.keys(properties).length) return;
  const columns = ingredientPropertyColumns;
  await db.exec(`INSERT INTO batch_event_inputs(id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
  [eventId, ...columns.map(column => properties[column] ?? null)]);
}

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
    const payload = input.eventType === 'addition' ? await resolvedAdditionPayload(tx, input.payload) : input.payload;
    const columns = Object.keys(payload);
    await tx.exec(`UPDATE ${table} SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE event_id = ?`,
      [...Object.values(payload), event.id]);
    if (input.eventType === 'addition' && typeof payload.item_name === 'string') {
      await tx.exec('UPDATE batch_events SET title = ? WHERE id = ?', [payload.item_name, event.id]);
      await snapshotAdditionLot(tx, event.id, payload.inventory_item_id);
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
  type EffectiveEquipmentRow = Equipment & {
    catalog_model_name: string | null; catalog_manufacturer: string | null;
    model_liquid_id: string | null; model_pressure_id: string | null;
    model_heat_id: string | null; model_cool_id: string | null; model_control_id: string | null;
    model_capacity_liters: number | null; model_max_pressure_kpa: number | null;
    model_rated_power_watts: number | null; model_rated_heat_removal_watts: number | null;
    model_min_temperature_c: number | null; model_max_temperature_c: number | null;
  };
  const [rows, channels, modelChannels, points] = await Promise.all([
    db.execO<EffectiveEquipmentRow>(`SELECT * FROM effective_equipment
      WHERE removed_at IS NULL
      ORDER BY name COLLATE NOCASE`),
    db.execO<MeasurementChannel & { equipment_id: string }>('SELECT * FROM effective_measurement_channels'),
    db.execO<MeasurementChannel & { equipment_id: string }>(`SELECT e.id AS equipment_id,
      channel.id, channel.measurement_kind, channel.measurement_min, channel.measurement_max,
      channel.measurement_unit, channel.measurement_scale
      FROM equipment e JOIN equipment_models workspace_model ON workspace_model.id = e.model_id
      JOIN catalog.model_measurement_channels channel
        ON channel.model_id = workspace_model.catalog_model_id`),
    db.execO<{ id: string; equipment_id: string; measurement_kind: string; reference_value: number; observed_value: number }>(
      'SELECT * FROM equipment_measurement_calibration_points')
  ]);
  const equipment: Equipment[] = rows.map(row => {
    const { catalog_model_name, catalog_manufacturer, model_capacity_liters, model_max_pressure_kpa,
      model_rated_power_watts, model_rated_heat_removal_watts, model_min_temperature_c,
      model_max_temperature_c, model_liquid_id, model_pressure_id, model_heat_id,
      model_cool_id, model_control_id, ...item } = row;
    if (item.catalog_model_id && catalog_model_name) item.catalog_model = {
      id: item.catalog_model_id, name: catalog_model_name, kind: item.kind,
      manufacturer: catalog_manufacturer, capacity_liters: model_capacity_liters,
      has_liquid_containment: !!model_liquid_id, has_pressure_rating: !!model_pressure_id,
      has_heating: !!model_heat_id, has_cooling: !!model_cool_id,
      has_temperature_control: !!model_control_id,
      max_pressure_kpa: model_max_pressure_kpa, rated_power_watts: model_rated_power_watts,
      rated_heat_removal_watts: model_rated_heat_removal_watts,
      min_temperature_c: model_min_temperature_c, max_temperature_c: model_max_temperature_c,
      boil_heat_loss_watts: item.catalog_model_boil_heat_loss_watts
    };
    return item;
  });
  const byId = new Map(equipment.map(item => [item.id, item]));
  for (const channel of modelChannels) {
    const model = byId.get(channel.equipment_id)?.catalog_model;
    if (!model) continue;
    (model.measurement_channels ||= []).push({ ...channel, model_id: model.id });
    if (channel.measurement_kind === measurementKindForEquipment(model.kind)) {
      model.measurement_min = channel.measurement_min;
      model.measurement_max = channel.measurement_max;
      model.measurement_unit = channel.measurement_scale || channel.measurement_unit;
    }
  }
  for (const channel of channels) {
    const item = byId.get(channel.equipment_id);
    if (!item) continue;
    (item.measurement_channels ||= []).push(channel);
    if (channel.measurement_kind === measurementKindForEquipment(item.kind)) {
      item.measurement_min = channel.measurement_min;
      item.measurement_max = channel.measurement_max;
      item.measurement_unit = channel.measurement_scale || channel.measurement_unit;
    }
  }
  for (const point of points) {
    const item = byId.get(point.equipment_id);
    if (!item) continue;
    if (item.kind === 'ph_meter') {
      if (point.reference_value === 4) item.buffer_4_observed = point.observed_value;
      else if (point.reference_value === 7) item.buffer_7_observed = point.observed_value;
    } else {
      const fields: Record<string, [keyof EquipmentSpecifications, keyof EquipmentSpecifications]> = {
        hydrometer: ['reference_sg', 'observed_sg'], refractometer: ['reference_brix', 'observed_brix'],
        scale: ['reference_g', 'observed_g'], pressure_gauge: ['reference_kpa', 'observed_kpa'],
        carbonation_meter: ['reference_volumes', 'observed_volumes'],
        dissolved_oxygen_meter: ['reference_mg_l', 'observed_mg_l']
      };
      const keys = fields[item.kind];
      if (keys) {
        (item as unknown as Record<string, unknown>)[keys[0]] = point.reference_value;
        (item as unknown as Record<string, unknown>)[keys[1]] = point.observed_value;
      }
    }
  }
  return equipment;
}

export async function listEquipmentModels(db: DB): Promise<Equipment[]> {
  return db.execO<Equipment>(`SELECT m.id, m.name, m.kind, m.catalog_model_id,
    COALESCE(m.has_liquid_containment, CASE WHEN cl.model_id IS NOT NULL THEN 1 END) AS has_liquid_containment,
    COALESCE(m.capacity_liters, cl.capacity_liters) AS capacity_liters,
    COALESCE(m.has_pressure_rating, CASE WHEN cp.model_id IS NOT NULL THEN 1 END) AS has_pressure_rating,
    COALESCE(m.max_pressure_kpa, cp.max_pressure_kpa) AS max_pressure_kpa,
    COALESCE(m.has_heating, CASE WHEN ch.model_id IS NOT NULL THEN 1 END) AS has_heating,
    COALESCE(m.rated_power_watts, ch.rated_power_watts) AS rated_power_watts,
    COALESCE(m.has_cooling, CASE WHEN cc.model_id IS NOT NULL THEN 1 END) AS has_cooling,
    COALESCE(m.rated_heat_removal_watts, cc.rated_heat_removal_watts) AS rated_heat_removal_watts,
    COALESCE(m.has_temperature_control, CASE WHEN ct.model_id IS NOT NULL THEN 1 END) AS has_temperature_control,
    COALESCE(m.min_temperature_c, ct.min_temperature_c) AS min_temperature_c,
    COALESCE(m.max_temperature_c, ct.max_temperature_c) AS max_temperature_c,
    m.mash_efficiency_pct, m.grain_absorption_l_per_kg,
    COALESCE(wb.heat_loss_watts, cb.heat_loss_watts) AS boil_heat_loss_watts,
    wb.heat_loss_watts AS workspace_model_boil_heat_loss_watts,
    cb.heat_loss_watts AS catalog_model_boil_heat_loss_watts
    FROM equipment_models m
    LEFT JOIN catalog.model_liquid_containment cl ON cl.model_id = m.catalog_model_id
    LEFT JOIN catalog.model_pressure_rating cp ON cp.model_id = m.catalog_model_id
    LEFT JOIN catalog.model_heating ch ON ch.model_id = m.catalog_model_id
    LEFT JOIN equipment_model_boil_characterization wb ON wb.model_id = m.id
    LEFT JOIN catalog.model_boil_characterization cb ON cb.model_id = m.catalog_model_id
    LEFT JOIN catalog.model_cooling cc ON cc.model_id = m.catalog_model_id
    LEFT JOIN catalog.model_temperature_control ct ON ct.model_id = m.catalog_model_id
    ORDER BY m.name COLLATE NOCASE`);
}

export async function createEquipmentUnit(db: DB, modelId: string, name: string, stockId?: string): Promise<string> {
  const models = await db.execO<{ id: string }>('SELECT id FROM equipment_models WHERE id = ?', [modelId]);
  if (!models.length) throw new Error('Choose an equipment model');
  if (!name.trim()) throw new Error('Enter an equipment name');
  if (stockId?.trim()) {
    const used = await db.execO<{ id: string }>('SELECT id FROM equipment WHERE stock_id = ? AND removed_at IS NULL', [stockId.trim()]);
    if (used.length) throw new Error('Stock ID is already in use');
  }
  const id = nanoid();
  const now = nowSeconds();
  await db.exec('INSERT INTO equipment(id, name, model_id, stock_id, added_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name.trim(), modelId, stockId?.trim() || null, now, now]);
  return id;
}

export async function updateBrewingLosses(db: DB, item: Equipment, values: Pick<EquipmentSpecifications,
  'mash_efficiency_pct' | 'grain_absorption_l_per_kg'>): Promise<void> {
  if (!['all_in_one', 'mash_tun', 'kettle', 'electric_kettle'].includes(item.kind)) throw new Error('Choose brewing equipment');
  for (const [key, value] of Object.entries(values)) {
    if (value != null && (!Number.isFinite(value) || value < 0 || key === 'mash_efficiency_pct' && value > 100)) {
      throw new Error(`Enter a valid ${key.replaceAll('_', ' ')}`);
    }
  }
  await db.tx(async tx => {
    await tx.exec(`INSERT INTO equipment_mash_assumptions(equipment_id, ${equipmentAssumptionColumns.join(', ')})
      VALUES (?, ${equipmentAssumptionColumns.map(() => '?').join(', ')})
      ON CONFLICT(equipment_id) DO UPDATE SET ${equipmentAssumptionColumns.map(column => `${column} = excluded.${column}`).join(', ')}`,
    [item.id, ...equipmentAssumptionColumns.map(column => values[column] ?? null)]);
    if (item.model_id) await tx.exec(`UPDATE equipment_models SET ${equipmentAssumptionColumns.map(column => `${column} = ?`).join(', ')}
      WHERE id = ?`, [...equipmentAssumptionColumns.map(column => values[column] ?? null), item.model_id]);
  });
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

export async function updateEquipmentIdentity(db: DB, item: Equipment, name: string, slug: string, stockId: string | undefined,
  equipment: Equipment[]): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120) throw new Error('Enter an equipment name');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) throw new Error('Enter a valid slug');
  if (equipment.some(row => row.id !== item.id && (equipmentSlug(row) === slug || row.id === slug))) {
    throw new Error('That slug is already used by another equipment item');
  }
  if (stockId?.trim() && equipment.some(row => row.id !== item.id && row.stock_id === stockId.trim())) {
    throw new Error('Stock ID is already in use');
  }
  await db.exec('UPDATE equipment SET name = ?, slug = ?, stock_id = ? WHERE id = ?',
    [trimmed, slug, stockId?.trim() || null, item.id]);
}

async function putEquipmentCapability(db: Pick<DB, 'exec'>, table: string, id: string,
  values: Record<string, string | number | null | undefined>): Promise<void> {
  const columns = Object.keys(values);
  await db.exec(`INSERT INTO ${table}(equipment_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
    ON CONFLICT(equipment_id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
  [id, ...columns.map(column => values[column] ?? null)]);
}

export async function createEquipment(db: DB, name: string, kind: string, catalogModel?: CatalogEquipment,
  overrides: EquipmentSpecifications = {},
  channelRanges: Record<string, { min: number; max: number; unit: string }> = {}, stockId?: string): Promise<string> {
  if (!equipmentKinds.some(item => item.value === kind)) throw new Error('Choose a valid equipment kind');
  if (catalogModel && catalogModel.kind !== kind) throw new Error('Catalog kind does not match equipment kind');
  const id = nanoid();
  if (!name.trim()) throw new Error('Enter an equipment name');
  if (stockId?.trim() && (await db.execO<{ id: string }>(
    'SELECT id FROM equipment WHERE stock_id = ? AND removed_at IS NULL', [stockId.trim()])).length) {
    throw new Error('Stock ID is already in use');
  }
  const changed = (column: keyof EquipmentSpecifications) => overrides[column] != null
    && (!catalogModel || overrides[column] !== catalogModel[column as keyof CatalogEquipment]);
  await db.tx(async tx => {
    const modelId = catalogModel?.id || nanoid();
    const now = nowSeconds();
    await tx.exec(`INSERT OR IGNORE INTO equipment_models(id, name, kind, catalog_model_id,
      has_liquid_containment, capacity_liters, has_pressure_rating, max_pressure_kpa,
      has_heating, rated_power_watts, has_cooling, rated_heat_removal_watts,
      has_temperature_control, min_temperature_c, max_temperature_c, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [modelId, catalogModel?.name || name.trim(), kind, catalogModel?.id || null,
      catalogModel ? null : Number(capacityKinds.has(kind)), catalogModel ? null : overrides.capacity_liters ?? null,
      catalogModel ? null : Number(kind === 'fermenter' || overrides.max_pressure_kpa != null),
      catalogModel ? null : overrides.max_pressure_kpa ?? null,
      catalogModel ? null : Number(boilOffKinds.has(kind) || !!overrides.has_heating),
      catalogModel ? null : overrides.rated_power_watts ?? null,
      catalogModel ? null : Number(!!overrides.has_cooling),
      catalogModel ? null : overrides.rated_heat_removal_watts ?? null,
      catalogModel ? null : Number(boilOffKinds.has(kind) || kind === 'fermentation_temperature_control'
        || !!overrides.has_temperature_control || !!overrides.built_in_temperature_control),
      catalogModel ? null : overrides.min_temperature_c ?? null,
      catalogModel ? null : overrides.max_temperature_c ?? null, now]);
    await tx.exec(`INSERT INTO equipment(id, name, model_id, stock_id, added_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [id, name.trim(), modelId, stockId?.trim() || null, now, now]);
    if ((!catalogModel && capacityKinds.has(kind)) || changed('capacity_liters')) {
      await putEquipmentCapability(tx, 'equipment_liquid_containment', id,
        { capacity_liters: changed('capacity_liters') ? overrides.capacity_liters : null });
    }
    if (changed('max_pressure_kpa') || !catalogModel && kind === 'fermenter') {
      await putEquipmentCapability(tx, 'equipment_pressure_rating', id,
        { max_pressure_kpa: overrides.max_pressure_kpa });
    }
    if ((!catalogModel && boilOffKinds.has(kind)) || overrides.has_heating && !catalogModel?.has_heating
      || changed('rated_power_watts')) {
      await putEquipmentCapability(tx, 'equipment_heating', id,
        { rated_power_watts: changed('rated_power_watts') ? overrides.rated_power_watts : null });
    }
    if (overrides.has_cooling && !catalogModel?.has_cooling || changed('rated_heat_removal_watts')) {
      await putEquipmentCapability(tx, 'equipment_cooling', id,
        { rated_heat_removal_watts: changed('rated_heat_removal_watts') ? overrides.rated_heat_removal_watts : null });
    }
    if ((overrides.built_in_temperature_control || overrides.has_temperature_control)
      && !catalogModel?.has_temperature_control
      || changed('min_temperature_c') || changed('max_temperature_c')
      || !catalogModel && (boilOffKinds.has(kind) || kind === 'fermentation_temperature_control')) {
      await putEquipmentCapability(tx, 'equipment_temperature_control', id,
        { min_temperature_c: changed('min_temperature_c') ? overrides.min_temperature_c : null,
          max_temperature_c: changed('max_temperature_c') ? overrides.max_temperature_c : null });
    }
    const measurementKind = measurementKindForEquipment(kind);
    if (measurementKind && (!catalogModel || changed('measurement_min') || changed('measurement_max')
      || changed('measurement_unit'))) {
      const display = changed('measurement_unit') ? overrides.measurement_unit : null;
      const scale = ['SG', '°Plato', '°Brix', 'pH'].includes(display || '') ? display : null;
      await tx.exec(`INSERT INTO equipment_measurement_channels
        (id, equipment_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [`${id}:${measurementKind}`, id, measurementKind,
        changed('measurement_min') ? overrides.measurement_min : null,
        changed('measurement_max') ? overrides.measurement_max : null,
        scale ? null : display, scale]);
    }
    for (const [channelKind, range] of Object.entries(channelRanges)) {
      const modelChannel = catalogModel?.measurement_channels?.find(channel => channel.measurement_kind === channelKind);
      if (!modelChannel) throw new Error('Unknown equipment measurement channel');
      const scale = ['SG', '°Plato', '°Brix', 'pH'].includes(range.unit) ? range.unit : null;
      await tx.exec(`INSERT INTO equipment_measurement_channels
        (id, equipment_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [`${id}:${channelKind}`, id, channelKind,
        range.min === modelChannel.measurement_min ? null : range.min,
        range.max === modelChannel.measurement_max ? null : range.max,
        range.unit === (modelChannel.measurement_scale || modelChannel.measurement_unit) ? null : scale ? null : range.unit,
        range.unit === (modelChannel.measurement_scale || modelChannel.measurement_unit) ? null : scale]);
    }
    if (!catalogModel) await tx.exec(`INSERT INTO equipment_model_measurement_channels
      (id, model_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
      SELECT ? || ':' || measurement_kind, ?, measurement_kind, measurement_min, measurement_max,
        measurement_unit, measurement_scale FROM equipment_measurement_channels WHERE equipment_id = ?`,
    [modelId, modelId, id]);
  });
  return id;
}

export async function updateEquipmentCapacity(db: DB, item: Equipment, capacityLiters: number | null): Promise<void> {
  await putEquipmentCapability(db, 'equipment_liquid_containment', item.id,
    { capacity_liters: capacityLiters === item.catalog_model?.capacity_liters ? null : capacityLiters });
}

export async function updateEquipmentPressureRating(db: DB, item: Equipment, maxPressureKpa: number | null): Promise<void> {
  if (maxPressureKpa != null && (!Number.isFinite(maxPressureKpa) || maxPressureKpa <= 0)) {
    throw new Error('Enter a positive pressure rating');
  }
  await putEquipmentCapability(db, 'equipment_pressure_rating', item.id,
    { max_pressure_kpa: maxPressureKpa === item.catalog_model?.max_pressure_kpa ? null : maxPressureKpa });
}

export async function addEquipmentCapability(db: DB, item: Equipment, capability: string, values: {
  capacity_liters?: number | null; max_pressure_kpa?: number | null;
  rated_power_watts?: number | null; rated_heat_removal_watts?: number | null;
  min_temperature_c?: number | null; max_temperature_c?: number | null;
  measurement_min?: number | null; measurement_max?: number | null; measurement_unit?: string | null;
} = {}): Promise<void> {
  const positive = (value: number | null | undefined) => value == null || Number.isFinite(value) && value > 0;
  if (capability === 'liquid_containment') {
    if (item.has_liquid_containment) throw new Error('Liquid capacity is already available');
    if (!positive(values.capacity_liters)) throw new Error('Enter a positive capacity');
    await putEquipmentCapability(db, 'equipment_liquid_containment', item.id,
      { capacity_liters: values.capacity_liters });
  } else if (capability === 'pressure_rating') {
    if (item.has_pressure_rating) throw new Error('Pressure rating is already available');
    if (!positive(values.max_pressure_kpa)) throw new Error('Enter a positive pressure rating');
    await putEquipmentCapability(db, 'equipment_pressure_rating', item.id,
      { max_pressure_kpa: values.max_pressure_kpa });
  } else if (capability === 'heating') {
    if (item.has_heating) throw new Error('Heating is already available');
    if (!positive(values.rated_power_watts)) throw new Error('Enter a positive power');
    await putEquipmentCapability(db, 'equipment_heating', item.id,
      { rated_power_watts: values.rated_power_watts });
  } else if (capability === 'cooling') {
    if (item.has_cooling) throw new Error('Cooling is already available');
    if (!positive(values.rated_heat_removal_watts)) throw new Error('Enter a positive heat removal rate');
    await putEquipmentCapability(db, 'equipment_cooling', item.id,
      { rated_heat_removal_watts: values.rated_heat_removal_watts });
  } else if (capability === 'temperature_control') {
    if (item.has_temperature_control) throw new Error('Temperature control is already available');
    if (values.min_temperature_c != null && !Number.isFinite(values.min_temperature_c)
      || values.max_temperature_c != null && !Number.isFinite(values.max_temperature_c)
      || values.min_temperature_c != null && values.max_temperature_c != null
        && values.min_temperature_c >= values.max_temperature_c) throw new Error('Enter a valid temperature range');
    await putEquipmentCapability(db, 'equipment_temperature_control', item.id,
      { min_temperature_c: values.min_temperature_c, max_temperature_c: values.max_temperature_c });
  } else if (capability.startsWith('measurement:')) {
    const kind = capability.slice('measurement:'.length);
    if (!['temperature', 'ph', 'gravity', 'volume', 'pressure', 'carbonation', 'dissolved_oxygen', 'mass']
      .includes(kind)) throw new Error('Unknown measurement channel');
    if (item.measurement_channels?.some(channel => channel.measurement_kind === kind)) {
      throw new Error('Measurement channel is already available');
    }
    if (!values.measurement_unit) throw new Error('Choose a measurement unit');
    if (values.measurement_min != null || values.measurement_max != null) {
      if (values.measurement_min == null || values.measurement_max == null
        || !Number.isFinite(values.measurement_min) || !Number.isFinite(values.measurement_max)
        || values.measurement_min >= values.measurement_max) throw new Error('Enter a valid measurement range');
    }
    const scale = ['SG', '°Plato', '°Brix', 'pH'].includes(values.measurement_unit) ? values.measurement_unit : null;
    await db.exec(`INSERT INTO equipment_measurement_channels
      (id, equipment_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [`${item.id}:${kind}`, item.id, kind,
      values.measurement_min ?? null, values.measurement_max ?? null,
      scale ? null : values.measurement_unit, scale]);
  } else {
    throw new Error('Unknown equipment capability');
  }
}

export async function updateEquipmentBoilHeatLoss(db: DB, item: Equipment, watts: number): Promise<void> {
  if (!boilOffKinds.has(item.kind)) throw new Error('Boil calibration applies to electric kettles and all-in-one systems');
  if (!Number.isFinite(watts) || watts < 0) throw new Error('Enter a valid heat loss');
  await putEquipmentCapability(db, 'equipment_boil_calibration', item.id, { heat_loss_watts: watts });
}

export async function clearEquipmentBoilHeatLoss(db: DB, item: Equipment): Promise<void> {
  if (!boilOffKinds.has(item.kind)) throw new Error('Boil calibration applies to electric kettles and all-in-one systems');
  await db.exec('DELETE FROM equipment_boil_calibration WHERE equipment_id = ?', [item.id]);
}

export async function updateEquipmentModelBoilHeatLoss(db: DB, item: Equipment, watts: number): Promise<void> {
  if (!boilOffKinds.has(item.kind) || !item.model_id) throw new Error('Choose a boiling equipment model');
  if (!Number.isFinite(watts) || watts < 0) throw new Error('Enter a valid heat loss');
  await db.exec(`INSERT INTO equipment_model_boil_characterization(model_id, heat_loss_watts) VALUES (?, ?)
    ON CONFLICT(model_id) DO UPDATE SET heat_loss_watts = excluded.heat_loss_watts`, [item.model_id, watts]);
}

export async function clearEquipmentModelBoilHeatLoss(db: DB, item: Equipment): Promise<void> {
  if (!boilOffKinds.has(item.kind) || !item.model_id) throw new Error('Choose a boiling equipment model');
  await db.exec('DELETE FROM equipment_model_boil_characterization WHERE model_id = ?', [item.model_id]);
}

export async function updateEquipmentTemperatureOffset(db: DB, item: Equipment, offsetC: number): Promise<void> {
  if (!temperatureCalibrationKinds.has(item.kind) && !item.measurement_channels?.some(channel => channel.measurement_kind === 'temperature')
    && !item.has_temperature_control) {
    throw new Error('This equipment has no temperature reading to calibrate');
  }
  if (!Number.isFinite(offsetC)) throw new Error('Enter valid temperatures');
  await putEquipmentCapability(db, 'equipment_temperature_calibration', item.id, { offset_c: offsetC });
}

export async function updateEquipmentCalibration(db: DB, item: Equipment, values: Record<string, number>): Promise<void> {
  if (!Object.keys(values).length || Object.values(values).some(value => !Number.isFinite(value))) {
    throw new Error('Enter valid calibration values');
  }
  const keys = Object.keys(values);
  if (keys.some(key => !(equipmentCalibrationColumns as readonly string[]).includes(key))) throw new Error('Unknown calibration field');
  const profiles: Record<string, { measurement: string; reference?: string; observed: string; fixed?: number }[]> = {
    ph_meter: [{ measurement: 'ph', observed: 'buffer_4_observed', fixed: 4 },
      { measurement: 'ph', observed: 'buffer_7_observed', fixed: 7 }],
    hydrometer: [{ measurement: 'gravity', reference: 'reference_sg', observed: 'observed_sg' }],
    refractometer: [{ measurement: 'gravity', reference: 'reference_brix', observed: 'observed_brix' }],
    scale: [{ measurement: 'mass', reference: 'reference_g', observed: 'observed_g' }],
    pressure_gauge: [{ measurement: 'pressure', reference: 'reference_kpa', observed: 'observed_kpa' }],
    carbonation_meter: [{ measurement: 'carbonation', reference: 'reference_volumes', observed: 'observed_volumes' }],
    dissolved_oxygen_meter: [{ measurement: 'dissolved_oxygen', reference: 'reference_mg_l', observed: 'observed_mg_l' }]
  };
  const points = profiles[item.kind] || [];
  if (!points.length || keys.some(key => !points.some(point => key === point.reference || key === point.observed))) {
    throw new Error('These calibration values do not apply to this equipment');
  }
  await db.tx(async tx => {
    for (const point of points) {
      const reference = point.fixed ?? (point.reference ? values[point.reference] : undefined);
      const observed = values[point.observed];
      if (reference == null || observed == null) throw new Error('Enter all calibration values');
      await tx.exec(`INSERT INTO equipment_measurement_calibration_points
        (id, equipment_id, measurement_kind, reference_value, observed_value) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET reference_value = excluded.reference_value,
          observed_value = excluded.observed_value`,
      [`${item.id}:${point.measurement}:${point.fixed ?? 'reference'}`, item.id, point.measurement, reference, observed]);
    }
  });
}

export async function updateEquipmentRatedPower(db: DB, item: Equipment, watts: number | null): Promise<void> {
  if (!item.has_heating) throw new Error('This equipment has no heating capability');
  if (watts != null && (!Number.isFinite(watts) || watts <= 0)) throw new Error('Enter a positive power');
  await putEquipmentCapability(db, 'equipment_heating', item.id,
    { rated_power_watts: watts === item.catalog_model?.rated_power_watts ? null : watts });
}

export async function updateEquipmentThermalCapabilities(db: DB, item: Equipment, values: {
  has_heating: boolean; rated_power_watts: number | null;
  has_cooling: boolean; rated_heat_removal_watts: number | null;
  has_temperature_control: boolean; min_temperature_c: number | null; max_temperature_c: number | null;
}): Promise<void> {
  const positive = (value: number | null, label: string) => {
    if (value != null && (!Number.isFinite(value) || value <= 0)) throw new Error(`Enter a positive ${label}`);
  };
  positive(values.rated_power_watts, 'heating power');
  positive(values.rated_heat_removal_watts, 'heat removal rate');
  if (values.min_temperature_c != null && !Number.isFinite(values.min_temperature_c)
    || values.max_temperature_c != null && !Number.isFinite(values.max_temperature_c)
    || values.min_temperature_c != null && values.max_temperature_c != null
      && values.min_temperature_c >= values.max_temperature_c) throw new Error('Enter a valid temperature range');
  await db.tx(async tx => {
    if (values.has_heating) await putEquipmentCapability(tx, 'equipment_heating', item.id,
      { rated_power_watts: values.rated_power_watts === item.catalog_model?.rated_power_watts
        ? null : values.rated_power_watts });
    if (values.has_cooling) await putEquipmentCapability(tx, 'equipment_cooling', item.id,
      { rated_heat_removal_watts: values.rated_heat_removal_watts === item.catalog_model?.rated_heat_removal_watts
        ? null : values.rated_heat_removal_watts });
    if (values.has_temperature_control) await putEquipmentCapability(tx, 'equipment_temperature_control', item.id,
      { min_temperature_c: values.min_temperature_c === item.catalog_model?.min_temperature_c
        ? null : values.min_temperature_c,
        max_temperature_c: values.max_temperature_c === item.catalog_model?.max_temperature_c
          ? null : values.max_temperature_c });
  });
}

export async function updateEquipmentMeasurementRange(db: DB, item: Equipment,
  range: { min: number; max: number; unit: string } | null, channelKind?: string): Promise<void> {
  const kind = channelKind || measurementKindForEquipment(item.kind);
  if (!kind || !item.measurement_channels?.some(channel => channel.measurement_kind === kind)) {
    throw new Error('This equipment has no matching measurement channel');
  }
  const scale = ['SG', '°Plato', '°Brix', 'pH'].includes(range?.unit || '') ? range?.unit ?? null : null;
  const model = item.catalog_model?.measurement_channels?.find(channel => channel.measurement_kind === kind);
  const modelUnit = model?.measurement_scale || model?.measurement_unit;
  await db.exec(`INSERT INTO equipment_measurement_channels
    (id, equipment_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET measurement_min = excluded.measurement_min,
      measurement_max = excluded.measurement_max, measurement_unit = excluded.measurement_unit,
      measurement_scale = excluded.measurement_scale`,
  [`${item.id}:${kind}`, item.id, kind,
    range?.min === model?.measurement_min ? null : range?.min ?? null,
    range?.max === model?.measurement_max ? null : range?.max ?? null,
    range?.unit === modelUnit ? null : scale ? null : range?.unit ?? null,
    range?.unit === modelUnit ? null : scale]);
}

export async function deleteEquipment(db: DB, id: string): Promise<void> {
  await db.exec('UPDATE equipment SET removed_at = ? WHERE id = ? AND removed_at IS NULL', [nowSeconds(), id]);
}

export async function listInventory(db: Pick<DB, 'execO'>): Promise<InventoryItem[]> {
  return db.execO<InventoryItem>(`SELECT i.id, COALESCE(s.name, i.name) AS name,
    COALESCE(s.category, i.category) AS category, i.default_unit,
    i.supply_id, i.lot_id, lot.lot_code, s.catalog_supply_id,
    COALESCE(d.display_unit, i.default_unit) AS display_unit, l.location_id, places.name AS location_name,
    COALESCE(lg.yield_pct, sg.yield_pct, cg.yield_pct, p.yield_pct) AS yield_pct,
    COALESCE(lg.color_lovibond, sg.color_lovibond, cg.color_lovibond, p.color_lovibond) AS color_lovibond,
    COALESCE(lh.alpha_acid_pct, sh.alpha_acid_pct, ch.alpha_acid_pct, p.alpha_acid_pct) AS alpha_acid_pct,
    COALESCE(lh.hop_form, sh.hop_form, ch.hop_form, p.hop_form) AS hop_form,
    COALESCE(ly.attenuation_pct, sy.attenuation_pct, cy.attenuation_pct, p.attenuation_pct) AS attenuation_pct
    FROM inventory_items i
    LEFT JOIN supplies s ON s.id = i.supply_id
    LEFT JOIN supply_lots lot ON lot.id = i.lot_id
    LEFT JOIN supply_grain_specs sg ON sg.supply_id = s.id
    LEFT JOIN supply_hop_specs sh ON sh.supply_id = s.id
    LEFT JOIN supply_yeast_specs sy ON sy.supply_id = s.id
    LEFT JOIN lot_grain_specs lg ON lg.lot_id = lot.id
    LEFT JOIN lot_hop_specs lh ON lh.lot_id = lot.id
    LEFT JOIN lot_yeast_specs ly ON ly.lot_id = lot.id
    LEFT JOIN catalog.supply_grain_specs cg ON cg.supply_id = s.catalog_supply_id
    LEFT JOIN catalog.supply_hop_specs ch ON ch.supply_id = s.catalog_supply_id
    LEFT JOIN catalog.supply_yeast_specs cy ON cy.supply_id = s.catalog_supply_id
    LEFT JOIN inventory_ingredient_properties p ON p.id = i.id
    LEFT JOIN inventory_display_units d ON d.id = i.id
    LEFT JOIN inventory_item_locations l ON l.id = i.id
    LEFT JOIN inventory_locations places ON places.id = l.location_id ORDER BY i.name COLLATE NOCASE`);
}

export async function listSupplies(db: Pick<DB, 'execO'>): Promise<InventoryItem[]> {
  return db.execO<InventoryItem>(`SELECT s.id, s.id AS supply_id, s.name, s.category,
    s.default_unit, s.default_unit AS display_unit, NULL AS location_id, s.catalog_supply_id,
    COALESCE(g.yield_pct, cg.yield_pct) AS yield_pct,
    COALESCE(g.color_lovibond, cg.color_lovibond) AS color_lovibond,
    COALESCE(h.alpha_acid_pct, ch.alpha_acid_pct) AS alpha_acid_pct,
    COALESCE(h.hop_form, ch.hop_form) AS hop_form,
    COALESCE(y.attenuation_pct, cy.attenuation_pct) AS attenuation_pct
    FROM supplies s
    LEFT JOIN supply_grain_specs g ON g.supply_id = s.id
    LEFT JOIN supply_hop_specs h ON h.supply_id = s.id
    LEFT JOIN supply_yeast_specs y ON y.supply_id = s.id
    LEFT JOIN catalog.supply_grain_specs cg ON cg.supply_id = s.catalog_supply_id
    LEFT JOIN catalog.supply_hop_specs ch ON ch.supply_id = s.catalog_supply_id
    LEFT JOIN catalog.supply_yeast_specs cy ON cy.supply_id = s.catalog_supply_id
    ORDER BY s.name COLLATE NOCASE`);
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
  const table = item.category === 'Hops' ? 'supply_hop_specs' : item.category === 'Yeast'
    ? 'supply_yeast_specs' : 'supply_grain_specs';
  if (!item.supply_id) throw new Error('Supply not found');
  const columns = allowed[item.category];
  await db.exec(`INSERT INTO ${table}(supply_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
    ON CONFLICT(supply_id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
  [item.supply_id, ...columns.map(column => values[column] ?? null)]);
}

export async function supplyIngredientProperties(db: DB, item: InventoryItem): Promise<IngredientProperties> {
  if (!item.supply_id) return {};
  const table = item.category === 'Hops' ? 'supply_hop_specs' : item.category === 'Yeast'
    ? 'supply_yeast_specs' : 'supply_grain_specs';
  return (await db.execO<IngredientProperties>(`SELECT * FROM ${table} WHERE supply_id = ?`, [item.supply_id]))[0] || {};
}

export async function updateLotIngredientProperties(db: DB, item: InventoryItem, properties: IngredientProperties): Promise<void> {
  if (!item.lot_id) throw new Error('Lot not found');
  const columns = item.category === 'Hops' ? ['alpha_acid_pct', 'hop_form']
    : item.category === 'Yeast' ? ['attenuation_pct']
      : ['yield_pct', 'color_lovibond'];
  const table = item.category === 'Hops' ? 'lot_hop_specs' : item.category === 'Yeast'
    ? 'lot_yeast_specs' : 'lot_grain_specs';
  await db.exec(`INSERT INTO ${table}(lot_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
    ON CONFLICT(lot_id) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`,
  [item.lot_id, ...columns.map(column => properties[column as keyof IngredientProperties] ?? null)]);
}

export async function lotIngredientProperties(db: DB, item: InventoryItem): Promise<IngredientProperties> {
  if (!item.lot_id) return {};
  const table = item.category === 'Hops' ? 'lot_hop_specs' : item.category === 'Yeast'
    ? 'lot_yeast_specs' : 'lot_grain_specs';
  return (await db.execO<IngredientProperties>(`SELECT * FROM ${table} WHERE lot_id = ?`, [item.lot_id]))[0] || {};
}

export async function listInventoryLocations(db: DB): Promise<InventoryLocation[]> {
  const rows = await db.execO<{ id: string; name: string; slug: string | null }>(`SELECT l.id, l.name, s.slug
    FROM inventory_locations l LEFT JOIN inventory_location_slugs s ON s.id = l.id ORDER BY l.id`);
  const used = new Set(rows.map(row => row.id));
  for (const row of rows) if (row.slug && !hasGeneratedLocationSuffix(row.name, row.id, row.slug)) used.add(row.slug);
  for (const row of rows) {
    if (row.slug && !hasGeneratedLocationSuffix(row.name, row.id, row.slug)) continue;
    const slug = locationSlug(row.name, used);
    used.add(slug);
    if (row.slug) await db.exec('UPDATE inventory_location_slugs SET slug = ? WHERE id = ?', [slug, row.id]);
    else await db.exec('INSERT OR IGNORE INTO inventory_location_slugs(id, slug) VALUES (?, ?)', [row.id, slug]);
  }
  return db.execO<InventoryLocation>(`SELECT l.id, l.name, l.parent_id, s.slug, a.address FROM inventory_locations l
    JOIN inventory_location_slugs s ON s.id = l.id
    LEFT JOIN inventory_location_addresses a ON a.id = l.id ORDER BY l.name COLLATE NOCASE, l.id`);
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

export async function saveInventoryLocation(db: DB, name: string, parentId: string | null, id?: string, slug?: string,
  address?: string): Promise<string> {
  const clean = name.trim();
  if (!clean) throw new Error('Enter a location name');
  const cleanAddress = address?.trim() || null;
  if (cleanAddress && cleanAddress.length > 500) throw new Error('Keep the address under 500 characters');
  const locations = await listInventoryLocations(db);
  const chosenSlug = slug?.trim() || (id ? locations.find(location => location.id === id)?.slug
    : locationSlug(clean, new Set(locations.flatMap(location => [location.id, location.slug]))));
  if (!chosenSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(chosenSlug) || chosenSlug.length > 80)
    throw new Error('Use lowercase letters, numbers, and hyphens for the slug');
  if (locations.some(location => location.id !== id && (location.slug === chosenSlug || location.id === chosenSlug)))
    throw new Error('That location slug is already in use');
  if (parentId && !locations.some(location => location.id === parentId)) throw new Error('Parent location not found');
  if (locations.some(location => location.id !== id && location.parent_id === parentId && location.name.toLowerCase() === clean.toLowerCase()))
    throw new Error('A location with this name already exists here');
  if (id) {
    let current = parentId;
    while (current) {
      if (current === id) throw new Error('A location cannot contain itself');
      current = locations.find(location => location.id === current)?.parent_id || null;
    }
    await db.tx(async tx => {
      await tx.exec('UPDATE inventory_locations SET name = ?, parent_id = ? WHERE id = ?', [clean, parentId, id]);
      await tx.exec('UPDATE inventory_location_slugs SET slug = ? WHERE id = ?', [chosenSlug, id]);
      if (cleanAddress) {
        if (locations.find(location => location.id === id)?.address)
          await tx.exec('UPDATE inventory_location_addresses SET address = ? WHERE id = ?', [cleanAddress, id]);
        else await tx.exec('INSERT INTO inventory_location_addresses(id, address) VALUES (?, ?)', [id, cleanAddress]);
      } else await tx.exec('DELETE FROM inventory_location_addresses WHERE id = ?', [id]);
    });
    return id;
  }
  const nextId = nanoid();
  await db.tx(async tx => {
    await tx.exec('INSERT INTO inventory_locations(id, name, parent_id, created_at) VALUES (?, ?, ?, ?)', [nextId, clean, parentId, nowSeconds()]);
    await tx.exec('INSERT INTO inventory_location_slugs(id, slug) VALUES (?, ?)', [nextId, chosenSlug]);
    if (cleanAddress) await tx.exec('INSERT INTO inventory_location_addresses(id, address) VALUES (?, ?)', [nextId, cleanAddress]);
  });
  return nextId;
}

export async function deleteInventoryLocation(db: DB, id: string): Promise<void> {
  const [children, stock] = await Promise.all([
    db.execO('SELECT id FROM inventory_locations WHERE parent_id = ? LIMIT 1', [id]),
    db.execO('SELECT id FROM inventory_item_locations WHERE location_id = ? LIMIT 1', [id])
  ]);
  if (children.length || stock.length) throw new Error('Move stock and child locations before deleting this location');
  await db.tx(async tx => {
    await tx.exec('DELETE FROM inventory_location_addresses WHERE id = ?', [id]);
    await tx.exec('DELETE FROM inventory_location_slugs WHERE id = ?', [id]);
    await tx.exec('DELETE FROM inventory_locations WHERE id = ?', [id]);
  });
}

function sameInventoryProduct(item: InventoryItem, name: string, category: string): boolean {
  return item.category === category && item.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase();
}

export function stockAtLocation(items: InventoryItem[], name: string, category: string, locationId: string | null,
  lotCode: string | null = null): InventoryItem | undefined {
  return items.find(item => sameInventoryProduct(item, name, category) && item.location_id === locationId
    && (item.lot_code || null) === lotCode);
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
  locationId: string | null = null, catalogSupplyId: string | null = null, lotCode: string | null = null): Promise<string> {
  const items = await listInventory(db);
  const cleanLot = lotCode?.trim() || null;
  if (stockAtLocation(items, name, category, locationId, cleanLot)) throw new Error('This lot already exists at that location');
  if (items.some(item => sameInventoryProduct(item, name, category)) && (!startingQuantity || startingQuantity <= 0))
    throw new Error('Enter a positive quantity to add this existing item');
  if (locationId && !(await listInventoryLocations(db)).some(location => location.id === locationId)) throw new Error('Location not found');
  const id = nanoid();
  const now = nowSeconds();
  await db.tx(async tx => {
    const existingSupply = await tx.execO<{ id: string }>(
      'SELECT id FROM supplies WHERE category = ? AND lower(trim(name)) = lower(trim(?)) LIMIT 1', [category, name]);
    const supplyId = existingSupply[0]?.id || nanoid();
    if (!existingSupply.length) await tx.exec(`INSERT INTO supplies(id, name, category, default_unit, catalog_supply_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [supplyId, name, category, defaultUnit, catalogSupplyId, now]);
    else if (catalogSupplyId) await tx.exec('UPDATE supplies SET catalog_supply_id = COALESCE(catalog_supply_id, ?) WHERE id = ?',
      [catalogSupplyId, supplyId]);
    const existingLot = await tx.execO<{ id: string }>(`SELECT id FROM supply_lots WHERE supply_id = ?
      AND (lot_code = ? OR lot_code IS NULL AND ? IS NULL) ORDER BY created_at, id LIMIT 1`,
    [supplyId, cleanLot, cleanLot]);
    const lotId = existingLot[0]?.id || nanoid();
    if (!existingLot.length) await tx.exec('INSERT INTO supply_lots(id, supply_id, lot_code, created_at) VALUES (?, ?, ?, ?)',
      [lotId, supplyId, cleanLot, now]);
    await tx.exec(`INSERT INTO inventory_items(id, name, category, default_unit, supply_id, lot_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, name, category, defaultUnit, supplyId, lotId, now]);
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
  let target = (await listInventory(db)).find(item => item.lot_id === source.lot_id && item.location_id === destinationId);
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
      await tx.exec(`INSERT INTO inventory_items(id, name, category, default_unit, supply_id, lot_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [target.id, target.name, target.category, target.default_unit, source.supply_id, source.lot_id, nowSeconds()]);
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

export interface SyncProgress { phase: 'uploading' | 'applying'; applied: number; total: number }

export function syncNow(db: DB, workspaceId: string, onProgress?: (progress: SyncProgress) => void): Promise<number> {
  const previous = syncQueues.get(db) || Promise.resolve();
  const current = previous.catch(() => undefined).then(() => performSync(db, workspaceId, onProgress));
  syncQueues.set(db, current.then(() => undefined, () => undefined));
  return current;
}

async function performSync(db: DB, workspaceId: string, onProgress?: (progress: SyncProgress) => void): Promise<number> {
  const localVersion = await stateValue(db, 'localCursor');
  let uploadVersion = localVersion;
  let uploadSeq = await stateValue(db, 'localSeq');
  if (uploadSeq === '0' && localVersion !== '0') uploadSeq = maxSequence;
  const uploadWhere = 'db_version >= ? AND (db_version > ? OR seq > ?) AND site_id = crsql_site_id()';
  const uploadArgs = (version: string, seq: string) => [BigInt(version), BigInt(version), BigInt(seq)];
  const uploadTotal = (await db.execO<{ count: number }>(
    `SELECT COUNT(*) AS count FROM crsql_changes WHERE ${uploadWhere}`, uploadArgs(uploadVersion, uploadSeq)))[0].count;
  let uploaded = 0;
  onProgress?.({ phase: 'uploading', applied: 0, total: uploadTotal });
  while (uploaded < uploadTotal) {
    const candidates = await db.execO<{ bytes: number }>(`SELECT length(val) AS bytes FROM crsql_changes
      WHERE ${uploadWhere} ORDER BY db_version, seq LIMIT 128`, uploadArgs(uploadVersion, uploadSeq));
    if (!candidates.length) break;
    let count = 0;
    let bytes = 0;
    for (const candidate of candidates) {
      if (count && bytes + (candidate.bytes || 0) > 12 * 1024 * 1024) break;
      bytes += candidate.bytes || 0;
      count++;
    }
    const rows = await db.execO<SqlChangeRow>(`SELECT "table", pk, cid, val, col_version, db_version,
      COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq FROM crsql_changes
      WHERE ${uploadWhere} ORDER BY db_version, seq LIMIT ${count}`, uploadArgs(uploadVersion, uploadSeq));
    const response = await fetchApi(`/api/workspaces/${workspaceId}/sync/upload`, {
      method: 'POST', headers: { 'Content-Type': syncContentType }, credentials: 'same-origin',
      body: encodeItem([syncProtocolVersion, uploadVersion, uploadSeq, rows.map(changeTuple)]) as BodyInit
    });
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error || 'Sync upload failed');
    const ack = decodeItem(new Uint8Array(await response.arrayBuffer()));
    if (!Array.isArray(ack) || ack[0] !== syncProtocolVersion || !/^\d+$/.test(ack[1]) || !/^\d+$/.test(ack[2]))
      throw new Error('Invalid sync upload acknowledgement');
    uploadVersion = ack[1] as string;
    uploadSeq = ack[2] as string;
    await db.tx(async tx => {
      await tx.exec('INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['localCursor', uploadVersion]);
      await tx.exec('INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['localSeq', uploadSeq]);
    });
    uploaded += rows.length;
    onProgress?.({ phase: 'uploading', applied: uploaded, total: uploadTotal });
  }
  const serverVersion = await stateValue(db, 'serverCursor');
  let serverSeq = await stateValue(db, 'serverSeq');
  if (serverSeq === '0' && serverVersion !== '0') serverSeq = maxSequence;
  const response = await fetchApi(`/api/workspaces/${workspaceId}/sync/download?version=${serverVersion}&seq=${serverSeq}`,
    { credentials: 'same-origin' });
  if (!response.ok) throw new Error((await response.json() as { error?: string }).error || 'Sync download failed');
  if (!response.body) throw new Error('Sync response cannot be streamed');
  const stream = readSequence(response.body);
  const first = await stream.next();
  const header = first.value;
  if (first.done || !Array.isArray(header) || header.length !== 3 || header[0] !== syncProtocolVersion
    || !Number.isSafeInteger(header[1]) || header[1] < 0 || !/^\d+$/.test(header[2]))
    throw new Error('Invalid sync stream header');
  const total = header[1] as number;
  const targetVersion = header[2] as string;
  onProgress?.({ phase: 'applying', applied: 0, total });
  const insert = `INSERT INTO crsql_changes (${changeColumns.map(name => `"${name}"`).join(', ')}) VALUES (${changeColumns.map(() => '?').join(', ')})`;
  let applied = 0;
  let batch: ChangeTuple[] = [];
  const apply = async () => {
    if (!batch.length) return;
    const changes = batch;
    batch = [];
    const last = changes.at(-1)!;
    await db.tx(async tx => {
      for (const change of changes) await tx.exec(insert, change);
      await tx.exec('INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        ['serverCursor', String(last[5])]);
      await tx.exec('INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        ['serverSeq', String(last[8])]);
    });
    applied += changes.length;
    onProgress?.({ phase: 'applying', applied, total });
  };
  for await (const item of stream) {
    if (!validChangeTuple(item)) throw new Error('Invalid change in sync stream');
    batch.push(item);
    if (batch.length >= 64) await apply();
  }
  await apply();
  if (applied !== total) throw new Error('Incomplete sync stream');
  await db.tx(async tx => {
    await tx.exec('INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ['serverCursor', targetVersion]);
    await tx.exec('INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ['serverSeq', maxSequence]);
  });
  return applied;
}
