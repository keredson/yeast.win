import test from 'node:test';
import assert from 'node:assert/strict';
import { appBatchSizeLiters, importedRecipeBatchSize } from '../shared/batchSize.ts';

test('import keeps its stated size even when the brewery has a different default', () => {
  assert.deepEqual(importedRecipeBatchSize(19, 22), { liters: 19, source: null });
});

test('import without a size stores a tagged brewery or app assumption', () => {
  assert.deepEqual(importedRecipeBatchSize(null, 22), { liters: 22, source: 'assumed_brewery' });
  assert.deepEqual(importedRecipeBatchSize(null, null), { liters: appBatchSizeLiters, source: 'assumed_app' });
});
