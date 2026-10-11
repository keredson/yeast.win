import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { catalogSnapshot, openCatalogDb } from '../server/catalog.ts';

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
    const snapshot = catalogSnapshot(db, 1);
    assert.ok(!('unchanged' in snapshot));
    if ('unchanged' in snapshot) return;
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_vevor_35l')?.name,
      'VEVOR Electric Brewing System 9.2 Gal/35 L Brewing Pot');
    assert.deepEqual(snapshot.inventory.find(row => row.id === 'inventory_bottle_12oz'),
      { id: 'inventory_bottle_12oz', name: '12 oz bottle', category: 'Packaging', unit: 'each' });
    assert.ok(snapshot.inventory.length > 20);
  } finally { db.close(); }
});
