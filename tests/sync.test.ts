import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import Database from 'better-sqlite3';
import { changeColumns, nowSeconds, workspaceSchemaVersion, type SyncRequest, validateChange, } from '../shared/schema.ts';
import { decodeChange, encodeChange, type SqlChangeRow } from '../shared/wire.ts';
import { appBatchSizeLiters } from '../shared/batchSize.ts';

process.env.BREWLOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'brewlog-sync-'));
const { openWorkspaceDb, closeWorkspaceDb } = await import('../server/db.ts');
const { syncWorkspace } = await import('../server/sync.ts');

const selectChanges = `SELECT "table", pk, cid, val, col_version, db_version,
  COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq FROM crsql_changes
  WHERE db_version > ? ORDER BY db_version, seq`;
const insertChange = `INSERT INTO crsql_changes (${changeColumns.map(name => `"${name}"`).join(',')}) VALUES (${changeColumns.map(() => '?').join(',')})`;

test('supply media upgrade preserves existing supplies and partially created media', () => {
  for (const partial of [false, true]) {
    const id = nanoid();
    const supplyId = nanoid();
    const before = openWorkspaceDb(id);
    try {
      before.prepare('INSERT INTO supplies(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(supplyId, 'Old two row', 'Grain', 'oz', 1);
      before.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(nanoid(), 'Unrelated batch', 'active', 1, 1);
      if (partial) before.prepare(`INSERT INTO supply_media(id, product_url, image_bytes, image_mime_type)
        VALUES (?, ?, ?, ?)`).run(supplyId, 'https://example.com/malt', Buffer.from([1, 2, 3]), 'image/png');
      else {
        before.prepare("SELECT crsql_as_table('supply_media')").get();
        before.exec('DROP TABLE supply_media');
      }
      before.pragma('user_version = 32');
    } finally { closeWorkspaceDb(before); }
    const upgraded = openWorkspaceDb(id);
    try {
      assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
      assert.equal((upgraded.prepare('SELECT name FROM supplies WHERE id = ?').get(supplyId) as {
        name: string }).name, 'Old two row');
      assert.equal((upgraded.prepare('SELECT count(*) AS count FROM batches').get() as { count: number }).count, 1);
      const media = upgraded.prepare('SELECT product_url, image_bytes FROM supply_media WHERE id = ?')
        .get(supplyId) as { product_url: string; image_bytes: Buffer } | undefined;
      if (partial) {
        assert.equal(media?.product_url, 'https://example.com/malt');
        assert.deepEqual(media?.image_bytes, Buffer.from([1, 2, 3]));
      } else assert.equal(media, undefined);
      assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE name = 'supply_media__crsql_clock'").get());
    } finally { closeWorkspaceDb(upgraded); }
  }
});

test('retiring generic catalog grains preserves brewery supplies and Crystal 60 color', () => {
  const id = nanoid();
  const db = openWorkspaceDb(id);
  const crystal = nanoid();
  const custom = nanoid();
  try {
    db.prepare('INSERT INTO supplies(id, name, category, default_unit, catalog_supply_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crystal, 'My Crystal 60', 'Grain', 'oz', 'inventory_crystal_60', 1);
    db.prepare('INSERT INTO supplies(id, name, category, default_unit, catalog_supply_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(custom, 'My custom ingredient', 'Grain', 'oz', null, 1);
    db.pragma('user_version = 31');
  } finally { closeWorkspaceDb(db); }
  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal((upgraded.prepare('SELECT catalog_supply_id FROM supplies WHERE id = ?')
      .get(crystal) as { catalog_supply_id: string | null }).catalog_supply_id, null);
    assert.equal((upgraded.prepare('SELECT color_lovibond FROM supply_grain_specs WHERE supply_id = ?')
      .get(crystal) as { color_lovibond: number }).color_lovibond, 60);
    assert.equal((upgraded.prepare('SELECT name FROM supplies WHERE id = ?')
      .get(custom) as { name: string }).name, 'My custom ingredient');
  } finally { closeWorkspaceDb(upgraded); }
});

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
    first.prepare('INSERT INTO equipment_model_media(id, product_url, image_bytes, image_mime_type) VALUES (?, ?, ?, ?)')
      .run(modelId, 'https://example.com/kettle', Buffer.from([255, 216, 255]), 'image/jpeg');
    first.prepare("INSERT INTO brewery_process_defaults(id, mash_efficiency_pct, default_batch_size_liters) VALUES ('brewery', 72, 20)").run();
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
    first.prepare('INSERT INTO equipment_locations(id, location_id) VALUES (?, ?)').run(equipmentId, roomId);
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
    assert.deepEqual(second.prepare('SELECT product_url, image_bytes, image_mime_type FROM equipment_model_media WHERE id = ?')
      .get(modelId), { product_url: 'https://example.com/kettle', image_bytes: Buffer.from([255, 216, 255]),
      image_mime_type: 'image/jpeg' });
    assert.equal((second.prepare("SELECT mash_efficiency_pct FROM brewery_process_defaults WHERE id = 'brewery'")
      .get() as { mash_efficiency_pct: number }).mash_efficiency_pct, 72);
    assert.equal((second.prepare("SELECT default_batch_size_liters FROM brewery_process_defaults WHERE id = 'brewery'")
      .get() as { default_batch_size_liters: number }).default_batch_size_liters, 20);
    assert.equal((second.prepare('SELECT quantity FROM inventory_discards WHERE inventory_item_id = ?').get(discardedItem) as { quantity: number }).quantity, 5);
    assert.equal((second.prepare('SELECT parent_id FROM inventory_locations WHERE id = ?').get(shelfId) as { parent_id: string }).parent_id, roomId);
    assert.equal((second.prepare('SELECT address FROM inventory_location_addresses WHERE id = ?').get(roomId) as { address: string }).address, '123 Brew Street');
    assert.equal((second.prepare('SELECT location_id FROM inventory_item_locations WHERE id = ?').get(targetId) as { location_id: string }).location_id, shelfId);
    assert.equal((second.prepare('SELECT location_id FROM equipment_locations WHERE id = ?').get(equipmentId) as { location_id: string }).location_id, roomId);
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

test('version 24 workspace adds batch origins while preserving existing batches and packaging', () => {
  const id = nanoid();
  const sourceId = nanoid();
  const eventId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(sourceId, 'Prior brew', 'active', 1, 1);
  db.prepare('INSERT INTO batch_events(id, batch_id, event_type, created_at) VALUES (?, ?, ?, ?)')
    .run(eventId, sourceId, 'packaging', 1);
  db.prepare('INSERT INTO packaging(event_id, container_name, container_size, container_unit, container_count) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, 'bottle', 0.5, 'L', 12);
  db.prepare("SELECT crsql_as_table('batch_origins')").get();
  db.exec('DROP TABLE batch_origins');
  db.pragma('user_version = 24');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal((upgraded.prepare('SELECT name FROM batches WHERE id = ?').get(sourceId) as { name: string }).name, 'Prior brew');
    const packageRow = upgraded.prepare('SELECT container_count FROM packaging WHERE event_id = ?')
      .get(eventId) as { container_count: number };
    assert.equal(packageRow.container_count, 12);
    upgraded.prepare('INSERT INTO batch_origins(id, source_batch_id) VALUES (?, ?)').run(nanoid(), sourceId);
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 25 workspace gains recipe slugs without changing recipes or their events', () => {
  const workspaceId = nanoid();
  const recipeId = nanoid();
  const eventId = nanoid();
  const db = openWorkspaceDb(workspaceId);
  db.prepare('INSERT INTO recipes(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(recipeId, 'Autumn Pale Ale', 1, 1);
  db.prepare('INSERT INTO recipe_events(id, recipe_id, event_type, title, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(eventId, recipeId, 'addition', 'Pale malt', 1);
  db.prepare("SELECT crsql_as_table('recipe_slugs')").get();
  db.exec('DROP TABLE recipe_slugs');
  db.pragma('user_version = 25');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(workspaceId);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal((upgraded.prepare('SELECT name FROM recipes WHERE id = ?').get(recipeId) as { name: string }).name,
      'Autumn Pale Ale');
    assert.equal((upgraded.prepare('SELECT title FROM recipe_events WHERE id = ?').get(eventId) as { title: string }).title,
      'Pale malt');
    assert.equal((upgraded.prepare('SELECT slug FROM recipe_slugs WHERE id = ?').get(recipeId) as { slug: string }).slug,
      'autumn-pale-ale');
  } finally { closeWorkspaceDb(upgraded); }
});

test('partially upgraded recipe slugs keep edits and fill missing names without ID suffixes', () => {
  const workspaceId = nanoid();
  const firstId = nanoid();
  const secondId = nanoid();
  const db = openWorkspaceDb(workspaceId);
  for (const id of [firstId, secondId]) db.prepare(
    'INSERT INTO recipes(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, 'House IPA', 1, 1);
  db.prepare('INSERT INTO recipe_slugs(id, slug) VALUES (?, ?)').run(firstId, 'favorite-ipa');
  db.pragma('user_version = 25');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(workspaceId);
  try {
    const slugs = upgraded.prepare('SELECT id, slug FROM recipe_slugs ORDER BY id').all() as { id: string; slug: string }[];
    assert.equal(slugs.length, 2);
    assert.equal(slugs.find(row => row.id === firstId)?.slug, 'favorite-ipa');
    assert.equal(slugs.find(row => row.id === secondId)?.slug, 'house-ipa');
  } finally { closeWorkspaceDb(upgraded); }
});

test('partial version 25 upgrade keeps existing batch origin links', () => {
  const id = nanoid();
  const sourceId = nanoid();
  const copyId = nanoid();
  const db = openWorkspaceDb(id);
  for (const batchId of [sourceId, copyId]) db.prepare(
    'INSERT INTO batches(id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(batchId, batchId, 'active', 1, 1);
  db.prepare('INSERT INTO batch_origins(id, source_batch_id) VALUES (?, ?)').run(copyId, sourceId);
  db.pragma('user_version = 24');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    const origin = upgraded.prepare('SELECT source_batch_id FROM batch_origins WHERE id = ?')
      .get(copyId) as { source_batch_id: string };
    assert.equal(origin.source_batch_id, sourceId);
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

test('version 27 adds model measurement removal markers while preserving channels and units', () => {
  const id = nanoid();
  const modelId = nanoid();
  const equipmentId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO equipment_models(id, name, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(modelId, 'Meter model', 'hydrometer', 1);
  db.prepare('INSERT INTO equipment(id, name, model_id, created_at) VALUES (?, ?, ?, ?)')
    .run(equipmentId, 'Meter unit', modelId, 1);
  db.prepare(`INSERT INTO equipment_model_measurement_channels
    (id, model_id, measurement_kind, measurement_min, measurement_max, measurement_scale)
    VALUES (?, ?, 'gravity', 1, 1.15, 'SG')`).run(`${modelId}:gravity`, modelId);
  db.prepare("SELECT crsql_begin_alter('equipment_model_measurement_channels')").get();
  db.exec('ALTER TABLE equipment_model_measurement_channels DROP COLUMN is_removed');
  db.prepare("SELECT crsql_commit_alter('equipment_model_measurement_channels')").get();
  db.pragma('user_version = 26');
  closeWorkspaceDb(db);

  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.deepEqual(upgraded.prepare(`SELECT measurement_min, measurement_max, measurement_scale, is_removed
      FROM equipment_model_measurement_channels WHERE model_id = ?`).get(modelId),
    { measurement_min: 1, measurement_max: 1.15, measurement_scale: 'SG', is_removed: 0 });
    assert.equal((upgraded.prepare('SELECT model_id FROM equipment WHERE id = ?').get(equipmentId) as { model_id: string }).model_id,
      modelId);
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 29 adds model media without disturbing models, units, or existing partial media', () => {
  for (const partiallyUpgraded of [false, true]) {
    const id = nanoid();
    const modelId = nanoid();
    const unitId = nanoid();
    const recipeId = nanoid();
    const db = openWorkspaceDb(id);
    db.prepare('INSERT INTO equipment_models(id, name, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(modelId, 'Existing model', 'electric_kettle', 1);
    db.prepare('INSERT INTO equipment(id, name, model_id, created_at) VALUES (?, ?, ?, ?)')
      .run(unitId, 'Existing unit', modelId, 1);
    db.prepare('INSERT INTO recipes(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(recipeId, 'Existing recipe', 1, 1);
    if (partiallyUpgraded) db.prepare('INSERT INTO equipment_model_media(id, product_url, image_bytes, image_mime_type) VALUES (?, ?, ?, ?)')
      .run(modelId, 'https://example.com/kettle', Buffer.from([1, 2, 3]), 'image/jpeg');
    else {
      db.prepare("SELECT crsql_as_table('equipment_model_media')").get();
      db.exec('DROP TABLE equipment_model_media');
    }
    db.pragma('user_version = 28');
    closeWorkspaceDb(db);
    const upgraded = openWorkspaceDb(id);
    try {
      assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
      assert.equal((upgraded.prepare('SELECT name FROM equipment_models WHERE id = ?').get(modelId) as { name: string }).name,
        'Existing model');
      assert.equal((upgraded.prepare('SELECT model_id FROM equipment WHERE id = ?').get(unitId) as { model_id: string }).model_id,
        modelId);
      assert.equal((upgraded.prepare('SELECT name FROM recipes WHERE id = ?').get(recipeId) as { name: string }).name,
        'Existing recipe');
      const media = upgraded.prepare('SELECT product_url, image_bytes, image_mime_type FROM equipment_model_media WHERE id = ?')
        .get(modelId) as { product_url: string; image_bytes: Buffer; image_mime_type: string } | undefined;
      if (partiallyUpgraded) assert.deepEqual(media, {
        product_url: 'https://example.com/kettle', image_bytes: Buffer.from([1, 2, 3]), image_mime_type: 'image/jpeg'
      });
      else assert.equal(media, undefined);
    } finally { closeWorkspaceDb(upgraded); }
  }
});

test('version 28 adds equipment post-boil loss without discarding older data', () => {
  const id = nanoid();
  const modelId = nanoid();
  const unitId = nanoid();
  const recipeId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO equipment_models(id, name, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(modelId, 'Kettle model', 'electric_kettle', 1);
  db.prepare('INSERT INTO equipment(id, name, model_id, created_at) VALUES (?, ?, ?, ?)')
    .run(unitId, 'Kettle unit', modelId, 1);
  db.prepare('INSERT INTO recipes(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(recipeId, 'Existing recipe', 1, 1);
  db.prepare('INSERT INTO recipe_inputs(id, target_fermenter_volume_liters, wort_loss_liters) VALUES (?, ?, ?)')
    .run(recipeId, 19, 1.5);
  db.prepare("SELECT crsql_begin_alter('equipment_models')").get();
  db.exec('ALTER TABLE equipment_models DROP COLUMN post_boil_loss_liters');
  db.prepare("SELECT crsql_commit_alter('equipment_models')").get();
  db.prepare("SELECT crsql_as_table('equipment_post_boil_losses')").get();
  db.exec('DROP TABLE equipment_post_boil_losses');
  for (const table of ['recipe_transfer_equipment', 'transfer_equipment']) {
    db.prepare('SELECT crsql_as_table(?)').get(table);
    db.exec(`DROP TABLE ${table}`);
  }
  db.pragma('user_version = 27');
  closeWorkspaceDb(db);

  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal((upgraded.prepare('SELECT name FROM equipment_models WHERE id = ?').get(modelId) as { name: string }).name,
      'Kettle model');
    assert.equal((upgraded.prepare('SELECT model_id FROM equipment WHERE id = ?').get(unitId) as { model_id: string }).model_id,
      modelId);
    assert.deepEqual(upgraded.prepare('SELECT target_fermenter_volume_liters, wort_loss_liters FROM recipe_inputs WHERE id = ?')
      .get(recipeId), { target_fermenter_volume_liters: 19, wort_loss_liters: 1.5 });
    upgraded.prepare('UPDATE equipment_models SET post_boil_loss_liters = ? WHERE id = ?').run(0, modelId);
    upgraded.prepare('INSERT INTO equipment_post_boil_losses(equipment_id, post_boil_loss_liters) VALUES (?, ?)')
      .run(unitId, 0.25);
    assert.equal((upgraded.prepare('SELECT post_boil_loss_liters FROM equipment_post_boil_losses WHERE equipment_id = ?')
      .get(unitId) as { post_boil_loss_liters: number }).post_boil_loss_liters, 0.25);
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'recipe_transfer_equipment'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'transfer_equipment'").get());
  } finally { closeWorkspaceDb(upgraded); }
});

test('partially upgraded post-boil loss rows survive reopening', () => {
  const id = nanoid();
  const modelId = nanoid();
  const unitId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO equipment_models(id, name, kind, post_boil_loss_liters, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(modelId, 'Partial kettle', 'kettle', 0, 1);
  db.prepare('INSERT INTO equipment(id, name, model_id, created_at) VALUES (?, ?, ?, ?)')
    .run(unitId, 'Unit', modelId, 1);
  db.prepare('INSERT INTO equipment_post_boil_losses(equipment_id, post_boil_loss_liters) VALUES (?, ?)')
    .run(unitId, 0.4);
  db.pragma('user_version = 27');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal((upgraded.prepare('SELECT post_boil_loss_liters FROM equipment_models WHERE id = ?')
      .get(modelId) as { post_boil_loss_liters: number }).post_boil_loss_liters, 0);
    assert.equal((upgraded.prepare('SELECT post_boil_loss_liters FROM equipment_post_boil_losses WHERE equipment_id = ?')
      .get(unitId) as { post_boil_loss_liters: number }).post_boil_loss_liters, 0.4);
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 29 adds equipment locations while preserving units, locations, and unrelated rows', () => {
  const id = nanoid();
  const modelId = nanoid();
  const unitId = nanoid();
  const placeId = nanoid();
  const recipeId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO equipment_models(id, name, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(modelId, 'Fermenter model', 'fermenter', 1);
  db.prepare('INSERT INTO equipment(id, name, model_id, stock_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(unitId, 'Fermenter', modelId, 'F-01', 1);
  db.prepare('INSERT INTO inventory_locations(id, name, created_at) VALUES (?, ?, ?)')
    .run(placeId, 'Cellar', 1);
  db.prepare('INSERT INTO recipes(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(recipeId, 'Preserved recipe', 1, 1);
  db.prepare("SELECT crsql_as_table('equipment_locations')").get();
  db.exec('DROP TABLE equipment_locations');
  db.pragma('user_version = 28');
  closeWorkspaceDb(db);

  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.equal((upgraded.prepare('SELECT stock_id FROM equipment WHERE id = ?').get(unitId) as { stock_id: string }).stock_id, 'F-01');
    assert.equal((upgraded.prepare('SELECT name FROM inventory_locations WHERE id = ?').get(placeId) as { name: string }).name, 'Cellar');
    assert.equal((upgraded.prepare('SELECT name FROM recipes WHERE id = ?').get(recipeId) as { name: string }).name, 'Preserved recipe');
    upgraded.prepare('INSERT INTO equipment_locations(id, location_id) VALUES (?, ?)').run(unitId, placeId);
    assert.equal((upgraded.prepare('SELECT location_id FROM equipment_locations WHERE id = ?').get(unitId) as { location_id: string }).location_id, placeId);
  } finally { closeWorkspaceDb(upgraded); }
});

test('a partially upgraded equipment location association survives reopening', () => {
  const id = nanoid();
  const unitId = nanoid();
  const placeId = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare('INSERT INTO equipment_locations(id, location_id) VALUES (?, ?)').run(unitId, placeId);
  db.pragma('user_version = 28');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal((upgraded.prepare('SELECT location_id FROM equipment_locations WHERE id = ?').get(unitId) as { location_id: string }).location_id, placeId);
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

test('version 30 recipe inputs upgrade fills only missing sizes from an already set brewery default', () => {
  const id = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare("INSERT INTO brewery_process_defaults(id, mash_efficiency_pct, default_batch_size_liters) VALUES ('brewery', 71, 22)").run();
  for (const recipeId of ['explicit', 'blank', 'absent']) db.prepare(
    'INSERT INTO recipes(id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
    .run(recipeId, recipeId);
  db.prepare('INSERT INTO recipe_inputs(id, target_fermenter_volume_liters, brewhouse_efficiency_pct) VALUES (?, ?, ?)')
    .run('explicit', 19, 68);
  db.prepare('INSERT INTO recipe_inputs(id, target_fermenter_volume_liters, brewhouse_efficiency_pct) VALUES (?, ?, ?)')
    .run('blank', null, 65);
  db.prepare('SELECT crsql_as_table(?)').get('recipe_inputs');
  db.exec(`CREATE TABLE old_recipe_inputs(id TEXT PRIMARY KEY NOT NULL,
    target_fermenter_volume_liters REAL, brewhouse_efficiency_pct REAL, wort_loss_liters REAL)`);
  db.exec(`INSERT INTO old_recipe_inputs SELECT id, target_fermenter_volume_liters,
    brewhouse_efficiency_pct, wort_loss_liters FROM recipe_inputs`);
  db.exec('DROP TABLE recipe_inputs');
  db.exec('ALTER TABLE old_recipe_inputs RENAME TO recipe_inputs');
  db.prepare('SELECT crsql_as_crr(?)').get('recipe_inputs');
  db.pragma('user_version = 30');
  closeWorkspaceDb(db);

  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    const rows = upgraded.prepare(`SELECT id, target_fermenter_volume_liters AS liters, batch_size_source AS source,
      brewhouse_efficiency_pct AS efficiency FROM recipe_inputs ORDER BY id`).all();
    assert.deepEqual(rows, [
      { id: 'absent', liters: 22, source: 'assumed_brewery', efficiency: null },
      { id: 'blank', liters: 22, source: 'assumed_brewery', efficiency: 65 },
      { id: 'explicit', liters: 19, source: null, efficiency: 68 }
    ]);
    assert.equal((upgraded.prepare("SELECT mash_efficiency_pct FROM brewery_process_defaults WHERE id = 'brewery'")
      .get() as { mash_efficiency_pct: number }).mash_efficiency_pct, 71);
    assert.equal((upgraded.prepare("SELECT name FROM recipes WHERE id = 'explicit'").get() as { name: string }).name,
      'explicit');
  } finally { closeWorkspaceDb(upgraded); }
});

test('partially upgraded recipe sizes retain their assumptions and app fallback fills blanks', () => {
  const id = nanoid();
  const db = openWorkspaceDb(id);
  for (const recipeId of ['existing', 'missing']) db.prepare(
    'INSERT INTO recipes(id, name, created_at, updated_at) VALUES (?, ?, 1, 1)').run(recipeId, recipeId);
  db.prepare(`INSERT INTO recipe_inputs(id, target_fermenter_volume_liters, batch_size_source)
    VALUES ('existing', 21, 'assumed_brewery')`).run();
  db.pragma('user_version = 30');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(id);
  try {
    assert.deepEqual(upgraded.prepare(`SELECT id, target_fermenter_volume_liters AS liters,
      batch_size_source AS source FROM recipe_inputs ORDER BY id`).all(), [
      { id: 'existing', liters: 21, source: 'assumed_brewery' },
      { id: 'missing', liters: appBatchSizeLiters, source: 'assumed_app' }
    ]);
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 30 schema upgrades without a brewery batch default', () => {
  const id = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare("INSERT INTO brewery_process_defaults(id, mash_efficiency_pct) VALUES ('brewery', 74)").run();
  db.prepare("INSERT INTO recipes(id, name, created_at, updated_at) VALUES ('old-recipe', 'Old recipe', 1, 1)").run();
  for (const [table, columns] of [
    ['recipe_inputs', 'id TEXT PRIMARY KEY NOT NULL, target_fermenter_volume_liters REAL, brewhouse_efficiency_pct REAL, wort_loss_liters REAL'],
    ['brewery_process_defaults', 'id TEXT PRIMARY KEY NOT NULL, wort_loss_liters REAL, mash_efficiency_pct REAL']
  ]) {
    db.prepare('SELECT crsql_as_table(?)').get(table);
    db.exec(`CREATE TABLE old_${table}(${columns})`);
    const oldColumns = columns.split(', ').map(column => column.split(' ')[0]);
    db.exec(`INSERT INTO old_${table}(${oldColumns.join(', ')}) SELECT ${oldColumns.join(', ')} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE old_${table} RENAME TO ${table}`);
    db.prepare('SELECT crsql_as_crr(?)').get(table);
  }
  db.pragma('user_version = 30');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.deepEqual(upgraded.prepare("SELECT target_fermenter_volume_liters AS liters, batch_size_source AS source FROM recipe_inputs WHERE id = 'old-recipe'").get(),
      { liters: appBatchSizeLiters, source: 'assumed_app' });
    assert.equal((upgraded.prepare("SELECT mash_efficiency_pct FROM brewery_process_defaults WHERE id = 'brewery'")
      .get() as { mash_efficiency_pct: number }).mash_efficiency_pct, 74);
  } finally { closeWorkspaceDb(upgraded); }
});

test('version 29 workspace preserves brewery settings and unrelated records when adding mash default', () => {
  const id = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare("INSERT INTO brewery_process_defaults(id, wort_loss_liters) VALUES ('brewery', 1.25)").run();
  db.prepare("INSERT INTO recipes(id, name, created_at, updated_at) VALUES ('recipe', 'Existing recipe', 1, 1)").run();
  db.prepare('SELECT crsql_as_table(?)').get('brewery_process_defaults');
  db.exec('CREATE TABLE old_brewery_defaults(id TEXT PRIMARY KEY NOT NULL, wort_loss_liters REAL)');
  db.exec('INSERT INTO old_brewery_defaults SELECT id, wort_loss_liters FROM brewery_process_defaults');
  db.exec('DROP TABLE brewery_process_defaults');
  db.exec('ALTER TABLE old_brewery_defaults RENAME TO brewery_process_defaults');
  db.prepare('SELECT crsql_as_crr(?)').get('brewery_process_defaults');
  db.pragma('user_version = 29');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.deepEqual(upgraded.prepare("SELECT wort_loss_liters, mash_efficiency_pct FROM brewery_process_defaults WHERE id = 'brewery'").get(),
      { wort_loss_liters: 1.25, mash_efficiency_pct: null });
    assert.equal((upgraded.prepare("SELECT name FROM recipes WHERE id = 'recipe'").get() as { name: string }).name,
      'Existing recipe');
  } finally { closeWorkspaceDb(upgraded); }
});

test('partially upgraded brewery mash default survives reopening', () => {
  const id = nanoid();
  const db = openWorkspaceDb(id);
  db.prepare("INSERT INTO brewery_process_defaults(id, wort_loss_liters, mash_efficiency_pct) VALUES ('brewery', 0.5, 68)").run();
  db.pragma('user_version = 29');
  closeWorkspaceDb(db);
  const upgraded = openWorkspaceDb(id);
  try {
    assert.equal(upgraded.pragma('user_version', { simple: true }), workspaceSchemaVersion);
    assert.deepEqual(upgraded.prepare("SELECT wort_loss_liters, mash_efficiency_pct FROM brewery_process_defaults WHERE id = 'brewery'").get(),
      { wort_loss_liters: 0.5, mash_efficiency_pct: 68 });
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
    assert.equal((upgraded.prepare('SELECT post_boil_loss_liters FROM equipment_models WHERE id = ?')
      .get(modelId) as { post_boil_loss_liters: number }).post_boil_loss_liters, 2);
    assert.equal((upgraded.prepare('SELECT post_boil_loss_liters FROM equipment_post_boil_losses WHERE equipment_id = ?')
      .get(unitId) as { post_boil_loss_liters: number }).post_boil_loss_liters, 2);
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
