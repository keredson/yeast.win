import test from 'node:test';
import assert from 'node:assert/strict';
import { appYeastAttenuationPct, calculateRecipe } from '../client/recipeCalculations.ts';
import { batchGravityReadings } from '../client/batchGravity.ts';
import type { Equipment, InventoryRecord, PlanInput } from '../client/db.ts';

const grain = { id: 'grain', name: 'Pale malt', category: 'Grain', default_unit: 'kg', display_unit: 'kg',
  location_id: null, yield_pct: 80, color_lovibond: 2 } satisfies InventoryRecord;
const yeast = { id: 'yeast', name: 'Ale yeast', category: 'Yeast', default_unit: 'packet', display_unit: 'packet',
  location_id: null, attenuation_pct: 75 } satisfies InventoryRecord;
const events: (PlanInput & { id: string })[] = [
  { id: 'mash', event_type: 'temperature_control', title: 'Mash', details: { phase: 'mash', equipment_id: 'tun' } },
  { id: 'drain', event_type: 'transfer', title: 'Drain grain', anchor_event_id: 'mash',
    details: { purpose: 'drain_grain', to_vessel_id: 'kettle' } },
  { id: 'boil', event_type: 'temperature_control', title: 'Boil', details: { phase: 'boil', equipment_id: 'kettle' } },
  { id: 'chill', event_type: 'temperature_control', title: 'Chill', details: { phase: 'chill', equipment_id: 'chiller' } },
  { id: 'grain-add', event_type: 'addition', title: 'Pale malt',
    details: { item_category: 'Grain', item_name: 'Pale malt', stock_bucket_id: 'grain', quantity: 5, unit: 'kg' } },
  { id: 'pitch', event_type: 'addition', title: 'Pitch yeast',
    details: { item_category: 'Yeast', stock_bucket_id: 'yeast' } }
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

test('batch estimates use event snapshots, unit efficiency, and the batch wort loss override', () => {
  const stock = [{ ...grain, yield_pct: 60, color_lovibond: 20 }, { ...yeast, attenuation_pct: 50 }];
  const batchEvents = events.map(event => event.id === 'grain-add' ? { ...event, details: {
    ...event.details, quantity: 6 } } : event);
  const result = calculateRecipe(batchEvents, stock, equipment,
    { target_fermenter_volume_liters: 25, wort_loss_liters: 3 }, {
      drain: { mash_efficiency_pct: 70 },
      'grain-add': { yield_pct: 80, color_lovibond: 2, grain_class: 'base' },
      pitch: { attenuation_pct: 75 }
    }, {}, 'beer', null, 'batch');
  const expectedOg = 1 + (6 / 0.45359237 * 46 * .8 * .7) / (28 / 3.785411784) / 1000;
  assert.ok(Math.abs(result.originalGravity! - expectedOg) < .000001);
  assert.ok(Math.abs(result.finalGravity! - (1 + (expectedOg - 1) * .25)) < .000001);
  assert.match(result.efficiencyLabel!, /70% mash efficiency.*3 L post-boil loss/);
  assert.ok(result.sources.targetLiters.some(line => line.includes('25 L (batch inputs)')));
  assert.ok(result.sources.originalGravity.some(line => line.includes('6 kg (batch action); extract yield 80% (batch event input)')));
  assert.ok(result.sources.originalGravity.some(line => line.includes('3 L (batch input)')));
  assert.ok(result.sources.finalGravity.some(line => line.includes('75% (batch event input)')));
  assert.ok(result.sources.colorSrm.some(line => line.includes('2 °L (batch event input)')));
});

test('measured batch mash efficiency replaces the planning assumption', () => {
  const inputs = { target_fermenter_volume_liters: 20 };
  const snapshots = { drain: { mash_efficiency_pct: 75 } };
  const assumed = calculateRecipe(events, [grain, yeast], equipment, inputs, snapshots,
    {}, 'beer', null, 'batch');
  const measured = calculateRecipe(events, [grain, yeast], equipment, inputs, snapshots,
    {}, 'beer', null, 'batch', [], {}, 68.4);
  assert.equal(assumed.mashEfficiencyPct, 75);
  assert.equal(assumed.measuredMashEfficiency, false);
  assert.equal(measured.mashEfficiencyPct, 68.4);
  assert.equal(measured.measuredMashEfficiency, true);
  assert.ok(measured.originalGravity! < assumed.originalGravity!);
  assert.ok(measured.sources.mashEfficiency.some(line => line.includes('collected wort volume')));
});

test('one selected yeast without attenuation uses a labeled app estimate', () => {
  const result = calculateRecipe(events, [grain, { ...yeast, attenuation_pct: null }], equipment,
    { target_fermenter_volume_liters: 20 }, {});
  assert.ok(result.originalGravity != null);
  assert.ok(Math.abs(result.finalGravity! - (1 + (result.originalGravity - 1)
    * (1 - appYeastAttenuationPct / 100))) < .000001);
  assert.ok(result.abvPct != null);
  assert.equal(result.usedAppYeastAttenuation, true);
  assert.ok(result.sources.finalGravity.some(line => line.includes('75% (app estimate; selected yeast has no attenuation value)')));
  assert.ok(result.sources.abvPct.some(line => line.includes('75% (app estimate; selected yeast has no attenuation value)')));
  assert.ok(!result.missing.some(line => line.includes('yeast')));
});

test('yeast snapshot and ingredient values take precedence over the app estimate', () => {
  const stock = [grain, { ...yeast, attenuation_pct: 81 }];
  const recipe = calculateRecipe(events, stock, equipment,
    { target_fermenter_volume_liters: 20 }, { pitch: { attenuation_pct: 70 } });
  const batch = calculateRecipe(events, stock, equipment,
    { target_fermenter_volume_liters: 20 }, { pitch: { attenuation_pct: 70 } }, {}, 'beer', null, 'batch');
  assert.ok(recipe.sources.finalGravity.some(line => line.includes('81% (brewery or catalog ingredient')));
  assert.ok(batch.sources.finalGravity.some(line => line.includes('70% (batch event input)')));
  assert.equal(recipe.usedAppYeastAttenuation, false);
  assert.equal(batch.usedAppYeastAttenuation, false);
});

test('missing or multiple yeast additions explain why FG is unavailable', () => {
  const withoutYeast = calculateRecipe(events.filter(event => event.id !== 'pitch'), [grain], equipment,
    { target_fermenter_volume_liters: 20 }, {});
  assert.equal(withoutYeast.finalGravity, null);
  assert.ok(withoutYeast.unavailable.finalGravity.some(line => line.includes('Add a yeast addition')));
  const multipleYeasts = calculateRecipe([...events, { ...events[5], id: 'pitch-again' }], [grain, yeast], equipment,
    { target_fermenter_volume_liters: 20 }, {});
  assert.equal(multipleYeasts.finalGravity, null);
  assert.ok(multipleYeasts.unavailable.finalGravity.some(line => line.includes('multiple yeast additions')));
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

test('batch grain linked directly to a catalog product contributes its color', () => {
  const catalogGrain = { id: 'briess-bonlander', name: 'Briess Bonlander Munich Malt 10L', category: 'Grain',
    unit: 'kg', yield_pct: 78, color_lovibond: 10 };
  const batchEvents = events.map(event => event.id === 'grain-add' ? { ...event, details: {
    ...event.details, stock_bucket_id: undefined, catalog_item_id: catalogGrain.id,
    item_name: catalogGrain.name } } : event);
  const result = calculateRecipe(batchEvents, [yeast], equipment,
    { target_fermenter_volume_liters: 20 }, {}, {}, 'beer', null, 'batch', [catalogGrain]);
  assert.ok(result.colorSrm != null && result.colorSrm > 0);
  assert.ok(result.sources.colorSrm.some(line => line.includes('Briess Bonlander Munich Malt 10L')));
  assert.ok(result.sources.colorSrm.some(line => line.includes('10 °L (brewery or catalog ingredient)')));
});

test('batch gravity readings replace estimates as OG and FG are recorded', () => {
  const readings = batchGravityReadings([
    { role: null, value: 1.063, unit: 'SG' },
    { role: 'og', value: 1.052, unit: 'SG' },
    { role: 'fg', value: 1.012, unit: 'SG' }
  ]);
  assert.deepEqual(readings, { original: 1.052, final: 1.012 });
  const ogOnly = calculateRecipe(events, [grain, yeast], equipment,
    { target_fermenter_volume_liters: 20 }, {}, {}, 'beer', null, 'batch', [], { original: readings.original });
  assert.equal(ogOnly.originalGravity, 1.052);
  assert.ok(Math.abs(ogOnly.finalGravity! - 1.013) < .000001);
  assert.equal(ogOnly.measuredOriginalGravity, true);
  assert.equal(ogOnly.measuredFinalGravity, false);
  const complete = calculateRecipe(events.filter(event => event.id !== 'pitch'), [grain], equipment,
    { target_fermenter_volume_liters: 20 }, {}, {}, 'beer', null, 'batch', [], readings);
  assert.equal(complete.finalGravity, 1.012);
  assert.equal(complete.measuredFinalGravity, true);
  assert.ok(Math.abs(complete.abvPct! - (1.052 - 1.012) * 131.25) < .000001);
  assert.deepEqual(complete.unavailable.finalGravity, []);
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
