import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { catalogChanges, openCatalogDb } from '../server/catalog.ts';
import { decodeChange } from '../shared/wire.ts';
import { changeColumns } from '../shared/schema.ts';
import { catalogModelTables, catalogSupplyTables, catalogTables, catalogSchemaVersion } from '../shared/catalog.ts';

const legacyInventoryTable = `CREATE TABLE inventory(id TEXT PRIMARY KEY NOT NULL, name TEXT, category TEXT, unit TEXT)`;
const legacyCatalogTables = [...Object.keys(catalogModelTables).filter(table => table !== 'model_boil_characterization'), 'inventory'];

function rows(db: Database.Database) {
  return {
    equipment: db.prepare(`SELECT m.id, m.model_name AS name, m.kind,
      CASE WHEN control.model_id IS NOT NULL THEN 1 ELSE NULL END AS built_in_temperature_control,
      pressure.max_pressure_kpa FROM equipment_models m
      LEFT JOIN model_temperature_control control ON control.model_id = m.id
      LEFT JOIN model_pressure_rating pressure ON pressure.model_id = m.id`).all() as {
      id: string; name: string; kind: string; built_in_temperature_control: number | null; max_pressure_kpa: number | null }[],
    inventory: db.prepare('SELECT * FROM supplies').all() as { id: string; name: string; category: string; unit: string }[]
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
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_brewzilla_35l_g4')?.kind, 'all_in_one');
    const gf30 = snapshot.equipment.find(row => row.id === 'equipment_grainfather_gf30');
    assert.equal(gf30?.kind, 'fermenter');
    assert.equal(gf30?.built_in_temperature_control, 1);
    const pressureFermenter = snapshot.equipment.find(row => row.id === 'equipment_fermzilla_all_rounder_30l');
    assert.equal(pressureFermenter?.kind, 'fermenter');
    assert.ok((pressureFermenter?.max_pressure_kpa || 0) > 0);
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_inkbird_itc_308')?.kind, 'fermentation_temperature_control');
    assert.equal(snapshot.equipment.some(row => row.id === 'equipment_inkbird_itc_308_wifi'), false);
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_anton_paar_easydens')?.kind, 'hydrometer');
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_vevor_35l')?.name,
      'VEVOR Electric Brewing System 9.2 Gal/35 L');
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_vevor_35l')?.kind, 'all_in_one');
    assert.equal((db.prepare('SELECT capacity_liters FROM model_liquid_containment WHERE model_id = ?')
      .get('equipment_vevor_35l') as { capacity_liters: number }).capacity_liters, 35);
    assert.ok(db.prepare('SELECT model_id FROM model_heating WHERE model_id = ?').get('equipment_vevor_35l'));
    assert.ok(db.prepare('SELECT model_id FROM model_temperature_control WHERE model_id = ?').get('equipment_vevor_35l'));
    assert.deepEqual((db.prepare('SELECT measurement_kind FROM model_measurement_channels WHERE model_id = ? ORDER BY measurement_kind')
      .all('equipment_rapt_pill') as { measurement_kind: string }[]).map(row => row.measurement_kind),
    ['gravity', 'temperature']);
    assert.equal((db.pragma('table_info(equipment_models)') as { name: string }[])
      .some(column => column.name === 'specification_json'), false);
    assert.deepEqual(snapshot.inventory.find(row => row.id === 'inventory_bottle_12oz'),
      { id: 'inventory_bottle_12oz', name: '12 oz bottle', category: 'Packaging', unit: 'each' });
    assert.ok(snapshot.inventory.length > 20);
    assert.equal(snapshot.inventory.find(row => row.id === 'inventory_lactic_acid')?.category, 'Adjunct');
  } finally { db.close(); }
});

test('ingredient catalog migration adds named products and preserves catalog edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-supply-products-'));
  const before = openCatalogDb(dir);
  before.prepare('INSERT INTO supplies(id, name, category, unit) VALUES (?, ?, ?, ?)')
    .run('custom_supply', 'Custom orange peel', 'Adjunct', 'g');
  before.prepare('UPDATE supply_products SET product_url = ? WHERE supply_id = ?')
    .run('https://example.com/my-malt', 'supply_briess_pale_ale');
  before.pragma('user_version = 21');
  before.close();
  const upgraded = openCatalogDb(dir);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.ok(upgraded.prepare('SELECT 1 FROM supplies WHERE id = ?').get('custom_supply'));
    assert.equal((upgraded.prepare('SELECT product_url FROM supply_products WHERE supply_id = ?')
      .get('supply_briess_pale_ale') as { product_url: string }).product_url, 'https://example.com/my-malt');
    assert.equal((upgraded.prepare('SELECT grain_class FROM supply_grain_classes WHERE supply_id = ?')
      .get('supply_weyermann_munich_type_2') as { grain_class: string }).grain_class, 'kilned');
    assert.equal((upgraded.prepare('SELECT yield_pct FROM supply_grain_specs WHERE supply_id = ?')
      .get('supply_briess_caramel_60') as { yield_pct: number }).yield_pct, 77);
    assert.equal(upgraded.prepare('SELECT 1 FROM supplies WHERE id = ?').get('inventory_munich_malt'), undefined);
    assert.ok(upgraded.prepare('SELECT 1 FROM supplies WHERE id = ?').get('inventory_bottle_12oz'));
    assert.ok((upgraded.prepare('SELECT length(image_bytes) AS bytes FROM supply_images WHERE supply_id = ?')
      .get('supply_briess_caramel_60') as { bytes: number }).bytes > 1000);
  } finally { upgraded.close(); }
});

