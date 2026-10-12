import test from 'node:test';
import assert from 'node:assert/strict';
import { heatLossFromBoil, predictedBoilOff, wattsPerLiterPerHour } from '../client/boilOff.ts';

test('one steady-boil calibration yields a heat loss reused at other power settings', () => {
  const loss = heatLossFromBoil(2000, 30, 27, 60);
  assert.ok(Math.abs(loss - (2000 - 3 * wattsPerLiterPerHour)) < 0.001);
  assert.ok(Math.abs(predictedBoilOff(2000, loss) - 3) < 0.001);
  assert.ok(predictedBoilOff(1500, loss) < 3);
  assert.equal(predictedBoilOff(100, loss), 0);
});

test('calibration rejects a physically inconsistent observation', () => {
  assert.throws(() => heatLossFromBoil(1000, 30, 27, 60), /exceeds the power/);
});
