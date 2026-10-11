export interface PreferredUnits {
  temperature: '°C' | '°F';
  volume: 'L' | 'US gal';
  mass: 'g' | 'oz';
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

export const quantityUnits = [...unitGroups.mass, ...unitGroups.volume, ...unitGroups.count];

export function unitOptions(units: readonly string[]) {
  return units.map(value => ({ value, label: value }));
}

export function validPreferredUnits(input: unknown): input is PreferredUnits {
  if (!input || typeof input !== 'object') return false;
  const units = input as Partial<PreferredUnits>;
  return (units.temperature === '°C' || units.temperature === '°F')
    && (units.volume === 'L' || units.volume === 'US gal')
    && (units.mass === 'g' || units.mass === 'oz')
    && (units.pressure === 'kPa' || units.pressure === 'psi');
}
