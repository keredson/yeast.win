import test from 'node:test';
import assert from 'node:assert/strict';
import { locationAncestors, locationDescendantIds, locationForPath } from '../client/locationRoutes.ts';
import type { InventoryLocation } from '../client/db.ts';

const locations: InventoryLocation[] = [
  { id: 'room', name: 'Back room', parent_id: null, slug: 'back-room-abc' },
  { id: 'shelf', name: 'Shelf A', parent_id: 'room', slug: 'shelf-a-def' },
  { id: 'bin', name: 'Bin 1', parent_id: 'shelf', slug: 'bin-1-ghi' }
];

test('location links resolve by stable slug and legacy ID', () => {
  assert.equal(locationForPath('shelf-a-def', locations)?.id, 'shelf');
  assert.equal(locationForPath('shelf', locations)?.slug, 'shelf-a-def');
});

test('hierarchy paths and descendants include nested storage', () => {
  assert.deepEqual(locationAncestors(locations[2], locations).map(item => item.id), ['room', 'shelf']);
  assert.deepEqual([...locationDescendantIds('room', locations)].sort(), ['bin', 'room', 'shelf']);
});
