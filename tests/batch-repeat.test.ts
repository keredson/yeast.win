import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatBatchActions } from '../client/batchRepeat.ts';
import type { ActualEvent, PlanDetails } from '../client/db.ts';

function event(id: string, eventType: string, details: PlanDetails,
  overrides: Partial<ActualEvent> = {}): ActualEvent {
  return { id, batch_id: 'source', event_type: eventType, title: id, planned_at: null,
    anchor_event_id: null, offset_seconds: 0, details, actual_at: null, skipped_at: null,
    note: null, source_id: null, ...overrides };
}

test('repeating a batch uses what happened as new timing and duration', () => {
  const source = [
    event('mash', 'temperature_control', { phase: 'mash', duration_seconds: 1800 },
      { actual_at: 1100, ended_at: 1700 }),
    event('grain', 'addition', { item_category: 'Grain', quantity: 5, unit: 'lb', anchor_point: 'start' },
      { anchor_event_id: 'mash', actual_at: 1100 }),
    event('drain', 'transfer', { purpose: 'drain_grain', anchor_point: 'end' },
      { anchor_event_id: 'mash', actual_at: 1710 }),
    event('gravity', 'measurement', { measurement_kind: 'gravity', target_unit: 'SG' },
      { anchor_event_id: 'drain', offset_seconds: 0 }),
    event('pill-reading', 'measurement', {}, { actual_at: 1800 }),
    event('photo', 'photo', {}, { actual_at: 1800 }),
    event('skipped', 'addition', { item_category: 'Hops' }, { skipped_at: 1800 })
  ];
  const repeated = repeatBatchActions(source, 1000);
  assert.deepEqual(repeated.map(action => action.sourceId), ['mash', 'grain', 'drain', 'gravity']);
  const [mash, grain, drain, gravity] = repeated;
  assert.equal(mash.offset_seconds, 100);
  assert.equal(mash.details.duration_seconds, 600);
  assert.equal(grain.anchor_event_id, mash.id);
  assert.equal(grain.offset_seconds, 0);
  assert.equal(grain.details.quantity, 5);
  assert.equal(drain.anchor_event_id, mash.id);
  assert.equal(drain.offset_seconds, 10);
  assert.equal(gravity.anchor_event_id, drain.id);
  assert.equal(gravity.offset_seconds, 0);
  assert.ok(repeated.every(action => !('actual_at' in action) && !('skipped_at' in action)));
});

test('children of omitted actions keep their scheduled offset from batch start', () => {
  const source = [
    event('skipped', 'addition', {}, { skipped_at: 1200, offset_seconds: 200 }),
    event('followup', 'addition', { item_category: 'Nutrient' },
      { anchor_event_id: 'skipped', offset_seconds: 60 })
  ];
  const repeated = repeatBatchActions(source, 1000);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].anchor_event_id, null);
  assert.equal(repeated[0].offset_seconds, 260);
});
