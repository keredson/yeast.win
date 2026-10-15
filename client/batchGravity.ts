import { convertUnit } from '../shared/units.ts';
import type { BatchGravityReadings } from './recipeCalculations.ts';
import type { GravityRole } from './db.ts';

export interface RecordedGravityRow { role: GravityRole | null; value: number; unit: string }

// Unassigned readings may be pre-boil or intermediate readings.
export function batchGravityReadings(rows: RecordedGravityRow[]): BatchGravityReadings {
  const readings: BatchGravityReadings = {};
  for (const row of rows) {
    const value = convertUnit(row.value, row.unit, 'SG');
    if (value == null || !Number.isFinite(value) || value <= 0.9 || value >= 2) continue;
    if (row.role === 'og') readings.original = value;
    else if (row.role === 'fg') readings.final = value;
  }
  return readings;
}
