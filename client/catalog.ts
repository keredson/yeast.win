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
    const version = (await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version;
    if (version < catalogSchemaVersion) {
      const oldClocks = await db.execO<{ name: string }>(`SELECT name FROM sqlite_master
        WHERE name IN ('catalog_equipment__crsql_clock', 'catalog_inventory__crsql_clock')`);
      await db.tx(async tx => {
        // The server has a new change history for the renamed CRRs. Reset the
        // local catalog and cursor together before receiving it.
        for (const row of oldClocks) {
          await tx.exec('SELECT crsql_as_table(?)', [row.name.replace('__crsql_clock', '')]);
        }
        await tx.exec('DROP TABLE IF EXISTS catalog_equipment');
        await tx.exec('DROP TABLE IF EXISTS catalog_inventory');
        await tx.exec('DROP TABLE IF EXISTS catalog_meta');
        await tx.exec('DROP TABLE IF EXISTS catalog_sync_state');
        await tx.exec(catalogEquipmentTable);
        await tx.exec(catalogInventoryTable);
        for (const table of catalogTables) await tx.exec('SELECT crsql_as_crr(?)', [table]);
        await tx.exec('CREATE TABLE IF NOT EXISTS sync_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
        await tx.exec('DELETE FROM sync_state');
        await tx.exec(`PRAGMA user_version = ${catalogSchemaVersion}`);
      });
    } else if (version > catalogSchemaVersion) {
      throw new Error(`This app cannot open catalog schema ${version}; update Brewlog first.`);
    }
    return db;
  })().catch(error => { opened = undefined; throw error; });
  return opened;
}

export async function readLocalCatalog(db: DB): Promise<{ equipment: CatalogEquipment[]; inventory: CatalogInventory[] }> {
  const [equipment, inventory] = await Promise.all([
    db.execO<CatalogEquipment>('SELECT * FROM equipment ORDER BY name COLLATE NOCASE'),
    db.execO<CatalogInventory>('SELECT id, name, category, unit FROM inventory ORDER BY name COLLATE NOCASE')
  ]);
  return { equipment, inventory };
}

export function syncLocalCatalog(db: DB): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    const rows = await db.execO<{ value: string }>("SELECT value FROM sync_state WHERE key = 'serverCursor'");
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
      await tx.exec(`INSERT INTO sync_state(key, value) VALUES ('serverCursor', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [result.serverCursor]);
    });
  })().finally(() => { syncing = undefined; });
  return syncing;
}
