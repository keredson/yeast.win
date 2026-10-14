import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceSchemaVersion } from '../shared/schema.ts';
import { catalogSchemaVersion } from '../shared/catalog.ts';

const directory = mkdtempSync(join(tmpdir(), 'brewlog-priming-sugar-'));
after(() => rmSync(directory, { recursive: true, force: true }));
process.env.BREWLOG_DATA_DIR = directory;
const { openCatalogDb } = await import('../server/catalog.ts');
const { openWorkspaceDb, closeWorkspaceDb } = await import('../server/db.ts');

test('catalog upgrade preserves edited categories and unrelated rows', () => {
  const before = openCatalogDb(directory);
  before.prepare("INSERT INTO supplies(id, name, category, unit) VALUES ('inventory_priming_sugar', 'Priming sugar', 'Other', 'g')").run();
  before.prepare("INSERT INTO supplies(id, name, category, unit) VALUES ('custom_other', 'Custom item', 'Other', 'each')").run();
  before.pragma('user_version = 27');
  before.close();

  const upgraded = openCatalogDb(directory);
  try {
    const category = (id: string) => (upgraded.prepare('SELECT category FROM supplies WHERE id = ?')
      .get(id) as { category: string }).category;
    assert.equal(category('inventory_priming_sugar'), 'Other');
    assert.equal(category('custom_other'), 'Other');
    assert.equal(upgraded.pragma('user_version', { simple: true }), catalogSchemaVersion);
  } finally { upgraded.close(); }

  const partial = openCatalogDb(directory);
  partial.pragma('user_version = 27');
  partial.close();
  const resumed = openCatalogDb(directory);
  try {
    assert.equal((resumed.prepare("SELECT category FROM supplies WHERE id = 'inventory_priming_sugar'")
      .get() as { category: string }).category, 'Other');
    assert.equal((resumed.prepare("SELECT category FROM supplies WHERE id = 'custom_other'")
      .get() as { category: string }).category, 'Other');
  } finally { resumed.close(); }
});

test('workspace upgrade reclassifies linked stock and retains other supplies', () => {
  const id = 'primingSugarTest';
  const before = openWorkspaceDb(id);
  before.prepare(`INSERT INTO supplies(id, name, category, default_unit, catalog_supply_id, created_at)
    VALUES ('priming_supply', 'Priming sugar', 'Other', 'g', 'inventory_priming_sugar', 1),
      ('other_supply', 'Other item', 'Other', 'each', NULL, 1)`).run();
  before.prepare(`INSERT INTO inventory_items(id, name, category, default_unit, supply_id, created_at)
    VALUES ('priming_stock', 'Priming sugar', 'Other', 'g', 'priming_supply', 1),
      ('other_stock', 'Other item', 'Other', 'each', 'other_supply', 1)`).run();
  before.pragma('user_version = 34');
  closeWorkspaceDb(before);

  const upgraded = openWorkspaceDb(id);
  try {
    const category = (table: string, rowId: string) => (upgraded.prepare(`SELECT category FROM ${table} WHERE id = ?`)
      .get(rowId) as { category: string }).category;
    assert.equal(category('supplies', 'priming_supply'), 'Other fermentables');
    assert.equal(category('inventory_items', 'priming_stock'), 'Other fermentables');
    assert.equal(category('supplies', 'other_supply'), 'Other');
    assert.equal(category('inventory_items', 'other_stock'), 'Other');
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
  } finally { closeWorkspaceDb(upgraded); }

  const partial = openWorkspaceDb(id);
  partial.pragma('user_version = 34');
  closeWorkspaceDb(partial);
  const resumed = openWorkspaceDb(id);
  try {
    assert.equal((resumed.prepare("SELECT category FROM supplies WHERE id = 'priming_supply'")
      .get() as { category: string }).category, 'Other fermentables');
    assert.equal((resumed.prepare("SELECT category FROM supplies WHERE id = 'other_supply'")
      .get() as { category: string }).category, 'Other');
  } finally { closeWorkspaceDb(resumed); }
});

test('version 35 and a partly added fermentable spec table preserve products and stock', () => {
  const id = 'otherFermentableTest';
  const before = openWorkspaceDb(id);
  before.prepare(`INSERT INTO supplies(id,name,category,default_unit,catalog_supply_id,created_at)
    VALUES ('linked','Priming sugar','Adjunct','g','inventory_priming_sugar',1),
      ('juice','Fresh cider','Other fermentables','L',NULL,1)`).run();
  before.prepare(`INSERT INTO inventory_items(id,name,category,default_unit,supply_id,created_at)
    VALUES ('stock','Priming sugar','Adjunct','g','linked',1)`).run();
  before.prepare(`INSERT INTO inventory_counts(id,inventory_item_id,quantity,unit,counted_at)
    VALUES ('count','stock',5,'g',1)`).run();
  before.prepare(`INSERT INTO supply_other_fermentable_specs(supply_id,typical_brix)
    VALUES ('juice',12.5)`).run();
  before.pragma('user_version = 35');
  closeWorkspaceDb(before);

  const after = openWorkspaceDb(id);
  try {
    assert.equal((after.prepare("SELECT category FROM supplies WHERE id='linked'").get() as { category: string }).category,
      'Other fermentables');
    assert.equal((after.prepare("SELECT category FROM inventory_items WHERE id='stock'").get() as { category: string }).category,
      'Other fermentables');
    assert.equal((after.prepare("SELECT typical_brix FROM supply_other_fermentable_specs WHERE supply_id='juice'")
      .get() as { typical_brix: number }).typical_brix, 12.5);
    assert.equal((after.prepare("SELECT quantity FROM inventory_counts WHERE id='count'").get() as { quantity: number }).quantity, 5);
    assert.equal(after.pragma('integrity_check', { simple: true }), 'ok');
  } finally { closeWorkspaceDb(after); }
});
