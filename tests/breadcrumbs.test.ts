import test from 'node:test';
import assert from 'node:assert/strict';
import { breadcrumbNodes, type BreadcrumbRecords } from '../client/breadcrumbs.ts';

const records: BreadcrumbRecords = {
  batches: [{ id: 'batch-one', name: 'Autumn brew', description: null, status: 'active', created_at: 1 }],
  recipes: [{ id: 'recipe-one', slug: 'house-ipa', name: 'House IPA', description: null, recipe_type: 'beer' }],
  supplies: [{ id: 'supply-one', name: 'Pale malt', category: 'Grain', default_unit: 'g',
    display_unit: 'g', location_id: null }],
  inventory: [{ id: 'stock-one', supply_id: 'supply-one', name: 'Pale malt', category: 'Grain',
    default_unit: 'g', display_unit: 'g', location_id: null }],
  equipmentModels: [{ id: 'model-one', name: 'RAPT Pill', kind: 'hydrometer' }],
  equipment: [{ id: 'unit-one', name: 'Blue Pill', kind: 'hydrometer', model_id: 'model-one', stock_id: 'PILL-01' }],
  locations: [
    { id: 'building', name: 'Brew house', parent_id: null, slug: 'brew-house', address: null },
    { id: 'room', name: 'Cold room', parent_id: 'building', slug: 'cold-room', address: null },
    { id: 'shelf', name: 'Shelf A', parent_id: 'room', slug: 'shelf-a', address: null }
  ]
};

test('detail pages use one section-to-record breadcrumb pattern', () => {
  const labels = (section: Parameters<typeof breadcrumbNodes>[0], id: string) =>
    breadcrumbNodes(section, id, records).map(node => node.label);
  assert.deepEqual(labels('batches', 'batch-one'), ['Home', 'Batches', 'Autumn brew']);
  assert.deepEqual(labels('recipes', 'house-ipa'), ['Home', 'Recipes', 'House IPA']);
  assert.deepEqual(labels('inventory', 'stock-one'), ['Home', 'Inventory', 'Pale malt']);
  assert.deepEqual(labels('equipment', 'model-one'), ['Home', 'Equipment', 'RAPT Pill']);
  assert.deepEqual(labels('equipment', 'rapt-pill/pill-01'), ['Home', 'Equipment', 'RAPT Pill', 'Blue Pill']);
  assert.deepEqual(labels('locations', 'shelf-a'), ['Home', 'Locations', 'Brew house', 'Cold room', 'Shelf A']);
  assert.deepEqual(labels('locations', ''), ['Home', 'Locations']);
  assert.deepEqual(breadcrumbNodes('locations', null, records).map(node => node.label), ['Home', 'Locations']);
  assert.deepEqual(breadcrumbNodes('locations', 'unknown', records).map(node => node.label), ['Home', 'Locations']);
});