test('version 22 catalog adds later bundled ingredient photos without overwriting edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-supply-photos-'));
  const before = openCatalogDb(dir);
  const edited = Buffer.from([255, 216, 255, 1, 2]);
  before.prepare('DELETE FROM supply_images WHERE supply_id = ?').run('supply_weyermann_pilsner');
  before.prepare('UPDATE supply_images SET image_bytes = ? WHERE supply_id = ?')
    .run(edited, 'supply_briess_pale_ale');
  before.pragma('user_version = 22');
  before.close();
  const upgraded = openCatalogDb(dir);
  try {
    assert.ok((upgraded.prepare('SELECT length(image_bytes) AS bytes FROM supply_images WHERE supply_id = ?')
      .get('supply_weyermann_pilsner') as { bytes: number }).bytes > 1000);
    assert.deepEqual((upgraded.prepare('SELECT image_bytes FROM supply_images WHERE supply_id = ?')
      .get('supply_briess_pale_ale') as { image_bytes: Buffer }).image_bytes, edited);
  } finally { upgraded.close(); }
});

test('version 23 catalog adds Lallemand package photos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-lallemand-photos-'));
  const before = openCatalogDb(dir);
  before.prepare('DELETE FROM supply_images WHERE supply_id = ?').run('supply_lallemand_nottingham');
  before.pragma('user_version = 23');
  before.close();
  const upgraded = openCatalogDb(dir);
  try {
    assert.ok((upgraded.prepare('SELECT length(image_bytes) AS bytes FROM supply_images WHERE supply_id = ?')
      .get('supply_lallemand_nottingham') as { bytes: number }).bytes > 1000);
  } finally { upgraded.close(); }
});

test('version 21 separates US and EU VEVOR systems without replacing catalog edits', () => {
  for (const edited of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'brewlog-vevor-region-'));
    const db = openCatalogDb(dir);
    const customImage = Buffer.from([255, 216, 255, 1, 2]);
    db.prepare('UPDATE equipment_models SET product_url = ? WHERE id = ?').run(
      edited ? 'https://example.com/my-vevor' :
        'https://eur.vevor.com/beer-brewing-system-c_11816/vevor-all-in-one-grain-brewing-system-home-beer-brewer-w-circulating-pump-30-l-p_010108577563',
      'equipment_vevor_35l');
    db.prepare('UPDATE model_heating SET rated_power_watts = ? WHERE model_id = ?')
      .run(edited ? 2100 : 2500, 'equipment_vevor_35l');
    db.prepare('UPDATE model_images SET image_bytes = ?, thumbnail_bytes = ? WHERE model_id = ?')
      .run(edited ? customImage : readFileSync('assets/catalog/models/equipment_vevor_35l_220v.jpg'),
        edited ? customImage : readFileSync('assets/catalog/models/equipment_vevor_35l_220v-thumb.jpg'),
        'equipment_vevor_35l');
    if (!edited) {
      for (const table of ['model_images', 'model_temperature_control', 'model_heating', 'model_liquid_containment']) {
        db.prepare(`DELETE FROM ${table} WHERE model_id = ?`)
          .run('equipment_vevor_35l_220v');
      }
      db.prepare('DELETE FROM equipment_models WHERE id = ?').run('equipment_vevor_35l_220v');
    }
    db.prepare('INSERT INTO supplies(id, name, category, unit) VALUES (?, ?, ?, ?)')
      .run('my_grain', 'My grain', 'Grain', 'g');
    db.pragma('user_version = 20');
    db.close();

    const upgraded = openCatalogDb(dir);
    try {
      assert.equal(upgraded.pragma('user_version', { simple: true }), catalogSchemaVersion);
      const us = upgraded.prepare('SELECT product_url FROM equipment_models WHERE id = ?')
        .get('equipment_vevor_35l') as { product_url: string };
      assert.equal(us.product_url, edited ? 'https://example.com/my-vevor'
        : 'https://www.vevor.com/beer-brewing-system-c_11816/vevor-home-beer-brewing-machine-grain-brewing-system-w-circulating-pump-8-gal-p_010556912690');
      assert.equal((upgraded.prepare('SELECT rated_power_watts FROM model_heating WHERE model_id = ?')
        .get('equipment_vevor_35l') as { rated_power_watts: number }).rated_power_watts, edited ? 2100 : 1800);
      const usImage = upgraded.prepare('SELECT image_bytes FROM model_images WHERE model_id = ?')
        .get('equipment_vevor_35l') as { image_bytes: Buffer };
      assert.deepEqual(usImage.image_bytes, edited ? customImage : readFileSync('assets/catalog/models/equipment_vevor_35l.jpg'));
      assert.equal((upgraded.prepare('SELECT name FROM supplies WHERE id = ?').get('my_grain') as { name: string }).name,
        'My grain');
      assert.equal((upgraded.prepare('SELECT rated_power_watts FROM model_heating WHERE model_id = ?')
        .get('equipment_vevor_35l_220v') as { rated_power_watts: number }).rated_power_watts, 2500);
      assert.deepEqual((upgraded.prepare('SELECT image_bytes FROM model_images WHERE model_id = ?')
        .get('equipment_vevor_35l_220v') as { image_bytes: Buffer }).image_bytes,
      readFileSync('assets/catalog/models/equipment_vevor_35l_220v.jpg'));
    } finally { upgraded.close(); }
  }
});

