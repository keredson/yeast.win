import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { catalogEquipmentTable, catalogInventoryTable, catalogSchemaVersion, catalogTables,
  type CatalogChanges, type CatalogEquipment, type CatalogInventory } from '../shared/catalog.ts';
import { changeColumns } from '../shared/schema.ts';
import { decodeChange } from '../shared/wire.ts';

let opened: Promise<DB> | undefined;
let syncing: Promise<void> | undefined;

export function openLocalCatalog(): Promise<DB> {
  if (!opened) opened = (async () => {
    const sqlite = await initWasm(() => wasmUrl);
    const db = await sqlite.open('brewlog-catalog');
    await db.exec('CREATE TABLE IF NOT EXISTS catalog_meta(version INTEGER NOT NULL)');
    const rows = await db.execO<{ version: number }>('SELECT version FROM catalog_meta LIMIT 1');
    if (!rows.length || rows[0].version < catalogSchemaVersion) {
      await db.tx(async tx => {
        // The old browser catalog was a replaceable snapshot. Start the CRR
        // catalog from a zero cursor so the server sends its full change history.
        await tx.exec('DROP TABLE IF EXISTS catalog_equipment');
        await tx.exec('DROP TABLE IF EXISTS catalog_inventory');
        await tx.exec(catalogEquipmentTable);
        await tx.exec(catalogInventoryTable);
        for (const table of catalogTables) await tx.exec('SELECT crsql_as_crr(?)', [table]);
        await tx.exec('CREATE TABLE IF NOT EXISTS catalog_sync_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
        await tx.exec('DELETE FROM catalog_sync_state');
        await tx.exec('DELETE FROM catalog_meta');
        await tx.exec('INSERT INTO catalog_meta(version) VALUES (?)', [catalogSchemaVersion]);
      });
    } else if (rows[0].version > catalogSchemaVersion) {
      throw new Error(`This app cannot open catalog schema ${rows[0].version}; update Brewlog first.`);
    }
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
    const rows = await db.execO<{ value: string }>("SELECT value FROM catalog_sync_state WHERE key = 'serverCursor'");
    const cursor = rows[0]?.value || '0';
    const response = await fetch(`/api/catalog?cursor=${cursor}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Catalog sync failed');
    const result = await response.json() as CatalogChanges;
    if (!/^\d+$/.test(result.serverCursor) || !Array.isArray(result.changes)
      || result.changes.some(change => !catalogTables.includes(change.table as typeof catalogTables[number]))) {
      throw new Error('Invalid catalog response');
    }
    const insert = `INSERT INTO crsql_changes (${changeColumns.map(column => `"${column}"`).join(', ')})
      VALUES (${changeColumns.map(() => '?').join(', ')})`;
    await db.tx(async tx => {
      for (const change of result.changes) await tx.exec(insert, decodeChange(change));
      await tx.exec(`INSERT INTO catalog_sync_state(key, value) VALUES ('serverCursor', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [result.serverCursor]);
    });
  })().finally(() => { syncing = undefined; });
  return syncing;
}
