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

export function inventoryItemForPath(segment: string, items: InventoryItem[]): InventoryItem | undefined {
  return items.find(item => item.id === segment) || items.find(item => inventoryPathSegment(item, items) === segment);
}
