import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'yeast-rapt-'));
after(() => rmSync(directory, { recursive: true, force: true }));
process.env.BREWLOG_DATA_DIR = directory;

const { closeWorkspaceDb, createWorkspace, openAuthDb, openWorkspaceDb } = await import('../server/db.ts');
const { deleteRaptIntegration, ensureRaptToken, ingestRaptReading, parseRaptReading, raptConnectionForToken,
  raptDevices, rotateRaptToken, setRaptBrewery } = await import('../server/rapt.ts');
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
  assert.match(old, /^[A-Za-z0-9_-]{21}$/);
  assert.equal(ensureRaptToken(auth, 'account-a'), old);
  const other = rotateRaptToken(auth, 'account-b');
  assert.match(other, /^[A-Za-z0-9_-]{21}$/);
  assert.equal(raptConnectionForToken(auth, old)?.account_id, 'account-a');
  assert.equal(raptConnectionForToken(auth, other)?.account_id, 'account-b');
  const current = rotateRaptToken(auth, 'account-a');
  assert.equal(raptConnectionForToken(auth, old), null);
  assert.equal(raptConnectionForToken(auth, current)?.account_id, 'account-a');
  const legacyToken = 'A'.repeat(43);
  auth.prepare('UPDATE rapt_connections SET token = ? WHERE account_id = ?').run(legacyToken, 'account-b');
  assert.equal(raptConnectionForToken(auth, legacyToken)?.account_id, 'account-b');
});

test('RAPT readings validate values and keep unassigned devices private', () => {
  assert.equal(parseRaptReading({ ...body(new Date().toISOString()), gravity: 3 }), null);
  assert.equal(parseRaptReading({ ...body(new Date().toISOString()), temperature: '@temperature' }), null);
  assert.equal(parseRaptReading({ ...body(new Date().toISOString()), created_date: 'bad' }), null);
  const reading = parseRaptReading(body(new Date().toISOString()));
  assert.ok(reading);
  assert.equal(ingestRaptReading(auth, 'account-a', reading, workspace), 'unassigned');
  assert.equal(raptDevices(auth, 'account-a', workspace)[0].workspace_id, null);
  assert.equal(raptDevices(auth, 'account-b', workspace).length, 0);
  assert.equal(setRaptBrewery(auth, 'account-b', deviceId, foreign.id, workspace), 'device_missing');
  assert.equal(setRaptBrewery(auth, 'account-a', deviceId, foreign.id, workspace), 'brewery_missing');
});

test('one-brewery discovery creates equipment, while batch use controls readings', () => {
  const foreignReading = parseRaptReading({ ...body(new Date().toISOString()), device_id: 'foreign-pill-123' });
  assert.ok(foreignReading);
  assert.equal(ingestRaptReading(auth, 'account-b', foreignReading, workspace), 'unassigned');
  const auto = raptDevices(auth, 'account-b', workspace)[0];
  assert.equal(auto.workspace_id, foreign.id);
  assert.equal((workspace(foreign.id).prepare('SELECT name FROM equipment WHERE id = ?').get(auto.equipment_id) as
    { name: string }).name, 'Blue Pill');
  assert.equal(setRaptBrewery(auth, 'account-a', deviceId, first.id, workspace), 'ok');
  const unit = raptDevices(auth, 'account-a', workspace)[0];
  assert.equal(unit.workspace_id, first.id);
  assert.ok(unit.equipment_id);
  assert.equal((workspace(first.id).prepare('SELECT catalog_product_id FROM products WHERE id = (SELECT model_id FROM equipment WHERE id = ?)')
    .get(unit.equipment_id) as { catalog_product_id: string }).catalog_product_id, 'equipment_rapt_pill');
  const useId = 'rapt_use_first';
  workspace(first.id).prepare(`INSERT INTO batch_events(id, batch_id, event_type, title, actual_at, created_at)
    VALUES (?, ?, 'equipment_use', 'Use Blue Pill', ?, ?)`).run(useId, batchA, Math.floor(Date.now() / 1000) - 10, 1);
  workspace(first.id).prepare('INSERT INTO equipment_use_events(event_id, equipment_id) VALUES (?, ?)')
    .run(useId, unit.equipment_id);
  const reading = parseRaptReading(body(new Date().toISOString()));
  assert.ok(reading);
  assert.equal(ingestRaptReading(auth, 'account-a', reading, workspace), 'recorded');
  assert.equal(ingestRaptReading(auth, 'account-a', reading, workspace), 'duplicate');
  const events = workspace(first.id).prepare(`SELECT e.batch_id, e.source_id, e.external_id,
      g.value AS gravity, t.value AS temperature, g.equipment_id AS gravity_equipment_id,
      t.equipment_id AS temperature_equipment_id FROM batch_events e
      JOIN gravity_measurements g ON g.event_id = e.id
      JOIN temperature_measurements t ON t.event_id = e.id`).all() as
    { batch_id: string; source_id: string; external_id: string; gravity: number; temperature: number;
      gravity_equipment_id: string; temperature_equipment_id: string }[];
  assert.equal(events.length, 1);
  assert.equal(events[0].batch_id, batchA);
  assert.equal(events[0].gravity, 1.0416);
  assert.equal(events[0].temperature, 18.38);
  assert.equal(events[0].external_id, reading.sourceTimestamp);
  assert.equal(events[0].source_id, `rapt:account-a:${deviceId}`);
  assert.equal(events[0].gravity_equipment_id, unit.equipment_id);
  assert.equal(events[0].temperature_equipment_id, unit.equipment_id);
  const renamed = parseRaptReading({ ...body(new Date(Date.now() + 1000).toISOString()), device_name: 'Green Pill' });
  assert.ok(renamed);
  assert.equal(ingestRaptReading(auth, 'account-a', renamed, workspace), 'recorded');
  assert.equal((workspace(first.id).prepare('SELECT name FROM equipment WHERE id = ?').get(unit.equipment_id) as
    { name: string }).name, 'Green Pill');
});

