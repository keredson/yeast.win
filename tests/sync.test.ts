import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import Database from 'better-sqlite3';
import { changeColumns, nowSeconds, workspaceSchemaVersion, type SyncRequest, validateChange, } from '../shared/schema.ts';
import { decodeChange, encodeChange, type SqlChangeRow } from '../shared/wire.ts';

process.env.BREWLOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'brewlog-sync-'));
const { openWorkspaceDb, closeWorkspaceDb } = await import('../server/db.ts');
const { syncWorkspace } = await import('../server/sync.ts');

const selectChanges = `SELECT "table", pk, cid, val, col_version, db_version,
  COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq FROM crsql_changes
  WHERE db_version > ? ORDER BY db_version, seq`;
const insertChange = `INSERT INTO crsql_changes (${changeColumns.map(name => `"${name}"`).join(',')}) VALUES (${changeColumns.map(() => '?').join(',')})`;

test('two offline peers merge batches, child rows and image BLOBs', () => {
  const first = openWorkspaceDb(nanoid());
  const second = openWorkspaceDb(nanoid());
  try {
    const batchA = nanoid();
    const batchB = nanoid();
    const event = nanoid();
    const photoId = nanoid();
    const timestamp = nowSeconds();
    first.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(batchA, 'A', 'active', timestamp, timestamp);
    first.prepare('INSERT INTO batch_events(id, batch_id, event_type, actual_at) VALUES (?, ?, ?, ?)')
      .run(event, batchA, 'measurement', timestamp);
    const equipmentId = nanoid();
    const modelId = nanoid();
    const equipmentUseId = nanoid();
    first.prepare('INSERT INTO equipment_models(id, name, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(modelId, 'Shared kettle model', 'electric_kettle', timestamp);
    first.prepare('INSERT INTO equipment(id, name, model_id, added_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(equipmentId, 'Shared kettle', modelId, timestamp, timestamp);
    first.prepare('INSERT INTO batch_events(id, batch_id, event_type, title, actual_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(equipmentUseId, batchA, 'equipment_use', 'Use Shared kettle', timestamp, timestamp);
    first.prepare('INSERT INTO equipment_use_events(event_id, equipment_id) VALUES (?, ?)')
      .run(equipmentUseId, equipmentId);
    first.prepare('INSERT INTO temperature_measurements(event_id, value, unit) VALUES (?, ?, ?)')
      .run(event, 20, 'degC');
    const discardedItem = nanoid();
    first.prepare('INSERT INTO inventory_discards(id, inventory_item_id, quantity, unit, discarded_at) VALUES (?, ?, ?, ?, ?)')
      .run(nanoid(), discardedItem, 5, 'g', timestamp);
    const roomId = nanoid();
    const shelfId = nanoid();
    const sourceId = nanoid();
    const targetId = nanoid();
    first.prepare('INSERT INTO inventory_locations(id, name, parent_id, created_at) VALUES (?, ?, ?, ?)')
      .run(roomId, 'Back room', null, timestamp);
    first.prepare('INSERT INTO inventory_location_addresses(id, address) VALUES (?, ?)')
      .run(roomId, '123 Brew Street');
    first.prepare('INSERT INTO inventory_locations(id, name, parent_id, created_at) VALUES (?, ?, ?, ?)')
      .run(shelfId, 'Shelf A', roomId, timestamp);
    for (const itemId of [sourceId, targetId]) first.prepare(
      'INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(itemId, 'Mosaic hops', 'Hops', 'g', timestamp);
    first.prepare('INSERT INTO inventory_item_locations(id, location_id) VALUES (?, ?)').run(targetId, shelfId);
    first.prepare('INSERT INTO inventory_moves(id, from_item_id, to_item_id, quantity, unit, moved_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nanoid(), sourceId, targetId, 25, 'g', timestamp);
    const pixels = Buffer.from([0, 1, 2, 127, 254, 255]);
    first.prepare('INSERT INTO photos(id, batch_id, mime_type, byte_count, image, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(photoId, batchA, 'image/png', pixels.length, pixels, timestamp);
    second.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(batchB, 'B', 'active', timestamp, timestamp);

    const outgoing = (first.prepare(selectChanges).all(0) as SqlChangeRow[]).map(encodeChange);
    assert.ok(outgoing.every(validateChange));
    const request: SyncRequest = { serverCursor: '0', localCursor: '0', changes: outgoing };
    const response = syncWorkspace(second, request);
    assert.equal((second.prepare('SELECT COUNT(*) AS count FROM batches').get() as { count: number }).count, 2);
    assert.equal((second.prepare('SELECT value FROM temperature_measurements WHERE event_id = ?').get(event) as { value: number }).value, 20);
    assert.equal((second.prepare('SELECT equipment_id FROM equipment_use_events WHERE event_id = ?').get(equipmentUseId) as { equipment_id: string }).equipment_id, equipmentId);
    assert.equal((second.prepare('SELECT model_id FROM equipment WHERE id = ?').get(equipmentId) as { model_id: string }).model_id, modelId);
    assert.equal((second.prepare('SELECT quantity FROM inventory_discards WHERE inventory_item_id = ?').get(discardedItem) as { quantity: number }).quantity, 5);
    assert.equal((second.prepare('SELECT parent_id FROM inventory_locations WHERE id = ?').get(shelfId) as { parent_id: string }).parent_id, roomId);
    assert.equal((second.prepare('SELECT address FROM inventory_location_addresses WHERE id = ?').get(roomId) as { address: string }).address, '123 Brew Street');
    assert.equal((second.prepare('SELECT location_id FROM inventory_item_locations WHERE id = ?').get(targetId) as { location_id: string }).location_id, shelfId);
    assert.equal((second.prepare('SELECT quantity FROM inventory_moves WHERE to_item_id = ?').get(targetId) as { quantity: number }).quantity, 25);
    assert.deepEqual((second.prepare('SELECT image FROM photos WHERE id = ?').get(photoId) as { image: Buffer }).image, pixels);

    const apply = first.prepare(insertChange);
    for (const change of response.changes) apply.run(...decodeChange(change));
    assert.equal((first.prepare('SELECT COUNT(*) AS count FROM batches').get() as { count: number }).count, 2);
  } finally {
    closeWorkspaceDb(first);
    closeWorkspaceDb(second);
  }
});

test('recording an action wins over a concurrent skip', () => {
  const first = openWorkspaceDb(nanoid());
  const second = openWorkspaceDb(nanoid());
  try {
    const id = nanoid();
    const batchId = nanoid();
    const at = nowSeconds();
    first.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(batchId, 'Test', 'active', at, at);
    first.prepare('INSERT INTO batch_events(id, batch_id, event_type, title, offset_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, batchId, 'addition', 'Hops', 0, at);
    first.prepare('INSERT INTO additions(event_id, item_name, quantity, unit) VALUES (?, ?, ?, ?)')
      .run(id, 'Hops', 6, 'oz');
    const changes = () => (first.prepare(selectChanges).all(0) as SqlChangeRow[]).map(encodeChange);
    for (const change of changes()) second.prepare(insertChange).run(...decodeChange(change));

    first.prepare('UPDATE batch_events SET skipped_at = ? WHERE id = ?').run(at + 60, id);
    second.prepare('UPDATE batch_events SET actual_at = ? WHERE id = ?').run(at + 70, id);
    second.prepare('UPDATE additions SET quantity = ? WHERE event_id = ?').run(5, id);
    const secondChanges = (second.prepare(selectChanges).all(0) as SqlChangeRow[]).map(encodeChange);
    for (const change of changes()) second.prepare(insertChange).run(...decodeChange(change));
    for (const change of secondChanges) first.prepare(insertChange).run(...decodeChange(change));

    for (const db of [first, second]) {
      const row = db.prepare('SELECT actual_at, skipped_at FROM batch_events WHERE id = ?')
        .get(id) as { actual_at: number; skipped_at: number };
      assert.equal(row.actual_at, at + 70);
      assert.equal(row.skipped_at, at + 60);
      const addition = db.prepare('SELECT quantity FROM additions WHERE event_id = ?').get(id) as { quantity: number };
      assert.equal(addition.quantity, 5);
    }
  } finally {
    closeWorkspaceDb(first);
    closeWorkspaceDb(second);
  }
});

test('old workspace schemas preserve common event columns without carrying old JSON', () => {
  const id = nanoid();
  const file = join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`);
  const old = new Database(file);
  old.loadExtension('vendor/crsqlite.so');
  old.exec(`CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (10);
    CREATE TABLE batch_events(id TEXT PRIMARY KEY NOT NULL, batch_id TEXT, details_json TEXT)`);
  old.prepare('SELECT crsql_as_crr(?)').get('batch_events');
  const eventId = nanoid();
  const batchId = nanoid();
  old.prepare('INSERT INTO batch_events(id, batch_id, details_json) VALUES (?, ?, ?)')
    .run(eventId, batchId, '{"mode":"hold"}');
  old.close();
  const db = openWorkspaceDb(id);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_meta'").get(), undefined);
    assert.equal((db.prepare('SELECT batch_id FROM batch_events WHERE id = ?').get(eventId) as { batch_id: string }).batch_id,
      batchId);
    assert.equal((db.pragma('table_info(batch_events)') as { name: string }[])
      .some(column => column.name === 'details_json'), false);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'recipe_temperature_control_events'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'inventory_ingredient_properties'").get());
    const columns = db.pragma('table_info(inventory_ingredient_properties)') as { name: string }[];
    assert.ok(columns.some(column => column.name === 'yield_pct'));
    assert.equal(columns.some(column => column.name === 'properties_json'), false);
    for (const table of ['recipe_inputs', 'recipe_event_inputs', 'batch_recipe_inputs', 'batch_event_inputs']) {
      assert.equal((db.pragma(`table_info(${table})`) as { name: string }[]).some(column => column.name === 'inputs_json'), false);
    }
    const equipmentColumns = db.pragma('table_info(equipment)') as { name: string }[];
    assert.equal(equipmentColumns.some(column => column.name === 'capacity_liters'), false);
    assert.equal(equipmentColumns.some(column => column.name === 'specification_json'), false);
    assert.ok((db.pragma('table_info(equipment_liquid_containment)') as { name: string }[])
      .some(column => column.name === 'capacity_liters'));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'equipment_measurement_channels'").get());
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'equipment_calibrations'").get(), undefined);
    assert.equal((db.pragma('table_info(temperature_measurements)') as { name: string }[])
      .some(column => column.name === 'calibration_id'), false);
  } finally { closeWorkspaceDb(db); }
});

test('unversioned workspace tables are upgraded without clearing their rows', () => {
  const id = nanoid();
  const batchId = nanoid();
  const old = new Database(join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`));
  old.loadExtension('vendor/crsqlite.so');
  old.exec('CREATE TABLE batches(id TEXT PRIMARY KEY NOT NULL, name TEXT, status TEXT, created_at INTEGER, updated_at INTEGER)');
  old.prepare('SELECT crsql_as_crr(?)').get('batches');
  old.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(batchId, 'Unversioned batch', 'active', 1, 1);
  old.close();
  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal((upgraded.prepare('SELECT name FROM batches WHERE id = ?').get(batchId) as { name: string }).name,
      'Unversioned batch');
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
  } finally { closeWorkspaceDb(upgraded); }
});

test('current schema data survives the move from schema_meta to user_version', () => {
  const id = nanoid();
  const batchId = nanoid();
  const first = openWorkspaceDb(id);
  try {
    first.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(batchId, 'Existing batch', 'active', 1, 1);
    first.exec(`CREATE TABLE schema_meta(version INTEGER NOT NULL); INSERT INTO schema_meta VALUES (${workspaceSchemaVersion})`);
    first.pragma('user_version = 0');
  } finally { closeWorkspaceDb(first); }
  const reopened = openWorkspaceDb(id);
  try {
    assert.equal(reopened.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_meta'").get(), undefined);
    assert.equal((reopened.prepare('SELECT name FROM batches WHERE id = ?').get(batchId) as { name: string }).name,
      'Existing batch');
  } finally { closeWorkspaceDb(reopened); }
});

test('current workspace repairs a missing capability table without losing existing rows', () => {
  const id = nanoid();
  const batchId = nanoid();
  const first = openWorkspaceDb(id);
  try {
    first.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(batchId, 'Keep this batch', 'active', 1, 1);
    first.prepare('SELECT crsql_as_table(?)').get('equipment_liquid_containment');
    first.exec('DROP TABLE equipment_liquid_containment');
  } finally { closeWorkspaceDb(first); }
  const reopened = openWorkspaceDb(id);
  try {
    assert.equal(reopened.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal((reopened.prepare('SELECT name FROM batches WHERE id = ?').get(batchId) as { name: string }).name,
      'Keep this batch');
    assert.ok((reopened.pragma('table_info(equipment_liquid_containment)') as { name: string }[])
      .some(column => column.name === 'capacity_liters'));
    assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'equipment_liquid_containment__crsql_clock'").get());
  } finally { closeWorkspaceDb(reopened); }
});

test('version 17 equipment settings move into capability tables while batches survive', () => {
  const id = nanoid();
  const equipmentId = nanoid();
  const batchId = nanoid();
  const old = new Database(join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`));
  old.loadExtension('vendor/crsqlite.so');
  old.exec(`CREATE TABLE equipment(id TEXT PRIMARY KEY NOT NULL, name TEXT, kind TEXT,
    catalog_model_id TEXT, slug TEXT, capacity_liters REAL, rated_power_watts REAL,
    boil_heat_loss_watts REAL, temperature_offset_c REAL, created_at INTEGER);
    CREATE TABLE batches(id TEXT PRIMARY KEY NOT NULL, name TEXT, status TEXT, created_at INTEGER, updated_at INTEGER)`);
  for (const table of ['equipment', 'batches']) old.prepare('SELECT crsql_as_crr(?)').get(table);
  old.prepare(`INSERT INTO equipment(id, name, kind, capacity_liters, rated_power_watts,
    boil_heat_loss_watts, temperature_offset_c, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    equipmentId, 'Old kettle', 'electric_kettle', 35, 1800, 250, 2, 1);
  old.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(batchId, 'Old batch', 'active', 1, 1);
  old.pragma('user_version = 17');
  old.close();

  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal((upgraded.prepare('SELECT name FROM batches WHERE id = ?').get(batchId) as { name: string }).name,
      'Old batch');
    assert.equal((upgraded.prepare('SELECT name FROM equipment WHERE id = ?').get(equipmentId) as { name: string }).name,
      'Old kettle');
    assert.equal((upgraded.prepare('SELECT capacity_liters FROM equipment_liquid_containment WHERE equipment_id = ?')
      .get(equipmentId) as { capacity_liters: number }).capacity_liters, 35);
    assert.equal((upgraded.prepare('SELECT rated_power_watts FROM equipment_heating WHERE equipment_id = ?')
      .get(equipmentId) as { rated_power_watts: number }).rated_power_watts, 1800);
    assert.equal((upgraded.prepare('SELECT heat_loss_watts FROM equipment_boil_calibration WHERE equipment_id = ?')
      .get(equipmentId) as { heat_loss_watts: number }).heat_loss_watts, 250);
    assert.equal((upgraded.prepare('SELECT offset_c FROM equipment_temperature_calibration WHERE equipment_id = ?')
      .get(equipmentId) as { offset_c: number }).offset_c, 2);
    assert.equal((upgraded.pragma('table_info(equipment)') as { name: string }[])
      .some(column => column.name === 'capacity_liters'), false);
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 12 ingredient JSON is replaced by typed columns', () => {
  const id = nanoid();
  const file = join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`);
  const old = new Database(file);
  old.loadExtension('vendor/crsqlite.so');
  old.exec(`CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (12);
    CREATE TABLE inventory_ingredient_properties(id TEXT PRIMARY KEY NOT NULL, properties_json TEXT)`);
  old.prepare('SELECT crsql_as_crr(?)').get('inventory_ingredient_properties');
  const propertyId = nanoid();
  old.prepare('INSERT INTO inventory_ingredient_properties(id, properties_json) VALUES (?, ?)')
    .run(propertyId, '{"yield_pct":80}');
  old.close();
  const db = openWorkspaceDb(id);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_meta'").get(), undefined);
    const columns = db.pragma('table_info(inventory_ingredient_properties)') as { name: string }[];
    assert.deepEqual(columns.map(column => column.name),
      ['id', 'yield_pct', 'color_lovibond', 'alpha_acid_pct', 'hop_form', 'attenuation_pct']);
    assert.equal((db.prepare('SELECT yield_pct FROM inventory_ingredient_properties WHERE id = ?')
      .get(propertyId) as { yield_pct: number | null }).yield_pct, null);
  } finally { closeWorkspaceDb(db); }
});

test('version 14 calibration JSON table is retired during upgrade', () => {
  const id = nanoid();
  const file = join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`);
  const old = new Database(file);
  old.loadExtension('vendor/crsqlite.so');
  old.exec(`CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (14);
    CREATE TABLE equipment_calibrations(id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT, parameters_json TEXT)`);
  old.prepare('SELECT crsql_as_crr(?)').get('equipment_calibrations');
  old.close();
  const db = openWorkspaceDb(id);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_meta'").get(), undefined);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'equipment_calibrations'").get(), undefined);
  } finally { closeWorkspaceDb(db); }
});

test('version 15 workspace gains new tables while retaining inventory and locations', () => {
  const id = nanoid();
  const file = join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`);
  const old = new Database(file);
  old.loadExtension('vendor/crsqlite.so');
  old.exec(`CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (15);
    CREATE TABLE inventory_locations(id TEXT PRIMARY KEY NOT NULL, name TEXT, parent_id TEXT, created_at INTEGER);
    CREATE TABLE inventory_items(id TEXT PRIMARY KEY NOT NULL, name TEXT, category TEXT, default_unit TEXT, created_at INTEGER);
    CREATE TABLE inventory_item_locations(id TEXT PRIMARY KEY NOT NULL, location_id TEXT)`);
  for (const table of ['inventory_locations', 'inventory_items', 'inventory_item_locations']) old.prepare('SELECT crsql_as_crr(?)').get(table);
  const locationId = nanoid();
  const itemId = nanoid();
  old.prepare('INSERT INTO inventory_locations(id, name, created_at) VALUES (?, ?, ?)').run(locationId, 'Cellar', nowSeconds());
  old.prepare('INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(itemId, 'Malt', 'Grain', 'kg', nowSeconds());
  old.prepare('INSERT INTO inventory_item_locations(id, location_id) VALUES (?, ?)').run(itemId, locationId);
  old.close();
  const db = openWorkspaceDb(id);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_meta'").get(), undefined);
    assert.equal((db.prepare('SELECT name FROM inventory_locations WHERE id = ?').get(locationId) as { name: string }).name,
      'Cellar');
    assert.equal((db.prepare('SELECT location_id FROM inventory_item_locations WHERE id = ?').get(itemId) as { location_id: string }).location_id,
      locationId);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'inventory_location_slugs'").get());
  } finally { closeWorkspaceDb(db); }
});

test('version 16 workspace creates a missing table without clearing locations', () => {
  const id = nanoid();
  const locationId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO inventory_locations(id, name, created_at) VALUES (?, ?, ?)')
    .run(locationId, 'Garage', nowSeconds());
  db.prepare('INSERT INTO inventory_location_slugs(id, slug) VALUES (?, ?)').run(locationId, 'garage');
  db.prepare("SELECT crsql_as_table('inventory_location_addresses')").get();
  db.exec('DROP TABLE inventory_location_addresses');
  db.pragma('user_version = 16');
  closeWorkspaceDb(db);

  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal((upgraded.prepare('SELECT name FROM inventory_locations WHERE id = ?').get(locationId) as { name: string }).name,
      'Garage');
    assert.equal((upgraded.prepare('SELECT slug FROM inventory_location_slugs WHERE id = ?').get(locationId) as { slug: string }).slug,
      'garage');
    upgraded.prepare('INSERT INTO inventory_location_addresses(id, address) VALUES (?, ?)').run(locationId, '123 Brew Street');
    assert.equal((upgraded.prepare('SELECT address FROM inventory_location_addresses WHERE id = ?').get(locationId) as { address: string }).address, '123 Brew Street');
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 19 workspace adds equipment use events without clearing equipment or batches', () => {
  const id = nanoid();
  const batchId = nanoid();
  const equipmentId = nanoid();
  const modelId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(batchId, 'Test batch', 'active', 1, 1);
  db.prepare('INSERT INTO equipment_models(id, name, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(modelId, 'Test kettle model', 'electric_kettle', 1);
  db.prepare('INSERT INTO equipment(id, name, model_id, added_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(equipmentId, 'Test kettle', modelId, 1, 1);
  db.prepare("SELECT crsql_as_table('equipment_use_events')").get();
  db.exec('DROP TABLE equipment_use_events');
  db.pragma('user_version = 19');
  closeWorkspaceDb(db);

  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal((upgraded.prepare('SELECT name FROM batches WHERE id = ?').get(batchId) as { name: string }).name, 'Test batch');
    assert.equal((upgraded.prepare('SELECT name FROM equipment WHERE id = ?').get(equipmentId) as { name: string }).name, 'Test kettle');
    const useId = nanoid();
    upgraded.prepare('INSERT INTO batch_events(id, batch_id, event_type, actual_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(useId, batchId, 'equipment_use', 2, 2);
    upgraded.prepare('INSERT INTO equipment_use_events(event_id, equipment_id) VALUES (?, ?)')
      .run(useId, equipmentId);
    assert.equal((upgraded.prepare('SELECT COUNT(*) AS count FROM equipment_use_events').get() as { count: number }).count, 1);
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 21 workspace adds brewery model boil defaults and keeps unit calibrations', () => {
  const id = nanoid();
  const modelId = nanoid();
  const unitId = nanoid();
  const batchId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO equipment_models(id, name, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(modelId, 'Kettle model', 'electric_kettle', 1);
  db.prepare('INSERT INTO equipment(id, name, model_id, created_at) VALUES (?, ?, ?, ?)')
    .run(unitId, 'Kettle #1', modelId, 1);
  db.prepare('INSERT INTO equipment_boil_calibration(equipment_id, heat_loss_watts) VALUES (?, ?)')
    .run(unitId, 250);
  db.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(batchId, 'Existing batch', 'active', 1, 1);
  db.prepare("SELECT crsql_as_table('equipment_model_boil_characterization')").get();
  db.exec('DROP TABLE equipment_model_boil_characterization');
  db.pragma('user_version = 21');
  closeWorkspaceDb(db);

  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal((upgraded.prepare('SELECT heat_loss_watts FROM equipment_boil_calibration WHERE equipment_id = ?')
      .get(unitId) as { heat_loss_watts: number }).heat_loss_watts, 250);
    assert.equal((upgraded.prepare('SELECT name FROM batches WHERE id = ?')
      .get(batchId) as { name: string }).name, 'Existing batch');
    upgraded.prepare('INSERT INTO equipment_model_boil_characterization(model_id, heat_loss_watts) VALUES (?, ?)')
      .run(modelId, 0);
    assert.equal((upgraded.prepare('SELECT heat_loss_watts FROM equipment_model_boil_characterization WHERE model_id = ?')
      .get(modelId) as { heat_loss_watts: number }).heat_loss_watts, 0);
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 22 workspace moves unambiguous wort loss to brewery and batch inputs', () => {
  const id = nanoid();
  const modelId = nanoid();
  const unitId = nanoid();
  const batchId = nanoid();
  const eventId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO equipment_models(id, name, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(modelId, 'Kettle model', 'kettle', 1);
  db.prepare('INSERT INTO equipment(id, name, model_id, created_at) VALUES (?, ?, ?, ?)')
    .run(unitId, 'Kettle', modelId, 1);
  db.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(batchId, 'Existing batch', 'active', 1, 1);
  db.prepare('INSERT INTO batch_events(id, batch_id, event_type, created_at) VALUES (?, ?, ?, ?)')
    .run(eventId, batchId, 'transfer', 1);
  for (const table of ['equipment_models', 'equipment_mash_assumptions', 'batch_event_inputs']) {
    db.prepare('SELECT crsql_as_table(?)').get(table);
    db.exec(`ALTER TABLE ${table} ADD COLUMN mash_deadspace_liters REAL`);
    db.exec(`ALTER TABLE ${table} ADD COLUMN kettle_retention_liters REAL`);
    db.prepare('SELECT crsql_as_crr(?)').get(table);
  }
  db.prepare('UPDATE equipment_models SET kettle_retention_liters = 2, mash_deadspace_liters = 1 WHERE id = ?')
    .run(modelId);
  db.prepare('INSERT INTO equipment_mash_assumptions(equipment_id, kettle_retention_liters) VALUES (?, ?)')
    .run(unitId, 2);
  db.prepare('INSERT INTO batch_event_inputs(id, kettle_retention_liters) VALUES (?, ?)')
    .run(eventId, 1.5);
  db.pragma('user_version = 22');
  closeWorkspaceDb(db);

  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal((upgraded.prepare("SELECT wort_loss_liters FROM brewery_process_defaults WHERE id = 'brewery'")
      .get() as { wort_loss_liters: number }).wort_loss_liters, 2);
    assert.equal((upgraded.prepare('SELECT wort_loss_liters FROM batch_recipe_inputs WHERE id = ?')
      .get(batchId) as { wort_loss_liters: number }).wort_loss_liters, 1.5);
    assert.equal((upgraded.prepare('SELECT name FROM batches WHERE id = ?')
      .get(batchId) as { name: string }).name, 'Existing batch');
    for (const table of ['equipment_models', 'equipment_mash_assumptions', 'batch_event_inputs']) {
      const columns = (upgraded.pragma(`table_info(${table})`) as { name: string }[]).map(row => row.name);
      assert.ok(!columns.includes('mash_deadspace_liters'));
      assert.ok(!columns.includes('kettle_retention_liters'));
    }
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 22 stock migrates into supplies and lots without changing ledger or event links', () => {
  const id = nanoid();
  const stockId = nanoid();
  const batchId = nanoid();
  const eventId = nanoid();
  const db = new Database(join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`));
  db.loadExtension('vendor/crsqlite.so');
  db.exec(`CREATE TABLE inventory_items(id TEXT PRIMARY KEY NOT NULL, name TEXT, category TEXT,
      default_unit TEXT, created_at INTEGER);
    CREATE TABLE inventory_ingredient_properties(id TEXT PRIMARY KEY NOT NULL, yield_pct REAL,
      color_lovibond REAL, alpha_acid_pct REAL, hop_form TEXT, attenuation_pct REAL);
    CREATE TABLE inventory_counts(id TEXT PRIMARY KEY NOT NULL, inventory_item_id TEXT,
      quantity REAL, unit TEXT, counted_at INTEGER, created_by_account_id TEXT);
    CREATE TABLE inventory_purchases(id TEXT PRIMARY KEY NOT NULL, inventory_item_id TEXT,
      quantity REAL, unit TEXT, purchased_at INTEGER, supplier TEXT, lot TEXT, cost REAL);
    CREATE TABLE batches(id TEXT PRIMARY KEY NOT NULL, name TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE batch_events(id TEXT PRIMARY KEY NOT NULL, batch_id TEXT, event_type TEXT,
      actual_at INTEGER, created_at INTEGER);
    CREATE TABLE additions(event_id TEXT PRIMARY KEY NOT NULL, inventory_item_id TEXT,
      item_name TEXT, quantity REAL, unit TEXT)`);
  for (const table of ['inventory_items', 'inventory_ingredient_properties', 'inventory_counts', 'inventory_purchases', 'batches', 'batch_events', 'additions']) {
    db.prepare('SELECT crsql_as_crr(?)').get(table);
  }
  db.prepare('INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(stockId, 'Custom grain', 'Grain', 'oz', 1);
  db.prepare('INSERT INTO inventory_ingredient_properties(id, yield_pct, color_lovibond) VALUES (?, ?, ?)')
    .run(stockId, 79, 3.5);
  db.prepare('INSERT INTO inventory_counts(id, inventory_item_id, quantity, unit, counted_at) VALUES (?, ?, ?, ?, ?)')
    .run(nanoid(), stockId, 32, 'oz', 2);
  db.prepare('INSERT INTO inventory_purchases(id, inventory_item_id, quantity, unit, purchased_at, lot) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nanoid(), stockId, 32, 'oz', 2, 'MALT-26-A');
  db.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(batchId, 'Existing batch', 'active', 1, 1);
  db.prepare('INSERT INTO batch_events(id, batch_id, event_type, actual_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, batchId, 'addition', 3, 3);
  db.prepare('INSERT INTO additions(event_id, inventory_item_id, item_name, quantity, unit) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, stockId, 'Custom grain', 5, 'oz');
  db.pragma('user_version = 22');
  db.close();

  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    const stock = upgraded.prepare('SELECT supply_id, lot_id FROM inventory_items WHERE id = ?')
      .get(stockId) as { supply_id: string; lot_id: string };
    assert.ok(stock.supply_id);
    assert.ok(stock.lot_id);
    assert.equal((upgraded.prepare('SELECT lot_code FROM supply_lots WHERE id = ?')
      .get(stock.lot_id) as { lot_code: string }).lot_code, 'MALT-26-A');
    assert.equal((upgraded.prepare('SELECT yield_pct FROM supply_grain_specs WHERE supply_id = ?')
      .get(stock.supply_id) as { yield_pct: number }).yield_pct, 79);
    assert.equal((upgraded.prepare('SELECT color_lovibond FROM lot_grain_specs WHERE lot_id = ?')
      .get(stock.lot_id) as { color_lovibond: number }).color_lovibond, 3.5);
    assert.equal((upgraded.prepare('SELECT supply_id FROM additions WHERE event_id = ?')
      .get(eventId) as { supply_id: string }).supply_id, stock.supply_id);
    assert.equal((upgraded.prepare('SELECT quantity FROM inventory_counts WHERE inventory_item_id = ?')
      .get(stockId) as { quantity: number }).quantity, 32);
    assert.equal((upgraded.prepare('SELECT name FROM batches WHERE id = ?')
      .get(batchId) as { name: string }).name, 'Existing batch');
  } finally { closeWorkspaceDb(upgraded); }
});

test('partly migrated stock keeps its chosen supply and existing lot properties', () => {
  const id = nanoid();
  const stockId = nanoid();
  const supplyId = nanoid();
  const lotId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO supplies(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(supplyId, 'Mosaic', 'Hops', 'g', 1);
  db.prepare('INSERT INTO supply_lots(id, supply_id, lot_code, created_at) VALUES (?, ?, ?, ?)')
    .run(lotId, supplyId, '2026-A', 1);
  db.prepare('INSERT INTO lot_hop_specs(lot_id, alpha_acid_pct) VALUES (?, ?)').run(lotId, 13.2);
  db.prepare('INSERT INTO inventory_items(id, name, category, default_unit, supply_id, lot_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(stockId, 'Mosaic', 'Hops', 'g', supplyId, lotId, 1);
  db.pragma('user_version = 22');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(id);
  try {
    assert.deepEqual(upgraded.prepare('SELECT supply_id, lot_id FROM inventory_items WHERE id = ?').get(stockId),
      { supply_id: supplyId, lot_id: lotId });
    assert.equal((upgraded.prepare('SELECT alpha_acid_pct FROM lot_hop_specs WHERE lot_id = ?')
      .get(lotId) as { alpha_acid_pct: number }).alpha_acid_pct, 13.2);
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 20 equipment splits into models and physical units while preserving event links', () => {
  const id = nanoid();
  const unitId = nanoid();
  const catalogUnitId = nanoid();
  const catalogModelId = nanoid();
  const recipeEventId = nanoid();
  const catalogRecipeEventId = nanoid();
  const batchEventId = nanoid();
  const old = new Database(join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`));
  old.loadExtension('vendor/crsqlite.so');
  old.exec(`CREATE TABLE equipment(id TEXT PRIMARY KEY NOT NULL, name TEXT, kind TEXT, catalog_model_id TEXT,
      slug TEXT, created_at INTEGER);
    CREATE TABLE equipment_heating(equipment_id TEXT PRIMARY KEY NOT NULL, rated_power_watts REAL);
    CREATE TABLE recipe_temperature_control_events(event_id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT);
    CREATE TABLE temperature_control_events(event_id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT)`);
  for (const table of ['equipment', 'equipment_heating', 'recipe_temperature_control_events', 'temperature_control_events']) {
    old.prepare('SELECT crsql_as_crr(?)').get(table);
  }
  old.prepare('INSERT INTO equipment(id, name, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(unitId, 'Custom kettle #1', 'electric_kettle', 123);
  old.prepare('INSERT INTO equipment(id, name, kind, catalog_model_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(catalogUnitId, 'Catalog kettle #1', 'electric_kettle', catalogModelId, 124);
  old.prepare('INSERT INTO equipment_heating(equipment_id, rated_power_watts) VALUES (?, ?)').run(unitId, 1800);
  old.prepare('INSERT INTO recipe_temperature_control_events(event_id, equipment_id) VALUES (?, ?)')
    .run(recipeEventId, unitId);
  old.prepare('INSERT INTO recipe_temperature_control_events(event_id, equipment_id) VALUES (?, ?)')
    .run(catalogRecipeEventId, catalogUnitId);
  old.prepare('INSERT INTO temperature_control_events(event_id, equipment_id) VALUES (?, ?)')
    .run(batchEventId, unitId);
  old.pragma('user_version = 20');
  old.close();

  const upgraded = openWorkspaceDb(id);
  try {
    const unit = upgraded.prepare('SELECT model_id, added_at FROM equipment WHERE id = ?').get(unitId) as
      { model_id: string; added_at: number };
    assert.equal(unit.model_id, unitId);
    assert.equal(unit.added_at, 123);
    assert.deepEqual(upgraded.prepare('SELECT name, kind, rated_power_watts FROM equipment_models WHERE id = ?')
      .get(unitId), { name: 'Custom kettle #1', kind: 'electric_kettle', rated_power_watts: 1800 });
    assert.equal((upgraded.prepare('SELECT equipment_id FROM recipe_temperature_control_events WHERE event_id = ?')
      .get(recipeEventId) as { equipment_id: string }).equipment_id, unitId);
    assert.equal((upgraded.prepare('SELECT equipment_id FROM recipe_temperature_control_events WHERE event_id = ?')
      .get(catalogRecipeEventId) as { equipment_id: string }).equipment_id, catalogModelId);
    assert.equal((upgraded.prepare('SELECT model_id FROM equipment WHERE id = ?')
      .get(catalogUnitId) as { model_id: string }).model_id, catalogModelId);
    assert.equal((upgraded.prepare('SELECT equipment_id FROM temperature_control_events WHERE event_id = ?')
      .get(batchEventId) as { equipment_id: string }).equipment_id, unitId);
  } finally { closeWorkspaceDb(upgraded); }
});
