import Database from 'better-sqlite3';
import { join } from 'node:path';
import { catalogEquipmentColumns, catalogEquipmentTable, initialCatalogEquipment, initialCatalogInventory,
  type CatalogSnapshot } from '../shared/catalog.ts';

const catalogVersion = 8;

export function openCatalogDb(dataDir: string): Database.Database {
  const db = new Database(join(dataDir, 'catalog.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS catalog_meta (version INTEGER NOT NULL)');
  const current = db.prepare('SELECT version FROM catalog_meta LIMIT 1').get() as { version: number } | undefined;
  if (!current || current.version < catalogVersion) {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS catalog_equipment');
      db.exec('DROP TABLE IF EXISTS catalog_inventory');
      db.exec(catalogEquipmentTable);
      db.exec(`CREATE TABLE catalog_inventory (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL)`);
      const addEquipment = db.prepare(`INSERT INTO catalog_equipment(id, name, kind, ${catalogEquipmentColumns.join(', ')})
        VALUES (?, ?, ?, ${catalogEquipmentColumns.map(() => '?').join(', ')})`);
      const addInventory = db.prepare('INSERT INTO catalog_inventory(id, name, category, unit) VALUES (?, ?, ?, ?)');
      for (const item of initialCatalogEquipment) addEquipment.run(item.id, item.name, item.kind,
        ...catalogEquipmentColumns.map(column => column === 'built_in_temperature_control'
          ? Number(!!item[column]) : item[column] ?? null));
      for (const item of initialCatalogInventory) addInventory.run(item.id, item.name, item.category, item.unit);
      db.prepare('DELETE FROM catalog_meta').run();
      db.prepare('INSERT INTO catalog_meta(version) VALUES (?)').run(catalogVersion);
    })();
  } else if (current.version > catalogVersion) {
    db.close();
    throw new Error(`This server cannot open catalog version ${current.version}; update Brewlog first.`);
  }
  return db;
}

export function catalogSnapshot(db: Database.Database, clientVersion: number): CatalogSnapshot | { version: number; unchanged: true } {
  const version = (db.prepare('SELECT version FROM catalog_meta LIMIT 1').get() as { version: number }).version;
  if (clientVersion === version) return { version, unchanged: true };
  return {
    version,
    equipment: db.prepare('SELECT * FROM catalog_equipment ORDER BY name COLLATE NOCASE').all() as CatalogSnapshot['equipment'],
    inventory: db.prepare('SELECT id, name, category, unit FROM catalog_inventory ORDER BY name COLLATE NOCASE').all() as CatalogSnapshot['inventory']
  };
}