test('moving a Pill ends its use and keeps old equipment and readings', () => {
  assert.equal(setRaptBrewery(auth, 'account-a', deviceId, second.id, workspace), 'ok');
  const unit = raptDevices(auth, 'account-a', workspace)[0];
  assert.equal(unit.workspace_id, second.id);
  assert.equal(unit.batch_id, null);
  assert.ok(workspace(first.id).prepare("SELECT 1 FROM event_ends WHERE id = 'rapt_use_first'").get());
  assert.ok((workspace(first.id).prepare("SELECT removed_at FROM equipment WHERE id = (SELECT equipment_id FROM equipment_use_events WHERE event_id = 'rapt_use_first')")
    .get() as { removed_at: number }).removed_at);
  const useId = 'rapt_use_second';
  workspace(second.id).prepare(`INSERT INTO batch_events(id, batch_id, event_type, title, actual_at, created_at)
    VALUES (?, ?, 'equipment_use', 'Use Green Pill', ?, ?)`).run(useId, batchB, Math.floor(Date.now() / 1000) - 10, 1);
  workspace(second.id).prepare('INSERT INTO equipment_use_events(event_id, equipment_id) VALUES (?, ?)')
    .run(useId, unit.equipment_id);
  const later = parseRaptReading(body(new Date(Date.now() + 2000).toISOString()));
  assert.ok(later);
  assert.equal(ingestRaptReading(auth, 'account-a', later, workspace), 'recorded');
  assert.equal((workspace(second.id).prepare('SELECT batch_id FROM batch_events').get() as
    { batch_id: string }).batch_id, batchB);
  assert.equal((workspace(first.id).prepare('SELECT count(*) AS n FROM gravity_measurements').get() as
    { n: number }).n, 2);
  assert.equal(setRaptBrewery(auth, 'account-a', deviceId, null, workspace), 'ok');
  const unassigned = parseRaptReading(body(new Date(Date.now() + 3000).toISOString()));
  assert.ok(unassigned);
  assert.equal(ingestRaptReading(auth, 'account-a', unassigned, workspace), 'unassigned');
  assert.equal(raptDevices(auth, 'account-a', workspace)[0].workspace_id, null);
});

