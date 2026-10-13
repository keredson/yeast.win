import type { Recipe } from './db.ts';

export function recipeForPath(segment: string, recipes: Recipe[]): Recipe | undefined {
  return recipes.find(recipe => recipe.id === segment) || recipes.find(recipe => recipe.slug === segment);
}
