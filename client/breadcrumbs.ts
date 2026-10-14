import type { Batch, Equipment, InventoryItem, InventoryLocation, Recipe } from './db.ts';
import { inventorySupplyForPath } from './inventoryRoutes.ts';
import { equipmentModelForPath, equipmentUnitForPath } from './equipmentRoutes.ts';
import { locationAncestors, locationForPath } from './locationRoutes.ts';
import { recipeForPath } from './recipeRoutes.ts';

export type BreadcrumbSection = 'batches' | 'recipes' | 'inventory' | 'equipment' | 'locations';
export interface BreadcrumbNode { label: string; section: BreadcrumbSection; id: string | null }
export interface BreadcrumbRecords {
  batches: Batch[]; recipes: Recipe[]; inventory: InventoryItem[]; supplies: InventoryItem[];
  equipment: Equipment[]; equipmentModels: Equipment[]; locations: InventoryLocation[];
}

const sectionLabels: Record<BreadcrumbSection, string> = {
  batches: 'Batches', recipes: 'Recipes', inventory: 'Inventory', equipment: 'Equipment', locations: 'Locations'
};

export function breadcrumbNodes(section: BreadcrumbSection, selectedId: string | null,
  records: BreadcrumbRecords): BreadcrumbNode[] {
  if (!selectedId) return [];
  const root: BreadcrumbNode = { label: sectionLabels[section], section, id: null };
  if (section === 'batches') {
    const batch = records.batches.find(row => row.id === selectedId);
    return batch ? [root, { label: batch.name, section, id: batch.id }] : [];
  }
  if (section === 'recipes') {
    const recipe = recipeForPath(selectedId, records.recipes);
    return recipe ? [root, { label: recipe.name, section, id: recipe.id }] : [];
  }
  if (section === 'inventory') {
    const supply = inventorySupplyForPath(selectedId, records.supplies, records.inventory);
    return supply ? [root, { label: supply.name, section, id: supply.id }] : [];
  }
  if (section === 'equipment') {
    const model = equipmentModelForPath(selectedId, records.equipmentModels);
    if (model) return [root, { label: model.name, section, id: model.id }];
    const unit = equipmentUnitForPath(selectedId, records.equipment, records.equipmentModels);
    if (!unit) return [];
    const parent = records.equipmentModels.find(row => row.id === unit.model_id);
    return [root, ...(parent ? [{ label: parent.name, section, id: parent.id }] : []),
      { label: unit.stock_id || `Unit ${unit.id.slice(0, 6)}`, section, id: unit.id }];
  }
  const location = locationForPath(selectedId, records.locations);
  return location ? [root, ...locationAncestors(location, records.locations).map(row => ({
    label: row.name, section, id: row.id
  })), { label: location.name, section, id: location.id }] : [];
}
