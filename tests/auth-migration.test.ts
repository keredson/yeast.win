import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const directory = mkdtempSync(join(tmpdir(), 'brewlog-auth-migration-'));
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
    assert.equal(db.pragma('user_version', { simple: true }), 1);
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
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'auth_meta'").get(), undefined);
    assert.equal((db.prepare("SELECT id FROM workspaces WHERE slug IS NULL").get() as { id: string }).id, 'second');
  } finally { db.close(); }
});