test('version 11 catalog adds Anton Paar instruments without replacing existing rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = new Database(join(dir, 'catalog.sqlite'));
  old.loadExtension(join(process.cwd(), 'vendor/crsqlite.so'));
  for (const statement of Object.values(catalogModelTables)) old.exec(statement);
  old.exec(legacyInventoryTable);
  for (const table of legacyCatalogTables) old.prepare('SELECT crsql_as_crr(?)').get(table);
  old.prepare('INSERT INTO equipment_models(id, model_name, kind) VALUES (?, ?, ?)')
    .run('my_meter', 'My meter', 'hydrometer');
  old.prepare('INSERT INTO inventory(id, name, category, unit) VALUES (?, ?, ?, ?)')
    .run('my_grain', 'My grain', 'Grain', 'g');
  old.pragma('user_version = 11');
  old.close();

  const db = openCatalogDb(dir);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal((db.prepare('SELECT model_name FROM equipment_models WHERE id = ?')
      .get('my_meter') as { model_name: string }).model_name, 'My meter');
    assert.equal((db.prepare('SELECT name FROM supplies WHERE id = ?')
      .get('my_grain') as { name: string }).name, 'My grain');
    assert.equal((db.prepare('SELECT measurement_scale FROM model_measurement_channels WHERE id = ?')
      .get('equipment_anton_paar_easydens:gravity') as { measurement_scale: string }).measurement_scale, 'SG');
    assert.equal((db.prepare('SELECT measurement_kind FROM model_measurement_channels WHERE id = ?')
      .get('equipment_anton_paar_cboxqc:dissolved_oxygen') as { measurement_kind: string }).measurement_kind,
      'dissolved_oxygen');
    assert.equal(db.prepare('SELECT id FROM equipment_models WHERE id = ?')
      .get('equipment_inkbird_itc_308_wifi'), undefined);
    assert.ok(catalogChanges(db, 0n).changes.some(change => change.table === 'equipment_models'));
  } finally { db.close(); }
});

test('version 12 catalog adds replicated boil defaults while preserving catalog edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = new Database(join(dir, 'catalog.sqlite'));
  old.loadExtension(join(process.cwd(), 'vendor/crsqlite.so'));
  for (const [name, statement] of Object.entries(catalogModelTables)) {
    if (name !== 'model_boil_characterization') old.exec(statement);
  }
  old.exec(legacyInventoryTable);
  for (const table of legacyCatalogTables) {
    if (table !== 'model_boil_characterization') old.prepare('SELECT crsql_as_crr(?)').get(table);
  }
  old.prepare('INSERT INTO equipment_models(id, model_name, kind) VALUES (?, ?, ?)')
    .run('my_kettle', 'My edited kettle', 'electric_kettle');
  old.prepare('INSERT INTO inventory(id, name, category, unit) VALUES (?, ?, ?, ?)')
    .run('my_grain', 'My grain', 'Grain', 'g');
  old.pragma('user_version = 12');
  old.close();

  const db = openCatalogDb(dir);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal((db.prepare('SELECT model_name FROM equipment_models WHERE id = ?')
      .get('my_kettle') as { model_name: string }).model_name, 'My edited kettle');
    assert.equal((db.prepare('SELECT name FROM supplies WHERE id = ?')
      .get('my_grain') as { name: string }).name, 'My grain');
    const cursor = BigInt(catalogChanges(db, 0n).serverCursor);
    db.prepare('INSERT INTO model_boil_characterization(model_id, heat_loss_watts) VALUES (?, ?)')
      .run('my_kettle', 0);
    const delta = catalogChanges(db, cursor);
    assert.ok(delta.changes.some(change => change.table === 'model_boil_characterization'));
    assert.equal((db.prepare('SELECT heat_loss_watts FROM model_boil_characterization WHERE model_id = ?')
      .get('my_kettle') as { heat_loss_watts: number }).heat_loss_watts, 0);
  } finally { db.close(); }
});

