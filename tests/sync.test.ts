import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { changeColumns, indexStatements, nowSeconds, replicatedTables, schemaStatements, type SyncRequest, validateChange, } from '../shared/schema.ts';
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
    assert.deepEqual((second.prepare('SELECT image FROM photos WHERE id = ?').get(photoId) as { image: Buffer }).image, pixels);

    const apply = first.prepare(insertChange);
    for (const change of response.changes) apply.run(...decodeChange(change));
    assert.equal((first.prepare('SELECT COUNT(*) AS count FROM batches').get() as { count: number }).count, 2);
  } finally {
    closeWorkspaceDb(first);
    closeWorkspaceDb(second);
  }
});

for (const version of [1, 2, 3, 4]) test(`existing version ${version} workspace gains replicated recipe types and event ends`, () => {
  const id = nanoid();
  const file = join(process.env.BREWLOG_DATA_DIR!, `${id}.sqlite`);
  const old = new Database(file);
  old.loadExtension(resolve('vendor/crsqlite.so'));
  old.exec(`CREATE TABLE schema_meta(version INTEGER NOT NULL); INSERT INTO schema_meta VALUES (${version})`);
  const existing = replicatedTables.filter(name => !['recipe_types', 'event_ends'].includes(name)
    && (version >= 4 || name !== 'inventory_display_units')
    && (version >= 3 || name !== 'inventory_item_specs') && (version > 1 || name !== 'equipment_archives'));
  for (const statement of schemaStatements.filter(sql => existing.some(name => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${name} `)))) old.exec(statement);
  for (const table of existing) old.prepare('SELECT crsql_as_crr(?)').get(table);
  for (const statement of indexStatements) old.exec(statement);
  old.close();

  const migrated = openWorkspaceDb(id);
  try {
    assert.equal((migrated.prepare('SELECT version FROM schema_meta').get() as { version: number }).version, 5);
    migrated.prepare('INSERT INTO equipment_archives(id, equipment_id, archived_at) VALUES (?, ?, ?)')
      .run(nanoid(), nanoid(), nowSeconds());
    assert.ok((migrated.prepare("SELECT 1 FROM crsql_changes WHERE \"table\" = 'equipment_archives' LIMIT 1").get()));
    migrated.prepare('INSERT INTO inventory_item_specs(id, inventory_item_id, capacity_liters) VALUES (?, ?, ?)')
      .run(nanoid(), nanoid(), 0.5);
    assert.ok((migrated.prepare("SELECT 1 FROM crsql_changes WHERE \"table\" = 'inventory_item_specs' LIMIT 1").get()));
    migrated.prepare('INSERT INTO inventory_display_units(id, display_unit) VALUES (?, ?)').run(nanoid(), 'lb + oz');
    assert.ok((migrated.prepare("SELECT 1 FROM crsql_changes WHERE \"table\" = 'inventory_display_units' LIMIT 1").get()));
    migrated.prepare('INSERT INTO recipe_types(id, recipe_type) VALUES (?, ?)').run(nanoid(), 'beer');
    migrated.prepare('INSERT INTO event_ends(id, ended_at) VALUES (?, ?)').run(nanoid(), nowSeconds());
    for (const table of ['recipe_types', 'event_ends']) {
      assert.ok(migrated.prepare('SELECT 1 FROM crsql_changes WHERE "table" = ? LIMIT 1').get(table));
    }
  } finally {
    closeWorkspaceDb(migrated);
  }
});
