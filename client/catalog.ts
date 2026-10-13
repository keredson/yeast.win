import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { catalogModelTables, catalogSupplyTables, catalogSchemaVersion, catalogTables,
  type CatalogChanges, type CatalogEquipment, type CatalogInventory, type CatalogMeasurementChannel } from '../shared/catalog.ts';
import { changeColumns } from '../shared/schema.ts';
import { decodeChange } from '../shared/wire.ts';

let opened: Promise<DB> | undefined;
let syncing: Promise<void> | undefined;

export function openLocalCatalog(): Promise<DB> {
  if (!opened) opened = (async () => {
    const sqlite = await initWasm(() => wasmUrl);
    const db = await sqlite.open('brewlog-catalog');
    const version = (await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version;
    if (version === 11) {
      await db.exec('PRAGMA user_version = 12');
    } else if (version < 12) {
      const oldClocks = await db.execO<{ name: string }>(`SELECT name FROM sqlite_master
        WHERE name LIKE '%__crsql_clock'`);
      await db.tx(async tx => {
        // Catalog schemas change together on both peers. Replay the server's
        // CR-SQLite history from zero after replacing the local tables.
        for (const row of oldClocks) {
          await tx.exec('SELECT crsql_as_table(?)', [row.name.replace('__crsql_clock', '')]);
        }
        for (const table of ['catalog_equipment', 'catalog_inventory', 'equipment', 'inventory',
          ...Object.keys(catalogModelTables)]) await tx.exec(`DROP TABLE IF EXISTS "${table}"`);
        await tx.exec('DROP TABLE IF EXISTS catalog_meta');
        await tx.exec('DROP TABLE IF EXISTS catalog_sync_state');
        for (const statement of [...Object.values(catalogModelTables), ...Object.values(catalogSupplyTables)]) await tx.exec(statement);
        for (const table of catalogTables) await tx.exec('SELECT crsql_as_crr(?)', [table]);
        await tx.exec('CREATE TABLE IF NOT EXISTS sync_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
        await tx.exec('DELETE FROM sync_state');
        await tx.exec('PRAGMA user_version = 12');
      });
    } else if (version > catalogSchemaVersion) {
      throw new Error(`This app cannot open catalog schema ${version}; update Brewlog first.`);
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 12) {
      await db.tx(async tx => {
        await tx.exec(catalogModelTables.model_boil_characterization);
        const clock = await tx.execO<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name = 'model_boil_characterization__crsql_clock'");
        if (!clock.length) await tx.exec("SELECT crsql_as_crr('model_boil_characterization')");
        await tx.exec('PRAGMA user_version = 13');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 13) {
      await db.tx(async tx => {
        for (const statement of Object.values(catalogSupplyTables)) await tx.exec(statement);
        for (const table of Object.keys(catalogSupplyTables)) {
          const clock = await tx.execO<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name = ?", [`${table}__crsql_clock`]);
          if (!clock.length) await tx.exec('SELECT crsql_as_crr(?)', [table]);
        }
        const old = await tx.execO<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inventory'");
        if (old.length) {
          await tx.exec('INSERT OR IGNORE INTO supplies(id, name, category, unit) SELECT id, name, category, unit FROM inventory');
          const clock = await tx.execO<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'inventory__crsql_clock'");
          if (clock.length) await tx.exec("SELECT crsql_as_table('inventory')");
          await tx.exec('DROP TABLE inventory');
        }
        await tx.exec(`PRAGMA user_version = ${catalogSchemaVersion}`);
      });
    }
    return db;
  })().catch(error => { opened = undefined; throw error; });
  return opened;
}

export async function readLocalCatalog(db: DB): Promise<{ equipment: CatalogEquipment[]; inventory: CatalogInventory[] }> {
  const [models, liquid, pressure, heating, boil, cooling, control, channels, inventory] = await Promise.all([
    db.execO<{ id: string; name: string; kind: string; manufacturer: string | null }>(
      'SELECT id, model_name AS name, kind, manufacturer FROM equipment_models ORDER BY model_name COLLATE NOCASE'),
    db.execO<{ model_id: string; capacity_liters: number | null }>('SELECT * FROM model_liquid_containment'),
    db.execO<{ model_id: string; max_pressure_kpa: number | null }>('SELECT * FROM model_pressure_rating'),
    db.execO<{ model_id: string; rated_power_watts: number | null }>('SELECT * FROM model_heating'),
    db.execO<{ model_id: string; heat_loss_watts: number | null }>('SELECT * FROM model_boil_characterization'),
    db.execO<{ model_id: string; rated_heat_removal_watts: number | null }>('SELECT * FROM model_cooling'),
    db.execO<{ model_id: string; min_temperature_c: number | null; max_temperature_c: number | null }>(
      'SELECT * FROM model_temperature_control'),
    db.execO<CatalogMeasurementChannel>('SELECT * FROM model_measurement_channels'),
    db.execO<CatalogInventory>(`SELECT s.id, s.name, s.category, s.unit,
      g.yield_pct, g.color_lovibond, h.alpha_acid_pct, h.hop_form, y.attenuation_pct
      FROM supplies s LEFT JOIN supply_grain_specs g ON g.supply_id = s.id
      LEFT JOIN supply_hop_specs h ON h.supply_id = s.id
      LEFT JOIN supply_yeast_specs y ON y.supply_id = s.id ORDER BY s.name COLLATE NOCASE`)
  ]);
  const byId = new Map(models.map(model => [model.id, { ...model, measurement_channels: [] as CatalogMeasurementChannel[] }]));
  for (const row of liquid) Object.assign(byId.get(row.model_id) || {},
    { has_liquid_containment: true, capacity_liters: row.capacity_liters });
  for (const row of pressure) Object.assign(byId.get(row.model_id) || {},
    { has_pressure_rating: true, max_pressure_kpa: row.max_pressure_kpa });
  for (const row of heating) Object.assign(byId.get(row.model_id) || {},
    { has_heating: true, rated_power_watts: row.rated_power_watts });
  for (const row of boil) Object.assign(byId.get(row.model_id) || {},
    { boil_heat_loss_watts: row.heat_loss_watts });
  for (const row of cooling) Object.assign(byId.get(row.model_id) || {},
    { has_cooling: true, rated_heat_removal_watts: row.rated_heat_removal_watts });
  for (const row of control) Object.assign(byId.get(row.model_id) || {}, {
    min_temperature_c: row.min_temperature_c, max_temperature_c: row.max_temperature_c,
    built_in_temperature_control: true, has_temperature_control: true
  });
  for (const channel of channels) byId.get(channel.model_id)?.measurement_channels.push(channel);
  const equipment: CatalogEquipment[] = [...byId.values()].map(model => {
    const primary = model.measurement_channels.find(channel => channel.measurement_kind ===
      (model.kind === 'hydrometer' || model.kind === 'refractometer' ? 'gravity' :
        model.kind === 'ph_meter' ? 'ph' : model.kind === 'scale' ? 'mass' :
          model.kind === 'pressure_gauge' ? 'pressure' : model.kind === 'carbonation_meter' ? 'carbonation' :
            model.kind === 'dissolved_oxygen_meter' ? 'dissolved_oxygen' : 'temperature'));
    return { ...model, measurement_min: primary?.measurement_min, measurement_max: primary?.measurement_max,
      measurement_unit: primary?.measurement_scale || primary?.measurement_unit };
  });
  return { equipment, inventory };
}

export function syncLocalCatalog(db: DB): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    const rows = await db.execO<{ value: string }>("SELECT value FROM sync_state WHERE key = 'serverCursor'");
    const cursor = rows[0]?.value || '0';
    const response = await fetch(`/api/catalog?cursor=${cursor}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Catalog sync failed');
    const result = await response.json() as CatalogChanges;
    if (!/^\d+$/.test(result.serverCursor) || !Array.isArray(result.changes)
      || result.changes.some(change => !catalogTables.includes(change.table as typeof catalogTables[number]))) {
      throw new Error('Invalid catalog response');
    }
    const insert = `INSERT INTO crsql_changes (${changeColumns.map(column => `"${column}"`).join(', ')})
      VALUES (${changeColumns.map(() => '?').join(', ')})`;
    await db.tx(async tx => {
      for (const change of result.changes) await tx.exec(insert, decodeChange(change));
      await tx.exec(`INSERT INTO sync_state(key, value) VALUES ('serverCursor', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [result.serverCursor]);
    });
  })().finally(() => { syncing = undefined; });
  return syncing;
}
