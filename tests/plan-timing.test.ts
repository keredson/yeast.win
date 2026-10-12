import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivePlanTime, orderTimelineGroup, planDetailsLabel, planDuration, planTimingLabel, timelineGroupKey, timelineGroupStep } from '../client/planTiming.ts';
import type { Plan } from '../client/db.ts';

test('plans use batch start and an actual anchor when it arrives', () => {
  const start = 1_800_000_000;
  const startAddition: Plan = { id: 'grain', batch_id: 'batch', title: 'Add grain', event_type: 'addition',
    planned_at: null, anchor_event_id: null, offset_seconds: 0, details_json: null,
    actual_at: null, skipped_at: null, note: null, source_id: null };
  const boilEnd: Plan = { ...startAddition, id: 'boil', title: 'Boil finished', event_type: 'boil_finished', offset_seconds: 3600 };
  const nutrient: Plan = { ...startAddition, id: 'nutrient', title: 'Add nutrient', anchor_event_id: 'boil', offset_seconds: 600 };
  const preparation: Plan = { ...startAddition, id: 'preparation', title: 'Prepare nutrient',
    anchor_event_id: 'boil', offset_seconds: -300 };
  const plans = [startAddition, boilEnd, nutrient, preparation];
  assert.equal(effectivePlanTime(startAddition, plans, [], start), start);
  assert.equal(effectivePlanTime(nutrient, plans, [], start), start + 4200);
  assert.equal(planTimingLabel(startAddition, plans), 'At batch start');
  assert.equal(planTimingLabel(nutrient, plans), '10 minutes after Boil finished');
  assert.equal(effectivePlanTime(preparation, plans, [], start), start + 3300);
  assert.equal(planTimingLabel(preparation, plans), '5 minutes before Boil finished');

  const recorded = plans.map(plan => plan.id === 'boil' ? { ...plan, actual_at: start + 4800 } : plan);
  assert.equal(effectivePlanTime(nutrient, recorded, recorded, start), start + 5400);
  assert.equal(effectivePlanTime(preparation, recorded, recorded, start), start + 4500);
});

test('a timed process exposes separate start and end anchors', () => {
  const start = 1_800_000_000;
  const boil: Plan = { id: 'boil', batch_id: 'batch', title: 'Boil', event_type: 'temperature_control',
    planned_at: null, anchor_event_id: null, offset_seconds: 600, details_json: JSON.stringify({ phase: 'boil', duration_seconds: 3600 }),
    actual_at: null, skipped_at: null, note: null, source_id: null };
  const hops: Plan = { ...boil, id: 'hops', title: 'Add hops', event_type: 'addition', anchor_event_id: 'boil',
    offset_seconds: 0, details_json: JSON.stringify({ anchor_point: 'start' }) };
  const yeast: Plan = { ...boil, id: 'yeast', title: 'Pitch yeast', event_type: 'addition', anchor_event_id: 'boil',
    offset_seconds: 0, details_json: JSON.stringify({ anchor_point: 'end' }) };
  const plans = [boil, hops, yeast];
  assert.equal(planTimingLabel(hops, plans), 'At start of Boil');
  assert.equal(planTimingLabel(yeast, plans), 'After Boil');
  assert.equal(effectivePlanTime(hops, plans, [], start), start + 600);
  assert.equal(effectivePlanTime(yeast, plans, [], start), start + 4200);
  const recorded = plans.map(plan => plan.id === 'boil' ? { ...plan, actual_at: start + 900, ended_at: start + 4500 } : plan);
  assert.equal(effectivePlanTime(hops, recorded, recorded, start), start + 900);
  assert.equal(effectivePlanTime(yeast, recorded, recorded, start), start + 4500);
});

test('packaging does not become a range even if old plan details contain a duration', () => {
  const packaging: Plan = { id: 'package', batch_id: 'batch', title: 'Package batch', event_type: 'packaging',
    planned_at: null, anchor_event_id: null, offset_seconds: 0,
    details_json: JSON.stringify({ duration_seconds: 3600 }), actual_at: null, skipped_at: null, note: null, source_id: null };
  assert.equal(planDuration(packaging), 0);
  assert.equal(planDuration({ ...packaging, event_type: 'pressure_control' }), 3600);
  assert.equal(planDuration({ ...packaging, event_type: 'temperature_control',
    details_json: JSON.stringify({ phase: 'chill', duration_seconds: 3600 }) }), 0);
});

