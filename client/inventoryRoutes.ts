import type { InventoryItem } from './db.ts';
import { recordSlug as slug } from './recordSlug.ts';

export function inventoryPathSegment(item: InventoryItem, items: InventoryItem[]): string {
  const name = slug(item.name);
  const sameName = items.filter(row => slug(row.name) === name);
  if (sameName.length === 1) return name;
  const categoryName = `${name}-${slug(item.category)}`;
  if (sameName.filter(row => slug(row.category) === slug(item.category)).length === 1) return categoryName;
  return `${categoryName}-${item.id.slice(0, 8).toLowerCase()}`;
}

export function inventorySupplyForPath(segment: string, supplies: InventoryItem[], stock: InventoryItem[]): InventoryItem | undefined {
  const supply = supplies.find(item => item.id === segment || inventoryPathSegment(item, supplies) === segment);
  if (supply) return supply;
  const legacyStock = stock.find(item => item.id === segment || inventoryPathSegment(item, stock) === segment);
  return supplies.find(item => item.id === legacyStock?.supply_id);
}
