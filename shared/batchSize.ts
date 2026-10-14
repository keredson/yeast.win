// Five US gallons, stored in the database's canonical volume unit.
export const appBatchSizeLiters = 18.92705892;

export function importedRecipeBatchSize(importedLiters: number | null, breweryLiters: number | null): {
  liters: number; source: 'assumed_brewery' | 'assumed_app' | null } {
  if (importedLiters != null && Number.isFinite(importedLiters) && importedLiters > 0) {
    return { liters: importedLiters, source: null };
  }
  return breweryLiters != null && Number.isFinite(breweryLiters) && breweryLiters > 0
    ? { liters: breweryLiters, source: 'assumed_brewery' }
    : { liters: appBatchSizeLiters, source: 'assumed_app' };
}

// Run after the current replicated schema exists. The update is safe to repeat:
// explicit sizes, including imported sizes, are never replaced.
export const fillMissingRecipeBatchSizes = [
  'INSERT OR IGNORE INTO recipe_inputs(id) SELECT id FROM recipes',
  `UPDATE recipe_inputs SET
    target_fermenter_volume_liters = COALESCE(
      (SELECT default_batch_size_liters FROM brewery_process_defaults
        WHERE id = 'brewery' AND default_batch_size_liters > 0), ${appBatchSizeLiters}),
    batch_size_source = CASE WHEN
      (SELECT default_batch_size_liters FROM brewery_process_defaults
        WHERE id = 'brewery' AND default_batch_size_liters > 0) IS NOT NULL
      THEN 'assumed_brewery' ELSE 'assumed_app' END
    WHERE id IN (SELECT id FROM recipes)
      AND (target_fermenter_volume_liters IS NULL OR target_fermenter_volume_liters <= 0)`
] as const;
