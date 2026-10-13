import assert from 'node:assert/strict';
import test from 'node:test';
import { hasGeneratedLocationSuffix, locationSlug } from '../client/locationSlug.ts';

test('location slugs use names and numeric suffixes for duplicates', () => {
  assert.equal(locationSlug('Garage', new Set()), 'garage');
  assert.equal(locationSlug('Garage', new Set(['garage'])), 'garage-2');
  assert.equal(locationSlug('Garage', new Set(['garage', 'garage-2'])), 'garage-3');
});

test('only old generated location slug shapes are replaced', () => {
  assert.equal(hasGeneratedLocationSuffix('Garage', 'abc', 'garage-myef22bc'), true);
  assert.equal(hasGeneratedLocationSuffix('Garage', 'abc', 'garage-616263'), true);
  assert.equal(hasGeneratedLocationSuffix('Garage', 'abc', 'garage-2'), false);
  assert.equal(hasGeneratedLocationSuffix('Garage', 'abc', 'custom-garage'), false);
});
