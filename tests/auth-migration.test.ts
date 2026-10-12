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
