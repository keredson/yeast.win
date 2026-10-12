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
  gravity: ['SG', '°Brix', '°Plato'],
  carbonation: ['vol CO₂', 'g/L'],
  dissolved_oxygen: ['mg/L', 'ppm']
} as const;

export const compoundMassUnit = 'lb + oz' as const;
export const massInputUnits = [...unitGroups.mass, compoundMassUnit];
export const quantityUnits = [...massInputUnits, ...unitGroups.volume, ...unitGroups.count];

export function quantityUnitsForCategory(category: string): readonly string[] {
  if (category === 'Grain' || category === 'Hops') return massInputUnits;
  if (category === 'Nutrient' || category === 'Chemical') return [...massInputUnits, ...unitGroups.volume];
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
  return `${pounds} lb ${ounces} oz`;
}

export function unitOptions(units: readonly string[]) {
  return units.map(value => ({ value, label: value }));
}

export function validPreferredUnits(input: unknown): input is PreferredUnits {
  if (!input || typeof input !== 'object') return false;
  const units = input as Partial<PreferredUnits>;
  return (units.temperature === '°C' || units.temperature === '°F')
    && (units.volume === 'L' || units.volume === 'US gal')
    && (units.mass === 'g' || units.mass === 'oz' || units.mass === compoundMassUnit)
    && (units.pressure === 'kPa' || units.pressure === 'psi');
}
