import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { catalogEquipmentColumns, catalogEquipmentTable, catalogInventoryTable, catalogSchemaVersion,
  catalogTables, initialCatalogEquipment, initialCatalogInventory, type CatalogChanges } from '../shared/catalog.ts';
import { encodeChange, type SqlChangeRow } from '../shared/wire.ts';
import { projectRoot } from './db.ts';

const selectChanges = `SELECT "table", pk, cid, val, col_version, db_version,
  COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq
  FROM crsql_changes WHERE db_version > ? ORDER BY db_version, seq`;

export function openCatalogDb(dataDir: string): Database.Database {
  const db = new Database(join(dataDir, 'catalog.sqlite'));
  db.pragma('journal_mode = WAL');
  db.loadExtension(resolve(projectRoot, 'vendor/crsqlite.so'));
  db.exec('CREATE TABLE IF NOT EXISTS catalog_meta (version INTEGER NOT NULL)');
  const current = db.prepare('SELECT version FROM catalog_meta LIMIT 1').get() as { version: number } | undefined;
  if (!current || current.version < catalogSchemaVersion) {
    db.transaction(() => {
      // Older catalogs were snapshots, not CRRs. This pre-release schema upgrade
      // starts a fresh change log; browsers reset their catalog cursor as well.
      if (!current || current.version < 9) {
        db.exec('DROP TABLE IF EXISTS catalog_equipment');
        db.exec('DROP TABLE IF EXISTS catalog_inventory');
      }
      db.exec(catalogEquipmentTable);
      db.exec(catalogInventoryTable);
      if (!current || current.version < 9) {
        for (const table of catalogTables) db.prepare('SELECT crsql_as_crr(?)').get(table);
      }
      const addEquipment = db.prepare(`INSERT INTO catalog_equipment(id, name, kind, ${catalogEquipmentColumns.join(', ')})
        VALUES (?, ?, ?, ${catalogEquipmentColumns.map(() => '?').join(', ')})
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
          ${catalogEquipmentColumns.map(column => `${column} = excluded.${column}`).join(', ')}`);
      const addInventory = db.prepare(`INSERT INTO catalog_inventory(id, name, category, unit) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, unit = excluded.unit`);
      for (const item of initialCatalogEquipment) addEquipment.run(item.id, item.name, item.kind,
        ...catalogEquipmentColumns.map(column => column === 'built_in_temperature_control'
          ? Number(!!item[column]) : item[column] ?? null));
      for (const item of initialCatalogInventory) addInventory.run(item.id, item.name, item.category, item.unit);
      db.prepare('DELETE FROM catalog_meta').run();
      db.prepare('INSERT INTO catalog_meta(version) VALUES (?)').run(catalogSchemaVersion);
    })();
  } else if (current.version > catalogSchemaVersion) {
    db.close();
    throw new Error(`This server cannot open catalog version ${current.version}; update Brewlog first.`);
  }
  return db;
}

export function catalogChanges(db: Database.Database, clientCursor: bigint): CatalogChanges {
  const cursor = BigInt((db.prepare('SELECT crsql_db_version() AS version').get() as { version: number | bigint }).version);
  if (clientCursor > cursor) throw new Error('Catalog cursor is ahead of the server');
  const rows = db.prepare(selectChanges).all(clientCursor) as SqlChangeRow[];
  return { serverCursor: String(cursor), changes: rows.map(encodeChange) };
}
