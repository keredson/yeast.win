import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import type { CatalogEquipment, CatalogInventory, CatalogSnapshot } from '../shared/catalog.ts';

let opened: Promise<DB> | undefined;
let syncing: Promise<void> | undefined;

export function openLocalCatalog(): Promise<DB> {
  if (!opened) opened = (async () => {
    const sqlite = await initWasm(() => wasmUrl);
    const db = await sqlite.open('brewlog-catalog');
    await db.exec('CREATE TABLE IF NOT EXISTS catalog_meta(version INTEGER NOT NULL)');
    await db.exec('CREATE TABLE IF NOT EXISTS catalog_equipment(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, specification_json TEXT)');
    await db.exec('CREATE TABLE IF NOT EXISTS catalog_inventory(id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL, capacity_liters REAL)');
    const columns = await db.execO<{ name: string }>('PRAGMA table_info(catalog_inventory)');
    if (!columns.some(column => column.name === 'capacity_liters')) await db.exec('ALTER TABLE catalog_inventory ADD COLUMN capacity_liters REAL');
    return db;
  })().catch(error => { opened = undefined; throw error; });
  return opened;
}

export async function readLocalCatalog(db: DB): Promise<{ equipment: CatalogEquipment[]; inventory: CatalogInventory[] }> {
  const [equipment, inventory] = await Promise.all([
    db.execO<CatalogEquipment>('SELECT id, name, kind, specification_json FROM catalog_equipment ORDER BY name COLLATE NOCASE'),
    db.execO<CatalogInventory>('SELECT id, name, category, unit, capacity_liters FROM catalog_inventory ORDER BY name COLLATE NOCASE')
  ]);
  return { equipment, inventory };
}

export function syncLocalCatalog(db: DB): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    const rows = await db.execO<{ version: number }>('SELECT version FROM catalog_meta LIMIT 1');
    const response = await fetch(`/api/catalog?version=${rows[0]?.version || 0}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Catalog sync failed');
    const result = await response.json() as CatalogSnapshot | { version: number; unchanged: true };
    if ('unchanged' in result) return;
    if (!Number.isSafeInteger(result.version) || !Array.isArray(result.equipment) || !Array.isArray(result.inventory)) {
      throw new Error('Invalid catalog response');
    }
    await db.tx(async tx => {
      await tx.exec('DELETE FROM catalog_equipment');
      await tx.exec('DELETE FROM catalog_inventory');
      for (const item of result.equipment) await tx.exec(
        'INSERT INTO catalog_equipment(id, name, kind, specification_json) VALUES (?, ?, ?, ?)',
        [item.id, item.name, item.kind, item.specification_json]);
      for (const item of result.inventory) await tx.exec(
        'INSERT INTO catalog_inventory(id, name, category, unit, capacity_liters) VALUES (?, ?, ?, ?, ?)',
        [item.id, item.name, item.category, item.unit, item.capacity_liters ?? null]);
      await tx.exec('DELETE FROM catalog_meta');
      await tx.exec('INSERT INTO catalog_meta(version) VALUES (?)', [result.version]);
    });
  })().finally(() => { syncing = undefined; });
  return syncing;
}
