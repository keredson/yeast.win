import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const directory = mkdtempSync(join(tmpdir(), 'brewlog-auth-migration-'));
after(() => rmSync(directory, { recursive: true, force: true }));
process.env.BREWLOG_DATA_DIR = directory;
const file = join(directory, 'auth.sqlite');
const legacy = new Database(file);
legacy.exec(`CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL, owner_account_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL
);`);
const insert = legacy.prepare('INSERT INTO workspaces(id, owner_account_id, name, created_at) VALUES (?, ?, ?, ?)');
insert.run('first', 'account', 'Homebrew', 10);
insert.run('second', 'account', 'Downtown Brewery', 10);
insert.run('third', 'account', 'Downtown Brewery', 10);
legacy.close();

const { openAuthDb } = await import('../server/db.ts');

test('legacy first brewery becomes the only root brewery', () => {
  const db = openAuthDb();
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 3);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'auth_meta'").get(), undefined);
    const rows = db.prepare('SELECT slug FROM workspaces WHERE owner_account_id = ? ORDER BY created_at, rowid')
      .all('account') as { slug: string | null }[];
    assert.deepEqual(rows.map(row => row.slug), [null, 'downtown-brewery', 'downtown-brewery-2']);
  } finally { db.close(); }
  const reopened = openAuthDb();
  try {
    const rows = reopened.prepare('SELECT slug FROM workspaces WHERE owner_account_id = ? ORDER BY created_at, rowid')
      .all('account') as { slug: string | null }[];
    assert.deepEqual(rows.map(row => row.slug), [null, 'downtown-brewery', 'downtown-brewery-2']);
  } finally { reopened.close(); }
});

test('auth upgrade respects the completed legacy root migration', () => {
  const legacy = new Database(file);
  legacy.exec(`UPDATE workspaces SET slug = 'homebrew' WHERE id = 'first';
    UPDATE workspaces SET slug = NULL WHERE id = 'second';
    CREATE TABLE auth_meta(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO auth_meta VALUES ('nullable_root_slug_v1', '1');
    PRAGMA user_version = 0;`);
  legacy.close();
  const db = openAuthDb();
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 3);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'auth_meta'").get(), undefined);
    assert.equal((db.prepare("SELECT id FROM workspaces WHERE slug IS NULL").get() as { id: string }).id, 'second');
  } finally { db.close(); }
});

test('auth upgrade preserves partially created RAPT tables and unrelated rows', () => {
  const legacy = new Database(file);
  legacy.exec(`INSERT INTO rapt_devices(account_id, device_id, name, device_type, last_seen_at)
    VALUES ('account', 'pill-one', 'Blue Pill', 'Hydrometer', 123);
    DROP INDEX rapt_assignments_one_active;
    PRAGMA user_version = 1;`);
  legacy.close();
  const db = openAuthDb();
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 3);
    assert.equal((db.prepare("SELECT name FROM rapt_devices WHERE device_id = 'pill-one'").get() as
      { name: string }).name, 'Blue Pill');
    assert.equal((db.prepare("SELECT name FROM workspaces WHERE id = 'first'").get() as
      { name: string }).name, 'Homebrew');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'rapt_assignments_one_active'").get());
  } finally { db.close(); }
});

test('auth upgrade adds nullable public profile visibility while preserving accounts and unrelated data', () => {
  const previous = new Database(file);
  previous.exec(`ALTER TABLE accounts DROP COLUMN hide_public_profile;
    INSERT INTO accounts(id, username, password_hash, created_at) VALUES ('brewer-one', 'brewer_one', 'saved-hash', 123);
    INSERT INTO account_avatars(account_id, image_jpeg, uploaded_at) VALUES ('brewer-one', x'010203', 456);
    PRAGMA user_version = 2;`);
  previous.close();
  const db = openAuthDb();
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 3);
    assert.deepEqual(db.prepare('SELECT username, password_hash, hide_public_profile FROM accounts WHERE id = ?')
      .get('brewer-one'), { username: 'brewer_one', password_hash: 'saved-hash', hide_public_profile: null });
    assert.deepEqual((db.prepare('SELECT image_jpeg FROM account_avatars WHERE account_id = ?')
      .get('brewer-one') as { image_jpeg: Buffer }).image_jpeg, Buffer.from([1, 2, 3]));
    assert.equal((db.prepare("SELECT name FROM rapt_devices WHERE device_id = 'pill-one'").get() as
      { name: string }).name, 'Blue Pill');
  } finally { db.close(); }
});

test('auth upgrade keeps visibility already added during a partial migration', () => {
  const partial = new Database(file);
  partial.exec("UPDATE accounts SET hide_public_profile = 1 WHERE id = 'brewer-one'; PRAGMA user_version = 2;");
  partial.close();
  const db = openAuthDb();
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 3);
    assert.equal((db.prepare("SELECT hide_public_profile FROM accounts WHERE id = 'brewer-one'").get() as
      { hide_public_profile: number }).hide_public_profile, 1);
    assert.equal((db.prepare("SELECT name FROM workspaces WHERE id = 'first'").get() as { name: string }).name, 'Homebrew');
  } finally { db.close(); }
});

test('public brewer visibility treats null as visible and hides both profile and avatar from visitors', async () => {
  const { publicBrewer, publicBrewerAvatar, setPublicProfileHidden } = await import('../server/auth.ts');
  const db = openAuthDb();
  try {
    db.prepare("UPDATE accounts SET hide_public_profile = NULL WHERE id = 'brewer-one'").run();
    assert.deepEqual(publicBrewer(db, 'BREWER_ONE'), { username: 'brewer_one', has_avatar: true, hidden: false });
    assert.deepEqual(publicBrewerAvatar(db, 'brewer_one'), Buffer.from([1, 2, 3]));
    setPublicProfileHidden(db, 'brewer-one', true);
    assert.equal(publicBrewer(db, 'brewer_one'), null);
    assert.equal(publicBrewerAvatar(db, 'brewer_one'), null);
    assert.deepEqual(publicBrewer(db, 'brewer_one', 'brewer-one'),
      { username: 'brewer_one', has_avatar: true, hidden: true });
    assert.deepEqual(publicBrewerAvatar(db, 'brewer_one', 'brewer-one'), Buffer.from([1, 2, 3]));
    setPublicProfileHidden(db, 'brewer-one', false);
    assert.deepEqual(publicBrewer(db, 'brewer_one'), { username: 'brewer_one', has_avatar: true, hidden: false });
  } finally { db.close(); }
});
