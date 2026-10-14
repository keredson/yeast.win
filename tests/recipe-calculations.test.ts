import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRecipe } from '../client/recipeCalculations.ts';
import type { Equipment, InventoryItem, PlanInput } from '../client/db.ts';

const grain = { id: 'grain', name: 'Pale malt', category: 'Grain', default_unit: 'kg', display_unit: 'kg',
  location_id: null, yield_pct: 80, color_lovibond: 2 } satisfies InventoryItem;
const yeast = { id: 'yeast', name: 'Ale yeast', category: 'Yeast', default_unit: 'packet', display_unit: 'packet',
  location_id: null, attenuation_pct: 75 } satisfies InventoryItem;
const events: (PlanInput & { id: string })[] = [
  { id: 'mash', event_type: 'temperature_control', title: 'Mash', details: { phase: 'mash', equipment_id: 'tun' } },
  { id: 'drain', event_type: 'transfer', title: 'Drain grain', anchor_event_id: 'mash',
    details: { purpose: 'drain_grain', to_vessel_id: 'kettle' } },
  { id: 'boil', event_type: 'temperature_control', title: 'Boil', details: { phase: 'boil', equipment_id: 'kettle' } },
  { id: 'chill', event_type: 'temperature_control', title: 'Chill', details: { phase: 'chill', equipment_id: 'chiller' } },
  { id: 'grain-add', event_type: 'addition', title: 'Pale malt',
    details: { item_category: 'Grain', item_name: 'Pale malt', inventory_item_id: 'grain', quantity: 5, unit: 'kg' } },
  { id: 'pitch', event_type: 'addition', title: 'Pitch yeast',
    details: { item_category: 'Yeast', inventory_item_id: 'yeast' } }
];
const equipment: Equipment[] = [
  { id: 'tun', kind: 'mash_tun', name: 'Tun', mash_efficiency_pct: 75 },
  { id: 'kettle', kind: 'kettle', name: 'Kettle', post_boil_loss_liters: 1.5 },
  { id: 'chiller', kind: 'chiller', name: 'Chiller', post_boil_loss_liters: .5 }
];

test('sums losses from post-boil equipment for OG, FG and ABV', () => {
  const result = calculateRecipe(events, [grain, yeast], equipment,
    { target_fermenter_volume_liters: 20 }, {});
  const expectedOg = 1 + (5 / 0.45359237 * 46 * .8 * .75) / (22 / 3.785411784) / 1000;
  assert.ok(Math.abs(result.originalGravity! - expectedOg) < .000001);
  assert.ok(Math.abs(result.finalGravity! - (1 + (expectedOg - 1) * .25)) < .000001);
  assert.ok(Math.abs(result.abvPct! - (expectedOg - result.finalGravity!) * 131.25) < .000001);
  const mcu = 5 / 0.45359237 * 2 / (20 / 3.785411784);
  assert.ok(Math.abs(result.colorSrm! - 1.4922 * mcu ** .6859) < .000001);
  assert.match(result.efficiencyLabel!, /2 L post-boil loss/);
});

test('imported brewhouse efficiency works without selected equipment', () => {
  const imported = calculateRecipe(events, [grain, yeast], [], { target_fermenter_volume_liters: 20, brewhouse_efficiency_pct: 70 }, {});
  assert.ok(imported.originalGravity! > 1.053 && imported.originalGravity! < 1.055);
  assert.match(imported.efficiencyLabel!, /brewhouse/);
});

test('brewery and app mash defaults are used only after recipe and equipment sources', () => {
  const noMashEquipment = equipment.filter(item => item.id !== 'tun');
  const inputs = { target_fermenter_volume_liters: 20 };
  const brewery = calculateRecipe(events, [grain, yeast], noMashEquipment, inputs, {}, {}, 'beer', 68);
  const app = calculateRecipe(events, [grain, yeast], noMashEquipment, inputs, {});
  assert.ok(brewery.originalGravity != null && app.originalGravity != null);
  assert.ok(brewery.originalGravity < app.originalGravity);
  assert.ok(brewery.sources.originalGravity.some(line => line.includes('68% (brewery default)')));
  assert.ok(app.sources.originalGravity.some(line => line.includes('75% (app default)')));
  const imported = calculateRecipe(events, [grain, yeast], noMashEquipment,
    { ...inputs, brewhouse_efficiency_pct: 70 }, {}, {}, 'beer', 68);
  assert.ok(imported.sources.originalGravity.some(line => line.includes('70% (imported recipe)')));
  const model = calculateRecipe(events, [grain, yeast], equipment, inputs, {}, {}, 'beer', 68);
  assert.ok(model.sources.originalGravity.some(line => line.includes('75% (equipment model Tun)')));
  const recent = calculateRecipe(events, [grain, yeast], noMashEquipment, inputs, {},
    { tun: { value: 73, batchName: 'Autumn ale' } }, 'beer', 68);
  assert.ok(recent.sources.originalGravity.some(line => line.includes('73% (batch Autumn ale using tun)')));
  assert.ok(model.sources.originalGravity.some(line => line.includes('Pale malt: 5 kg')));
  assert.ok(model.sources.finalGravity.some(line => line.includes('Ale yeast')));
  assert.ok(model.sources.abvPct.some(line => line.includes('131.25')));
  assert.ok(model.sources.colorSrm.some(line => line.includes('2 °L')));
});

