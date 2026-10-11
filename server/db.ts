import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { indexStatements, nowSeconds, replicatedTables, schemaStatements } from '../shared/schema.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const dataDir = resolve(process.env.BREWLOG_DATA_DIR || './data');
const extensionPath = resolve('vendor/crsqlite.so');
mkdirSync(dataDir, { recursive: true });

export function openAuthDb(): Database.Database {
  const db = new Database(join(dataDir, 'auth.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      owner_account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function createWorkspace(auth: Database.Database, ownerId: string, name: string) {
  const id = nanoid();
  const db = openWorkspaceDb(id);
  db.close();
  auth.prepare('INSERT INTO workspaces(id, owner_account_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(id, ownerId, name, nowSeconds());
  return { id, name };
}

export function openWorkspaceDb(id: string): Database.Database {
  if (!/^[A-Za-z0-9_-]{10,32}$/.test(id)) throw new Error('Invalid workspace ID');
  if (!existsSync(extensionPath)) {
    throw new Error('CR-SQLite extension missing. Run yarn setup:sqlite first.');
  }
  const db = new Database(join(dataDir, `${id}.sqlite`));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.loadExtension(extensionPath);
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined;
  if (!row) {
    db.exec('BEGIN');
    try {
      for (const statement of schemaStatements) db.exec(statement);
      for (const table of replicatedTables) db.prepare('SELECT crsql_as_crr(?)').get(table);
      for (const statement of indexStatements) db.exec(statement);
      db.prepare('INSERT INTO schema_meta(version) VALUES (1)').run();
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  } else if (row.version !== 1) {
    db.close();
    throw new Error(`Unsupported workspace schema ${row.version}`);
  }
  return db;
}

export function closeWorkspaceDb(db: Database.Database): void {
  db.prepare('SELECT crsql_finalize()').get();
  db.close();
}
