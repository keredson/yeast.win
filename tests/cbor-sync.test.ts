import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { ServerResponse } from 'node:http';
import { changeTuple, decodeItem, encodeItem, maxSequence, readSequence, syncProtocolVersion,
  validChangeTuple } from '../shared/cborSync.ts';
import type { SqlChangeRow } from '../shared/wire.ts';

const testDirectory = mkdtempSync(join(tmpdir(), 'brewlog-cbor-sync-'));
process.env.BREWLOG_DATA_DIR = testDirectory;
after(() => rmSync(testDirectory, { recursive: true, force: true }));
const { openWorkspaceDb, closeWorkspaceDb } = await import('../server/db.ts');
const { receiveCborChanges, streamCborChanges } = await import('../server/sync.ts');
const { openCatalogDb } = await import('../server/catalog.ts');

const select = `SELECT "table", pk, cid, val, col_version, db_version,
  COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq FROM crsql_changes ORDER BY db_version, seq`;

test('CBOR sync preserves binary photo data and resumes after an applied change', async () => {
  const source = openWorkspaceDb(nanoid());
  const target = openWorkspaceDb(nanoid());
  try {
    const batchId = nanoid();
    const pixels = Buffer.from([0, 1, 127, 255]);
    source.prepare('INSERT INTO batches(id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(batchId, 'CBOR batch', 'active', 1, 1);
    source.prepare('INSERT INTO photos(id,batch_id,mime_type,byte_count,image,created_at) VALUES (?,?,?,?,?,?)')
      .run(nanoid(), batchId, 'image/png', pixels.length, pixels, 1);
    const rows = source.prepare(select).safeIntegers().all() as SqlChangeRow[];
    const payload = encodeItem([syncProtocolVersion, '0', '0', rows.map(changeTuple)]);
    const ack = decodeItem(receiveCborChanges(target, payload));
    assert.deepEqual(ack, [syncProtocolVersion, String(rows.at(-1)!.db_version), String(rows.at(-1)!.seq)]);
    assert.deepEqual((target.prepare('SELECT image FROM photos').get() as { image: Buffer }).image, pixels);

    const chunks: Uint8Array[] = [];
    const response = {
      destroyed: false, headersSent: false,
      writeHead() { (response as unknown as { headersSent: boolean }).headersSent = true; },
      write(value: Uint8Array) { chunks.push(value); return true; },
      end() {},
      destroy(error: Error) { throw error; }
    } as unknown as ServerResponse;
    await streamCborChanges(source, response, '0', '0');
    const bytes = Buffer.concat(chunks);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7));
      controller.close();
    } });
    const items: unknown[] = [];
    for await (const item of readSequence(body)) items.push(item);
    assert.equal((items[0] as unknown[])[1], rows.length);
    assert.ok(items.slice(1).every(validChangeTuple));
    const first = items[1] as ReturnType<typeof changeTuple>;
    const afterFirst: Uint8Array[] = [];
    const resumed = { ...response,
      write(value: Uint8Array) { afterFirst.push(value); return true; }
    } as ServerResponse;
    await streamCborChanges(source, resumed, String(first[5]), String(first[8]));
    assert.equal(afterFirst.length, rows.length);
    assert.equal((decodeItem(afterFirst[0]) as unknown[])[1], rows.length - 1);
    assert.equal(maxSequence, '9223372036854775807');
  } finally {
    closeWorkspaceDb(source);
    closeWorkspaceDb(target);
  }
});

test('an incomplete CBOR sequence is rejected', async () => {
  const bytes = encodeItem(['large', new Uint8Array(500)]);
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, -1)); controller.close(); } });
  await assert.rejects(async () => { for await (const _item of readSequence(body)) { /* consume */ } }, /Incomplete CBOR/);
});

test('catalog also streams CBOR changes from its SQLite snapshot', async () => {
  const catalog = openCatalogDb(process.env.BREWLOG_DATA_DIR!);
  try {
    catalog.prepare("INSERT OR IGNORE INTO supplies(id,name,category,unit) VALUES ('sync_test','Sync test','Other','each')").run();
    const chunks: Uint8Array[] = [];
    const response = {
      destroyed: false, headersSent: false,
      writeHead() {},
      write(value: Uint8Array) { chunks.push(value); return true; },
      end() {},
      destroy(error: Error) { throw error; }
    } as unknown as ServerResponse;
    await streamCborChanges(catalog, response, '0', '0');
    const [header, ...changes] = chunks.map(decodeItem);
    assert.equal((header as unknown[])[1], changes.length);
    assert.ok(changes.length > 0);
    assert.ok(changes.every(validChangeTuple));
    const cursor = String((catalog.prepare('SELECT crsql_db_version() AS version').get() as { version: number }).version);
    const emptyChunks: Uint8Array[] = [];
    const currentResponse = { ...response,
      end(value?: Uint8Array) { if (value) emptyChunks.push(value); }
    } as ServerResponse;
    await streamCborChanges(catalog, currentResponse, cursor, maxSequence);
    assert.deepEqual(decodeItem(Buffer.concat(emptyChunks)), [syncProtocolVersion, 0, cursor]);
  } finally { catalog.close(); }
});
