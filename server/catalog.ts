import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { catalogEquipmentColumns, catalogEquipmentTable, catalogInventoryTable, catalogSchemaVersion,
  catalogTables, initialCatalogEquipment, initialCatalogInventory,
  type CatalogChanges, type CatalogEquipment, type CatalogInventory } from '../shared/catalog.ts';
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
  if (version < catalogSchemaVersion) {
    const hasLegacyMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_meta'").get();
    const legacyVersion = hasLegacyMeta
      ? (db.prepare('SELECT version FROM catalog_meta LIMIT 1').get() as { version: number } | undefined)?.version : undefined;
    // Version 9 already uses CR-SQLite. Retain direct server edits while the
    // table names and change history move to the new schema.
    const oldEquipment = legacyVersion === 9
      ? db.prepare('SELECT * FROM catalog_equipment').all() as CatalogEquipment[] : [];
    const oldInventory = legacyVersion === 9
      ? db.prepare('SELECT * FROM catalog_inventory').all() as CatalogInventory[] : [];
    db.transaction(() => {
      if (legacyVersion === 9) {
        for (const table of ['catalog_equipment', 'catalog_inventory']) {
          db.prepare('SELECT crsql_as_table(?)').get(table);
        }
      }
      db.exec('DROP TABLE IF EXISTS catalog_equipment');
      db.exec('DROP TABLE IF EXISTS catalog_inventory');
      db.exec('DROP TABLE IF EXISTS catalog_meta');
      db.exec(catalogEquipmentTable);
      db.exec(catalogInventoryTable);
      for (const table of catalogTables) db.prepare('SELECT crsql_as_crr(?)').get(table);
      const addEquipment = db.prepare(`INSERT INTO equipment(id, name, kind, ${catalogEquipmentColumns.join(', ')})
        VALUES (?, ?, ?, ${catalogEquipmentColumns.map(() => '?').join(', ')})
        ON CONFLICT(id) DO NOTHING`);
      const addInventory = db.prepare(`INSERT INTO inventory(id, name, category, unit) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`);
      for (const item of [...oldEquipment, ...initialCatalogEquipment]) addEquipment.run(item.id, item.name, item.kind,
        ...catalogEquipmentColumns.map(column => column === 'built_in_temperature_control'
          ? Number(!!item[column]) : item[column] ?? null));
      for (const item of [...oldInventory, ...initialCatalogInventory]) {
        addInventory.run(item.id, item.name, item.category, item.unit);
      }
      db.pragma(`user_version = ${catalogSchemaVersion}`);
    })();
  }
  return db;
}

export function catalogChanges(db: Database.Database, clientCursor: bigint): CatalogChanges {
  const cursor = BigInt((db.prepare('SELECT crsql_db_version() AS version').get() as { version: number | bigint }).version);
  if (clientCursor > cursor) throw new Error('Catalog cursor is ahead of the server');
  const rows = db.prepare(selectChanges).all(clientCursor) as SqlChangeRow[];
  return { serverCursor: String(cursor), changes: rows.map(encodeChange) };
}
