import { decode, decodeMultiple, encode } from 'cbor-x';
import type { SqlChangeRow } from './wire.ts';

export const syncContentType = 'application/cbor-seq';
export const syncProtocolVersion = 1;
export const maxSequence = '9223372036854775807';

type ChangeValue = string | number | bigint | Uint8Array | null;
export type ChangeTuple = [string, Uint8Array, string, ChangeValue, bigint, bigint, Uint8Array, bigint, bigint];

export function changeTuple(row: SqlChangeRow): ChangeTuple {
  return [row.table, row.pk, row.cid, row.val as ChangeValue, BigInt(row.col_version),
    BigInt(row.db_version), row.site_id, BigInt(row.cl), BigInt(row.seq)];
}

export function validChangeTuple(input: unknown): input is ChangeTuple {
  if (!Array.isArray(input) || input.length !== 9) return false;
  const [table, pk, cid, val, colVersion, dbVersion, siteId, cl, seq] = input;
  return typeof table === 'string' && table.length > 0 && table.length <= 100
    && pk instanceof Uint8Array && pk.length <= 4096
    && typeof cid === 'string' && cid.length <= 100
    && (val === null || typeof val === 'string' || typeof val === 'number'
      || typeof val === 'bigint' || val instanceof Uint8Array)
    && typeof colVersion === 'bigint' && typeof dbVersion === 'bigint'
    && siteId instanceof Uint8Array && siteId.length === 16
    && typeof cl === 'bigint' && typeof seq === 'bigint'
    && colVersion >= 0n && dbVersion >= 0n && cl >= 0n && seq >= 0n;
}

export function encodeItem(value: unknown): Uint8Array { return encode(value); }
export function decodeItem(bytes: Uint8Array): unknown { return decode(bytes); }

export async function* readSequence(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  let pending = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(pending.length + value.length);
      joined.set(pending); joined.set(value, pending.length);
      try {
        for (const item of decodeMultiple(joined) as unknown[]) yield item;
        pending = new Uint8Array(0);
      } catch (error) {
        const incomplete = error as Error & { incomplete?: boolean; lastPosition?: number; values?: unknown[] };
        if (!incomplete.incomplete || incomplete.lastPosition === undefined) throw error;
        for (const item of incomplete.values || []) yield item;
        pending = joined.slice(incomplete.lastPosition);
        if (pending.length > 16 * 1024 * 1024) throw new Error('Sync item is too large');
      }
    }
    if (pending.length) throw new Error('Incomplete CBOR sync stream');
  } finally {
    reader.releaseLock();
  }
}
