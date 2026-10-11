import type { BinaryWire, IntegerWire, WireChange, WireValue } from './schema.ts';

export interface SqlChangeRow {
  table: string;
  pk: Uint8Array;
  cid: string;
  val: unknown;
  col_version: number | bigint;
  db_version: number | bigint;
  site_id: Uint8Array;
  cl: number | bigint;
  seq: number | bigint;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 16_384) {
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 16_384)));
  }
  return btoa(chunks.join(''));
}

function base64ToBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

export function encodeValue(value: unknown): WireValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return { type: 'integer', decimal: value.toString() };
  if (value instanceof Uint8Array) return { type: 'binary', base64: bytesToBase64(value) };
  throw new Error(`Cannot encode SQLite value of type ${typeof value}`);
}

export function decodeValue(value: WireValue): string | number | bigint | Uint8Array | null {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (value.type === 'integer') return BigInt((value as IntegerWire).decimal);
  if (value.type === 'binary') return base64ToBytes((value as BinaryWire).base64);
  throw new Error('Invalid wire value');
}

export function encodeChange(row: SqlChangeRow): WireChange {
  return {
    table: row.table,
    pk: { type: 'binary', base64: bytesToBase64(row.pk) },
    cid: row.cid,
    val: encodeValue(row.val),
    col_version: String(row.col_version),
    db_version: String(row.db_version),
    site_id: { type: 'binary', base64: bytesToBase64(row.site_id) },
    cl: String(row.cl),
    seq: String(row.seq)
  };
}

export function decodeChange(change: WireChange): [string, Uint8Array, string, string | number | bigint | Uint8Array | null, bigint, bigint, Uint8Array, bigint, bigint] {
  return [
    change.table,
    base64ToBytes(change.pk.base64),
    change.cid,
    decodeValue(change.val),
    BigInt(change.col_version),
    BigInt(change.db_version),
    base64ToBytes(change.site_id.base64),
    BigInt(change.cl),
    BigInt(change.seq)
  ];
}
