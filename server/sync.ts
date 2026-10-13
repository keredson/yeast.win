import type Database from 'better-sqlite3';
import { changeColumns, nowSeconds, type SyncRequest, type SyncResponse, validateChange } from '../shared/schema.ts';
import { decodeChange, encodeChange, type SqlChangeRow } from '../shared/wire.ts';
import { changeTuple, decodeItem, encodeItem, syncContentType, syncProtocolVersion,
  validChangeTuple, type ChangeTuple } from '../shared/cborSync.ts';
import type { ServerResponse } from 'node:http';
import Sqlite from 'better-sqlite3';
import { resolve } from 'node:path';

const selectChanges = `SELECT "table", pk, cid, val, col_version, db_version,
  COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq
  FROM crsql_changes WHERE db_version > ? ORDER BY db_version, seq`;
const insertChange = `INSERT INTO crsql_changes (${changeColumns.map(column => `"${column}"`).join(', ')})
  VALUES (${changeColumns.map(() => '?').join(', ')})`;

export function validateSyncRequest(input: unknown): input is SyncRequest {
  if (!input || typeof input !== 'object') return false;
  const request = input as Partial<SyncRequest>;
  return typeof request.serverCursor === 'string' && /^\d+$/.test(request.serverCursor)
    && typeof request.localCursor === 'string' && /^\d+$/.test(request.localCursor)
    && Array.isArray(request.changes) && request.changes.length <= 2_000
    && request.changes.every(validateChange);
}

export function syncWorkspace(db: Database.Database, request: SyncRequest): SyncResponse {
  const current = BigInt((db.prepare('SELECT crsql_db_version() AS version').get() as { version: number | bigint }).version);
  if (BigInt(request.serverCursor) > current) throw new Error('Server cursor is ahead of this brewery; local sync state must be reset');

  const apply = db.prepare(insertChange);
  const receive = db.transaction(() => {
    for (const change of request.changes) apply.run(...decodeChange(change));
    db.prepare('UPDATE batch_events SET received_at = ? WHERE received_at IS NULL')
      .run(nowSeconds());
  });
  receive();

  const rows = db.prepare(selectChanges).all(BigInt(request.serverCursor)) as SqlChangeRow[];
  const cursor = (db.prepare('SELECT crsql_db_version() AS version').get() as { version: number | bigint }).version;
  const accepted = request.changes.reduce(
    (max, change) => BigInt(change.db_version) > max ? BigInt(change.db_version) : max,
    BigInt(request.localCursor)
  );
  return {
    serverCursor: String(cursor),
    acceptedLocalCursor: String(accepted),
    changes: rows.map(encodeChange)
  };
}

const decimal = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);
const syncWhere = 'db_version >= ? AND (db_version > ? OR seq > ?)';

export function receiveCborChanges(db: Database.Database, bytes: Uint8Array): Uint8Array {
  let input: unknown;
  try { input = decodeItem(bytes); }
  catch { throw new Error('Invalid CBOR sync upload'); }
  if (!Array.isArray(input) || input.length !== 4 || input[0] !== syncProtocolVersion
    || !decimal(input[1]) || !decimal(input[2]) || !Array.isArray(input[3])
    || input[3].length > 512 || !input[3].every(validChangeTuple)) throw new Error('Invalid CBOR sync upload');
  const [, localVersion, localSeq, changes] = input as [number, string, string, ChangeTuple[]];
  const insert = db.prepare(insertChange);
  db.transaction(() => {
    for (const change of changes) insert.run(...change);
    db.prepare('UPDATE batch_events SET received_at = ? WHERE received_at IS NULL').run(nowSeconds());
  })();
  const last = changes.at(-1);
  return encodeItem([syncProtocolVersion, last ? String(last[5]) : localVersion,
    last ? String(last[8]) : localSeq]);
}

export async function streamCborChanges(db: Database.Database, res: ServerResponse,
  version: string, seq: string): Promise<void> {
  if (!decimal(version) || !decimal(seq)) throw new Error('Invalid sync cursor');
  const current = BigInt((db.prepare('SELECT crsql_db_version() AS version').get() as { version: number | bigint }).version);
  if (BigInt(version) > current) throw new Error('Server cursor is ahead of this brewery; local sync state must be reset');
  // A separate read connection gives this stream a stable snapshot while uploads continue.
  const reader = new Sqlite(db.name, { readonly: true });
  try {
    reader.loadExtension(resolve(import.meta.dirname, '../vendor/crsqlite.so'));
    reader.exec('BEGIN');
    const cursor = [BigInt(version), BigInt(version), BigInt(seq)];
    const total = (reader.prepare(`SELECT COUNT(*) AS count FROM crsql_changes WHERE ${syncWhere}`)
      .get(...cursor) as { count: number }).count;
    const target = String((reader.prepare('SELECT crsql_db_version() AS version').get() as { version: number | bigint }).version);
    res.writeHead(200, { 'Content-Type': syncContentType, 'Cache-Control': 'no-store' });
    const write = async (item: unknown) => {
      if (res.destroyed) throw new Error('Sync connection closed');
      if (!res.write(encodeItem(item))) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { res.off('drain', drained); res.off('close', closed); };
        const drained = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new Error('Sync connection closed')); };
        res.once('drain', drained);
        res.once('close', closed);
      });
    };
    await write([syncProtocolVersion, total, target]);
    const statement = reader.prepare(`SELECT "table", pk, cid, val, col_version, db_version,
      COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq FROM crsql_changes
      WHERE ${syncWhere} ORDER BY db_version, seq`).safeIntegers();
    for (const row of statement.iterate(...cursor) as Iterable<SqlChangeRow>) await write(changeTuple(row));
    res.end();
    reader.exec('COMMIT');
  } catch (error) {
    if (!res.headersSent) throw error;
    res.destroy(error as Error);
  } finally {
    reader.close();
  }
}