test('version 14 catalog gains manufacturers, product media, and models without replacing edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = new Database(join(dir, 'catalog.sqlite'));
  old.loadExtension(join(process.cwd(), 'vendor/crsqlite.so'));
  old.exec(`CREATE TABLE equipment_models(id TEXT PRIMARY KEY NOT NULL, manufacturer TEXT, model_name TEXT, kind TEXT)`);
  for (const [name, statement] of Object.entries({ ...catalogModelTables, ...catalogSupplyTables })) {
    if (name !== 'manufacturers' && name !== 'equipment_models') old.exec(statement);
  }
  for (const table of ['equipment_models', ...catalogTables.filter(table => table !== 'manufacturers' && table !== 'equipment_models')]) {
    old.prepare('SELECT crsql_as_crr(?)').get(table);
  }
  old.prepare('INSERT INTO equipment_models(id, manufacturer, model_name, kind) VALUES (?, ?, ?, ?)')
    .run('equipment_vevor_35l', null, 'My renamed VEVOR', 'all_in_one');
  old.prepare('INSERT INTO model_heating(model_id, rated_power_watts) VALUES (?, ?)').run('equipment_vevor_35l', 2100);
  old.prepare('INSERT INTO supplies(id, name, category, unit) VALUES (?, ?, ?, ?)').run('my_hop', 'My hop', 'Hops', 'g');
  old.pragma('user_version = 14');
  old.close();

  const db = openCatalogDb(dir);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    const vevor = db.prepare(`SELECT manufacturer, model_name, product_url
      FROM equipment_models WHERE id = 'equipment_vevor_35l'`).get() as Record<string, string>;
    assert.equal(vevor.model_name, 'My renamed VEVOR');
    assert.equal(vevor.manufacturer, 'VEVOR');
    assert.match(vevor.product_url, /vevor\.com/);
    assert.equal((db.prepare("SELECT image_mime_type FROM model_images WHERE model_id = 'equipment_vevor_35l'")
      .get() as { image_mime_type: string }).image_mime_type, 'image/jpeg');
    assert.equal((db.prepare("SELECT rated_power_watts FROM model_heating WHERE model_id = 'equipment_vevor_35l'")
      .get() as { rated_power_watts: number }).rated_power_watts, 2100);
    assert.equal((db.prepare("SELECT name FROM supplies WHERE id = 'my_hop'").get() as { name: string }).name, 'My hop');
    assert.equal((db.prepare("SELECT capacity_liters FROM model_liquid_containment WHERE model_id = 'equipment_spike_flex_plus_7gal'")
      .get() as { capacity_liters: number }).capacity_liters, 26.4979);
    assert.equal((db.prepare("SELECT website_url FROM manufacturers WHERE name = 'Spike Brewing'")
      .get() as { website_url: string }).website_url, 'https://spikebrewing.com/');
    assert.ok(catalogChanges(db, 0n).changes.some(change => change.table === 'manufacturers'));
  } finally { db.close(); }
});

test('version 16 catalog removes obsolete media URLs and preserves stored media and unrelated rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = openCatalogDb(dir);
  old.prepare("SELECT crsql_begin_alter('equipment_models')").get();
  old.exec('ALTER TABLE equipment_models ADD COLUMN image_url TEXT; ALTER TABLE equipment_models ADD COLUMN thumbnail_url TEXT');
  old.prepare("SELECT crsql_commit_alter('equipment_models')").get();
  old.prepare("SELECT crsql_begin_alter('manufacturers')").get();
  old.exec('ALTER TABLE manufacturers ADD COLUMN logo_url TEXT');
  old.prepare("SELECT crsql_commit_alter('manufacturers')").get();
  old.prepare("UPDATE equipment_models SET image_url = 'https://example.test/old.png' WHERE id = 'equipment_vevor_35l'").run();
  old.prepare("UPDATE manufacturers SET logo_url = 'https://example.test/old-logo.png' WHERE name = 'Spike Brewing'").run();
  old.prepare("INSERT INTO supplies(id, name, category, unit) VALUES ('my_supply', 'My supply', 'Grain', 'g')").run();
  old.prepare("DELETE FROM model_images WHERE model_id = 'equipment_tilt'").run();
  old.pragma('user_version = 16');
  old.close();
  const db = openCatalogDb(dir);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal((db.prepare("SELECT website_url FROM manufacturers WHERE name = 'Spike Brewing'")
      .get() as { website_url: string }).website_url, 'https://spikebrewing.com/');
    assert.equal((db.prepare("SELECT name FROM supplies WHERE id = 'my_supply'")
      .get() as { name: string }).name, 'My supply');
    assert.equal((db.prepare("SELECT image_mime_type FROM model_images WHERE model_id = 'equipment_tilt'")
      .get() as { image_mime_type: string }).image_mime_type, 'image/jpeg');
    assert.equal((db.pragma('table_info(equipment_models)') as { name: string }[])
      .some(column => column.name === 'image_url' || column.name === 'thumbnail_url'), false);
    assert.equal((db.pragma('table_info(manufacturers)') as { name: string }[])
      .some(column => column.name === 'logo_url'), false);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'manufacturers__crsql_clock'").get());
  } finally { db.close(); }
});

