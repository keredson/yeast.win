import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQuantity, quantityForStorage, quantityUnitsForCategory, splitOunces, validPreferredUnits } from '../shared/units.ts';

test('compound pounds and ounces store as ounces and render without drift', () => {
  assert.deepEqual(quantityForStorage('lb + oz', undefined, 2, 5.5), { quantity: 37.5, unit: 'oz' });
  assert.deepEqual(splitOunces(37.5), { pounds: 2, ounces: 5.5 });
  assert.equal(formatQuantity(37.5, 'oz', 'lb + oz'), '2 lb 5.5 oz');
  assert.throws(() => quantityForStorage('lb + oz', undefined, 1, 16));
  assert.ok(validPreferredUnits({ temperature: '°C', volume: 'L', mass: 'lb + oz', pressure: 'kPa' }));
});

test('grain offers mass units without package counts', () => {
  const grain = quantityUnitsForCategory('Grain');
  assert.ok(grain.includes('lb + oz'));
  assert.ok(!grain.includes('vial'));
  assert.ok(!grain.includes('bottle'));
});
