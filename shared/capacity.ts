export const capacityUnits = [
  { value: 'L', label: 'L' },
  { value: 'mL', label: 'mL' },
  { value: 'US gal', label: 'US gal' },
  { value: 'US fl oz', label: 'US fl oz' }
] as const;

const litersPerUnit: Record<string, number> = {
  L: 1, mL: 0.001, 'US gal': 3.785411784, 'US fl oz': 0.0295735295625
};

export function capacityInLiters(value: number | undefined, unit: string | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value <= 0 || !unit || !litersPerUnit[unit]) throw new Error('Enter a positive capacity and unit');
  return value * litersPerUnit[unit];
}

export function capacityLabel(liters: number | null | undefined): string {
  return liters == null ? '' : `${Number(liters.toFixed(3))} L`;
}
