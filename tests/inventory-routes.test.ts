import test from 'node:test';
import assert from 'node:assert/strict';
import { inventorySupplyForPath, inventoryPathSegment } from '../client/inventoryRoutes.ts';
import type { InventoryItem } from '../client/db.ts';

const item = (id: string, name: string, category = 'Hops'): InventoryItem =>
  ({ id, name, category, default_unit: 'g', display_unit: 'g', location_id: null });

test('inventory links open supplies and resolve legacy stock IDs', () => {
  const mosaic = item('u95969aXiGdKSVnMXTi40', 'Mosaic hops');
  const stock = { ...item('stock-1234567890', 'Mosaic hops'), supply_id: mosaic.id, lot_id: 'lot-1' };
  assert.equal(inventoryPathSegment(mosaic, [mosaic]), 'mosaic-hops');
  assert.equal(inventorySupplyForPath('mosaic-hops', [mosaic], [stock])?.id, mosaic.id);
  assert.equal(inventorySupplyForPath(mosaic.id, [mosaic], [stock])?.id, mosaic.id);
  assert.equal(inventorySupplyForPath(stock.id, [mosaic], [stock])?.id, mosaic.id);
});

test('matching inventory names get distinct paths', () => {
  const hops = item('abcdefgh1234567890123', 'Mosaic hops');
  const grain = item('ijklmnop1234567890123', 'Mosaic hops', 'Grain');
  const secondHops = item('qrstuvwx1234567890123', 'Mosaic hops');
  assert.equal(inventoryPathSegment(grain, [hops, grain, secondHops]), 'mosaic-hops-grain');
  assert.equal(inventoryPathSegment(hops, [hops, grain, secondHops]), 'mosaic-hops-hops-abcdefgh');
  assert.equal(inventorySupplyForPath('mosaic-hops-hops-abcdefgh', [hops, grain, secondHops], [])?.id, hops.id);
});

test('old stock slugs resolve to the shared supply page', () => {
  const supply = item('supply1234567890', '2-row pale malt', 'Grain');
  const pantry = { ...item('abcdefgh1234567890123', supply.name, supply.category), supply_id: supply.id,
    lot_id: 'lot-a', location_id: 'pantry' };
  const garage = { ...item('ijklmnop1234567890123', supply.name, supply.category), supply_id: supply.id,
    lot_id: 'lot-a', location_id: 'garage' };
  const oldSlug = inventoryPathSegment(pantry, [pantry, garage]);
  assert.equal(inventorySupplyForPath(oldSlug, [supply], [pantry, garage])?.id, supply.id);
  assert.equal(inventoryPathSegment(supply, [supply]), '2-row-pale-malt');
});
