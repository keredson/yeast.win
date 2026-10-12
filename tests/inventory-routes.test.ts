import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryItemForPath, inventoryPathSegment } from '../client/inventoryRoutes.ts';
import type { InventoryItem } from '../client/db.ts';

const item = (id: string, name: string, category = 'Hops'): InventoryItem =>
  ({ id, name, category, default_unit: 'g', display_unit: 'g' });

test('inventory links use readable names and resolve legacy IDs', () => {
  const mosaic = item('u95969aXiGdKSVnMXTi40', 'Mosaic hops');
  assert.equal(inventoryPathSegment(mosaic, [mosaic]), 'mosaic-hops');
  assert.equal(inventoryItemForPath('mosaic-hops', [mosaic])?.id, mosaic.id);
  assert.equal(inventoryItemForPath(mosaic.id, [mosaic])?.id, mosaic.id);
});

test('matching inventory names get distinct paths', () => {
  const hops = item('abcdefgh1234567890123', 'Mosaic hops');
  const grain = item('ijklmnop1234567890123', 'Mosaic hops', 'Grain');
  const secondHops = item('qrstuvwx1234567890123', 'Mosaic hops');
  assert.equal(inventoryPathSegment(grain, [hops, grain, secondHops]), 'mosaic-hops-grain');
  assert.equal(inventoryPathSegment(hops, [hops, grain, secondHops]), 'mosaic-hops-hops-abcdefgh');
  assert.equal(inventoryItemForPath('mosaic-hops-hops-abcdefgh', [hops, grain, secondHops])?.id, hops.id);
});
