import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { catalogChanges, openCatalogDb } from '../server/catalog.ts';
import { catalogCategoryOptions, catalogSchemaVersion } from '../shared/catalog.ts';

function directory(): string { return mkdtempSync(join(tmpdir(), 'brewlog-catalog-')); }

test('cached products provide category options before new category rows sync', () => {
  const products = [
    { id: 'a', name: 'Malt', category: 'Grain', unit: 'g' },
    { id: 'b', name: 'Cider', category: 'Juice & must', unit: 'L' },
    { id: 'c', name: 'More malt', category: 'Grain', unit: 'g' }
  ];
  assert.deepEqual(catalogCategoryOptions([], products).map(row => row.name), ['Grain', 'Juice & must']);
  assert.deepEqual(catalogCategoryOptions([{ name: 'Juice & must', sort_order: 5 }], products)
    .map(row => row.name), ['Juice & must', 'Grain']);
});

test('a new catalog has the current schema and no bundled products', () => {
  const db = openCatalogDb(directory());
  try {
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal((db.prepare('SELECT count(*) AS n FROM supplies').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM supply_categories').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM equipment_models').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('catalog content and CR-SQLite changes persist across a schema upgrade', () => {
  const dir = directory();
  const before = openCatalogDb(dir);
  const image = Buffer.from([255, 216, 255, 11, 12]);
  before.prepare("INSERT INTO supplies(id,name,category,unit) VALUES ('malt','My malt','Grain','g')").run();
  before.prepare('INSERT INTO supply_images(supply_id,image_bytes,image_mime_type) VALUES (?,?,?)')
    .run('malt', image, 'image/jpeg');
  before.prepare("INSERT INTO equipment_models(id,model_name,kind) VALUES ('kettle','My kettle','kettle')").run();
  before.pragma('user_version = 28');
  before.close();

  const after = openCatalogDb(dir);
  try {
    assert.equal(after.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal((after.prepare("SELECT name FROM supplies WHERE id='malt'").get() as { name: string }).name, 'My malt');
    assert.deepEqual((after.prepare("SELECT image_bytes FROM supply_images WHERE supply_id='malt'")
      .get() as { image_bytes: Buffer }).image_bytes, image);
    assert.ok(after.prepare("SELECT id FROM equipment_models WHERE id='kettle'").get());
    assert.deepEqual(after.prepare("SELECT name,sort_order FROM supply_categories WHERE name='Grain'").get(),
      { name: 'Grain', sort_order: 1000 });
    assert.ok(catalogChanges(after, 0n).changes.length > 0);
    assert.equal(after.pragma('integrity_check', { simple: true }), 'ok');
  } finally { after.close(); }
});

test('partially created categories survive upgrade and missing product categories are added', () => {
  const dir = directory();
  const before = openCatalogDb(dir);
  before.prepare("INSERT INTO supplies(id,name,category,unit) VALUES ('grain','My malt','Grain','g')").run();
  before.prepare("INSERT INTO supplies(id,name,category,unit) VALUES ('hop','My hop','Hops','g')").run();
  before.prepare("INSERT INTO supply_categories(name,sort_order) VALUES ('Grain',4)").run();
  before.prepare("INSERT INTO supply_categories(name,sort_order) VALUES ('Juice & must',5)").run();
  before.pragma('user_version = 29');
  before.close();

  const after = openCatalogDb(dir);
  try {
    assert.deepEqual(after.prepare('SELECT name,sort_order FROM supply_categories ORDER BY sort_order,name').all(), [
      { name: 'Grain', sort_order: 4 }, { name: 'Juice & must', sort_order: 5 },
      { name: 'Hops', sort_order: 1000 }
    ]);
    assert.equal((after.prepare('SELECT count(*) AS n FROM supplies').get() as { n: number }).n, 2);
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
