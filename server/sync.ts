import type Database from 'better-sqlite3';
import { changeColumns, nowSeconds, type SyncRequest, type SyncResponse, validateChange } from '../shared/schema.ts';
import { decodeChange, encodeChange, type SqlChangeRow } from '../shared/wire.ts';

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
