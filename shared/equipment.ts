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