test('version 15 catalog seeds offline media and preserves partially upgraded image rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = openCatalogDb(dir);
  old.prepare("SELECT crsql_as_table('model_images')").get();
  const replacement = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  old.prepare('UPDATE model_images SET image_bytes = ?, image_mime_type = NULL WHERE model_id = ?')
    .run(replacement, 'equipment_spike_flex_plus_7gal');
  old.pragma('user_version = 15');
  old.close();

  const db = openCatalogDb(dir);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    const stored = db.prepare('SELECT image_bytes, image_mime_type, thumbnail_bytes, thumbnail_mime_type FROM model_images WHERE model_id = ?')
      .get('equipment_spike_flex_plus_7gal') as {
      image_bytes: Buffer; image_mime_type: string; thumbnail_bytes: Buffer; thumbnail_mime_type: string };
    assert.deepEqual(stored.image_bytes, replacement);
    assert.equal(stored.image_mime_type, 'image/jpeg');
    assert.ok(stored.thumbnail_bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
    assert.equal(stored.thumbnail_mime_type, 'image/jpeg');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'model_images__crsql_clock'").get());
    assert.ok((db.prepare('SELECT COUNT(*) AS count FROM manufacturer_logos').get() as { count: number }).count > 0);
  } finally { db.close(); }
});

test('version 17 catalog identifies existing WebP and PNG media without replacing edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = openCatalogDb(dir);
  for (const [table, renamed, removed] of [
    ['model_images', [['image_bytes', 'image_webp'], ['thumbnail_bytes', 'thumbnail_webp']],
      ['image_mime_type', 'thumbnail_mime_type']],
    ['manufacturer_logos', [['image_bytes', 'image_webp']], ['mime_type']]
  ] as const) {
    old.prepare('SELECT crsql_begin_alter(?)').get(table);
    for (const [current, prior] of renamed) old.exec(`ALTER TABLE ${table} RENAME COLUMN ${current} TO ${prior}`);
    for (const column of removed) old.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    old.prepare('SELECT crsql_commit_alter(?)').get(table);
  }
  const webp = Buffer.from('RIFF0000WEBPcustom-image');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
  old.prepare('UPDATE model_images SET image_webp = ?, thumbnail_webp = ? WHERE model_id = ?')
    .run(webp, png, 'equipment_tilt');
  old.prepare('UPDATE manufacturer_logos SET image_webp = ? WHERE manufacturer_name = ?')
    .run(png, 'KegLand');
  old.prepare("INSERT INTO supplies(id, name, category, unit) VALUES ('my_grain', 'My grain', 'Grain', 'g')").run();
  old.pragma('user_version = 17');
  old.close();

  const db = openCatalogDb(dir);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    const model = db.prepare('SELECT image_bytes, image_mime_type, thumbnail_bytes, thumbnail_mime_type FROM model_images WHERE model_id = ?')
      .get('equipment_tilt') as { image_bytes: Buffer; image_mime_type: string;
        thumbnail_bytes: Buffer; thumbnail_mime_type: string };
    assert.deepEqual(model.image_bytes, webp);
    assert.equal(model.image_mime_type, 'image/webp');
    assert.deepEqual(model.thumbnail_bytes, png);
    assert.equal(model.thumbnail_mime_type, 'image/png');
    const logo = db.prepare('SELECT image_bytes, mime_type FROM manufacturer_logos WHERE manufacturer_name = ?')
      .get('KegLand') as { image_bytes: Buffer; mime_type: string };
    assert.deepEqual(logo.image_bytes, png);
    assert.equal(logo.mime_type, 'image/png');
    assert.equal((db.prepare("SELECT name FROM supplies WHERE id = 'my_grain'")
      .get() as { name: string }).name, 'My grain');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'model_images__crsql_clock'").get());
  } finally { db.close(); }
});