test('pitching after chill follows the chill completion point', () => {
  const start = 1_800_000_000;
  const chill: Plan = { id: 'chill', batch_id: 'batch', title: 'Chill', event_type: 'temperature_control',
    planned_at: null, anchor_event_id: null, offset_seconds: 600,
    details_json: JSON.stringify({ phase: 'chill' }), actual_at: null, skipped_at: null, note: null, source_id: null };
  const pitch: Plan = { ...chill, id: 'pitch', title: 'Pitch yeast', event_type: 'addition',
    anchor_event_id: 'chill', offset_seconds: 0, details_json: JSON.stringify({ anchor_point: 'end' }) };
  assert.equal(planTimingLabel(pitch, [chill, pitch]), 'After Chill');
  assert.equal(effectivePlanTime(pitch, [chill, pitch], [], start), start + 600);
  const recordedChill = { ...chill, actual_at: start + 900 };
  assert.equal(effectivePlanTime(pitch, [chill, pitch], [recordedChill], start), start + 900);
});

test('same-time timeline rows keep chill before its dependent yeast pitch', () => {
  const chill = { id: 'chill', event_type: 'temperature_control', anchor_event_id: 'boil', details_json: '{"phase":"chill"}' };
  const transfer = { id: 'transfer', event_type: 'transfer', anchor_event_id: 'chill', details_json: null };
  const gravity = { id: 'gravity', event_type: 'measurement', anchor_event_id: 'transfer', details_json: null };
  const pitch = { id: 'pitch', event_type: 'addition', anchor_event_id: 'chill', details_json: '{"item_category":"Yeast"}' };
  const group = [pitch, chill, transfer, gravity];
  const times = new Map(group.map(event => [event.id, 600]));
  assert.deepEqual(orderTimelineGroup(group, times).map(event => event.id), ['chill', 'pitch', 'transfer', 'gravity']);
  assert.deepEqual(orderTimelineGroup([chill, transfer, gravity, pitch], times).map(event => event.id),
    ['chill', 'transfer', 'gravity', 'pitch']);
  const grain = { id: 'grain', event_type: 'addition', anchor_event_id: null, details_json: '{"item_category":"Grain"}' };
  assert.equal(orderTimelineGroup([chill, grain], new Map([['chill', 600], ['grain', 600]]))[0].id, 'grain');
  const boil = { id: 'boil', event_type: 'temperature_control', anchor_event_id: null,
    details_json: '{"phase":"boil","duration_seconds":3600}' };
  const boilGrain = { ...grain, anchor_event_id: 'boil', details_json: '{"item_category":"Grain","anchor_point":"start"}' };
  assert.deepEqual(orderTimelineGroup([boil, boilGrain], new Map([['boil', 600], ['grain', 600]])).map(event => event.id),
    ['grain', 'boil']);
});

test('timeline groups only exact simultaneous steps', () => {
  const chill: Plan = { id: 'chill', batch_id: 'batch', title: 'Chill', event_type: 'temperature_control',
    planned_at: null, anchor_event_id: null, offset_seconds: 0, details_json: '{"phase":"chill"}',
    actual_at: null, skipped_at: null, note: null, source_id: null };
  const transfer: Plan = { ...chill, id: 'transfer', title: 'Transfer to fermenter', event_type: 'transfer',
    anchor_event_id: 'chill', details_json: '{"anchor_point":"end"}' };
  const gravity: Plan = { ...chill, id: 'gravity', title: 'Measure original specific gravity', event_type: 'measurement',
    anchor_event_id: 'transfer', details_json: '{"anchor_point":"start"}' };
  const pitch: Plan = { ...chill, id: 'pitch', title: 'Pitch yeast', event_type: 'addition',
    anchor_event_id: 'chill', details_json: '{"anchor_point":"end","item_category":"Yeast"}' };
  const plans = [chill, transfer, gravity, pitch];
  const times = new Map(plans.map(plan => [plan.id, 600]));
  const group = (plan: Plan) => timelineGroupKey(times.get(plan.id)!, timelineGroupStep(plan, plans, times), plan.id);
  assert.notEqual(group(chill), group(transfer));
  assert.equal(group(transfer), group(pitch));
  assert.notEqual(group(transfer), group(gravity));
  assert.notEqual(timelineGroupKey(600, 0, 'a'), timelineGroupKey(601, 0, 'b'));
  assert.equal(planDetailsLabel({ event_type: 'addition', title: 'Pitch yeast',
    details_json: '{"item_category":"Yeast","item_name":"Yeast"}' }), '');
});
