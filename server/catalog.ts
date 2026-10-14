import Database from 'better-sqlite3';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { catalogProductTables, catalogModelTables, catalogSupplyTables, catalogSchemaVersion,
  type CatalogChanges } from '../shared/catalog.ts';
import { encodeChange, type SqlChangeRow } from '../shared/wire.ts';
import { projectRoot } from './db.ts';

const selectChanges = `SELECT "table", pk, cid, val, col_version, db_version,
  COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq
  FROM crsql_changes WHERE db_version > ? ORDER BY db_version, seq`;

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function alter(db: Database.Database, table: string, statements: string[]): void {
  if (!statements.length) return;
  db.prepare('SELECT crsql_begin_alter(?)').get(table);
  for (const statement of statements) db.exec(statement);
  db.prepare('SELECT crsql_commit_alter(?)').get(table);
}

function ensureTables(db: Database.Database): void {
  for (const [table, sql] of Object.entries({ ...catalogProductTables, ...catalogModelTables, ...catalogSupplyTables })) {
    db.exec(sql);
    if (!hasTable(db, `${table}__crsql_clock`)) db.prepare('SELECT crsql_as_crr(?)').get(table);
  }
}

function migrateCurrentCatalogToProducts(db: Database.Database): void {
  db.exec(`INSERT INTO products(id, name, manufacturer, product_url, image_url, thumbnail_url)
    SELECT s.id, s.name, p.manufacturer, p.product_url, i.image_url, NULL
    FROM supplies s LEFT JOIN supply_products p ON p.supply_id = s.id
    LEFT JOIN supply_images i ON i.supply_id = s.id`);
  db.exec(`INSERT INTO products(id, name, manufacturer, product_url, image_url, thumbnail_url)
    SELECT m.id, m.model_name, m.manufacturer, m.product_url, i.image_url, i.thumbnail_url
    FROM equipment_models m LEFT JOIN model_images i ON i.model_id = m.id`);
  alter(db, 'equipment_models', [
    'ALTER TABLE equipment_models DROP COLUMN manufacturer',
    'ALTER TABLE equipment_models DROP COLUMN model_name',
    'ALTER TABLE equipment_models DROP COLUMN product_url'
  ]);
  alter(db, 'supplies', ['ALTER TABLE supplies DROP COLUMN name']);
  for (const table of ['model_images', 'supply_products', 'supply_images']) {
    db.prepare('SELECT crsql_as_table(?)').get(table);
    db.exec(`DROP TABLE ${table}`);
  }
}

export function openCatalogDb(dataDir: string): Database.Database {
  const path = join(dataDir, 'catalog.sqlite');
  // Both checkouts use one WAL and SHM path even when one opens a symlink.
  const db = new Database(existsSync(path) ? realpathSync(path) : path);
  db.pragma('journal_mode = WAL');
  db.loadExtension(resolve(projectRoot, 'vendor/crsqlite.so'));
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === catalogSchemaVersion && hasTable(db, 'products__crsql_clock')) return db;
  if (version !== 0 && version !== 34) {
    db.close();
    throw new Error(`This server cannot open catalog version ${version}; update Yeast.Win! first.`);
  }
  db.transaction(() => {
    ensureTables(db);
    if (version === 34) migrateCurrentCatalogToProducts(db);
    db.pragma(`user_version = ${catalogSchemaVersion}`);
  })();
  return db;
}

export function catalogChanges(db: Database.Database, clientCursor: bigint): CatalogChanges {
  const cursor = BigInt((db.prepare('SELECT crsql_db_version() AS version').get() as { version: number | bigint }).version);
  if (clientCursor > cursor) throw new Error('Catalog cursor is ahead of the server');
  const rows = db.prepare(selectChanges).all(clientCursor) as SqlChangeRow[];
  return { serverCursor: String(cursor), changes: rows.map(encodeChange) };
}
