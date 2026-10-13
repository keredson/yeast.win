import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeForPath } from '../client/recipeRoutes.ts';
import type { Recipe } from '../client/db.ts';

test('recipe links resolve stored slugs and legacy IDs', () => {
  const recipes: Recipe[] = [
    { id: 'VtQfmQyFbtnv3Ic-APyyJ', slug: 'autumn-pale-ale', name: 'Autumn Pale Ale', description: null, recipe_type: 'beer' }
  ];
  assert.equal(recipeForPath('autumn-pale-ale', recipes)?.id, recipes[0].id);
  assert.equal(recipeForPath('VtQfmQyFbtnv3Ic-APyyJ', recipes)?.slug, recipes[0].slug);
});
