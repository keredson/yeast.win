import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeForPath, recipePathSegment } from '../client/recipeRoutes.ts';
import type { Recipe } from '../client/db.ts';

test('recipe links resolve stored slugs and legacy IDs', () => {
  const recipes: Recipe[] = [
    { id: 'VtQfmQyFbtnv3Ic-APyyJ', slug: 'autumn-pale-ale', name: 'Autumn Pale Ale', description: null, recipe_type: 'beer' }
  ];
  assert.equal(recipeForPath('autumn-pale-ale', recipes)?.id, recipes[0].id);
  assert.equal(recipeForPath('VtQfmQyFbtnv3Ic-APyyJ', recipes)?.slug, recipes[0].slug);
});

test('replicated duplicate recipe slugs resolve to distinct URLs', () => {
  const recipes: Recipe[] = ['first', 'second', 'third'].map((id, index) => ({ id, name: id,
    slug: index === 2 ? 'pale-first' : 'pale', description: null, recipe_type: 'beer' }));
  const segments = recipes.map(recipe => recipePathSegment(recipe, recipes));
  assert.equal(new Set(segments).size, recipes.length);
  for (const recipe of recipes) assert.equal(recipeForPath(recipePathSegment(recipe, recipes), recipes)?.id, recipe.id);
});
