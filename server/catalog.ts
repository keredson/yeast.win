import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { catalogModelTables, catalogInventoryTable, catalogSchemaVersion,
  catalogTables, initialCatalogEquipment, initialCatalogInventory,
  antonPaarEquipment, vevorModelName,
  type CatalogChanges, type CatalogEquipment, type CatalogInventory } from '../shared/catalog.ts';
import { boilOffKinds, vesselKinds } from '../shared/equipment.ts';
import { encodeChange, type SqlChangeRow } from '../shared/wire.ts';
import { projectRoot } from './db.ts';

const selectChanges = `SELECT "table", pk, cid, val, col_version, db_version,
  COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq
  FROM crsql_changes WHERE db_version > ? ORDER BY db_version, seq`;

export function openCatalogDb(dataDir: string): Database.Database {
  const db = new Database(join(dataDir, 'catalog.sqlite'));
  db.pragma('journal_mode = WAL');
  db.loadExtension(resolve(projectRoot, 'vendor/crsqlite.so'));
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > catalogSchemaVersion) {
    db.close();
    throw new Error(`This server cannot open catalog version ${version}; update Brewlog first.`);
  }
  if (version === 11) {
    db.transaction(() => {
      const addModel = db.prepare(`INSERT INTO equipment_models(id, manufacturer, model_name, kind)
        VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
      const addChannel = db.prepare(`INSERT INTO model_measurement_channels
        (id, model_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const channelKinds: Record<string, string> = { hydrometer: 'gravity', refractometer: 'gravity',
        carbonation_meter: 'carbonation', dissolved_oxygen_meter: 'dissolved_oxygen' };
      for (const item of antonPaarEquipment) {
        if (!addModel.run(item.id, item.manufacturer ?? null, item.name, item.kind).changes) continue;
        const scale = ['SG', '°Plato', '°Brix'].includes(item.measurement_unit || '')
          ? item.measurement_unit : null;
        addChannel.run(`${item.id}:${channelKinds[item.kind]}`, item.id, channelKinds[item.kind],
          item.measurement_min ?? null, item.measurement_max ?? null,
          scale ? null : item.measurement_unit ?? null, scale);
        for (const channel of item.measurement_channels || []) {
          addChannel.run(channel.id, item.id, channel.measurement_kind,
            channel.measurement_min ?? null, channel.measurement_max ?? null,
            channel.measurement_unit ?? null, channel.measurement_scale ?? null);
        }
      }
      db.pragma(`user_version = ${catalogSchemaVersion}`);
    })();
  } else if (version < catalogSchemaVersion) {
    const hasLegacyMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_meta'").get();
    const legacyVersion = hasLegacyMeta
      ? (db.prepare('SELECT version FROM catalog_meta LIMIT 1').get() as { version: number } | undefined)?.version : undefined;
    const oldEquipment = version === 10
      ? db.prepare('SELECT * FROM equipment').all() as CatalogEquipment[] : [];
    const oldInventory = version === 10
      ? db.prepare('SELECT * FROM inventory').all() as CatalogInventory[]
      : legacyVersion === 9 ? db.prepare('SELECT * FROM catalog_inventory').all() as CatalogInventory[] : [];
    db.transaction(() => {
      const clocks = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__crsql_clock'").all() as { name: string }[];
      for (const row of clocks) {
        db.prepare('SELECT crsql_as_table(?)').get(row.name.replace('__crsql_clock', ''));
      }
      for (const table of ['catalog_equipment', 'catalog_inventory', 'equipment', 'inventory',
        ...Object.keys(catalogModelTables)]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
      db.exec('DROP TABLE IF EXISTS catalog_meta');
      for (const statement of Object.values(catalogModelTables)) db.exec(statement);
      db.exec(catalogInventoryTable);
      for (const table of catalogTables) db.prepare('SELECT crsql_as_crr(?)').get(table);
      const addModel = db.prepare(`INSERT INTO equipment_models(id, manufacturer, model_name, kind)
        VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
      const addLiquid = db.prepare('INSERT INTO model_liquid_containment(model_id, capacity_liters) VALUES (?, ?)');
      const addPressure = db.prepare('INSERT INTO model_pressure_rating(model_id, max_pressure_kpa) VALUES (?, ?)');
      const addHeating = db.prepare('INSERT INTO model_heating(model_id, rated_power_watts) VALUES (?, ?)');
      const addCooling = db.prepare('INSERT INTO model_cooling(model_id, rated_heat_removal_watts) VALUES (?, ?)');
      const addControl = db.prepare(`INSERT INTO model_temperature_control(model_id, min_temperature_c, max_temperature_c)
        VALUES (?, ?, ?)`);
      const addChannel = db.prepare(`INSERT INTO model_measurement_channels
        (id, model_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const addInventory = db.prepare(`INSERT INTO inventory(id, name, category, unit) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`);
      for (const item of [...oldEquipment, ...initialCatalogEquipment]) {
        if (!addModel.run(item.id, item.manufacturer ?? null, item.name, item.kind).changes) continue;
        if (vesselKinds.has(item.kind) || item.capacity_liters != null) addLiquid.run(item.id, item.capacity_liters ?? null);
        if (item.max_pressure_kpa != null) addPressure.run(item.id, item.max_pressure_kpa);
        if (boilOffKinds.has(item.kind) || item.rated_power_watts != null) addHeating.run(item.id, item.rated_power_watts ?? null);
        if (item.rated_heat_removal_watts != null) addCooling.run(item.id, item.rated_heat_removal_watts);
        if (item.built_in_temperature_control || boilOffKinds.has(item.kind)
          || item.kind === 'fermentation_temperature_control') {
          addControl.run(item.id, item.min_temperature_c ?? null, item.max_temperature_c ?? null);
        }
        const measurementKind: Record<string, string> = { hydrometer: 'gravity', refractometer: 'gravity',
          thermometer: 'temperature', ph_meter: 'ph', pressure_gauge: 'pressure',
          carbonation_meter: 'carbonation', dissolved_oxygen_meter: 'dissolved_oxygen', scale: 'mass' };
        const kind = measurementKind[item.kind];
        if (kind) {
          const scale = ['SG', '°Plato', '°Brix', 'pH'].includes(item.measurement_unit || '')
            ? item.measurement_unit : null;
          addChannel.run(`${item.id}:${kind}`, item.id, kind, item.measurement_min ?? null,
            item.measurement_max ?? null, scale ? null : item.measurement_unit ?? null, scale);
        }
        for (const channel of item.measurement_channels || []) {
          addChannel.run(channel.id, item.id, channel.measurement_kind,
            channel.measurement_min ?? null, channel.measurement_max ?? null,
            channel.measurement_unit ?? null, channel.measurement_scale ?? null);
        }
        if (['equipment_tilt', 'equipment_rapt_pill'].includes(item.id)) {
          addChannel.run(`${item.id}:temperature`, item.id, 'temperature', null, null, '°C', null);
        }
      }
      for (const item of [...oldInventory, ...initialCatalogInventory]) {
        addInventory.run(item.id, item.name, item.category, item.unit);
      }
      db.pragma(`user_version = ${catalogSchemaVersion}`);
    })();
  }
  db.prepare(`UPDATE equipment_models SET model_name = ?
    WHERE id = ? AND model_name IN (?, ?)`).run(vevorModelName, 'equipment_vevor_35l',
    'VEVOR Electric Brewing System 9.2 Gal/35 L Brewing Pot', 'VEVOR 35 L');
  return db;
}

export function catalogChanges(db: Database.Database, clientCursor: bigint): CatalogChanges {
  const cursor = BigInt((db.prepare('SELECT crsql_db_version() AS version').get() as { version: number | bigint }).version);
  if (clientCursor > cursor) throw new Error('Catalog cursor is ahead of the server');
  const rows = db.prepare(selectChanges).all(clientCursor) as SqlChangeRow[];
  return { serverCursor: String(cursor), changes: rows.map(encodeChange) };
}
