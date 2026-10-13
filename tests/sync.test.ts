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

test('pre-release workspace schemas reset without carrying old event JSON', () => {
  const id = nanoid();
  const file = join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`);
  const old = new Database(file);
  old.loadExtension('vendor/crsqlite.so');
  old.exec(`CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (10);
    CREATE TABLE batch_events(id TEXT PRIMARY KEY NOT NULL, batch_id TEXT, details_json TEXT)`);
  old.prepare('SELECT crsql_as_crr(?)').get('batch_events');
  old.prepare('INSERT INTO batch_events(id, batch_id, details_json) VALUES (?, ?, ?)')
    .run(nanoid(), nanoid(), '{"mode":"hold"}');
  old.close();
  const db = openWorkspaceDb(id);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_meta'").get(), undefined);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM batch_events').get() as { count: number }).count, 0);
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

test('version 12 ingredient JSON is replaced by typed columns', () => {
  const id = nanoid();
  const file = join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`);
  const old = new Database(file);
  old.loadExtension('vendor/crsqlite.so');
  old.exec(`CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta VALUES (12);
    CREATE TABLE inventory_ingredient_properties(id TEXT PRIMARY KEY NOT NULL, properties_json TEXT)`);
  old.prepare('SELECT crsql_as_crr(?)').get('inventory_ingredient_properties');
  old.prepare('INSERT INTO inventory_ingredient_properties(id, properties_json) VALUES (?, ?)')
    .run(nanoid(), '{"yield_pct":80}');
  old.close();
  const db = openWorkspaceDb(id);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_meta'").get(), undefined);
    const columns = db.pragma('table_info(inventory_ingredient_properties)') as { name: string }[];
    assert.deepEqual(columns.map(column => column.name),
      ['id', 'yield_pct', 'color_lovibond', 'alpha_acid_pct', 'hop_form', 'attenuation_pct']);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM inventory_ingredient_properties').get() as { count: number }).count, 0);
  } finally { closeWorkspaceDb(db); }
});

test('version 14 calibration JSON table is removed on reset', () => {
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

test('version 15 workspace resets for the capability schema', () => {
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
    assert.equal(db.prepare('SELECT name FROM inventory_locations WHERE id = ?').get(locationId), undefined);
    assert.equal(db.prepare('SELECT location_id FROM inventory_item_locations WHERE id = ?').get(itemId), undefined);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'inventory_location_slugs'").get());
  } finally { closeWorkspaceDb(db); }
});

test('version 16 workspace resets for the capability schema', () => {
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
    assert.equal(upgraded.prepare('SELECT name FROM inventory_locations WHERE id = ?').get(locationId), undefined);
    assert.equal(upgraded.prepare('SELECT slug FROM inventory_location_slugs WHERE id = ?').get(locationId), undefined);
    upgraded.prepare('INSERT INTO inventory_location_addresses(id, address) VALUES (?, ?)').run(locationId, '123 Brew Street');
    assert.equal((upgraded.prepare('SELECT address FROM inventory_location_addresses WHERE id = ?').get(locationId) as { address: string }).address, '123 Brew Street');
  } finally { closeWorkspaceDb(upgraded); }
});
