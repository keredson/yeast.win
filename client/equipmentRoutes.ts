import type { Equipment } from './db.ts';
import { recordSlug } from './recordSlug.ts';

// A workspace model describes a product; a unit is one physical piece of stock.
export function equipmentModelPathSegment(model: Equipment, models: Equipment[]): string {
  const slug = recordSlug(model.name);
  return models.filter(row => recordSlug(row.name) === slug).length === 1
    ? slug : `${slug}-${model.id.toLowerCase()}`;
}

export function equipmentUnitPathSegment(item: Equipment, items: Equipment[], models: Equipment[]): string {
  const model = models.find(row => row.id === item.model_id);
  if (!model) return item.id;
  const modelSegment = equipmentModelPathSegment(model, models);
  const stockId = item.stock_id?.trim();
  const unitSlug = stockId ? recordSlug(stockId) : `unit-${item.id.toLowerCase()}`;
  const siblings = items.filter(row => row.model_id === item.model_id);
  const unitSegment = siblings.filter(row => (row.stock_id?.trim()
    ? recordSlug(row.stock_id.trim()) : `unit-${row.id.toLowerCase()}`) === unitSlug).length === 1
    ? unitSlug : `${unitSlug}-${item.id.toLowerCase()}`;
  return `${modelSegment}/${unitSegment}`;
}

export function equipmentModelForPath(segment: string, models: Equipment[]): Equipment | undefined {
  return models.find(model => model.id === segment)
    || models.find(model => equipmentModelPathSegment(model, models) === segment);
}

export function equipmentUnitForPath(segment: string, items: Equipment[], models: Equipment[]): Equipment | undefined {
  const slash = segment.indexOf('/');
  if (slash >= 0) {
    const model = equipmentModelForPath(segment.slice(0, slash), models);
    if (!model) return undefined;
    const unitSegment = segment.slice(slash + 1);
    return items.find(item => item.model_id === model.id
      && equipmentUnitPathSegment(item, items, models).split('/')[1] === unitSegment);
  }
  // Old one-segment unit links remain aliases unless a model now owns that URL.
  return items.find(item => item.id === segment)
    || items.find(item => item.slug === segment)
    || items.find(item => {
      const name = recordSlug(item.name);
      return items.filter(row => recordSlug(row.name) === name).length === 1
        ? name === segment : `${name}-${item.id.toLowerCase()}` === segment;
    });
}