test('legacy Pill assignments become equipment uses and link older measurements', () => {
  const legacyDevice = 'legacy-device-123';
  const at = Math.floor(Date.now() / 1000) - 100;
  auth.prepare(`INSERT INTO rapt_devices(account_id, device_id, name, device_type, last_seen_at)
    VALUES ('account-a', ?, 'Legacy Pill', 'Hydrometer', ?)`).run(legacyDevice, at);
  auth.prepare(`INSERT INTO rapt_assignments(id, account_id, device_id, workspace_id, batch_id, valid_from)
    VALUES ('legacy_assn', 'account-a', ?, ?, ?, ?)`).run(legacyDevice, first.id, batchA, at);
  auth.prepare("UPDATE rapt_assignments SET valid_until = ? WHERE id = 'legacy_assn'").run(at + 50);
  auth.prepare(`INSERT INTO rapt_assignments(id, account_id, device_id, workspace_id, batch_id, valid_from)
    VALUES ('legacy_second', 'account-a', ?, ?, ?, ?)`).run(legacyDevice, second.id, batchB, at + 50);
  workspace(first.id).prepare(`INSERT INTO batch_events(id, batch_id, event_type, title, actual_at, created_at, source_id)
    VALUES ('legacy_reading', ?, 'measurement', 'Legacy reading', ?, ?, ?)`)
    .run(batchA, at + 10, at + 10, `rapt:account-a:${legacyDevice}`);
  workspace(first.id).prepare("INSERT INTO gravity_measurements(event_id, value, unit, source) VALUES ('legacy_reading', 1.04, 'SG', 'rapt')").run();
  const migrated = raptDevices(auth, 'account-a', workspace).find(device => device.device_id === legacyDevice)!;
  assert.equal(migrated.workspace_id, second.id);
  assert.equal(migrated.batch_id, batchB);
  const firstEquipmentId = (workspace(first.id).prepare("SELECT equipment_id FROM equipment_use_events WHERE event_id = 'ra_legacy_assn'")
    .get() as { equipment_id: string }).equipment_id;
  assert.equal((workspace(first.id).prepare("SELECT equipment_id FROM gravity_measurements WHERE event_id = 'legacy_reading'")
    .get() as { equipment_id: string }).equipment_id, firstEquipmentId);
  assert.equal((workspace(first.id).prepare('SELECT removed_at FROM equipment WHERE id = ?').get(firstEquipmentId) as
    { removed_at: number }).removed_at, at + 50);
  raptDevices(auth, 'account-a', workspace);
  assert.equal((workspace(first.id).prepare("SELECT count(*) AS n FROM equipment_use_events WHERE event_id = 'ra_legacy_assn'")
    .get() as { n: number }).n, 1);
});

test('deleted Pill equipment stops readings and is not recreated by later webhooks', () => {
  assert.equal(setRaptBrewery(auth, 'account-a', deviceId, first.id, workspace), 'ok');
  const unit = raptDevices(auth, 'account-a', workspace).find(device => device.device_id === deviceId)!;
  workspace(first.id).prepare('UPDATE equipment SET removed_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), unit.equipment_id);
  const reading = parseRaptReading(body(new Date(Date.now() + 4000).toISOString()));
  assert.ok(reading);
  assert.equal(ingestRaptReading(auth, 'account-a', reading, workspace), 'unassigned');
  assert.equal(raptDevices(auth, 'account-a', workspace).find(device => device.device_id === deviceId)?.workspace_id, null);
  const later = parseRaptReading(body(new Date(Date.now() + 5000).toISOString()));
  assert.ok(later);
  assert.equal(ingestRaptReading(auth, 'account-a', later, workspace), 'unassigned');
  assert.equal((workspace(first.id).prepare('SELECT removed_at FROM equipment WHERE id = ?').get(unit.equipment_id) as
    { removed_at: number }).removed_at !== null, true);
});

test('deleting a RAPT integration revokes its URL and clears its devices without removing batch readings', () => {
  const token = ensureRaptToken(auth, 'account-a');
  const other = ensureRaptToken(auth, 'account-b');
  deleteRaptIntegration(auth, 'account-a');
  assert.equal(raptConnectionForToken(auth, token), null);
  assert.equal(raptDevices(auth, 'account-a', workspace).length, 0);
  assert.equal((auth.prepare('SELECT count(*) AS n FROM rapt_assignments WHERE account_id = ?').get('account-a') as
    { n: number }).n, 0);
  assert.equal(raptConnectionForToken(auth, other)?.account_id, 'account-b');
  assert.equal((workspace(first.id).prepare('SELECT count(*) AS n FROM gravity_measurements').get() as { n: number }).n, 3);
  assert.notEqual(ensureRaptToken(auth, 'account-a'), token);
});
