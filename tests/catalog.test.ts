import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { catalogChanges, openCatalogDb } from '../server/catalog.ts';
import { decodeChange } from '../shared/wire.ts';
import { changeColumns } from '../shared/schema.ts';
import { catalogEquipmentTable, catalogInventoryTable, catalogTables } from '../shared/catalog.ts';

function rows(db: Database.Database) {
  return {
    equipment: db.prepare('SELECT * FROM equipment').all() as { id: string; name: string; kind: string; built_in_temperature_control: number | null; max_pressure_kpa: number | null }[],
    inventory: db.prepare('SELECT * FROM inventory').all() as { id: string; name: string; category: string; unit: string }[]
  };
}

test('existing catalog gains new equipment and inventory without item capacity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = new Database(join(dir, 'catalog.sqlite'));
  old.exec(`CREATE TABLE catalog_meta(version INTEGER NOT NULL); INSERT INTO catalog_meta VALUES (1);
    CREATE TABLE catalog_equipment(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, specification_json TEXT);
    CREATE TABLE catalog_inventory(id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL);
    INSERT INTO catalog_inventory VALUES ('inventory_bottle_12oz', '12 oz bottle', 'Packaging', 'each');`);
  old.close();

  const db = openCatalogDb(dir);
  try {
    const snapshot = rows(db);
    assert.equal(db.pragma('user_version', { simple: true }), 10);
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_brewzilla_35l_g4')?.kind, 'all_in_one');
    const gf30 = snapshot.equipment.find(row => row.id === 'equipment_grainfather_gf30');
    assert.equal(gf30?.kind, 'fermenter');
    assert.equal(gf30?.built_in_temperature_control, 1);
    const pressureFermenter = snapshot.equipment.find(row => row.id === 'equipment_fermzilla_all_rounder_30l');
    assert.equal(pressureFermenter?.kind, 'fermenter');
    assert.ok((pressureFermenter?.max_pressure_kpa || 0) > 0);
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_inkbird_itc_308')?.kind, 'fermentation_temperature_control');
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_vevor_35l')?.name,
      'VEVOR Electric Brewing System 9.2 Gal/35 L Brewing Pot');
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_vevor_35l')?.kind, 'all_in_one');
    assert.equal((db.pragma('table_info(equipment)') as { name: string }[])
      .some(column => column.name === 'specification_json'), false);
    assert.deepEqual(snapshot.inventory.find(row => row.id === 'inventory_bottle_12oz'),
      { id: 'inventory_bottle_12oz', name: '12 oz bottle', category: 'Packaging', unit: 'each' });
    assert.ok(snapshot.inventory.length > 20);
    assert.equal(snapshot.inventory.find(row => row.id === 'inventory_lactic_acid')?.category, 'Adjunct');
  } finally { db.close(); }
});

test('existing catalog models use the combined fermentation control choice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = new Database(join(dir, 'catalog.sqlite'));
  old.exec(`CREATE TABLE catalog_meta(version INTEGER NOT NULL); INSERT INTO catalog_meta VALUES (4);
    CREATE TABLE catalog_equipment(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, specification_json TEXT);
    CREATE TABLE catalog_inventory(id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL);
    INSERT INTO catalog_equipment VALUES ('equipment_rapt_chamber', 'KegLand RAPT Fermentation Chamber', 'refrigerator', NULL);
    INSERT INTO catalog_equipment VALUES ('equipment_grainfather_gc4', 'Grainfather GC4 Glycol Chiller', 'glycol_chiller', NULL);`);
  old.close();

  const db = openCatalogDb(dir);
  try {
    const snapshot = rows(db);
    assert.equal(db.pragma('user_version', { simple: true }), 10);
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_rapt_chamber')?.kind, 'fermentation_temperature_control');
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_grainfather_gc4')?.kind, 'fermentation_temperature_control');
  } finally { db.close(); }
});

test('version 5 catalog restores VEVOR as an all-in-one system', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = new Database(join(dir, 'catalog.sqlite'));
  old.exec(`CREATE TABLE catalog_meta(version INTEGER NOT NULL); INSERT INTO catalog_meta VALUES (5);
    CREATE TABLE catalog_equipment(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, specification_json TEXT);
    CREATE TABLE catalog_inventory(id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL);
    INSERT INTO catalog_equipment VALUES ('equipment_vevor_35l', 'VEVOR Electric Brewing System 9.2 Gal/35 L Brewing Pot', 'kettle', NULL);`);
  old.close();

  const db = openCatalogDb(dir);
  try {
    const snapshot = rows(db);
    assert.equal(db.pragma('user_version', { simple: true }), 10);
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_vevor_35l')?.kind, 'all_in_one');
  } finally { db.close(); }
});