test('missing loss attributes default to zero, and imported values survive empty supply properties', () => {
  const missingRetention = calculateRecipe(events, [grain, yeast], equipment.map(item => ({ ...item, post_boil_loss_liters: null })),
    { target_fermenter_volume_liters: 20 }, {});
  assert.ok(missingRetention.originalGravity != null);
  assert.match(missingRetention.efficiencyLabel!, /0 L post-boil loss/);
  assert.deepEqual(missingRetention.unavailable.colorSrm, []);
  const missingYield = calculateRecipe(events, [{ ...grain, yield_pct: null, color_lovibond: null }, yeast], equipment,
    { target_fermenter_volume_liters: 20 }, { 'grain-add': { yield_pct: 80 } });
  assert.ok(missingYield.originalGravity != null);
  assert.ok(missingYield.sources.originalGravity.some(line => line.includes('80% (imported recipe)')));
  assert.equal(missingYield.colorSrm, null);
  assert.ok(!missingYield.unavailable.originalGravity.some(message => message.includes('extract yield')));
  assert.ok(missingYield.unavailable.colorSrm.some(message => message.includes('color value')));
});

test('missing grain yields use named app class estimates without filling missing color', () => {
  const munich = { ...grain, name: 'Munich malt', yield_pct: null, color_lovibond: null };
  const result = calculateRecipe([{ ...events[4], title: 'Munich malt', details: {
    ...events[4].details, item_name: 'Munich malt' } }], [munich], equipment,
  { target_fermenter_volume_liters: 20 }, {});
  assert.ok(result.originalGravity != null);
  assert.ok(result.sources.originalGravity.some(line => line.includes('75% (app estimate for kilned malt)')));
  assert.equal(result.colorSrm, null);
});

test('repeated use of one unit contributes its loss only once', () => {
  const repeated = [...events, { id: 'second-boil', event_type: 'temperature_control', title: 'Boil again',
    details: { phase: 'boil', equipment_id: 'kettle' } }] as (PlanInput & { id: string })[];
  const result = calculateRecipe(repeated, [grain, yeast], equipment,
    { target_fermenter_volume_liters: 20 }, {});
  assert.ok(result.originalGravity != null);
  assert.match(result.efficiencyLabel!, /2 L post-boil loss/);
});

test('transfer equipment contributes post-boil loss without counting grain draining or duplicate equipment', () => {
  const transfer = { id: 'to-fermenter', event_type: 'transfer', title: 'Transfer to fermenter',
    details: { purpose: 'to_fermenter', transfer_equipment_ids: ['pump', 'chiller'] } };
  const draining = { id: 'drain-again', event_type: 'transfer', title: 'Drain grain',
    details: { purpose: 'drain_grain', transfer_equipment_ids: ['tun'] } };
  const result = calculateRecipe([...events, transfer, draining], [grain, yeast],
    [...equipment, { id: 'pump', kind: 'pump', name: 'Pump', post_boil_loss_liters: .25 },
      { id: 'tun', kind: 'mash_tun', name: 'Tun', mash_efficiency_pct: 75, post_boil_loss_liters: 3 }],
    { target_fermenter_volume_liters: 20 }, {});
  assert.match(result.efficiencyLabel!, /2.25 L post-boil loss/);
});

test('cider recipe asks for sugar inputs rather than grain mash equipment', () => {
  const result = calculateRecipe([], [], [], { target_fermenter_volume_liters: 19 }, {}, {}, 'cider');
  assert.equal(result.originalGravity, null);
  assert.equal(result.targetLiters, 19);
  assert.ok(result.missing.some(message => message.includes('fermentable sugar inputs')));
  assert.ok(result.missing.every(message => !message.includes('grain') && !message.includes('mash')));
});

test('batch size tooltip identifies saved assumptions and explicit recipe settings', () => {
  const assumed = calculateRecipe([], [], [],
    { target_fermenter_volume_liters: 18.92705892, batch_size_source: 'assumed_app' }, {});
  assert.match(assumed.sources.targetLiters[0], /assumed from 5 US gal app default/);
  const explicit = calculateRecipe([], [], [],
    { target_fermenter_volume_liters: 20, batch_size_source: null }, {});
  assert.match(explicit.sources.targetLiters[0], /recipe settings/);
});
