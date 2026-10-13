import assert from 'node:assert/strict';
import test from 'node:test';
import { locationTreeData, newLocationOption } from '../client/LocationTreeSelect.tsx';
import type { InventoryLocation } from '../client/db.ts';

const locations: InventoryLocation[] = [
  { id: 'room', name: 'Back room', parent_id: null, slug: 'back-room', address: null },
  { id: 'shelf', name: 'Shelf A', parent_id: 'room', slug: 'shelf-a', address: null },
  { id: 'garage', name: 'Garage', parent_id: null, slug: 'garage', address: null }
];

test('location choices follow the hierarchy and show paths when selected', () => {
  const tree = locationTreeData(locations, new Set(), true);
  assert.equal(tree[0].title, 'Back room');
  assert.equal(tree[0].children?.[0].title, 'Shelf A');
  assert.equal(tree[0].children?.[0].label, 'Back room / Shelf A');
  assert.equal(tree[1].title, 'Garage');
  assert.equal(tree[2].value, newLocationOption);
});

test('excluded locations cannot be chosen as a parent or stock destination', () => {
  const tree = locationTreeData(locations, new Set(['room']));
  assert.equal(tree[0].title, 'Shelf A');
  assert.equal(tree[1].title, 'Garage');
});
