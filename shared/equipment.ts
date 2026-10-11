export const equipmentKinds = [
  { value: 'kettle', label: 'Kettle' },
  { value: 'mash_tun', label: 'Mash tun' },
  { value: 'fermenter', label: 'Fermenter' },
  { value: 'chiller', label: 'Chiller' },
  { value: 'refrigerator', label: 'Refrigerator or freezer' },
  { value: 'temperature_controller', label: 'Temperature controller' },
  { value: 'pump', label: 'Pump' },
  { value: 'hydrometer', label: 'Hydrometer' },
  { value: 'thermometer', label: 'Thermometer' },
  { value: 'refractometer', label: 'Refractometer' },
  { value: 'ph_meter', label: 'pH meter' },
  { value: 'pressure_gauge', label: 'Pressure gauge' },
  { value: 'carbonation_meter', label: 'Carbonation meter' },
  { value: 'dissolved_oxygen_meter', label: 'Dissolved oxygen meter' },
  { value: 'scale', label: 'Scale' },
  { value: 'other', label: 'Other equipment' }
] as const;

export function equipmentKindLabel(kind: string): string {
  return equipmentKinds.find(item => item.value === kind)?.label || kind;
}

export const capacityKinds = new Set<string>(['kettle', 'mash_tun', 'fermenter', 'refrigerator']);

export const measurementRangeUnits: Record<string, readonly string[]> = {
  hydrometer: ['SG', '°Plato'],
  refractometer: ['°Brix', 'SG'],
  thermometer: ['°C', '°F'],
  ph_meter: ['pH'],
  pressure_gauge: ['kPa', 'psi'],
  carbonation_meter: ['vol CO₂', 'g/L'],
  dissolved_oxygen_meter: ['mg/L', 'ppm'],
  scale: ['g', 'kg', 'oz', 'lb']
};
