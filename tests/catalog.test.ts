import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openCatalogDb } from '../server/catalog.ts';
import { catalogSchemaVersion, catalogTables } from '../shared/catalog.ts';

const directory = mkdtempSync(join(tmpdir(), 'brewlog-products-catalog-'));
after(() => rmSync(directory, { recursive: true, force: true }));

test('new catalog has a single product identity and typed product tables', () => {
  const folder = mkdtempSync(join(directory, 'fresh-'));
  const db = openCatalogDb(folder);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    for (const table of catalogTables) assert.ok(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(`${table}__crsql_clock`));
    assert.equal((db.prepare('SELECT count(*) AS n FROM products').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('current local catalog moves equipment and supplies into products without losing specifications', () => {
  const folder = mkdtempSync(join(directory, 'current-'));
  const old = new Database(join(folder, 'catalog.sqlite'));
  old.loadExtension(resolve('vendor/crsqlite.so'));
  old.exec(`CREATE TABLE equipment_models(id TEXT PRIMARY KEY NOT NULL, manufacturer TEXT,
      model_name TEXT, kind TEXT, product_url TEXT);
    CREATE TABLE model_images(model_id TEXT PRIMARY KEY NOT NULL, image_url TEXT, thumbnail_url TEXT);
    CREATE TABLE supplies(id TEXT PRIMARY KEY NOT NULL, name TEXT, category TEXT, unit TEXT);
    CREATE TABLE supply_products(supply_id TEXT PRIMARY KEY NOT NULL, manufacturer TEXT, product_url TEXT);
    CREATE TABLE supply_images(supply_id TEXT PRIMARY KEY NOT NULL, image_url TEXT);
    CREATE TABLE supply_container_specs(supply_id TEXT PRIMARY KEY NOT NULL,
      container_kind TEXT, capacity_liters REAL, material TEXT, wood_species TEXT,
      wood_origin TEXT, connector_type TEXT)`);
  for (const table of ['equipment_models', 'model_images', 'supplies', 'supply_products',
    'supply_images', 'supply_container_specs']) old.prepare('SELECT crsql_as_crr(?)').get(table);
  old.prepare('INSERT INTO equipment_models VALUES (?,?,?,?,?)')
    .run('model-keg', 'Kegco', 'Five gallon keg', 'keg', 'https://example.com/model');
  old.prepare('INSERT INTO model_images VALUES (?,?,?)')
    .run('model-keg', 'https://example.com/model.jpg', 'https://example.com/model-small.jpg');
  old.prepare('INSERT INTO supplies VALUES (?,?,?,?)')
    .run('supply-keg', 'Five gallon keg', 'Packaging', 'each');
  old.prepare('INSERT INTO supply_products VALUES (?,?,?)')
    .run('supply-keg', 'Kegco', 'https://example.com/supply');
  old.prepare('INSERT INTO supply_images VALUES (?,?)')
    .run('supply-keg', 'https://example.com/supply.jpg');
  old.prepare('INSERT INTO supply_container_specs(supply_id, container_kind, capacity_liters) VALUES (?,?,?)')
    .run('supply-keg', 'keg', 18.927);
  old.pragma('user_version = 34');
  old.close();
  const db = openCatalogDb(folder);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.deepEqual(db.prepare('SELECT id,name,manufacturer,product_url,image_url,thumbnail_url FROM products ORDER BY id').all(), [
      { id: 'model-keg', name: 'Five gallon keg', manufacturer: 'Kegco', product_url: 'https://example.com/model',
        image_url: 'https://example.com/model.jpg', thumbnail_url: 'https://example.com/model-small.jpg' },
      { id: 'supply-keg', name: 'Five gallon keg', manufacturer: 'Kegco', product_url: 'https://example.com/supply',
        image_url: 'https://example.com/supply.jpg', thumbnail_url: null }
    ]);
    assert.deepEqual(db.prepare('SELECT container_kind,capacity_liters FROM supply_container_specs WHERE supply_id = ?')
      .get('supply-keg'), { container_kind: 'keg', capacity_liters: 18.927 });
    assert.equal((db.prepare(`SELECT count(*) AS n FROM crsql_changes WHERE "table" = 'products'`)
      .get() as { n: number }).n > 0, true);
  } finally { db.close(); }
});
