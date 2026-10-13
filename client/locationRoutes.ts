import type { InventoryLocation } from './db.ts';

export function locationForPath(segment: string, locations: InventoryLocation[]): InventoryLocation | undefined {
  return locations.find(location => location.slug === segment || location.id === segment);
}

export function locationAncestors(location: InventoryLocation, locations: InventoryLocation[]): InventoryLocation[] {
  const byId = new Map(locations.map(row => [row.id, row]));
  const path: InventoryLocation[] = [];
  const seen = new Set<string>([location.id]);
  let parentId = location.parent_id;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    path.unshift(parent);
    parentId = parent.parent_id;
  }
  return path;
}

export function locationDescendantIds(id: string, locations: InventoryLocation[]): Set<string> {
  const ids = new Set([id]);
  let added = true;
  while (added) {
    added = false;
    for (const location of locations) {
      if (location.parent_id && ids.has(location.parent_id) && !ids.has(location.id)) {
        ids.add(location.id);
        added = true;
      }
    }
  }
  return ids;
}
