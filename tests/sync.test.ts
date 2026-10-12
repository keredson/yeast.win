import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import Database from 'better-sqlite3';
import { changeColumns, inventoryLocationTables, nowSeconds, replicatedTables, schemaStatements, type SyncRequest, validateChange, } from '../shared/schema.ts';
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
    first.prepare('INSERT INTO batch_events(id, batch_id, event_type, title, offset_seconds, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, batchId, 'addition', 'Hops', 0, JSON.stringify({ quantity: 6, unit: 'oz' }), at);
    const changes = () => (first.prepare(selectChanges).all(0) as SqlChangeRow[]).map(encodeChange);
    for (const change of changes()) second.prepare(insertChange).run(...decodeChange(change));

    first.prepare('UPDATE batch_events SET skipped_at = ? WHERE id = ?').run(at + 60, id);
    second.prepare('UPDATE batch_events SET actual_at = ?, details_json = ? WHERE id = ?')
      .run(at + 70, JSON.stringify({ quantity: 5, unit: 'oz' }), id);
    const secondChanges = (second.prepare(selectChanges).all(0) as SqlChangeRow[]).map(encodeChange);
    for (const change of changes()) second.prepare(insertChange).run(...decodeChange(change));
    for (const change of secondChanges) first.prepare(insertChange).run(...decodeChange(change));

    for (const db of [first, second]) {
      const row = db.prepare('SELECT actual_at, skipped_at, details_json FROM batch_events WHERE id = ?')
        .get(id) as { actual_at: number; skipped_at: number; details_json: string };
      assert.equal(row.actual_at, at + 70);
      assert.equal(row.skipped_at, at + 60);
      assert.equal(JSON.parse(row.details_json).quantity, 5);
    }
  } finally {
    closeWorkspaceDb(first);
    closeWorkspaceDb(second);
  }
});

test('older proof-of-concept databases require a fresh schema', () => {
  const id = nanoid();
  const file = join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`);
  const old = new Database(file);
  old.exec('CREATE TABLE schema_meta(version INTEGER NOT NULL); INSERT INTO schema_meta VALUES (6)');
  old.close();
  assert.throws(() => openWorkspaceDb(id), /create a fresh database/);
});

test('schema 7 inventory upgrades and removes an unused duplicate without losing stock', () => {
  const id = nanoid();
  const file = join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`);
  const old = new Database(file);
  old.loadExtension('vendor/crsqlite.so');
  old.exec('CREATE TABLE schema_meta(version INTEGER NOT NULL); INSERT INTO schema_meta VALUES (7)');
  for (const [index, table] of replicatedTables.entries()) {
    if (inventoryLocationTables.includes(table as typeof inventoryLocationTables[number])) continue;
    old.exec(schemaStatements[index]);
    old.prepare('SELECT crsql_as_crr(?)').get(table);
  }
  const emptyId = nanoid();
  const stockedId = nanoid();
  old.prepare('INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(emptyId, 'SafAle US-05', 'Yeast', 'packet', 1);
  old.prepare('INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(stockedId, 'SafAle US-05', 'Yeast', 'packet', 2);
  old.prepare('INSERT INTO inventory_purchases(id, inventory_item_id, quantity, unit, purchased_at) VALUES (?, ?, ?, ?, ?)')
    .run(nanoid(), stockedId, 10, 'packet', 3);
  const acidId = nanoid();
  old.prepare('INSERT INTO inventory_items(id, name, category, default_unit, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(acidId, 'Lactic acid', 'Chemical', 'mL', 2);
  old.close();

  const db = openWorkspaceDb(id);
  try {
    assert.equal((db.prepare('SELECT version FROM schema_meta').get() as { version: number }).version, 8);
    assert.deepEqual(db.prepare("SELECT id FROM inventory_items WHERE name = 'SafAle US-05'").all(), [{ id: stockedId }]);
    assert.equal((db.prepare('SELECT category FROM inventory_items WHERE id = ?').get(acidId) as { category: string }).category, 'Adjunct');
    assert.equal((db.prepare('SELECT quantity FROM inventory_purchases WHERE inventory_item_id = ?').get(stockedId) as { quantity: number }).quantity, 10);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'inventory_locations'").get());
  } finally { closeWorkspaceDb(db); }
});
