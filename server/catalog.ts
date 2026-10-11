import Database from 'better-sqlite3';
import { join } from 'node:path';
import { initialCatalogEquipment, initialCatalogInventory, type CatalogSnapshot } from '../shared/catalog.ts';

export function openCatalogDb(dataDir: string): Database.Database {
  const db = new Database(join(dataDir, 'catalog.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_meta (version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS catalog_equipment (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, specification_json TEXT
    );
    CREATE TABLE IF NOT EXISTS catalog_inventory (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL
    );
  `);
  if (!(db.prepare('SELECT 1 FROM catalog_meta LIMIT 1').get())) {
    db.transaction(() => {
      const addEquipment = db.prepare('INSERT INTO catalog_equipment(id, name, kind, specification_json) VALUES (?, ?, ?, ?)');
      const addInventory = db.prepare('INSERT INTO catalog_inventory(id, name, category, unit) VALUES (?, ?, ?, ?)');
      for (const item of initialCatalogEquipment) addEquipment.run(item.id, item.name, item.kind, item.specification_json);
      for (const item of initialCatalogInventory) addInventory.run(item.id, item.name, item.category, item.unit);
      db.prepare('INSERT INTO catalog_meta(version) VALUES (1)').run();
    })();
  }
  return db;
}

export function catalogSnapshot(db: Database.Database, clientVersion: number): CatalogSnapshot | { version: number; unchanged: true } {
  const version = (db.prepare('SELECT version FROM catalog_meta LIMIT 1').get() as { version: number }).version;
  if (clientVersion === version) return { version, unchanged: true };
  return {
    version,
    equipment: db.prepare('SELECT id, name, kind, specification_json FROM catalog_equipment ORDER BY name COLLATE NOCASE').all() as CatalogSnapshot['equipment'],
    inventory: db.prepare('SELECT id, name, category, unit FROM catalog_inventory ORDER BY name COLLATE NOCASE').all() as CatalogSnapshot['inventory']
  };
}
