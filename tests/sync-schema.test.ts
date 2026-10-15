import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientUpdateRequiredError, syncError } from '../client/api.ts';
import { syncSchemaConflict } from '../shared/syncSchema.ts';
import { workspaceSchemaVersion } from '../shared/schema.ts';

test('sync rejects missing and older client schemas before accepting changes', () => {
  assert.deepEqual(syncSchemaConflict(undefined, workspaceSchemaVersion), {
    code: 'client_update_required', error: 'This app needs an update before it can sync.', requiredSchemaVersion: workspaceSchemaVersion
  });
  assert.equal(syncSchemaConflict(String(workspaceSchemaVersion), workspaceSchemaVersion), null);
  assert.equal(syncSchemaConflict(String(workspaceSchemaVersion - 1), workspaceSchemaVersion)?.code, 'client_update_required');
  assert.equal(syncSchemaConflict(String(workspaceSchemaVersion + 1), workspaceSchemaVersion)?.code, 'server_update_required');
  assert.equal(syncSchemaConflict('invalid', workspaceSchemaVersion)?.code, 'client_update_required');
});

test('client distinguishes an update request from ordinary sync errors', async () => {
  const outdated = await syncError(new Response(JSON.stringify({
    code: 'client_update_required', requiredSchemaVersion: 40
  }), { status: 409 }), 'Sync failed');
  assert.ok(outdated instanceof ClientUpdateRequiredError);
  assert.equal(outdated.requiredSchemaVersion, 40);
  const server = await syncError(new Response(JSON.stringify({
    code: 'server_update_required', error: 'Server needs an update'
  }), { status: 409 }), 'Sync failed');
  assert.equal(server.message, 'Server needs an update');
});
