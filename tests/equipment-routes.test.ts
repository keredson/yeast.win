import test from 'node:test';
import assert from 'node:assert/strict';
import { equipmentModelForPath, equipmentModelPathSegment, equipmentUnitForPath,
  equipmentUnitPathSegment } from '../client/equipmentRoutes.ts';
import type { Equipment } from '../client/db.ts';

const item = (id: string, name: string): Equipment => ({ id, name, kind: 'all_in_one' });

test('equipment model and stock unit have distinct routes', () => {
  const model = item('equipment_vevor_35l', 'VEVOR Electric Brewing System');
  const vevor = { ...item('27I0Kppqfmadgy4Ymv-Ze', 'My VEVOR'), model_id: model.id, stock_id: 'Unit 7' };
  assert.equal(equipmentModelPathSegment(model, [model]), 'vevor-electric-brewing-system');
  assert.equal(equipmentUnitPathSegment(vevor, [vevor], [model]), 'vevor-electric-brewing-system/unit-7');
  assert.equal(equipmentModelForPath('vevor-electric-brewing-system', [model])?.id, model.id);
  assert.equal(equipmentUnitForPath('vevor-electric-brewing-system/unit-7', [vevor], [model])?.id, vevor.id);
  assert.equal(equipmentUnitForPath(vevor.id, [vevor], [model])?.id, vevor.id);
});

test('stock units without IDs get stable links within a model', () => {
  const model = item('brewzilla', 'BrewZilla 35L');
  const first = { ...item('abcdefgh1234567890123', 'BrewZilla 35L'), model_id: model.id };
  const second = { ...item('ijklmnop1234567890123', 'BrewZilla 35L'), model_id: model.id };
  const units = [first, second];
  assert.equal(equipmentUnitPathSegment(first, units, [model]), 'brewzilla-35l/unit-abcdefgh1234567890123');
  assert.equal(equipmentUnitPathSegment(second, units, [model]), 'brewzilla-35l/unit-ijklmnop1234567890123');
  assert.equal(equipmentUnitForPath(equipmentUnitPathSegment(second, units, [model]), units, [model])?.id, second.id);
  assert.equal(equipmentUnitForPath('brewzilla-35l-ijklmnop1234567890123', units, [model])?.id, second.id);
  assert.equal(equipmentUnitForPath(`brewzilla/${equipmentUnitPathSegment(second, units, [model]).split('/')[1]}`,
    units, [model])?.id, second.id);
});

test('stock IDs that normalize to the same slug remain distinct', () => {
  const model = item('brewzilla', 'BrewZilla 35L');
  const first = { ...item('first', 'BrewZilla 35L'), model_id: model.id, stock_id: 'Unit 1' };
  const second = { ...item('second', 'BrewZilla 35L'), model_id: model.id, stock_id: 'unit-1' };
  const units = [first, second];
  assert.equal(equipmentUnitPathSegment(first, units, [model]), 'brewzilla-35l/unit-1-first');
  assert.equal(equipmentUnitPathSegment(second, units, [model]), 'brewzilla-35l/unit-1-second');
  assert.equal(equipmentUnitForPath('brewzilla-35l/unit-1-second', units, [model])?.id, second.id);
});

test('matching model names get distinct parent routes', () => {
  const first = item('model_a', 'BrewZilla 35L');
  const second = item('model_b', 'BrewZilla 35L');
  const models = [first, second];
  assert.equal(equipmentModelPathSegment(first, models), 'brewzilla-35l-model_a');
  assert.equal(equipmentModelPathSegment(second, models), 'brewzilla-35l-model_b');
  assert.equal(equipmentModelForPath('brewzilla-35l-model_b', models)?.id, second.id);
});

test('the path follows changed stock ID while old saved slugs remain aliases', () => {
  const model = item('equipment_vevor_35l', 'VEVOR Electric Brewing System');
  const vevor = { ...item('27I0Kppqfmadgy4Ymv-Ze', 'My VEVOR'), model_id: model.id,
    stock_id: 'Unit 9', slug: 'my-old-vevor' };
  assert.equal(equipmentUnitPathSegment(vevor, [vevor], [model]), 'vevor-electric-brewing-system/unit-9');
  assert.equal(equipmentUnitForPath('my-old-vevor', [vevor], [model])?.id, vevor.id);
});
