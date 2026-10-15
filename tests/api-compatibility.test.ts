import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apiRevisionHeaders, fetchWithApiRevision } from '../client/apiRevision.ts';
import { AppUpdateRequiredError, fetchApi } from '../client/api.ts';
import { ServerUpdateRequiredError } from '../client/apiRevision.ts';
import { endpointContract, endpointContracts, endpointVersionConflict, endpointVersionHeader, clientRevisionHeader } from '../shared/apiCompatibility.ts';

test('API requests carry the browser revision and contract version without dropping existing headers', async () => {
  const headers = apiRevisionHeaders('/api/me/rapt', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get(endpointVersionHeader), '2');
  assert.ok(headers.get(clientRevisionHeader));

  const originalFetch = globalThis.fetch;
  let captured: Headers | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = new Headers(init?.headers);
    return new Response('{}', { headers: { [endpointVersionHeader]: captured.get(endpointVersionHeader) || '1' } });
  };
  try {
    await fetchWithApiRevision('/api/me', { headers: { Accept: 'application/json' } });
    assert.equal(captured?.get('Accept'), 'application/json');
    assert.equal(captured?.get(endpointVersionHeader), '1');
    assert.ok(captured?.get(clientRevisionHeader));
    await fetchWithApiRevision('/api/me/rapt');
    assert.equal(captured?.get(endpointVersionHeader), '2');
  } finally { globalThis.fetch = originalFetch; }
});

test('an old RAPT client receives an update response it recognizes; other endpoints keep working', async () => {
  const rapt = endpointContract('/api/me/rapt', 'GET');
  const conflict = endpointVersionConflict(rapt, '1');
  assert.deepEqual(conflict, { code: 'app_update_required', error: 'Update Yeast.Win! to continue.',
    requiredEndpointVersion: 2 });
  assert.equal(endpointVersionConflict(rapt, '2'), null);
  assert.equal(endpointVersionConflict(rapt, undefined), null,
    'headerless deployed clients retain the temporary legacy response');
  assert.equal(endpointVersionConflict(endpointContract('/api/me/profile', 'PATCH'), '1'), null);
  assert.deepEqual(endpointVersionConflict(endpointContract('/api/me/rapt', 'GET'), '3'), {
    code: 'server_update_required', error: 'The server needs an update to support this app.', serverEndpointVersion: 2
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(conflict), { status: 409,
    headers: { 'Content-Type': 'application/json' } });
  try {
    await assert.rejects(() => fetchApi('/api/me/rapt'), error =>
      error instanceof AppUpdateRequiredError && error.requiredEndpointVersion === 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('each endpoint has one version line and a unique change ID for a breaking bump', () => {
  const seen = new Set<string>();
  const changes = new Set<string>();
  const registryLines = readFileSync(new URL('../shared/apiCompatibility.ts', import.meta.url), 'utf8').split('\n');
  for (const entry of endpointContracts) {
    const key = `${entry.method} ${entry.path}`;
    assert.ok(!seen.has(key), `duplicate contract: ${key}`);
    seen.add(key);
    assert.ok(Number.isSafeInteger(entry.version) && entry.version >= 1, key);
    assert.equal(registryLines.filter(line => line.includes(`method: '${entry.method}', path: '${entry.path}'`)
      && line.includes(`version: ${entry.version}, changeId: '${entry.changeId}'`)).length, 1,
    `${key} must keep its version and change ID on one line for merge conflicts`);
    if (entry.version > 1) {
      assert.match(entry.changeId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, key);
      assert.ok(!changes.has(entry.changeId), `duplicate change ID: ${entry.changeId}`);
      changes.add(entry.changeId);
    }
  }
  assert.equal(endpointContract('/api/me/rapt/devices/blue-pill/brewery', 'PUT')?.version, 1);
  assert.equal(endpointContract('/api/me/rapt/devices/blue-pill/assignment', 'DELETE')?.version, 2);
});

test('a new browser rejects an older server response before parsing its body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ targets: [] }), { status: 200 });
  try {
    await assert.rejects(() => fetchApi('/api/me/rapt'), error =>
      error instanceof ServerUpdateRequiredError && error.serverEndpointVersion === 1);
  } finally { globalThis.fetch = originalFetch; }
});
