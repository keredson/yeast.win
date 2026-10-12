import type { Equipment } from './db.ts';
import { recordSlug } from './recordSlug.ts';

export function equipmentPathSegment(item: Equipment, items: Equipment[]): string {
  const name = recordSlug(item.name);
  return items.filter(row => recordSlug(row.name) === name).length === 1
    ? name : `${name}-${item.id.toLowerCase()}`;
}

export function equipmentItemForPath(segment: string, items: Equipment[]): Equipment | undefined {
  return items.find(item => item.id === segment) || items.find(item => equipmentPathSegment(item, items) === segment);
}