test('version 18 catalog replaces bundled WebP media while retaining edited images and supplies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = openCatalogDb(dir);
  const fixture = (name: string) => readFileSync(join(process.cwd(), 'tests/fixtures/catalog-version-18', name));
  const originalImage = fixture('smartref-image.bin');
  const originalThumbnail = fixture('smartref-thumbnail.bin');
  const originalLogo = fixture('clawhammer-logo.bin');
  old.prepare(`UPDATE model_images SET image_bytes = ?, image_mime_type = 'image/webp',
    thumbnail_bytes = ?, thumbnail_mime_type = 'image/webp' WHERE model_id = ?`)
    .run(originalImage, originalThumbnail, 'equipment_anton_paar_smartref');
  old.prepare("UPDATE manufacturer_logos SET image_bytes = ?, mime_type = 'image/webp' WHERE manufacturer_name = ?")
    .run(originalLogo, 'Clawhammer Supply');
  const custom = Buffer.from('RIFF0000WEBPmy-custom-photo');
  old.prepare("UPDATE model_images SET image_bytes = ?, image_mime_type = 'image/webp' WHERE model_id = ?")
    .run(custom, 'equipment_tilt');
  old.prepare("INSERT INTO supplies(id, name, category, unit) VALUES ('my_supply', 'My supply', 'Grain', 'g')").run();
  const cursor = BigInt((old.prepare('SELECT crsql_db_version() AS version').get() as { version: number }).version);
  old.pragma('user_version = 18');
  old.close();

  const db = openCatalogDb(dir);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    const updated = db.prepare(`SELECT image_bytes, image_mime_type, thumbnail_bytes, thumbnail_mime_type
      FROM model_images WHERE model_id = ?`).get('equipment_anton_paar_smartref') as {
      image_bytes: Buffer; image_mime_type: string; thumbnail_bytes: Buffer; thumbnail_mime_type: string };
    assert.equal(updated.image_mime_type, 'image/jpeg');
    assert.equal(updated.thumbnail_mime_type, 'image/jpeg');
    assert.deepEqual(updated.image_bytes, readFileSync(join(process.cwd(),
      'assets/catalog/models/equipment_anton_paar_smartref.jpg')));
    assert.deepEqual(updated.thumbnail_bytes, readFileSync(join(process.cwd(),
      'assets/catalog/models/equipment_anton_paar_smartref-thumb.jpg')));
    const logo = db.prepare('SELECT image_bytes, mime_type FROM manufacturer_logos WHERE manufacturer_name = ?')
      .get('Clawhammer Supply') as { image_bytes: Buffer; mime_type: string };
    assert.equal(logo.mime_type, 'image/png');
    assert.deepEqual(logo.image_bytes, readFileSync(join(process.cwd(),
      'assets/catalog/manufacturers/clawhammer-supply.png')));
    const edited = db.prepare('SELECT image_bytes, image_mime_type FROM model_images WHERE model_id = ?')
      .get('equipment_tilt') as { image_bytes: Buffer; image_mime_type: string };
    assert.deepEqual(edited.image_bytes, custom);
    assert.equal(edited.image_mime_type, 'image/webp');
    assert.equal((db.prepare("SELECT name FROM supplies WHERE id = 'my_supply'")
      .get() as { name: string }).name, 'My supply');
    assert.ok(catalogChanges(db, cursor).changes.some(change => change.table === 'model_images'));
    assert.ok(catalogChanges(db, cursor).changes.some(change => change.table === 'manufacturer_logos'));
  } finally { db.close(); }
});

test('partially upgraded catalog preserves boil defaults when enabling replication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const db = openCatalogDb(dir);
  db.prepare('INSERT INTO model_boil_characterization(model_id, heat_loss_watts) VALUES (?, ?)')
    .run('equipment_vevor_35l', 325);
  db.prepare("SELECT crsql_as_table('model_boil_characterization')").get();
  db.pragma('user_version = 12');
  db.close();

  const upgraded = openCatalogDb(dir);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal((upgraded.prepare('SELECT heat_loss_watts FROM model_boil_characterization WHERE model_id = ?')
      .get('equipment_vevor_35l') as { heat_loss_watts: number }).heat_loss_watts, 325);
    assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE name = 'model_boil_characterization__crsql_clock'").get());
  } finally { upgraded.close(); }
});

test('partially upgraded supply catalog preserves existing supply specs and old inventory rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const db = openCatalogDb(dir);
  db.prepare('INSERT INTO supplies(id, name, category, unit) VALUES (?, ?, ?, ?)')
    .run('custom_supply', 'Custom hops', 'Hops', 'g');
  db.prepare('INSERT INTO supply_hop_specs(supply_id, alpha_acid_pct) VALUES (?, ?)')
    .run('custom_supply', 12.5);
  db.exec(legacyInventoryTable);
  db.prepare("SELECT crsql_as_crr('inventory')").get();
  db.prepare('INSERT INTO inventory(id, name, category, unit) VALUES (?, ?, ?, ?)')
    .run('old_supply', 'Old grain', 'Grain', 'g');
  db.pragma('user_version = 13');
  db.close();
  const upgraded = openCatalogDb(dir);
  try {
    assert.equal((upgraded.prepare('SELECT name FROM supplies WHERE id = ?')
      .get('old_supply') as { name: string }).name, 'Old grain');
    assert.equal((upgraded.prepare('SELECT alpha_acid_pct FROM supply_hop_specs WHERE supply_id = ?')
      .get('custom_supply') as { alpha_acid_pct: number }).alpha_acid_pct, 12.5);
    assert.equal(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'inventory'").get(), undefined);
  } finally { upgraded.close(); }
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
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
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
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal(snapshot.equipment.find(row => row.id === 'equipment_vevor_35l')?.kind, 'all_in_one');
  } finally { db.close(); }
});

