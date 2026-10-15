import { convertUnit } from '../shared/units.ts';

export interface MashGrain { quantity: number; unit: string; yieldPct: number }

// Yield percentage describes extract potential relative to sucrose (46 point-gallons/lb).
export function mashEfficiencyPct(grains: MashGrain[], volume: number, volumeUnit: string,
  gravity: number, gravityScale: string): number | null {
  const gallons = convertUnit(volume, volumeUnit, 'US gal');
  const sg = convertUnit(gravity, gravityScale, 'SG');
  if (gallons == null || gallons <= 0 || sg == null || sg < 1) return null;
  let potential = 0;
  for (const grain of grains) {
    const pounds = convertUnit(grain.quantity, grain.unit, 'lb');
    if (pounds == null || pounds <= 0 || !Number.isFinite(grain.yieldPct)
      || grain.yieldPct <= 0 || grain.yieldPct > 100) return null;
    potential += pounds * 46 * grain.yieldPct / 100;
  }
  if (potential <= 0) return null;
  const efficiency = (sg - 1) * 1000 * gallons / potential * 100;
  return efficiency >= 0 && efficiency <= 105 ? Number(efficiency.toFixed(2)) : null;
}
