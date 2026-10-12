import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { indexStatements, nowSeconds, replicatedTables, schemaStatements, workspaceSchemaVersion, workspaceV2Statements, workspaceV3Statements, workspaceV4Statements } from '../shared/schema.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
export const dataDir = resolve(process.env.BREWLOG_DATA_DIR || './data');
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
    CREATE TABLE IF NOT EXISTS account_avatars (
      account_id TEXT PRIMARY KEY NOT NULL,
      image_jpeg BLOB NOT NULL,
      uploaded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_preferences (
      account_id TEXT PRIMARY KEY NOT NULL,
      temperature_unit TEXT NOT NULL,
      volume_unit TEXT NOT NULL,
      mass_unit TEXT NOT NULL,
      pressure_unit TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      owner_account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  const columns = db.pragma('table_info(workspaces)') as { name: string }[];
  if (!columns.some(column => column.name === 'slug')) db.exec('ALTER TABLE workspaces ADD COLUMN slug TEXT');
  const rows = db.prepare('SELECT id, owner_account_id, name, slug FROM workspaces ORDER BY created_at, rowid')
    .all() as { id: string; owner_account_id: string; name: string; slug: string | null }[];
  const used = new Map<string, Set<string>>();
  for (const row of rows) if (row.slug) {
    const set = used.get(row.owner_account_id) || new Set<string>();
    set.add(row.slug); used.set(row.owner_account_id, set);
  }
  const update = db.prepare('UPDATE workspaces SET slug = ? WHERE id = ?');
  for (const row of rows) if (!row.slug) {
    const slug = uniqueSlug(row.name, used.get(row.owner_account_id) || new Set());
    update.run(slug, row.id);
    const set = used.get(row.owner_account_id) || new Set<string>();
    set.add(slug); used.set(row.owner_account_id, set);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_slug ON workspaces(owner_account_id, slug)');
  return db;
}

function uniqueSlug(name: string, used: Set<string>): string {
  const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'brewery';
  let slug = base;
  for (let number = 2; used.has(slug); number++) slug = `${base}-${number}`;
  return slug;
}

export function createWorkspace(auth: Database.Database, ownerId: string, name: string) {
  const id = nanoid();
  const existing = auth.prepare('SELECT slug FROM workspaces WHERE owner_account_id = ?').all(ownerId) as { slug: string }[];
  const slug = uniqueSlug(name, new Set(existing.map(row => row.slug)));
  const db = openWorkspaceDb(id);
  db.close();
  auth.prepare('INSERT INTO workspaces(id, owner_account_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, ownerId, name, slug, nowSeconds());
  return { id, name, slug };
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
      db.prepare('INSERT INTO schema_meta(version) VALUES (?)').run(workspaceSchemaVersion);
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  } else if ([1, 2, 3].includes(row.version)) {
    db.exec('BEGIN');
    try {
      if (row.version < 2) {
        for (const statement of workspaceV2Statements) db.exec(statement);
        db.prepare('SELECT crsql_as_crr(?)').get('equipment_archives');
      }
      if (row.version < 3) {
        for (const statement of workspaceV3Statements) db.exec(statement);
        db.prepare('SELECT crsql_as_crr(?)').get('inventory_item_specs');
      }
      for (const statement of workspaceV4Statements) db.exec(statement);
      db.prepare('SELECT crsql_as_crr(?)').get('inventory_display_units');
      db.prepare('UPDATE schema_meta SET version = ?').run(workspaceSchemaVersion);
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  } else if (row.version !== workspaceSchemaVersion) {
    db.close();
    throw new Error(`Unsupported workspace schema ${row.version}`);
  }
  return db;
}

export function closeWorkspaceDb(db: Database.Database): void {
  db.prepare('SELECT crsql_finalize()').get();
  db.close();
}
