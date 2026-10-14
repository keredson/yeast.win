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
  equipmentModels: [{ id: 'model-one', name: 'Fermenter', kind: 'fermenter' }],
  equipment: [{ id: 'unit-one', name: 'Fermenter', kind: 'fermenter', model_id: 'model-one', stock_id: 'F-01' }],
  locations: [
    { id: 'building', name: 'Brew house', parent_id: null, slug: 'brew-house', address: null },
    { id: 'room', name: 'Cold room', parent_id: 'building', slug: 'cold-room', address: null },
    { id: 'shelf', name: 'Shelf A', parent_id: 'room', slug: 'shelf-a', address: null }
  ]
};

test('detail pages use one section-to-record breadcrumb pattern', () => {
  const labels = (section: Parameters<typeof breadcrumbNodes>[0], id: string) =>
    breadcrumbNodes(section, id, records).map(node => node.label);
  assert.deepEqual(labels('batches', 'batch-one'), ['Batches', 'Autumn brew']);
  assert.deepEqual(labels('recipes', 'house-ipa'), ['Recipes', 'House IPA']);
  assert.deepEqual(labels('inventory', 'stock-one'), ['Inventory', 'Pale malt']);
  assert.deepEqual(labels('equipment', 'model-one'), ['Equipment', 'Fermenter']);
  assert.deepEqual(labels('equipment', 'fermenter/f-01'), ['Equipment', 'Fermenter', 'F-01']);
  assert.deepEqual(labels('locations', 'shelf-a'), ['Locations', 'Brew house', 'Cold room', 'Shelf A']);
  assert.deepEqual(breadcrumbNodes('locations', null, records), []);
  assert.deepEqual(breadcrumbNodes('locations', 'unknown', records), []);
});
