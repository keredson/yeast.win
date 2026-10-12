export interface PreferredUnits {
  temperature: '°C' | '°F';
  volume: 'L' | 'US gal';
  mass: 'g' | 'oz' | 'lb + oz';
  pressure: 'kPa' | 'psi';
}

export const defaultPreferredUnits: PreferredUnits = {
  temperature: '°C', volume: 'L', mass: 'g', pressure: 'kPa'
};

export const unitGroups = {
  temperature: ['°C', '°F'],
  volume: ['mL', 'L', 'US fl oz', 'US gal'],
  mass: ['g', 'kg', 'oz', 'lb'],
  pressure: ['kPa', 'psi'],
  count: ['each', 'packet', 'vial', 'can', 'bottle'],
  carbonation: ['vol CO₂', 'g/L'],
  dissolved_oxygen: ['mg/L', 'ppm']
} as const;

// Specific gravity is a density ratio, so these are gravity scales rather than units.
export const gravityScales = ['SG', '°Brix', '°Plato'] as const;

export const compoundMassUnit = 'lb + oz' as const;
export const massInputUnits = [...unitGroups.mass, compoundMassUnit];
export const quantityUnits = [...massInputUnits, ...unitGroups.volume, ...unitGroups.count];

export function quantityUnitsForCategory(category: string): readonly string[] {
  if (category === 'Grain' || category === 'Hops') return massInputUnits;
  if (category === 'Nutrient' || category === 'Chemical' || category === 'Adjunct') return [...massInputUnits, ...unitGroups.volume];
  if (category === 'Yeast') return [...unitGroups.count, ...massInputUnits, ...unitGroups.volume];
  if (category === 'Packaging') return unitGroups.count;
  return quantityUnits;
}

export function storageUnit(unit: string): string { return unit === compoundMassUnit ? 'oz' : unit; }

export function quantityForStorage(unit: string, quantity: number | null | undefined,
  pounds?: number | null, ounces?: number | null): { quantity: number; unit: string } | null {
  if (unit === compoundMassUnit) {
    if (pounds == null && ounces == null) return null;
    const lbs = pounds ?? 0;
    const oz = ounces ?? 0;
    if (!Number.isInteger(lbs) || lbs < 0 || !Number.isFinite(oz) || oz < 0 || oz >= 16) {
      throw new Error('Enter whole pounds and ounces from 0 to less than 16');
    }
    return { quantity: lbs * 16 + oz, unit: 'oz' };
  }
  if (quantity == null) return null;
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Enter a valid quantity');
  return { quantity, unit };
}

export function splitOunces(total: number): { pounds: number; ounces: number } {
  const pounds = Math.floor(total / 16);
  return { pounds, ounces: Math.round((total - pounds * 16) * 1000) / 1000 };
}

export function formatQuantity(quantity: number, unit: string, displayUnit?: string): string {
  if (unit !== 'oz' || displayUnit !== compoundMassUnit) return `${quantity} ${unit}`;
  const { pounds, ounces } = splitOunces(quantity);
  return ounces === 0 ? `${pounds} lb` : pounds === 0 ? `${ounces} oz` : `${pounds} lb ${ounces} oz`;
}

const massInGrams: Record<string, number> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237, [compoundMassUnit]: 28.349523125 };
const volumeInLiters: Record<string, number> = { mL: 0.001, L: 1, 'US fl oz': 0.0295735295625, 'US gal': 3.785411784 };
const pressureInKpa: Record<string, number> = { kPa: 1, psi: 6.894757293168 };
const carbonDioxideInGramsPerLiter: Record<string, number> = { 'vol CO₂': 1.977, 'g/L': 1 };

function scaled(value: number, from: string, to: string, factors: Record<string, number>): number | null {
  return factors[from] && factors[to] ? value * factors[from] / factors[to] : null;
}

/** Returns null when units represent different physical quantities. */
export function convertUnit(value: number, from: string, to: string, delta = false): number | null {
  if (!Number.isFinite(value)) return null;
  if (from === to) return value;
  let result = scaled(value, from, to, massInGrams)
    ?? scaled(value, from, to, volumeInLiters)
    ?? scaled(value, from, to, pressureInKpa)
    ?? scaled(value, from, to, carbonDioxideInGramsPerLiter);
  if (result == null && (from === '°C' || from === '°F') && (to === '°C' || to === '°F')) {
    result = from === '°C' ? value * 9 / 5 + (delta ? 0 : 32) : (value - (delta ? 0 : 32)) * 5 / 9;
  }
  if (result == null && ['mg/L', 'ppm'].includes(from) && ['mg/L', 'ppm'].includes(to)) result = value;
  if (result == null && ['SG', '°Brix', '°Plato'].includes(from) && ['SG', '°Brix', '°Plato'].includes(to)) {
    // Standard wort approximation; a corrected refractometer reading needs its own calibration first.
    const sg = from === 'SG' ? value : 1 + value / (258.6 - value / 258.2 * 227.1);
    result = to === 'SG' ? sg : -616.868 + 1111.14 * sg - 630.272 * sg ** 2 + 135.997 * sg ** 3;
  }
  return result == null ? null : Number(result.toFixed(6));
}

export function unitOptions(units: readonly string[]) {
  return units.map(value => ({ value, label: value === 'SG' ? 'Specific gravity (unitless)' : value }));
}

export function validPreferredUnits(input: unknown): input is PreferredUnits {
  if (!input || typeof input !== 'object') return false;
  const units = input as Partial<PreferredUnits>;
  return (units.temperature === '°C' || units.temperature === '°F')
    && (units.volume === 'L' || units.volume === 'US gal')
    && (units.mass === 'g' || units.mass === 'oz' || units.mass === compoundMassUnit)
    && (units.pressure === 'kPa' || units.pressure === 'psi');
}
