import Database from 'better-sqlite3';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { catalogModelTables, catalogSupplyTables, catalogSchemaVersion,
  type CatalogChanges } from '../shared/catalog.ts';
import { encodeChange, type SqlChangeRow } from '../shared/wire.ts';
import { projectRoot } from './db.ts';

const selectChanges = `SELECT "table", pk, cid, val, col_version, db_version,
  COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq
  FROM crsql_changes WHERE db_version > ? ORDER BY db_version, seq`;

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columns(db: Database.Database, name: string): Set<string> {
  return new Set((db.pragma(`table_info(${name})`) as { name: string }[]).map(row => row.name));
}

function alter(db: Database.Database, table: string, statements: string[]): void {
  if (!statements.length) return;
  db.prepare('SELECT crsql_begin_alter(?)').get(table);
  for (const statement of statements) db.exec(statement);
  db.prepare('SELECT crsql_commit_alter(?)').get(table);
}

function ensureTables(db: Database.Database): void {
  for (const [table, sql] of Object.entries({ ...catalogModelTables, ...catalogSupplyTables })) {
    db.exec(sql);
    if (!hasTable(db, `${table}__crsql_clock`)) db.prepare('SELECT crsql_as_crr(?)').get(table);
  }
}

function migrateColumns(db: Database.Database): void {
  const modelCols = columns(db, 'equipment_models');
  alter(db, 'equipment_models', [
    ...(!modelCols.has('product_url') ? ['ALTER TABLE equipment_models ADD COLUMN product_url TEXT'] : []),
    ...['image_url', 'thumbnail_url', 'specification_json']
      .filter(column => modelCols.has(column))
      .map(column => `ALTER TABLE equipment_models DROP COLUMN ${column}`)
  ]);
  const manufacturerCols = columns(db, 'manufacturers');
  alter(db, 'manufacturers', [
    ...(!manufacturerCols.has('website_url') ? ['ALTER TABLE manufacturers ADD COLUMN website_url TEXT'] : []),
    ...(manufacturerCols.has('logo_url') ? ['ALTER TABLE manufacturers DROP COLUMN logo_url'] : [])
  ]);
  for (const [table, renamed, mimeColumns] of [
    ['model_images', [['image_webp', 'image_bytes'], ['thumbnail_webp', 'thumbnail_bytes']],
      ['image_mime_type', 'thumbnail_mime_type']],
    ['manufacturer_logos', [['image_webp', 'image_bytes']], ['mime_type']]
  ] as const) {
    const present = columns(db, table);
    const statements: string[] = [];
    for (const [oldName, newName] of renamed) if (present.has(oldName) && !present.has(newName)) {
      statements.push(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
    }
    for (const column of mimeColumns) if (!present.has(column)) {
      statements.push(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
    alter(db, table, statements);
  }
  const productCols = columns(db, 'supply_products');
  if (!productCols.has('product_url')) alter(db, 'supply_products',
    ['ALTER TABLE supply_products ADD COLUMN product_url TEXT']);
  if (productCols.has('spec_source_url')) {
    db.exec(`UPDATE supply_products SET product_url = spec_source_url
      WHERE (product_url IS NULL OR product_url = '') AND spec_source_url IS NOT NULL`);
    alter(db, 'supply_products', ['ALTER TABLE supply_products DROP COLUMN spec_source_url']);
  }
  const mime = (column: string) => `CASE
    WHEN substr(${column}, 1, 3) = x'FFD8FF' THEN 'image/jpeg'
    WHEN substr(${column}, 1, 4) = x'89504E47' THEN 'image/png'
    WHEN substr(${column}, 1, 4) = x'52494646' AND substr(${column}, 9, 4) = x'57454250' THEN 'image/webp'
    ELSE 'application/octet-stream' END`;
  for (const [table, dataColumn, mimeColumn] of [
    ['model_images', 'image_bytes', 'image_mime_type'],
    ['model_images', 'thumbnail_bytes', 'thumbnail_mime_type'],
    ['manufacturer_logos', 'image_bytes', 'mime_type'],
    ['supply_images', 'image_bytes', 'image_mime_type']
  ]) db.exec(`UPDATE ${table} SET ${mimeColumn} = ${mime(dataColumn)}
    WHERE ${dataColumn} IS NOT NULL AND ${mimeColumn} IS NULL`);
}

function migrateLegacyRows(db: Database.Database): void {
  for (const table of ['catalog_equipment', 'equipment']) {
    if (!hasTable(db, table)) continue;
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    const insertModel = db.prepare(`INSERT OR IGNORE INTO equipment_models
      (id, manufacturer, model_name, kind, product_url) VALUES (?, ?, ?, ?, ?)`);
    const insertLiquid = db.prepare('INSERT OR IGNORE INTO model_liquid_containment(model_id, capacity_liters) VALUES (?, ?)');
    const insertHeating = db.prepare('INSERT OR IGNORE INTO model_heating(model_id, rated_power_watts) VALUES (?, ?)');
    const insertPressure = db.prepare('INSERT OR IGNORE INTO model_pressure_rating(model_id, max_pressure_kpa) VALUES (?, ?)');
    const insertControl = db.prepare(`INSERT OR IGNORE INTO model_temperature_control
      (model_id, min_temperature_c, max_temperature_c) VALUES (?, ?, ?)`);
    for (const row of rows) {
      let spec: Record<string, unknown> = {};
      if (typeof row.specification_json === 'string') {
        try { spec = JSON.parse(row.specification_json) as Record<string, unknown>; } catch { /* Legacy freeform value. */ }
      }
      const id = String(row.id);
      insertModel.run(id, row.manufacturer ?? spec.manufacturer ?? null,
        row.model_name ?? row.name ?? spec.name ?? id, row.kind ?? spec.kind ?? 'other',
        row.product_url ?? spec.product_url ?? null);
      const capacity = row.capacity_liters ?? spec.capacity_liters;
      if (capacity != null) insertLiquid.run(id, capacity);
      const power = row.rated_power_watts ?? spec.rated_power_watts;
      if (power != null) insertHeating.run(id, power);
      const pressure = row.max_pressure_kpa ?? spec.max_pressure_kpa;
      if (pressure != null) insertPressure.run(id, pressure);
      if (row.built_in_temperature_control || spec.built_in_temperature_control) {
        insertControl.run(id, row.min_temperature_c ?? spec.min_temperature_c ?? null,
          row.max_temperature_c ?? spec.max_temperature_c ?? null);
      }
    }
  }
  for (const table of ['catalog_inventory', 'inventory']) {
    if (!hasTable(db, table)) continue;
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    const insert = db.prepare('INSERT OR IGNORE INTO supplies(id, name, category, unit) VALUES (?, ?, ?, ?)');
    for (const row of rows) insert.run(row.id, row.name, row.category, row.unit ?? row.default_unit ?? 'each');
  }
  for (const table of ['catalog_equipment', 'catalog_inventory', 'equipment', 'inventory']) {
    if (!hasTable(db, table)) continue;
    if (hasTable(db, `${table}__crsql_clock`)) db.prepare('SELECT crsql_as_table(?)').get(table);
    db.exec(`DROP TABLE ${table}`);
  }
  if (hasTable(db, 'catalog_meta')) db.exec('DROP TABLE catalog_meta');
}

export function openCatalogDb(dataDir: string): Database.Database {
  const path = join(dataDir, 'catalog.sqlite');
  // Both checkouts use one WAL and SHM path even when one opens a symlink.
  const db = new Database(existsSync(path) ? realpathSync(path) : path);
  db.pragma('journal_mode = WAL');
  db.loadExtension(resolve(projectRoot, 'vendor/crsqlite.so'));
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > catalogSchemaVersion) {
    db.close();
    throw new Error(`This server cannot open catalog version ${version}; update Brewlog first.`);
  }
  if (version < catalogSchemaVersion) db.transaction(() => {
    ensureTables(db);
    migrateColumns(db);
    migrateLegacyRows(db);
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