test('version 9 CRR catalog keeps direct server edits when removing prefixes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = new Database(join(dir, 'catalog.sqlite'));
  old.loadExtension(join(process.cwd(), 'vendor/crsqlite.so'));
  old.exec(`CREATE TABLE catalog_meta(version INTEGER NOT NULL); INSERT INTO catalog_meta VALUES (9);
    CREATE TABLE catalog_equipment(id TEXT PRIMARY KEY NOT NULL, name TEXT, kind TEXT);
    CREATE TABLE catalog_inventory(id TEXT PRIMARY KEY NOT NULL, name TEXT, category TEXT, unit TEXT)`);
  for (const table of ['catalog_equipment', 'catalog_inventory']) old.prepare('SELECT crsql_as_crr(?)').get(table);
  old.prepare('INSERT INTO catalog_inventory VALUES (?, ?, ?, ?)')
    .run('inventory_maris_otter', 'My edited malt', 'Grain', 'g');
  old.prepare('INSERT INTO catalog_inventory VALUES (?, ?, ?, ?)')
    .run('custom_ingredient', 'My custom grain', 'Grain', 'g');
  old.close();

  const db = openCatalogDb(dir);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 10);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'catalog_%'").all(), []);
    assert.equal((db.prepare('SELECT name FROM inventory WHERE id = ?').get('inventory_maris_otter') as { name: string }).name,
      'My edited malt');
    assert.equal((db.prepare('SELECT name FROM inventory WHERE id = ?').get('custom_ingredient') as { name: string }).name,
      'My custom grain');
    assert.ok(catalogChanges(db, 0n).changes.some(change => change.table === 'inventory'));
  } finally { db.close(); }
});

test('catalog sends only CR-SQLite changes after the client cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const db = openCatalogDb(dir);
  const replica = new Database(':memory:');
  replica.loadExtension(join(process.cwd(), 'vendor/crsqlite.so'));
  try {
    replica.exec(catalogEquipmentTable);
    replica.exec(catalogInventoryTable);
    for (const table of catalogTables) replica.prepare('SELECT crsql_as_crr(?)').get(table);
    const apply = replica.prepare(`INSERT INTO crsql_changes (${changeColumns.map(column => `"${column}"`).join(', ')})
      VALUES (${changeColumns.map(() => '?').join(', ')})`);
    const initial = catalogChanges(db, 0n);
    assert.ok(initial.changes.length > 0);
    for (const change of initial.changes) apply.run(...decodeChange(change));
    assert.deepEqual(rows(replica), rows(db));

    // A local-only row remains when the server updates a different row.
    replica.prepare('INSERT INTO inventory(id, name, category, unit) VALUES (?, ?, ?, ?)')
      .run('personal_ingredient', 'My grain', 'Grain', 'g');
    db.prepare('UPDATE inventory SET name = ? WHERE id = ?')
      .run('Updated Maris Otter', 'inventory_maris_otter');
    const delta = catalogChanges(db, BigInt(initial.serverCursor));
    assert.equal(delta.changes.length, 1);
    assert.equal(delta.changes[0].table, 'inventory');
    for (const change of delta.changes) apply.run(...decodeChange(change));
    assert.equal((replica.prepare('SELECT name FROM inventory WHERE id = ?')
      .get('inventory_maris_otter') as { name: string }).name, 'Updated Maris Otter');
    assert.equal((replica.prepare('SELECT name FROM inventory WHERE id = ?')
      .get('personal_ingredient') as { name: string }).name, 'My grain');
    assert.deepEqual(catalogChanges(db, BigInt(delta.serverCursor)).changes, []);

    db.prepare('DELETE FROM inventory WHERE id = ?').run('inventory_maris_otter');
    const deletion = catalogChanges(db, BigInt(delta.serverCursor));
    assert.ok(deletion.changes.length > 0);
    for (const change of deletion.changes) apply.run(...decodeChange(change));
    assert.equal(replica.prepare('SELECT id FROM inventory WHERE id = ?').get('inventory_maris_otter'), undefined);
    assert.equal((replica.prepare('SELECT name FROM inventory WHERE id = ?')
      .get('personal_ingredient') as { name: string }).name, 'My grain');
  } finally { replica.close(); db.close(); }
});