test('existing catalog updates previous VEVOR names and preserves edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const db = openCatalogDb(dir);
  try {
    db.prepare('UPDATE equipment_models SET model_name = ? WHERE id = ?')
      .run('VEVOR 35 L', 'equipment_vevor_35l');
  } finally { db.close(); }
  const upgraded = openCatalogDb(dir);
  try {
    assert.equal((upgraded.prepare('SELECT model_name FROM equipment_models WHERE id = ?')
      .get('equipment_vevor_35l') as { model_name: string }).model_name,
      'VEVOR Electric Brewing System 9.2 Gal/35 L');
    upgraded.prepare('UPDATE equipment_models SET model_name = ? WHERE id = ?')
      .run('VEVOR Electric Brewing System 9.2 Gal/35 L Brewing Pot', 'equipment_vevor_35l');
  } finally { upgraded.close(); }
  const legacy = openCatalogDb(dir);
  try {
    assert.equal((legacy.prepare('SELECT model_name FROM equipment_models WHERE id = ?')
      .get('equipment_vevor_35l') as { model_name: string }).model_name,
      'VEVOR Electric Brewing System 9.2 Gal/35 L');
    legacy.prepare('UPDATE equipment_models SET model_name = ? WHERE id = ?')
      .run('My VEVOR', 'equipment_vevor_35l');
  } finally { legacy.close(); }
  const reopened = openCatalogDb(dir);
  try {
    assert.equal((reopened.prepare('SELECT model_name FROM equipment_models WHERE id = ?')
      .get('equipment_vevor_35l') as { model_name: string }).model_name, 'My VEVOR');
  } finally { reopened.close(); }
});

test('catalog spec and media refresh fills gaps without replacing catalog edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const old = openCatalogDb(dir);
  try {
    old.prepare('UPDATE model_liquid_containment SET capacity_liters = NULL WHERE model_id = ?')
      .run('equipment_grainfather_g40');
    old.prepare('UPDATE model_heating SET rated_power_watts = ? WHERE model_id = ?')
      .run(2900, 'equipment_grainfather_g40');
    old.prepare('UPDATE model_cooling SET rated_heat_removal_watts = NULL WHERE model_id = ?')
      .run('equipment_grainfather_gc4');
    old.prepare('UPDATE model_measurement_channels SET measurement_max = NULL WHERE id = ?')
      .run('equipment_tilt:temperature');
    old.prepare('DELETE FROM model_images WHERE model_id = ?').run('equipment_grainfather_g40');
    old.prepare('UPDATE equipment_models SET product_url = ? WHERE id = ?').run(
      'https://us.grainfather.com/pages/compare-the-grainfather-brewing-systems', 'equipment_grainfather_g40');
    old.prepare('INSERT INTO supplies(id,name,category,unit) VALUES (?,?,?,?)')
      .run('custom_grain', 'My grain', 'Grain', 'g');
    old.pragma('user_version = 19');
  } finally { old.close(); }
  const upgraded = openCatalogDb(dir);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.equal((upgraded.prepare('SELECT capacity_liters FROM model_liquid_containment WHERE model_id = ?')
      .get('equipment_grainfather_g40') as { capacity_liters: number }).capacity_liters, 46);
    assert.equal((upgraded.prepare('SELECT rated_power_watts FROM model_heating WHERE model_id = ?')
      .get('equipment_grainfather_g40') as { rated_power_watts: number }).rated_power_watts, 2900);
    assert.equal((upgraded.prepare('SELECT product_url FROM equipment_models WHERE id = ?')
      .get('equipment_grainfather_g40') as { product_url: string }).product_url,
      'https://us.grainfather.com/products/g40-brewing-system');
    assert.equal((upgraded.prepare('SELECT rated_heat_removal_watts FROM model_cooling WHERE model_id = ?')
      .get('equipment_grainfather_gc4') as { rated_heat_removal_watts: number }).rated_heat_removal_watts, 196);
    assert.equal((upgraded.prepare('SELECT measurement_max FROM model_measurement_channels WHERE id = ?')
      .get('equipment_tilt:temperature') as { measurement_max: number }).measurement_max, 85);
    const photo = upgraded.prepare('SELECT image_bytes, thumbnail_bytes, image_mime_type FROM model_images WHERE model_id = ?')
      .get('equipment_grainfather_g40') as { image_bytes: Buffer; thumbnail_bytes: Buffer; image_mime_type: string };
    assert.ok(photo.image_bytes.length > 0);
    assert.ok(photo.thumbnail_bytes.length > 0);
    assert.equal(photo.image_mime_type, 'image/jpeg');
    assert.equal((upgraded.prepare('SELECT name FROM supplies WHERE id = ?')
      .get('custom_grain') as { name: string }).name, 'My grain');
  } finally { upgraded.close(); }
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
    assert.equal(db.pragma('user_version', { simple: true }), catalogSchemaVersion);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'catalog_%'").all(), []);
    assert.equal(db.prepare('SELECT name FROM supplies WHERE id = ?').get('inventory_maris_otter'), undefined);
    assert.equal((db.prepare('SELECT name FROM supplies WHERE id = ?').get('custom_ingredient') as { name: string }).name,
      'My custom grain');
    assert.ok(catalogChanges(db, 0n).changes.some(change => change.table === 'supplies'));
  } finally { db.close(); }
});

