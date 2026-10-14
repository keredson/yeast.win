import { convertUnit } from '../shared/units.ts';
import type { BatchGravityReadings } from './recipeCalculations.ts';

export interface RecordedGravityRow { title: string; value: number; unit: string }

// Gravity readings without an OG or FG role may be pre-boil or intermediate readings.
export function batchGravityReadings(rows: RecordedGravityRow[]): BatchGravityReadings {
  const readings: BatchGravityReadings = {};
  for (const row of rows) {
    const value = convertUnit(row.value, row.unit, 'SG');
    if (value == null || !Number.isFinite(value) || value <= 0.9 || value >= 2) continue;
    if (/\b(original|og)\b/i.test(row.title)) readings.original = value;
    else if (/\b(final|fg)\b/i.test(row.title)) readings.final = value;
  }
  return readings;
}
