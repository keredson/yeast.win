import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRecipe } from '../client/recipeCalculations.ts';
import type { Equipment, InventoryItem, PlanInput } from '../client/db.ts';

const grain = { id: 'grain', name: 'Pale malt', category: 'Grain', default_unit: 'kg', display_unit: 'kg',
  location_id: null, properties_json: '{"yield_pct":80,"color_lovibond":2}' } satisfies InventoryItem;
const yeast = { id: 'yeast', name: 'Ale yeast', category: 'Yeast', default_unit: 'packet', display_unit: 'packet',
  location_id: null, properties_json: '{"attenuation_pct":75}' } satisfies InventoryItem;
const events: (PlanInput & { id: string })[] = [
  { id: 'mash', event_type: 'temperature_control', title: 'Mash', details: { phase: 'mash', equipment_id: 'tun' } },
  { id: 'drain', event_type: 'transfer', title: 'Drain grain', anchor_event_id: 'mash',
    details: { purpose: 'drain_grain', to_vessel_id: 'kettle' } },
  { id: 'grain-add', event_type: 'addition', title: 'Pale malt',
    details: { item_category: 'Grain', item_name: 'Pale malt', inventory_item_id: 'grain', quantity: 5, unit: 'kg' } },
  { id: 'pitch', event_type: 'addition', title: 'Pitch yeast',
    details: { item_category: 'Yeast', inventory_item_id: 'yeast' } }
];
const equipment: Equipment[] = [
  { id: 'tun', kind: 'mash_tun', name: 'Tun', specification_json: '{"mash_efficiency_pct":75}' },
  { id: 'kettle', kind: 'kettle', name: 'Kettle', specification_json: '{"kettle_retention_liters":2}' }
];

test('estimates OG, FG and ABV using mash efficiency and the retained kettle volume', () => {
  const result = calculateRecipe(events, [grain, yeast], equipment, { target_fermenter_volume_liters: 20 }, {});
  const expectedOg = 1 + (5 / 0.45359237 * 46 * .8 * .75) / (22 / 3.785411784) / 1000;
  assert.ok(Math.abs(result.originalGravity! - expectedOg) < .000001);
  assert.ok(Math.abs(result.finalGravity! - (1 + (expectedOg - 1) * .25)) < .000001);
  assert.ok(Math.abs(result.abvPct! - (expectedOg - result.finalGravity!) * 131.25) < .000001);
  const mcu = 5 / 0.45359237 * 2 / (20 / 3.785411784);
  assert.ok(Math.abs(result.colorSrm! - 1.4922 * mcu ** .6859) < .000001);
  assert.match(result.efficiencyLabel!, /kettle retention/);
});

test('imported brewhouse efficiency works without selected equipment and never uses imported OG', () => {
  const imported = calculateRecipe(events, [grain, yeast], [], { batch_size: '20', efficiency: '70', og: '1.099' }, {});
  assert.ok(imported.originalGravity! > 1.053 && imported.originalGravity! < 1.055);
  assert.notEqual(imported.originalGravity!.toFixed(3), '1.099');
  assert.match(imported.efficiencyLabel!, /brewhouse/);
});

test('incomplete equipment or ingredient inputs do not produce misleading gravity', () => {
  const missingRetention = calculateRecipe(events, [grain, yeast], equipment.slice(0, 1),
    { target_fermenter_volume_liters: 20 }, {});
  assert.equal(missingRetention.originalGravity, null);
  assert.ok(missingRetention.missing.some(message => message.includes('kettle retention')));
  const missingYield = calculateRecipe(events, [{ ...grain, properties_json: null }, yeast], equipment,
    { target_fermenter_volume_liters: 20 }, { 'grain-add': { yield: 80 } });
  assert.equal(missingYield.originalGravity, null);
  assert.ok(missingYield.missing.some(message => message.includes('extract yield')));
  assert.equal(missingYield.colorSrm, null);
});

test('cider recipe asks for sugar inputs rather than grain mash equipment', () => {
  const result = calculateRecipe([], [], [], { target_fermenter_volume_liters: 19 }, {}, {}, 'cider');
  assert.equal(result.originalGravity, null);
  assert.equal(result.targetLiters, 19);
  assert.ok(result.missing.some(message => message.includes('fermentable sugar inputs')));
  assert.ok(result.missing.every(message => !message.includes('grain') && !message.includes('mash')));
});
