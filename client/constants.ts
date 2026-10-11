export const planKinds = [
  { value: 'addition', label: 'Addition' },
  { value: 'measurement', label: 'Measurement' },
  { value: 'temperature_control', label: 'Temperature setting' },
  { value: 'pressure_control', label: 'Pressure setting' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'packaging', label: 'Packaging' },
  { value: 'boil_finished', label: 'Boil finished' },
  { value: 'note', label: 'Note or check' }
];

export function kindLabel(value: string): string {
  return planKinds.find(item => item.value === value)?.label || value.replaceAll('_', ' ');
}

export const measurementKinds = [
  { value: 'temperature', label: 'Temperature', unit: '°C' },
  { value: 'ph', label: 'pH', unit: 'pH' },
  { value: 'gravity', label: 'Gravity', unit: 'SG' },
  { value: 'volume', label: 'Volume', unit: 'L' },
  { value: 'pressure', label: 'Pressure', unit: 'kPa' },
  { value: 'carbonation', label: 'Carbonation', unit: 'vol CO₂' },
  { value: 'dissolved_oxygen', label: 'Dissolved oxygen', unit: 'mg/L' }
];
