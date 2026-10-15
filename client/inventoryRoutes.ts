import type { InventoryRecord } from './db.ts';
import { recordSlug as slug } from './recordSlug.ts';
import { uniqueRouteSegments } from './uniqueRouteSegments.ts';

export function inventoryPathSegment(item: InventoryRecord, items: InventoryRecord[]): string {
  return uniqueRouteSegments(items, row => {
    const name = slug(row.name);
    const sameName = items.filter(other => slug(other.name) === name);
    if (sameName.length === 1) return name;
    const categoryName = `${name}-${slug(row.category)}`;
    if (sameName.filter(other => slug(other.category) === slug(row.category)).length === 1) return categoryName;
    return `${categoryName}-${row.id.slice(0, 8).toLowerCase()}`;
  }, true).get(item.id) || item.id;
}

export function inventorySupplyForPath(segment: string, supplies: InventoryRecord[], stock: InventoryRecord[]): InventoryRecord | undefined {
  const supply = supplies.find(item => item.id === segment || inventoryPathSegment(item, supplies) === segment);
  if (supply) return supply;
  const legacyStock = stock.find(item => item.id === segment || inventoryPathSegment(item, stock) === segment);
  return supplies.find(item => item.id === legacyStock?.supply_id);
}
