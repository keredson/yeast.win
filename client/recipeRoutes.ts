import type { Recipe } from './db.ts';
import { uniqueRouteSegments } from './uniqueRouteSegments.ts';

export function recipePathSegment(recipe: Recipe, recipes: Recipe[]): string {
  return uniqueRouteSegments(recipes, row => row.slug, true).get(recipe.id) || recipe.id;
}

export function recipeForPath(segment: string, recipes: Recipe[]): Recipe | undefined {
  return recipes.find(recipe => recipe.id === segment)
    || recipes.find(recipe => recipePathSegment(recipe, recipes) === segment);
}
