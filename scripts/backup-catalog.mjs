import Database from 'better-sqlite3';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const envPath = join(projectRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const dataDir = resolve(projectRoot, process.env.BREWLOG_DATA_DIR || './data');
const sourcePath = join(dataDir, 'catalog.sqlite');
if (!existsSync(sourcePath)) throw new Error(`Catalog database not found: ${sourcePath}`);

const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const destination = resolve(process.argv[2] || join(dataDir, 'backups', `catalog-${timestamp}.sqlite`));
if (existsSync(destination)) throw new Error(`Backup already exists: ${destination}`);
mkdirSync(dirname(destination), { recursive: true });
const source = new Database(realpathSync(sourcePath), { readonly: true });
try {
  await source.backup(destination);
} finally { source.close(); }
const backup = new Database(destination, { readonly: true });
try {
  const integrity = backup.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Catalog backup failed integrity check: ${integrity}`);
  console.log(destination);
} finally { backup.close(); }
