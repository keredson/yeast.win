import assert from 'node:assert/strict';
import test from 'node:test';
import { createId } from '../shared/id.ts';

test('new distributed IDs are URL-friendly and distinct', () => {
  const ids = Array.from({ length: 1_000 }, createId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{21}$/);
});
