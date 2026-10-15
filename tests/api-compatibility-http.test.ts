import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { clientApiVersion, clientApiVersionHeader, clientRevisionHeader, serverRevisionHeader } from '../shared/apiCompatibility.ts';

test('new server serves a legacy RAPT tab and gives an update-aware old client a clear response', async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  probe.close();
  await once(probe, 'close');

  const directory = mkdtempSync(join(tmpdir(), 'yeast-api-compat-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BREWLOG_DATA_DIR: directory, BREWLOG_PORT: String(port),
      BREWLOG_HOST: '127.0.0.1', BREWLOG_DEV_SOCKET: '', BREWLOG_SOCKET: '' }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error(`API exited: ${stderr}`);
      try {
        const health = await fetch(`${base}/api/healthz`);
        if (health.ok) { ready = true; break; }
      } catch { /* Wait for the child to listen. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `API did not start: ${stderr}`);
    const registration = await fetch(`${base}/api/register`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', [clientRevisionHeader]: 'old-browser-revision',
        [clientApiVersionHeader]: '1' },
      body: JSON.stringify({ username: 'compatbrewer', password: 'password123', unit_system: 'imperial' }) });
    assert.equal(registration.status, 201);
    const serverRevision = registration.headers.get(serverRevisionHeader);
    assert.ok(serverRevision);
    const cookie = registration.headers.get('set-cookie');
    assert.ok(cookie);

    const legacy = await fetch(`${base}/api/me/rapt`, { headers: { Cookie: cookie } });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get(serverRevisionHeader), serverRevision);
    const legacyBody = await legacy.json() as { targets: unknown[] };
    assert.deepEqual(legacyBody.targets.map(target => target), [], 'old bundle can map targets');

    const outdated = await fetch(`${base}/api/me/rapt`, { headers: { Cookie: cookie,
      [clientRevisionHeader]: 'old-browser-revision', [clientApiVersionHeader]: '1' } });
    assert.equal(outdated.status, 409);
    assert.equal(outdated.headers.get(serverRevisionHeader), serverRevision);
    assert.deepEqual(await outdated.json(), { code: 'app_update_required',
      error: 'Update Yeast.Win! to continue.', requiredClientApiVersion: 2 });

    const current = await fetch(`${base}/api/me/rapt`, { headers: { Cookie: cookie,
      [clientRevisionHeader]: 'current-browser-revision', [clientApiVersionHeader]: String(clientApiVersion) } });
    assert.equal(current.status, 200);
    assert.equal(current.headers.get(serverRevisionHeader), serverRevision);
    assert.ok(Array.isArray((await current.json() as { workspaces: unknown[] }).workspaces));
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
