import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivePlanTime, planTimingLabel } from '../client/planTiming.ts';
import type { ActualEvent, Plan } from '../client/db.ts';

test('plans use batch start and an actual anchor when it arrives', () => {
  const start = 1_800_000_000;
  const startAddition: Plan = { id: 'grain', batch_id: 'batch', title: 'Add grain', event_type: 'addition',
    planned_at: null, anchor_event_id: null, offset_seconds: 0, details_json: null };
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

  const actual: ActualEvent = { id: 'done', batch_id: 'batch', event_type: 'boil_finished',
    actual_at: start + 4800, planned_event_id: 'boil', note: null, source_id: null };
  assert.equal(effectivePlanTime(nutrient, plans, [actual], start), start + 5400);
  assert.equal(effectivePlanTime(preparation, plans, [actual], start), start + 4500);
});

test('a timed process exposes separate start and end anchors', () => {
  const start = 1_800_000_000;
  const boil: Plan = { id: 'boil', batch_id: 'batch', title: 'Boil', event_type: 'temperature_control',
    planned_at: null, anchor_event_id: null, offset_seconds: 600, details_json: JSON.stringify({ phase: 'boil', duration_seconds: 3600 }) };
  const hops: Plan = { ...boil, id: 'hops', title: 'Add hops', event_type: 'addition', anchor_event_id: 'boil',
    offset_seconds: 0, details_json: JSON.stringify({ anchor_point: 'start' }) };
  const yeast: Plan = { ...boil, id: 'yeast', title: 'Pitch yeast', event_type: 'addition', anchor_event_id: 'boil',
    offset_seconds: 0, details_json: JSON.stringify({ anchor_point: 'end' }) };
  const plans = [boil, hops, yeast];
  assert.equal(planTimingLabel(hops, plans), 'At start of Boil');
  assert.equal(planTimingLabel(yeast, plans), 'At end of Boil');
  assert.equal(effectivePlanTime(hops, plans, [], start), start + 600);
  assert.equal(effectivePlanTime(yeast, plans, [], start), start + 4200);
  const actual: ActualEvent = { id: 'boil-actual', batch_id: 'batch', event_type: 'temperature_control',
    actual_at: start + 900, ended_at: start + 4500, planned_event_id: 'boil', note: null, source_id: null };
  assert.equal(effectivePlanTime(hops, plans, [actual], start), start + 900);
  assert.equal(effectivePlanTime(yeast, plans, [actual], start), start + 4500);
});
