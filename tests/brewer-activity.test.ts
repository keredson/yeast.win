import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { activityWindow, brewerActivity } from '../server/brewerActivity.ts';
import { registrationTimeZone, validTimeZone } from '../server/timeZone.ts';

function workspace(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE batches(created_at INTEGER NOT NULL);
    CREATE TABLE recipes(created_at INTEGER NOT NULL);
    CREATE TABLE batch_events(actual_at INTEGER);`);
  return db;
}

function seconds(value: string): number { return Date.parse(value) / 1000; }

test('activity combines breweries by local day, excludes today, and stays cached until the next local day', () => {
  const auth = new Database(':memory:');
  const first = workspace();
  const second = workspace();
  auth.exec(`CREATE TABLE brewer_activity_cache(account_id TEXT PRIMARY KEY, time_zone TEXT NOT NULL,
    through_date TEXT NOT NULL, data_json TEXT NOT NULL, generated_at INTEGER NOT NULL)`);
  try {
    first.prepare('INSERT INTO batches VALUES (?)').run(seconds('2026-10-14T06:30:00Z')); // Oct 13 in Los Angeles.
    first.prepare('INSERT INTO batch_events VALUES (?)').run(seconds('2026-10-14T06:40:00Z'));
    first.prepare('INSERT INTO batches VALUES (?)').run(seconds('2026-10-14T08:00:00Z')); // Today is omitted.
    second.prepare('INSERT INTO recipes VALUES (?)').run(seconds('2026-10-13T18:00:00Z'));
    const getDb = (id: string) => id === 'first' ? first : second;
    const time = Date.parse('2026-10-14T12:00:00Z');
    const activity = brewerActivity(auth, 'owner', 'America/Los_Angeles', ['first', 'second'], getDb, time);
    assert.equal(activity.days.length, 365);
    assert.equal(activity.through_date, '2026-10-13');
    assert.equal(activity.days.at(-1)?.count, 3);
    assert.equal(activity.total, 3);
    second.prepare('INSERT INTO recipes VALUES (?)').run(seconds('2026-10-13T19:00:00Z'));
    assert.equal(brewerActivity(auth, 'owner', 'America/Los_Angeles', ['first', 'second'], getDb, time).total, 3);
    const changedZone = brewerActivity(auth, 'owner', 'Pacific/Kiritimati', ['first', 'second'], getDb, time);
    assert.equal(changedZone.through_date, '2026-10-14');
    assert.equal(changedZone.total, 5);
    assert.equal(brewerActivity(auth, 'owner', 'America/Los_Angeles', ['first', 'second'], getDb,
      Date.parse('2026-10-15T12:00:00Z')).total, 5);
  } finally { auth.close(); first.close(); second.close(); }
});

test('activity window follows the selected time zone across local midnight', () => {
  const instant = Date.parse('2026-03-08T07:30:00Z');
  assert.equal(activityWindow('America/New_York', instant).today, '2026-03-08');
  assert.equal(activityWindow('America/Los_Angeles', instant).today, '2026-03-07');
});

test('registration uses a valid browser time zone when no local GeoIP database is available', () => {
  assert.equal(registrationTimeZone('not-an-ip', 'Europe/Berlin'), 'Europe/Berlin');
  assert.equal(registrationTimeZone('not-an-ip', 'invalid/timezone'), 'UTC');
  assert.equal(validTimeZone('America/New_York'), true);
  assert.equal(validTimeZone('invalid/timezone'), false);
});
