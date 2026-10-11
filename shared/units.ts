export interface PreferredUnits {
  temperature: '°C' | '°F';
  volume: 'L' | 'US gal';
  mass: 'g' | 'oz';
  pressure: 'kPa' | 'psi';
}

export const defaultPreferredUnits: PreferredUnits = {
  temperature: '°C', volume: 'L', mass: 'g', pressure: 'kPa'
};

export function validPreferredUnits(input: unknown): input is PreferredUnits {
  if (!input || typeof input !== 'object') return false;
  const units = input as Partial<PreferredUnits>;
  return (units.temperature === '°C' || units.temperature === '°F')
    && (units.volume === 'L' || units.volume === 'US gal')
    && (units.mass === 'g' || units.mass === 'oz')
    && (units.pressure === 'kPa' || units.pressure === 'psi');
}
