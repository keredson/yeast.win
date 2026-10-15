import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'brewlog-registration-units-'));
after(() => rmSync(directory, { recursive: true, force: true }));
process.env.BREWLOG_DATA_DIR = directory;

const { openAuthDb } = await import('../server/db.ts');
const { getPreferredUnits, register } = await import('../server/auth.ts');

test('registration saves the selected unit system for the new account', () => {
  const db = openAuthDb();
  try {
    for (const [system, expected] of [
      ['metric', { temperature: '°C', volume: 'L', mass: 'g', pressure: 'kPa' }],
      ['imperial', { temperature: '°F', volume: 'US gal', mass: 'lb + oz', pressure: 'psi' }]
    ] as const) {
      assert.ok(register(db, `${system}signup`, 'password123', system, 'America/Los_Angeles'));
      const account = db.prepare('SELECT id FROM accounts WHERE username = ?')
        .get(`${system}signup`) as { id: string };
      assert.deepEqual(getPreferredUnits(db, account.id), expected);
      assert.equal((db.prepare('SELECT time_zone FROM accounts WHERE id = ?').get(account.id) as
        { time_zone: string }).time_zone, 'America/Los_Angeles');
      assert.ok(db.prepare('SELECT 1 FROM workspaces WHERE owner_account_id = ?').get(account.id));
    }
  } finally { db.close(); }
});
