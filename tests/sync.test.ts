import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { SqlChangeRow } from '../shared/wire.ts';
import { changeTuple, encodeItem, syncProtocolVersion } from '../shared/cborSync.ts';
import { workspaceSchemaVersion, replicatedTables } from '../shared/schema.ts';

const directory = mkdtempSync(join(tmpdir(), 'brewlog-product-workspace-'));
process.env.BREWLOG_DATA_DIR = directory;
after(() => rmSync(directory, { recursive: true, force: true }));
const { openWorkspaceDb, closeWorkspaceDb } = await import('../server/db.ts');
const { receiveCborChanges } = await import('../server/sync.ts');

test('fresh workspace shares product identity across quantity stock and individual units', () => {
  const db = openWorkspaceDb(nanoid());
  try {
    assert.equal(db.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'equipment_archives'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'inventory_items'").get(), undefined);
    for (const table of replicatedTables) assert.ok(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE name = ?").get(`${table}__crsql_clock`), table);
    db.prepare('INSERT INTO products(id,name,catalog_product_id,created_at) VALUES (?,?,?,?)')
      .run('keg', 'Five gallon keg', 'catalog-keg', 1);
    db.prepare('INSERT INTO supply_specs(id,category,default_unit) VALUES (?,?,?)')
      .run('keg', 'Packaging', 'each');
    db.prepare('INSERT INTO equipment_model_specs(id,kind) VALUES (?,?)').run('keg', 'keg');
    db.prepare('INSERT INTO equipment(id,name,model_id,stock_id,created_at) VALUES (?,?,?,?,?)')
      .run('unit-1', 'Keg 1', 'keg', 'K-001', 1);
    db.prepare('INSERT INTO stock_buckets(id,name,category,default_unit,supply_id,created_at) VALUES (?,?,?,?,?,?)')
      .run('bucket-1', 'Five gallon keg', 'Packaging', 'each', 'keg', 1);
    assert.equal((db.prepare('SELECT name FROM supplies WHERE id = ?').get('keg') as { name: string }).name,
      'Five gallon keg');
    assert.equal((db.prepare('SELECT name FROM equipment_models WHERE id = ?').get('keg') as { name: string }).name,
      'Five gallon keg');
    assert.equal((db.prepare('SELECT model_id FROM equipment WHERE id = ?').get('unit-1') as { model_id: string }).model_id,
      'keg');
  } finally { closeWorkspaceDb(db); }
});

test('product, typed specifications, and stock bucket replicate together', () => {
  const source = openWorkspaceDb(nanoid());
  const target = openWorkspaceDb(nanoid());
  try {
    source.prepare('INSERT INTO products(id,name,created_at) VALUES (?,?,?)').run('keg', 'Keg', 1);
    source.prepare('INSERT INTO supply_specs(id,category,default_unit) VALUES (?,?,?)')
      .run('keg', 'Packaging', 'each');
    source.prepare('INSERT INTO equipment_model_specs(id,kind) VALUES (?,?)').run('keg', 'keg');
    source.prepare('INSERT INTO stock_buckets(id,name,category,default_unit,supply_id,created_at) VALUES (?,?,?,?,?,?)')
      .run('bucket', 'Keg', 'Packaging', 'each', 'keg', 1);
    const rows = source.prepare(`SELECT "table",pk,cid,val,col_version,db_version,
      COALESCE(site_id,crsql_site_id()) AS site_id,cl,seq FROM crsql_changes ORDER BY db_version,seq`)
      .safeIntegers().all() as SqlChangeRow[];
    receiveCborChanges(target, encodeItem([syncProtocolVersion, '0', '0', rows.map(changeTuple)]));
    assert.deepEqual(target.prepare('SELECT name FROM products WHERE id = ?').get('keg'), { name: 'Keg' });
    assert.deepEqual(target.prepare('SELECT category FROM supplies WHERE id = ?').get('keg'), { category: 'Packaging' });
    assert.deepEqual(target.prepare('SELECT kind FROM equipment_models WHERE id = ?').get('keg'), { kind: 'keg' });
    assert.deepEqual(target.prepare('SELECT supply_id FROM stock_buckets WHERE id = ?').get('bucket'), { supply_id: 'keg' });
  } finally { closeWorkspaceDb(source); closeWorkspaceDb(target); }
});
