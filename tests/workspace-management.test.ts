import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'brewlog-workspace-management-'));
process.env.BREWLOG_DATA_DIR = directory;
const { createWorkspace, deleteWorkspace, openAuthDb, updateWorkspace } = await import('../server/db.ts');

test('root URL belongs only to a null slug and deletion removes brewery data', () => {
  const auth = openAuthDb();
  try {
    const root = createWorkspace(auth, 'owner', 'Homebrew');
    const other = createWorkspace(auth, 'owner', 'Production');
    assert.equal(root.slug, null);
    assert.equal(other.slug, 'production');
    assert.ok(existsSync(join(directory, `${root.id}.sqlite`)));
    assert.deepEqual(updateWorkspace(auth, 'owner', other.id, 'Pilot', 'pilot'),
      { id: other.id, name: 'Pilot', slug: 'pilot' });
    assert.throws(() => updateWorkspace(auth, 'owner', other.id, 'Pilot', null), /UNIQUE constraint/);
    assert.equal(deleteWorkspace(auth, 'different-owner', root.id, () => {}), false);
    assert.ok(existsSync(join(directory, `${root.id}.sqlite`)));
    assert.equal(deleteWorkspace(auth, 'owner', root.id, () => {}), true);
    assert.equal(existsSync(join(directory, `${root.id}.sqlite`)), false);
    assert.equal((auth.prepare('SELECT slug FROM workspaces WHERE id = ?').get(other.id) as { slug: string }).slug, 'pilot');
    const reopened = openAuthDb();
    try { assert.equal((reopened.prepare('SELECT slug FROM workspaces WHERE id = ?').get(other.id) as { slug: string }).slug, 'pilot'); }
    finally { reopened.close(); }
    assert.deepEqual(updateWorkspace(auth, 'owner', other.id, 'Pilot', null),
      { id: other.id, name: 'Pilot', slug: null });
    assert.equal(deleteWorkspace(auth, 'owner', other.id, () => {}), true);
    assert.equal(createWorkspace(auth, 'owner', 'Again').slug, null);
  } finally { auth.close(); }
});
