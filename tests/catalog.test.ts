import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { catalogChanges, openCatalogDb } from '../server/catalog.ts';
import { catalogSchemaVersion } from '../shared/catalog.ts';

const testDirectories = new Set<string>();
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  testDirectories.add(path);
  return path;
}
after(() => { for (const path of testDirectories) rmSync(path, { recursive: true, force: true }); });

test('a new catalog has the current schema and no bundled products', () => {
  const db = openCatalogDb(directory());
  try {
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal((db.prepare('SELECT count(*) AS n FROM supplies').get() as { n: number }).n, 0);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'supply_categories'").get(), undefined);
    assert.equal((db.prepare('SELECT count(*) AS n FROM equipment_models').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('catalog URLs and unrelated content persist when legacy image bytes are removed', () => {
  const dir = directory();
  const before = openCatalogDb(dir);
  const image = Buffer.from([255, 216, 255, 11, 12]);
  before.prepare("INSERT INTO supplies(id,name,category,unit) VALUES ('malt','My malt','Grain','g')").run();
  before.prepare("SELECT crsql_begin_alter('supply_images')").get();
  before.exec('ALTER TABLE supply_images ADD COLUMN image_bytes BLOB');
  before.prepare("SELECT crsql_commit_alter('supply_images')").get();
  before.prepare('INSERT INTO supply_images(supply_id,image_url,image_bytes) VALUES (?,?,?)')
    .run('malt', 'https://example.com/malt.jpg', image);
  before.prepare("INSERT INTO equipment_models(id,model_name,kind) VALUES ('kettle','My kettle','kettle')").run();
  before.pragma('user_version = 31');
  before.close();

  const after = openCatalogDb(dir);
  try {
    assert.equal(after.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal((after.prepare("SELECT name FROM supplies WHERE id='malt'").get() as { name: string }).name, 'My malt');
    assert.equal((after.prepare("SELECT image_url FROM supply_images WHERE supply_id='malt'")
      .get() as { image_url: string }).image_url, 'https://example.com/malt.jpg');
    assert.equal((after.pragma('table_info(supply_images)') as { name: string }[])
      .some(row => row.name === 'image_bytes'), false);
    assert.ok(after.prepare("SELECT id FROM equipment_models WHERE id='kettle'").get());
    assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'supply_categories'").get(), undefined);
    assert.ok(catalogChanges(after, 0n).changes.length > 0);
    assert.equal(after.pragma('integrity_check', { simple: true }), 'ok');
  } finally { after.close(); }
});

test('older model and manufacturer image URLs move into media tables', () => {
  const dir = directory();
  const before = openCatalogDb(dir);
  before.prepare("INSERT INTO manufacturers(name,website_url) VALUES ('Maker','https://example.com')").run();
  before.prepare("INSERT INTO equipment_models(id,manufacturer,model_name,kind) VALUES ('kettle','Maker','Kettle','kettle')").run();
  for (const [table, column] of [['equipment_models', 'image_url'], ['equipment_models', 'thumbnail_url'],
    ['manufacturers', 'logo_url']] as const) {
    before.prepare('SELECT crsql_begin_alter(?)').get(table);
    before.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    before.prepare('SELECT crsql_commit_alter(?)').get(table);
  }
  before.prepare("UPDATE equipment_models SET image_url='https://example.com/kettle.jpg', thumbnail_url='https://example.com/kettle-small.jpg' WHERE id='kettle'").run();
  before.prepare("UPDATE manufacturers SET logo_url='https://example.com/logo.png' WHERE name='Maker'").run();
  before.prepare("INSERT INTO model_images(model_id) VALUES ('kettle')").run();
  before.prepare("INSERT INTO manufacturer_logos(manufacturer_name) VALUES ('Maker')").run();
  before.pragma('user_version = 31');
  before.close();
  const after = openCatalogDb(dir);
  try {
    assert.deepEqual(after.prepare("SELECT image_url,thumbnail_url FROM model_images WHERE model_id='kettle'").get(),
      { image_url: 'https://example.com/kettle.jpg', thumbnail_url: 'https://example.com/kettle-small.jpg' });
    assert.deepEqual(after.prepare("SELECT logo_url FROM manufacturer_logos WHERE manufacturer_name='Maker'").get(),
      { logo_url: 'https://example.com/logo.png' });
    assert.equal((after.pragma('table_info(equipment_models)') as { name: string }[]).some(row => row.name === 'image_url'), false);
    assert.equal(after.pragma('integrity_check', { simple: true }), 'ok');
  } finally { after.close(); }
});

test('previous category rows retire without disturbing products and specifications', () => {
  const dir = directory();
  const before = openCatalogDb(dir);
  before.exec('CREATE TABLE supply_categories(name TEXT PRIMARY KEY NOT NULL, sort_order INTEGER NOT NULL DEFAULT 1000)');
  before.prepare("SELECT crsql_as_crr('supply_categories')").get();
  before.prepare("INSERT INTO supplies(id,name,category,unit) VALUES ('grain','My malt','Grain','g')").run();
  before.prepare("INSERT INTO supplies(id,name,category,unit) VALUES ('hop','My hop','Hops','g')").run();
  before.prepare("INSERT INTO supply_categories(name,sort_order) VALUES ('Grain',4)").run();
  before.prepare("INSERT INTO supply_categories(name,sort_order) VALUES ('Juice & must',5)").run();
  before.pragma('user_version = 30');
  before.close();

  const after = openCatalogDb(dir);
  try {
    assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'supply_categories'").get(), undefined);
    assert.equal((after.prepare('SELECT count(*) AS n FROM supplies').get() as { n: number }).n, 2);
    assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'supply_other_fermentable_specs'").get());
    assert.equal(after.pragma('integrity_check', { simple: true }), 'ok');
  } finally { after.close(); }
});

test('a previous-version catalog repairs a partially created fermentable specification table', () => {
  const dir = directory();
  const before = openCatalogDb(dir);
  before.prepare("INSERT INTO supplies(id,name,category,unit) VALUES ('syrup','My syrup','Other fermentables','mL')").run();
  before.prepare("INSERT INTO equipment_models(id,model_name,kind) VALUES ('mill','My mill','mill')").run();
  before.exec('DROP TABLE supply_other_fermentable_specs');
  before.pragma('user_version = 32');
  before.close();

  const after = openCatalogDb(dir);
  try {
    assert.equal(after.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.ok(after.prepare("SELECT name FROM sqlite_master WHERE name = 'supply_other_fermentable_specs'").get());
    assert.ok(after.prepare("SELECT id FROM supplies WHERE id='syrup'").get());
    assert.ok(after.prepare("SELECT id FROM equipment_models WHERE id='mill'").get());
    assert.equal(after.pragma('integrity_check', { simple: true }), 'ok');
  } finally { after.close(); }
});

test('version 22 and a partially upgraded product table retain source links and unrelated rows', () => {
  for (const version of [22, 26]) {
    const dir = directory();
    const before = openCatalogDb(dir);
    before.prepare("INSERT INTO supplies(id,name,category,unit) VALUES ('grain','My grain','Grain','g')").run();
    before.prepare("INSERT INTO supplies(id,name,category,unit) VALUES ('bottle','My bottle','Packaging','each')").run();
    before.prepare("INSERT INTO supply_products(supply_id,manufacturer) VALUES ('grain','My Maltster')").run();
    before.prepare("SELECT crsql_begin_alter('supply_products')").get();
    before.exec('ALTER TABLE supply_products ADD COLUMN spec_source_url TEXT');
    before.prepare("SELECT crsql_commit_alter('supply_products')").get();
    before.prepare("UPDATE supply_products SET spec_source_url='https://example.com/grain' WHERE supply_id='grain'").run();
    before.pragma(`user_version = ${version}`);
    before.close();

    const after = openCatalogDb(dir);
    try {
      assert.equal(after.pragma('user_version', { simple: true }), catalogSchemaVersion);
      assert.deepEqual(after.prepare("SELECT manufacturer,product_url FROM supply_products WHERE supply_id='grain'").get(),
        { manufacturer: 'My Maltster', product_url: 'https://example.com/grain' });
      assert.ok(after.prepare("SELECT id FROM supplies WHERE id='bottle'").get());
      assert.equal((after.pragma('table_info(supply_products)') as { name: string }[])
        .some(row => row.name === 'spec_source_url'), false);
    } finally { after.close(); }
  }
});

test('legacy catalog rows migrate into typed tables without bundled rows', () => {
  const dir = directory();
  const old = new Database(join(dir, 'catalog.sqlite'));
  old.exec(`CREATE TABLE catalog_meta(version INTEGER NOT NULL);
    INSERT INTO catalog_meta VALUES (1);
    CREATE TABLE catalog_equipment(id TEXT PRIMARY KEY, name TEXT, kind TEXT, specification_json TEXT);
    INSERT INTO catalog_equipment VALUES ('old_kettle', 'Old kettle', 'kettle', '{"capacity_liters":35}');
    CREATE TABLE catalog_inventory(id TEXT PRIMARY KEY, name TEXT, category TEXT, unit TEXT);
    INSERT INTO catalog_inventory VALUES ('old_grain', 'Old grain', 'Grain', 'g');`);
  old.close();
  const db = openCatalogDb(dir);
  try {
    assert.equal((db.prepare("SELECT capacity_liters FROM model_liquid_containment WHERE model_id='old_kettle'")
      .get() as { capacity_liters: number }).capacity_liters, 35);
    assert.equal((db.prepare("SELECT name FROM supplies WHERE id='old_grain'").get() as { name: string }).name,
      'Old grain');
    assert.equal((db.prepare('SELECT count(*) AS n FROM supplies').get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test('a symlinked checkout opens the canonical database path', () => {
  const ownerDir = directory();
  const otherDir = directory();
  const owner = openCatalogDb(ownerDir);
  owner.close();
  symlinkSync(join(ownerDir, 'catalog.sqlite'), join(otherDir, 'catalog.sqlite'));
  const other = openCatalogDb(otherDir);
  try {
    assert.equal(other.name, join(ownerDir, 'catalog.sqlite'));
    other.prepare("INSERT INTO supplies(id,name,category,unit) VALUES ('shared','Shared','Other','each')").run();
  } finally { other.close(); }
  const reopened = openCatalogDb(ownerDir);
  try { assert.ok(reopened.prepare("SELECT 1 FROM supplies WHERE id='shared'").get()); }
  finally { reopened.close(); }
});
