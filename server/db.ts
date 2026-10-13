import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { indexStatements, legacyEquipmentCopyStatements, nowSeconds, replicatedTables, retiredReplicatedTables, schemaStatements,
  workspaceSchemaVersion, workspaceTableColumns } from '../shared/schema.ts';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
export const dataDir = resolve(projectRoot, process.env.BREWLOG_DATA_DIR || './data');
const extensionPath = resolve(projectRoot, 'vendor/crsqlite.so');
const authSchemaVersion = 1;
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
    throw new Error(`This server cannot open auth schema ${version}; update Brewlog first.`);
  }
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
  const hasLegacyMeta = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_meta'").get();
  const rootMigrationDone = version >= authSchemaVersion || (hasLegacyMeta
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
  const id = nanoid();
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
  const storedVersion = db.pragma('user_version', { simple: true }) as number;
  const hasLegacyMeta = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").get();
  const legacyVersion = hasLegacyMeta
    ? (db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined)?.version : undefined;
  const version = storedVersion || legacyVersion || 0;
  const hasWorkspaceTables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[]).some(row => replicatedTables.includes(row.name));
  if (version === 0 && !hasWorkspaceTables) {
    db.exec('BEGIN');
    try {
      for (const statement of schemaStatements) db.exec(statement);
      for (const table of replicatedTables) db.prepare('SELECT crsql_as_crr(?)').get(table);
      for (const statement of indexStatements) db.exec(statement);
      if (hasLegacyMeta) db.exec('DROP TABLE schema_meta');
      db.pragma(`user_version = ${workspaceSchemaVersion}`);
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  } else if (version > workspaceSchemaVersion) {
    db.close();
    throw new Error(`This server cannot open workspace schema ${version}; update Brewlog first.`);
  } else {
    db.exec('BEGIN');
    try {
      const existing = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]).map(row => row.name));
      for (const [index, table] of replicatedTables.entries()) {
        const expected = workspaceTableColumns[table];
        if (existing.has(table)) {
          const actual = (db.pragma(`table_info("${table}")`) as { name: string }[]).map(row => row.name);
          if (actual.join(',') === expected.join(',')) {
            if (!existing.has(`${table}__crsql_clock`)) db.prepare('SELECT crsql_as_crr(?)').get(table);
            continue;
          }
          const common = expected.filter(column => actual.includes(column));
          const snapshot = `migration_${table}`;
          if (table === 'equipment' && actual.some(column => !expected.includes(column))
            && !existing.has('equipment_legacy_migration')) {
            db.exec('CREATE TABLE equipment_legacy_migration AS SELECT * FROM equipment');
          }
          if (common.length) db.exec(`CREATE TEMP TABLE "${snapshot}" AS SELECT ${common.join(', ')} FROM "${table}"`);
          if (existing.has(`${table}__crsql_clock`)) db.prepare('SELECT crsql_as_table(?)').get(table);
          db.exec(`DROP TABLE "${table}"`);
          db.exec(schemaStatements[index]);
          db.prepare('SELECT crsql_as_crr(?)').get(table);
          if (common.length) {
            db.exec(`INSERT INTO "${table}" (${common.join(', ')}) SELECT ${common.join(', ')} FROM "${snapshot}"`);
            db.exec(`DROP TABLE "${snapshot}"`);
          }
        } else {
          db.exec(schemaStatements[index]);
          db.prepare('SELECT crsql_as_crr(?)').get(table);
        }
      }
      for (const table of retiredReplicatedTables) if (existing.has(table)) {
        if (existing.has(`${table}__crsql_clock`)) db.prepare('SELECT crsql_as_table(?)').get(table);
        db.exec(`DROP TABLE "${table}"`);
      }
      for (const statement of indexStatements) db.exec(statement);
      if (hasLegacyMeta) db.exec('DROP TABLE schema_meta');
      db.pragma(`user_version = ${workspaceSchemaVersion}`);
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'equipment_legacy_migration'").get()) {
    db.transaction(() => {
      const columns = (db.pragma('table_info(equipment_legacy_migration)') as { name: string }[])
        .map(row => row.name);
      for (const statement of legacyEquipmentCopyStatements(columns)) db.exec(statement);
      db.exec('DROP TABLE equipment_legacy_migration');
    })();
  }
  const catalogPath = join(dataDir, 'catalog.sqlite');
  if (existsSync(catalogPath)) db.prepare('ATTACH DATABASE ? AS catalog').run(catalogPath);
  return db;
}

export function closeWorkspaceDb(db: Database.Database): void {
  db.prepare('SELECT crsql_finalize()').get();
  db.close();
}
