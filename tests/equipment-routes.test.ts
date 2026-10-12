import test from 'node:test';
import assert from 'node:assert/strict';
import { equipmentItemForPath, equipmentPathSegment } from '../client/equipmentRoutes.ts';
import type { Equipment } from '../client/db.ts';

const item = (id: string, name: string): Equipment => ({ id, name, kind: 'all_in_one', specification_json: null });

test('equipment links use readable names and resolve legacy IDs', () => {
  const vevor = item('27I0Kppqfmadgy4Ymv-Ze', 'VEVOR Electric Brewing System');
  assert.equal(equipmentPathSegment(vevor, [vevor]), 'vevor-electric-brewing-system');
  assert.equal(equipmentItemForPath('vevor-electric-brewing-system', [vevor])?.id, vevor.id);
  assert.equal(equipmentItemForPath(vevor.id, [vevor])?.id, vevor.id);
});

test('matching equipment names get distinct links', () => {
  const first = item('abcdefgh1234567890123', 'BrewZilla 35L');
  const second = item('ijklmnop1234567890123', 'BrewZilla 35L');
  const items = [first, second];
  assert.equal(equipmentPathSegment(first, items), 'brewzilla-35l-abcdefgh1234567890123');
  assert.equal(equipmentPathSegment(second, items), 'brewzilla-35l-ijklmnop1234567890123');
  assert.equal(equipmentItemForPath(equipmentPathSegment(second, items), items)?.id, second.id);
});

test('an edited slug is independent of the display name', () => {
  const vevor = { ...item('27I0Kppqfmadgy4Ymv-Ze', 'My VEVOR'), specification_json: '{"slug":"vevor-35l"}' };
  assert.equal(equipmentPathSegment(vevor, [vevor]), 'vevor-35l');
  assert.equal(equipmentItemForPath('vevor-35l', [vevor])?.id, vevor.id);
});