test('catalog sends only CR-SQLite changes after the client cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brewlog-catalog-'));
  const db = openCatalogDb(dir);
  const replica = new Database(':memory:');
  replica.loadExtension(join(process.cwd(), 'vendor/crsqlite.so'));
  try {
    for (const statement of Object.values(catalogModelTables)) replica.exec(statement);
    for (const statement of Object.values(catalogSupplyTables)) replica.exec(statement);
    for (const table of catalogTables) replica.prepare('SELECT crsql_as_crr(?)').get(table);
    const apply = replica.prepare(`INSERT INTO crsql_changes (${changeColumns.map(column => `"${column}"`).join(', ')})
      VALUES (${changeColumns.map(() => '?').join(', ')})`);
    const initial = catalogChanges(db, 0n);
    assert.ok(initial.changes.length > 0);
    for (const change of initial.changes) apply.run(...decodeChange(change));
    assert.deepEqual(rows(replica), rows(db));
    const serverImage = db.prepare('SELECT image_bytes, image_mime_type FROM model_images WHERE model_id = ?')
      .get('equipment_spike_flex_plus_7gal') as { image_bytes: Buffer; image_mime_type: string };
    const replicaImage = replica.prepare('SELECT image_bytes, image_mime_type FROM model_images WHERE model_id = ?')
      .get('equipment_spike_flex_plus_7gal') as { image_bytes: Buffer; image_mime_type: string };
    assert.deepEqual(replicaImage.image_bytes, serverImage.image_bytes);
    assert.equal(replicaImage.image_mime_type, 'image/jpeg');
    assert.ok(replicaImage.image_bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));

    // A local-only row remains when the server updates a different row.
    replica.prepare('INSERT INTO supplies(id, name, category, unit) VALUES (?, ?, ?, ?)')
      .run('personal_ingredient', 'My grain', 'Grain', 'g');
    db.prepare('UPDATE supplies SET name = ? WHERE id = ?')
      .run('Updated Briess pale malt', 'supply_briess_pale_ale');
    const delta = catalogChanges(db, BigInt(initial.serverCursor));
    assert.equal(delta.changes.length, 1);
    assert.equal(delta.changes[0].table, 'supplies');
    for (const change of delta.changes) apply.run(...decodeChange(change));
    assert.equal((replica.prepare('SELECT name FROM supplies WHERE id = ?')
      .get('supply_briess_pale_ale') as { name: string }).name, 'Updated Briess pale malt');
    assert.equal((replica.prepare('SELECT name FROM supplies WHERE id = ?')
      .get('personal_ingredient') as { name: string }).name, 'My grain');
    assert.deepEqual(catalogChanges(db, BigInt(delta.serverCursor)).changes, []);

    db.prepare('UPDATE model_heating SET rated_power_watts = ? WHERE model_id = ?')
      .run(2100, 'equipment_vevor_35l');
    const powerDelta = catalogChanges(db, BigInt(delta.serverCursor));
    assert.equal(powerDelta.changes.length, 1);
    assert.equal(powerDelta.changes[0].table, 'model_heating');
    for (const change of powerDelta.changes) apply.run(...decodeChange(change));
    assert.equal((replica.prepare('SELECT rated_power_watts FROM model_heating WHERE model_id = ?')
      .get('equipment_vevor_35l') as { rated_power_watts: number }).rated_power_watts, 2100);

    db.prepare('INSERT INTO model_boil_characterization(model_id, heat_loss_watts) VALUES (?, ?)')
      .run('equipment_vevor_35l', 320);
    const boilDelta = catalogChanges(db, BigInt(powerDelta.serverCursor));
    assert.ok(boilDelta.changes.some(change => change.table === 'model_boil_characterization'));
    for (const change of boilDelta.changes) apply.run(...decodeChange(change));
    assert.equal((replica.prepare('SELECT heat_loss_watts FROM model_boil_characterization WHERE model_id = ?')
      .get('equipment_vevor_35l') as { heat_loss_watts: number }).heat_loss_watts, 320);

    db.prepare('DELETE FROM supplies WHERE id = ?').run('inventory_dap');
    const deletion = catalogChanges(db, BigInt(boilDelta.serverCursor));
    assert.ok(deletion.changes.length > 0);
    for (const change of deletion.changes) apply.run(...decodeChange(change));
    assert.equal(replica.prepare('SELECT id FROM supplies WHERE id = ?').get('inventory_dap'), undefined);
    assert.equal((replica.prepare('SELECT name FROM supplies WHERE id = ?')
      .get('personal_ingredient') as { name: string }).name, 'My grain');
  } finally { replica.close(); db.close(); }
});
