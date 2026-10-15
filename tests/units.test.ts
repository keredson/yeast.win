import test from 'node:test';
import assert from 'node:assert/strict';
import { convertUnit, formatQuantity, gravityScales, quantityForStorage, quantityUnitsForCategory, splitOunces, unitGroups, unitOptions, validPreferredUnits } from '../shared/units.ts';
import { unitForCategory } from '../shared/catalog.ts';

test('compound pounds and ounces store as ounces and render without drift', () => {
  assert.deepEqual(quantityForStorage('lb + oz', undefined, 2, 5.5), { quantity: 37.5, unit: 'oz' });
  assert.deepEqual(splitOunces(37.5), { pounds: 2, ounces: 5.5 });
  assert.equal(formatQuantity(37.5, 'oz', 'lb + oz'), '2 lb 5.5 oz');
  assert.equal(formatQuantity(800, 'oz', 'lb + oz'), '50 lb');
  assert.throws(() => quantityForStorage('lb + oz', undefined, 1, 16));
  assert.ok(validPreferredUnits({ temperature: '°C', volume: 'L', mass: 'lb + oz', pressure: 'kPa' }));
});

test('unit changes preserve amounts and clear incompatible quantities', () => {
  assert.equal(convertUnit(5, 'US gal', 'L'), 18.927059);
  assert.equal(convertUnit(20, '°C', '°F'), 68);
  assert.equal(convertUnit(18, '°F', '°C', true), 10);
  assert.equal(convertUnit(50, 'lb', 'lb + oz'), 800);
  assert.equal(convertUnit(12, 'packet', 'oz'), null);
});

test('grain offers mass units without package counts', () => {
  const grain = quantityUnitsForCategory('Grain');
  assert.ok(grain.includes('lb + oz'));
  assert.ok(!grain.includes('vial'));
  assert.ok(!grain.includes('bottle'));
  assert.equal(unitForCategory('Grain', 'oz'), 'lb + oz');
  assert.equal(unitForCategory('Grain', 'g'), 'g');
});

test('specific gravity is a unitless gravity scale', () => {
  assert.deepEqual(gravityScales, ['SG', '°Brix', '°Plato']);
  assert.ok(!Object.values(unitGroups).some(units => units.includes('SG' as never)));
  assert.deepEqual(unitOptions(gravityScales)[0], { value: 'SG', label: 'Specific gravity (unitless)' });
});
