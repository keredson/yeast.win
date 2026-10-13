import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { catalogEquipmentColumns, catalogEquipmentTable, type CatalogEquipment, type CatalogInventory,
  type CatalogSnapshot } from '../shared/catalog.ts';

let opened: Promise<DB> | undefined;
let syncing: Promise<void> | undefined;

export function openLocalCatalog(): Promise<DB> {
  if (!opened) opened = (async () => {
    const sqlite = await initWasm(() => wasmUrl);
    const db = await sqlite.open('brewlog-catalog');
    await db.exec('CREATE TABLE IF NOT EXISTS catalog_meta(version INTEGER NOT NULL)');
    const columns = await db.execO<{ name: string }>('PRAGMA table_info(catalog_equipment)');
    if (columns.some(column => column.name === 'specification_json')) {
      await db.exec('DROP TABLE catalog_equipment');
      await db.exec('DELETE FROM catalog_meta');
    }
    await db.exec(catalogEquipmentTable);
    await db.exec('CREATE TABLE IF NOT EXISTS catalog_inventory(id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL)');
    return db;
  })().catch(error => { opened = undefined; throw error; });
  return opened;
}

export async function readLocalCatalog(db: DB): Promise<{ equipment: CatalogEquipment[]; inventory: CatalogInventory[] }> {
  const [equipment, inventory] = await Promise.all([
    db.execO<CatalogEquipment>('SELECT * FROM catalog_equipment ORDER BY name COLLATE NOCASE'),
    db.execO<CatalogInventory>('SELECT id, name, category, unit FROM catalog_inventory ORDER BY name COLLATE NOCASE')
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
        `INSERT INTO catalog_equipment(id, name, kind, ${catalogEquipmentColumns.join(', ')})
          VALUES (?, ?, ?, ${catalogEquipmentColumns.map(() => '?').join(', ')})`,
        [item.id, item.name, item.kind, ...catalogEquipmentColumns.map(column => column === 'built_in_temperature_control'
          ? Number(!!item[column]) : item[column] ?? null)]);
      for (const item of result.inventory) await tx.exec(
        'INSERT INTO catalog_inventory(id, name, category, unit) VALUES (?, ?, ?, ?)',
        [item.id, item.name, item.category, item.unit]);
      await tx.exec('DELETE FROM catalog_meta');
      await tx.exec('INSERT INTO catalog_meta(version) VALUES (?)', [result.version]);
    });
  })().finally(() => { syncing = undefined; });
  return syncing;
}
