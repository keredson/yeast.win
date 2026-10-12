export const equipmentKinds = [
  { value: 'electric_kettle', label: 'Electric kettle' },
  { value: 'all_in_one', label: 'All-in-one brewing system' },
  { value: 'controlled_fermenter', label: 'Temperature-controlled fermenter' },
  { value: 'fermentation_temperature_control', label: 'Fermentation temperature control' },
  { value: 'glycol_chiller', label: 'Glycol chiller' },
  { value: 'kettle', label: 'Kettle' },
  { value: 'mash_tun', label: 'Mash tun' },
  { value: 'fermenter', label: 'Fermenter' },
  { value: 'chiller', label: 'Wort chiller' },
  { value: 'refrigerator', label: 'Fermentation fridge or freezer' },
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

export const equipmentGroups = [
  { key: 'control', label: 'Control', kinds: ['electric_kettle', 'all_in_one', 'controlled_fermenter',
    'fermentation_temperature_control', 'chiller'] },
  { key: 'measurement', label: 'Measurement', kinds: ['hydrometer', 'thermometer', 'refractometer',
    'ph_meter', 'pressure_gauge', 'carbonation_meter', 'dissolved_oxygen_meter', 'scale'] },
  { key: 'passive', label: 'Passive vessels', kinds: ['kettle', 'mash_tun', 'fermenter'] }
] as const;

export function equipmentKindLabel(kind: string): string {
  return equipmentKinds.find(item => item.value === kind)?.label || kind;
}

export const capacityKinds = new Set<string>(['electric_kettle', 'all_in_one', 'controlled_fermenter',
  'kettle', 'mash_tun', 'fermenter', 'refrigerator']);

export const vesselKinds = new Set<string>(['electric_kettle', 'all_in_one', 'controlled_fermenter',
  'kettle', 'mash_tun', 'fermenter']);

export const boilOffKinds = new Set<string>(['electric_kettle', 'all_in_one']);

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
