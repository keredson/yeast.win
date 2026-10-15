import test from 'node:test';
import assert from 'node:assert/strict';
import type { FormInstance } from 'antd';
import { changeNumberUnit, changeQuantityUnit } from '../client/unitFields.ts';

function formState(initial: Record<string, number | undefined>) {
  const values = { ...initial };
  const form = {
    getFieldValue(name: string) { return values[name]; },
    setFieldsValue(next: Record<string, number | undefined>) { Object.assign(values, next); }
  } as FormInstance<Record<string, number | undefined>>;
  return { values, form };
}

test('changing a compound quantity keeps the amount', () => {
  const { values, form } = formState({ pounds: 50, ounces: 0 });
  changeQuantityUnit(form, 'lb + oz', 'oz');
  assert.equal(values.quantity, 800);
  changeQuantityUnit(form, 'oz', 'lb + oz');
  assert.deepEqual([values.pounds, values.ounces], [50, 0]);
});

test('a temperature unit change converts readings and their uncertainty', () => {
  const { values, form } = formState({ value: 20, uncertainty: 0.5 });
  changeNumberUnit(form, ['value', 'uncertainty'], '°C', '°F', ['uncertainty']);
  assert.deepEqual([values.value, values.uncertainty], [68, 0.9]);
});
