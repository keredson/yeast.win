import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'yeast-rapt-'));
after(() => rmSync(directory, { recursive: true, force: true }));
process.env.BREWLOG_DATA_DIR = directory;

const { closeWorkspaceDb, createWorkspace, openAuthDb, openWorkspaceDb } = await import('../server/db.ts');
const { assignRaptDevice, deleteRaptIntegration, ensureRaptToken, ingestRaptReading, parseRaptReading, raptConnectionForToken,
  raptDevices, rotateRaptToken, unassignRaptDevice } = await import('../server/rapt.ts');
const auth = openAuthDb();
const first = createWorkspace(auth, 'account-a', 'Home');
const second = createWorkspace(auth, 'account-a', 'Commercial');
const foreign = createWorkspace(auth, 'account-b', 'Other');
const dbs = new Map([
  [first.id, openWorkspaceDb(first.id)],
  [second.id, openWorkspaceDb(second.id)],
  [foreign.id, openWorkspaceDb(foreign.id)]
]);
const batchA = 'batch_for_account_a_1';
const batchB = 'batch_for_account_a_2';
for (const [workspaceId, batchId] of [[first.id, batchA], [second.id, batchB]]) {
  dbs.get(workspaceId)!.prepare(`INSERT INTO batches(id, name, status, created_at, updated_at)
    VALUES (?, ?, 'active', 1, 1)`).run(batchId, batchId);
}
after(() => { for (const db of dbs.values()) closeWorkspaceDb(db); auth.close(); });
const workspace = (id: string) => dbs.get(id)!;
const deviceId = '2c6b1715-930a-464a-b62e-3f2bc66d2261';
const body = (timestamp: string) => ({
  device_id: deviceId, device_name: 'Blue Pill', device_type: 'Hydrometer',
  temperature: 18.38, gravity: 1.0416, battery: 67.02, rssi: -46, created_date: timestamp
});

test('RAPT tokens are private to an account and rotation invalidates the old URL', () => {
  const old = ensureRaptToken(auth, 'account-a');
  assert.equal(ensureRaptToken(auth, 'account-a'), old);
  const other = rotateRaptToken(auth, 'account-b');
  assert.equal(raptConnectionForToken(auth, old)?.account_id, 'account-a');
  assert.equal(raptConnectionForToken(auth, other)?.account_id, 'account-b');
  const current = rotateRaptToken(auth, 'account-a');
  assert.equal(raptConnectionForToken(auth, old), null);
  assert.equal(raptConnectionForToken(auth, current)?.account_id, 'account-a');
});

test('RAPT readings validate values and keep unassigned devices private', () => {
  assert.equal(parseRaptReading({ ...body(new Date().toISOString()), gravity: 3 }), null);
  assert.equal(parseRaptReading({ ...body(new Date().toISOString()), temperature: '@temperature' }), null);
  assert.equal(parseRaptReading({ ...body(new Date().toISOString()), created_date: 'bad' }), null);
  const reading = parseRaptReading(body(new Date().toISOString()));
  assert.ok(reading);
  assert.equal(ingestRaptReading(auth, 'account-a', reading, workspace), 'unassigned');
  assert.equal(raptDevices(auth, 'account-a')[0].device_id, deviceId);
  assert.equal(raptDevices(auth, 'account-b').length, 0);
  assert.equal(assignRaptDevice(auth, 'account-b', deviceId, foreign.id, batchA, workspace(foreign.id)), 'device_missing');
  assert.equal(assignRaptDevice(auth, 'account-a', deviceId, foreign.id, batchA, workspace(foreign.id)), 'batch_missing');
});

test('one Pill reading creates one gravity and temperature event in its assigned batch', () => {
  assert.equal(assignRaptDevice(auth, 'account-a', deviceId, first.id, batchA, workspace(first.id)), 'ok');
  const reading = parseRaptReading(body(new Date().toISOString()));
  assert.ok(reading);
  assert.equal(ingestRaptReading(auth, 'account-a', reading, workspace), 'recorded');
  assert.equal(ingestRaptReading(auth, 'account-a', reading, workspace), 'duplicate');
  const events = workspace(first.id).prepare(`SELECT e.batch_id, e.source_id, e.external_id,
      g.value AS gravity, t.value AS temperature FROM batch_events e
      JOIN gravity_measurements g ON g.event_id = e.id
      JOIN temperature_measurements t ON t.event_id = e.id`).all() as
    { batch_id: string; source_id: string; external_id: string; gravity: number; temperature: number }[];
  assert.equal(events.length, 1);
  assert.equal(events[0].batch_id, batchA);
  assert.equal(events[0].gravity, 1.0416);
  assert.equal(events[0].temperature, 18.38);
  assert.equal(events[0].external_id, reading.sourceTimestamp);
  assert.equal(events[0].source_id, `rapt:account-a:${deviceId}`);
});

test('a Pill can be reassigned to another workspace without moving old readings', () => {
  assert.equal(assignRaptDevice(auth, 'account-a', deviceId, second.id, batchB, workspace(second.id)), 'ok');
  const later = parseRaptReading(body(new Date(Date.now() + 2000).toISOString()));
  assert.ok(later);
  assert.equal(ingestRaptReading(auth, 'account-a', later, workspace), 'recorded');
  assert.equal((workspace(second.id).prepare('SELECT batch_id FROM batch_events').get() as
    { batch_id: string }).batch_id, batchB);
  assert.equal((workspace(first.id).prepare('SELECT count(*) AS n FROM batch_events').get() as
    { n: number }).n, 1);
  unassignRaptDevice(auth, 'account-a', deviceId);
  const unassigned = parseRaptReading(body(new Date(Date.now() + 3000).toISOString()));
  assert.ok(unassigned);
  assert.equal(ingestRaptReading(auth, 'account-a', unassigned, workspace), 'unassigned');
});

test('deleting a RAPT integration revokes its URL and clears its devices without removing batch readings', () => {
  const token = ensureRaptToken(auth, 'account-a');
  const other = ensureRaptToken(auth, 'account-b');
  deleteRaptIntegration(auth, 'account-a');
  assert.equal(raptConnectionForToken(auth, token), null);
  assert.equal(raptDevices(auth, 'account-a').length, 0);
  assert.equal((auth.prepare('SELECT count(*) AS n FROM rapt_assignments WHERE account_id = ?').get('account-a') as
    { n: number }).n, 0);
  assert.equal(raptConnectionForToken(auth, other)?.account_id, 'account-b');
  assert.equal((workspace(first.id).prepare('SELECT count(*) AS n FROM batch_events').get() as { n: number }).n, 1);
  assert.notEqual(ensureRaptToken(auth, 'account-a'), token);
});
