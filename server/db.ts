import Database from 'better-sqlite3';
import { existsSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createId } from '../shared/id.ts';
import { indexStatements, nowSeconds, replicatedTables, schemaStatements, workspaceSchemaVersion, workspaceViewStatements } from '../shared/schema.ts';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
export const dataDir = resolve(projectRoot, process.env.BREWLOG_DATA_DIR || './data');
const extensionPath = resolve(projectRoot, 'vendor/crsqlite.so');
const authSchemaVersion = 5;
mkdirSync(dataDir, { recursive: true });

export function assertCrSqliteAvailable(): void {
  if (!existsSync(extensionPath)) {
    throw new Error('CR-SQLite extension missing. Run yarn setup:sqlite first.');
  }
  const db = new Database(':memory:');
  try {
    db.loadExtension(extensionPath);
  } catch (cause) {
    throw new Error('Could not load CR-SQLite. Run yarn setup:sqlite first.', { cause });
  } finally {
    db.close();
  }
}

export function openAuthDb(): Database.Database {
  const db = new Database(join(dataDir, 'auth.sqlite'));
  db.pragma('journal_mode = WAL');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > authSchemaVersion) {
    db.close();
    throw new Error(`This server cannot open auth schema ${version}; update Yeast.Win! first.`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      hide_public_profile INTEGER DEFAULT NULL CHECK (hide_public_profile IN (0, 1) OR hide_public_profile IS NULL),
      time_zone TEXT,
      full_name TEXT
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
  const accountColumns = db.pragma('table_info(accounts)') as { name: string }[];
  if (!accountColumns.some(column => column.name === 'hide_public_profile'))
    db.exec('ALTER TABLE accounts ADD COLUMN hide_public_profile INTEGER DEFAULT NULL CHECK (hide_public_profile IN (0, 1) OR hide_public_profile IS NULL)');
  if (!accountColumns.some(column => column.name === 'time_zone'))
    db.exec('ALTER TABLE accounts ADD COLUMN time_zone TEXT');
  if (!accountColumns.some(column => column.name === 'full_name'))
    db.exec('ALTER TABLE accounts ADD COLUMN full_name TEXT');
  const hasLegacyMeta = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_meta'").get();
  const rootMigrationDone = version >= 1 || (hasLegacyMeta
    && !!db.prepare("SELECT 1 FROM auth_meta WHERE key = 'nullable_root_slug_v1'").get());
  db.transaction(() => {
    if (!rootMigrationDone) {
      const rows = db.prepare('SELECT id, owner_account_id, name, slug FROM workspaces ORDER BY created_at, rowid')
        .all() as { id: string; owner_account_id: string; name: string; slug: string | null }[];
      const used = new Map<string, Set<string>>();
      for (const row of rows) if (row.slug) {
        const set = used.get(row.owner_account_id) || new Set<string>();
        set.add(row.slug); used.set(row.owner_account_id, set);
      }
      const update = db.prepare('UPDATE workspaces SET slug = ? WHERE id = ?');
      for (const row of rows) if (row.slug === null) {
        const slug = uniqueSlug(row.name, used.get(row.owner_account_id) || new Set());
        update.run(slug, row.id);
        const set = used.get(row.owner_account_id) || new Set<string>();
        set.add(slug); used.set(row.owner_account_id, set);
      }
      const roots = new Set<string>();
      for (const row of rows) if (!roots.has(row.owner_account_id)) {
        roots.add(row.owner_account_id);
        db.prepare('UPDATE workspaces SET slug = NULL WHERE id = ?').run(row.id);
      }
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_slug ON workspaces(owner_account_id, slug)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workspaces_one_root ON workspaces(owner_account_id) WHERE slug IS NULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS rapt_connections (
        account_id TEXT PRIMARY KEY NOT NULL,
        token TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rapt_devices (
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        name TEXT NOT NULL,
        device_type TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS rapt_assignments (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        valid_from INTEGER NOT NULL,
        valid_until INTEGER
      );
      CREATE INDEX IF NOT EXISTS rapt_assignments_device_time
        ON rapt_assignments(account_id, device_id, valid_from, valid_until);
      CREATE UNIQUE INDEX IF NOT EXISTS rapt_assignments_one_active
        ON rapt_assignments(account_id, device_id) WHERE valid_until IS NULL;
      CREATE INDEX IF NOT EXISTS rapt_assignments_workspace
        ON rapt_assignments(workspace_id);
      CREATE TABLE IF NOT EXISTS brewer_activity_cache (
        account_id TEXT PRIMARY KEY NOT NULL,
        time_zone TEXT NOT NULL,
        through_date TEXT NOT NULL,
        data_json TEXT NOT NULL,
        generated_at INTEGER NOT NULL
      );
    `);
    if (hasLegacyMeta) db.exec('DROP TABLE auth_meta');
    if (version < authSchemaVersion) db.pragma(`user_version = ${authSchemaVersion}`);
  })();
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
  const id = createId();
  const existing = auth.prepare('SELECT slug FROM workspaces WHERE owner_account_id = ?').all(ownerId) as { slug: string | null }[];
  const slug = existing.length ? uniqueSlug(name, new Set(existing.map(row => row.slug).filter((value): value is string => value !== null))) : null;
  const db = openWorkspaceDb(id);
  db.close();
  auth.prepare('INSERT INTO workspaces(id, owner_account_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, ownerId, name, slug, nowSeconds());
  return { id, name, slug };
}

export function updateWorkspace(auth: Database.Database, ownerId: string, id: string, name: string, slug: string | null) {
  const result = auth.prepare('UPDATE workspaces SET name = ?, slug = ? WHERE id = ? AND owner_account_id = ?')
    .run(name, slug, id, ownerId);
  return result.changes ? { id, name, slug } : null;
}

export function deleteWorkspace(auth: Database.Database, ownerId: string, id: string,
  closeOpenDb: () => void): boolean {
  const owned = auth.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_account_id = ?').get(id, ownerId);
  if (!owned) return false;
  closeOpenDb();
  auth.prepare('DELETE FROM rapt_assignments WHERE workspace_id = ?').run(id);
  const file = join(dataDir, `${id}.sqlite`);
  for (const path of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(path)) unlinkSync(path);
  auth.prepare('DELETE FROM workspaces WHERE id = ? AND owner_account_id = ?').run(id, ownerId);
  return true;
}

export function openWorkspaceDb(id: string): Database.Database {
  if (!/^[A-Za-z0-9_-]{10,32}$/.test(id)) throw new Error('Invalid workspace ID');
  const db = new Database(join(dataDir, `${id}.sqlite`));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.loadExtension(extensionPath);
  const version = db.pragma('user_version', { simple: true }) as number;
  const ready = version === workspaceSchemaVersion && !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE name = 'products__crsql_clock'").get();
  if (!ready) db.transaction(() => {
    // Local prototype workspaces predate the product baseline. Their contents
    // are disposable; the shared catalog is migrated separately and retained.
    const views = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as { name: string }[];
    for (const row of views) db.exec(`DROP VIEW "${row.name}"`);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'crsql_%'
      AND name NOT LIKE '%__crsql_%'`).all() as { name: string }[];
    const clocks = new Set((db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__crsql_clock'")
      .all() as { name: string }[]).map(row => row.name));
    for (const row of tables) {
      if (clocks.has(`${row.name}__crsql_clock`)) db.prepare('SELECT crsql_as_table(?)').get(row.name);
      db.exec(`DROP TABLE "${row.name}"`);
    }
    for (const statement of schemaStatements) db.exec(statement);
    for (const table of replicatedTables) db.prepare('SELECT crsql_as_crr(?)').get(table);
    for (const statement of indexStatements) db.exec(statement);
    for (const statement of workspaceViewStatements) db.exec(statement);
    db.pragma(`user_version = ${workspaceSchemaVersion}`);
  })();
  const catalogPath = join(dataDir, 'catalog.sqlite');
  if (existsSync(catalogPath)) db.prepare('ATTACH DATABASE ? AS catalog').run(realpathSync(catalogPath));
  return db;
}

export function closeWorkspaceDb(db: Database.Database): void {
  db.prepare('SELECT crsql_finalize()').get();
  db.close();
}
