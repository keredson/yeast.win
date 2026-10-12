import test from 'node:test';
import assert from 'node:assert/strict';
import { boilOffByPower, estimatedBoilOffAtPower, type BoilObservation } from '../client/boilOff.ts';

const observation = (id: string, watts: number, start: number, end: number, seconds: number): BoilObservation =>
  ({ id, observed_at: 1, power_watts: watts, ambient_c: null, liquid_c: null, start_liters: start,
    end_liters: end, duration_seconds: seconds });

test('boil observations weight rates by duration and interpolate only within measured powers', () => {
  const rows = [observation('a', 1000, 30, 29, 3600), observation('b', 1000, 30, 28, 7200),
    observation('c', 2000, 30, 27, 3600)];
  assert.deepEqual(boilOffByPower(rows), [{ watts: 1000, litersPerHour: 1 }, { watts: 2000, litersPerHour: 3 }]);
  assert.equal(estimatedBoilOffAtPower(rows, 1500), 2);
  assert.equal(estimatedBoilOffAtPower(rows, 2500), null);
});
