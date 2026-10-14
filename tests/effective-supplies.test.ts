import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { effectiveSuppliesView } from '../shared/effectiveSupplies.ts';

test('effective supplies inherit live catalog specs and keep brewery overrides', () => {
  const db = new Database(':memory:');
  try {
    db.exec("ATTACH DATABASE ':memory:' AS catalog");
    db.exec(`CREATE TABLE supplies(id TEXT PRIMARY KEY, name TEXT, category TEXT,
      default_unit TEXT, catalog_supply_id TEXT);
      CREATE TABLE supply_grain_specs(supply_id TEXT PRIMARY KEY, grain_class TEXT,
        yield_pct REAL, color_lovibond REAL);
      CREATE TABLE supply_hop_specs(supply_id TEXT PRIMARY KEY, alpha_acid_pct REAL, hop_form TEXT);
      CREATE TABLE supply_yeast_specs(supply_id TEXT PRIMARY KEY, attenuation_pct REAL);
      CREATE TABLE supply_other_fermentable_specs(supply_id TEXT PRIMARY KEY, typical_brix REAL,
        extract_color_value REAL, extract_color_scale TEXT, extract_color_reference_value REAL,
        extract_color_reference_unit TEXT);
      CREATE TABLE supply_container_specs(supply_id TEXT PRIMARY KEY, container_kind TEXT, capacity_liters REAL,
        material TEXT, wood_species TEXT, wood_origin TEXT, connector_type TEXT);
      CREATE TABLE catalog.supply_grain_specs(supply_id TEXT PRIMARY KEY, yield_pct REAL, color_lovibond REAL);
      CREATE TABLE catalog.supply_grain_classes(supply_id TEXT PRIMARY KEY, grain_class TEXT);
      CREATE TABLE catalog.supply_hop_specs(supply_id TEXT PRIMARY KEY, alpha_acid_pct REAL, hop_form TEXT);
      CREATE TABLE catalog.supply_yeast_specs(supply_id TEXT PRIMARY KEY, attenuation_pct REAL);
      CREATE TABLE catalog.supply_other_fermentable_specs(supply_id TEXT PRIMARY KEY, typical_brix REAL,
        extract_color_value REAL, extract_color_scale TEXT, extract_color_reference_value REAL,
        extract_color_reference_unit TEXT);
      CREATE TABLE catalog.supply_container_specs(supply_id TEXT PRIMARY KEY, container_kind TEXT, capacity_liters REAL,
        material TEXT, wood_species TEXT, wood_origin TEXT, connector_type TEXT)`);
    db.exec(effectiveSuppliesView);
    db.prepare('INSERT INTO supplies VALUES (?, ?, ?, ?, ?)').run('local', 'Bonlander', 'Grain', 'kg', 'catalog-grain');
    db.prepare('INSERT INTO catalog.supply_grain_specs VALUES (?, ?, ?)').run('catalog-grain', 78, 10);
    const read = db.prepare('SELECT yield_pct, color_lovibond FROM effective_supplies WHERE id = ?');
    assert.deepEqual(read.get('local'), { yield_pct: 78, color_lovibond: 10 });
    db.prepare('UPDATE catalog.supply_grain_specs SET color_lovibond = ? WHERE supply_id = ?')
      .run(11, 'catalog-grain');
    assert.deepEqual(read.get('local'), { yield_pct: 78, color_lovibond: 11 });
    db.prepare('INSERT INTO supply_grain_specs(supply_id, color_lovibond) VALUES (?, ?)').run('local', 12);
    assert.deepEqual(read.get('local'), { yield_pct: 78, color_lovibond: 12 });
    db.prepare('INSERT INTO supplies VALUES (?, ?, ?, ?, ?)').run('local-keg', 'My keg', 'Packaging', 'each', 'catalog-keg');
    db.prepare('INSERT INTO catalog.supply_container_specs VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('catalog-keg', 'keg', 18.927, 'stainless steel', null, null, 'ball lock');
    const container = db.prepare('SELECT container_kind,capacity_liters,material,connector_type FROM effective_supplies WHERE id = ?');
    assert.deepEqual(container.get('local-keg'), { container_kind: 'keg', capacity_liters: 18.927,
      material: 'stainless steel', connector_type: 'ball lock' });
    db.prepare('INSERT INTO supply_container_specs(supply_id,connector_type) VALUES (?, ?)')
      .run('local-keg', 'pin lock');
    assert.deepEqual(container.get('local-keg'), { container_kind: 'keg', capacity_liters: 18.927,
      material: 'stainless steel', connector_type: 'pin lock' });
  } finally { db.close(); }
});
