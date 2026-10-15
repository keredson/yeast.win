import test from 'node:test';
import assert from 'node:assert/strict';
import { apiRevisionHeaders, fetchWithApiRevision } from '../client/apiRevision.ts';
import { AppUpdateRequiredError, fetchApi } from '../client/api.ts';
import { appUpdateConflict, clientApiVersion, clientApiVersionHeader, clientRevisionHeader } from '../shared/apiCompatibility.ts';

test('API requests carry the browser revision and contract version without dropping existing headers', async () => {
  const headers = apiRevisionHeaders({ 'Content-Type': 'application/json' });
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get(clientApiVersionHeader), String(clientApiVersion));
  assert.ok(headers.get(clientRevisionHeader));

  const originalFetch = globalThis.fetch;
  let captured: Headers | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = new Headers(init?.headers);
    return new Response('{}');
  };
  try {
    await fetchWithApiRevision('/api/me', { headers: { Accept: 'application/json' } });
    assert.equal(captured?.get('Accept'), 'application/json');
    assert.equal(captured?.get(clientApiVersionHeader), String(clientApiVersion));
    assert.ok(captured?.get(clientRevisionHeader));
  } finally { globalThis.fetch = originalFetch; }
});

test('an old RAPT client receives an update response it recognizes; other endpoints keep working', async () => {
  const conflict = appUpdateConflict('/api/me/rapt', 'GET', '1');
  assert.deepEqual(conflict, { code: 'app_update_required', error: 'Update Yeast.Win! to continue.',
    requiredClientApiVersion: 2 });
  assert.equal(appUpdateConflict('/api/me/rapt', 'GET', String(clientApiVersion)), null);
  assert.equal(appUpdateConflict('/api/me/rapt', 'GET', undefined), null,
    'headerless deployed clients retain the temporary legacy response');
  assert.equal(appUpdateConflict('/api/me/profile', 'PATCH', '1'), null);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(conflict), { status: 409,
    headers: { 'Content-Type': 'application/json' } });
  try {
    await assert.rejects(() => fetchApi('/api/me/rapt'), error =>
      error instanceof AppUpdateRequiredError && error.requiredClientApiVersion === 2);
  } finally { globalThis.fetch = originalFetch; }
});
