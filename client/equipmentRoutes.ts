import type { Equipment } from './db.ts';
import { recordSlug } from './recordSlug.ts';

export function equipmentPathSegment(item: Equipment, items: Equipment[]): string {
  const name = equipmentSlug(item);
  return items.filter(row => equipmentSlug(row) === name).length === 1
    ? name : `${name}-${item.id.toLowerCase()}`;
}

export function equipmentSlug(item: Equipment): string {
  return item.slug || recordSlug(item.name);
}

export function equipmentItemForPath(segment: string, items: Equipment[]): Equipment | undefined {
  return items.find(item => item.id === segment) || items.find(item => equipmentPathSegment(item, items) === segment);
}
