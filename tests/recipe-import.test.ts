import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipeImport } from '../client/recipeImport.ts';

test('Brewfather JSON selects recipes and makes boil hops relative to boil end', () => {
  const source = JSON.stringify({ recipes: [{ _id: 'source-one', name: 'Pale Ale', type: 'All Grain',
    batchSize: 20, boilTime: 60, efficiency: 72, og: 1.052,
    mash: { steps: [{ name: 'Saccharification', stepTemp: 66, stepTime: 45 }] },
    fermentables: [{ name: '2-row pale malt', type: 'Grain', amount: 4.5, yield: 80 }],
    hops: [{ name: 'Cascade', use: 'Boil', amount: 30, time: 15, alpha: 6 }],
    yeasts: [{ name: 'US-05', unit: 'packet', amount: 1, attenuation: 78 }]
  }, { name: 'Second recipe', boilTime: 30 }] });
  const parsed = parseRecipeImport(source, 'brewfather_json');
  assert.equal(parsed.recipes.length, 2);
  const recipe = parsed.recipes[0];
  assert.equal(recipe.externalId, 'source-one');
  assert.equal(recipe.inputs.efficiency, 72);
  assert.equal(recipe.inputs.og, undefined);
  assert.deepEqual(recipe.ingredients.map(item => item.name), ['2-row pale malt', 'US-05', 'Cascade']);
  const boil = recipe.actions.find(item => item.title === 'Boil')!;
  const hop = recipe.actions.find(item => item.title === 'Cascade')!;
  assert.equal(hop.anchorKey, boil.key);
  assert.equal(hop.offsetSeconds, -900);
  assert.equal(hop.details.anchor_point, 'end');
  assert.equal(hop.details.quantity, 30);
  assert.equal(hop.inputs.alpha, 6);
});

test('JSON importer rejects documents without recipes', () => {
  assert.throws(() => parseRecipeImport('{"inventory":[]}', 'brewfather_json'), /has no name|No Brewfather recipes/);
});
