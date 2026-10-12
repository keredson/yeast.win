export interface CatalogEquipment { id: string; name: string; kind: string; specification_json: string | null }
export interface CatalogInventory { id: string; name: string; category: string; unit: string }
export interface CatalogSnapshot { version: number; equipment: CatalogEquipment[]; inventory: CatalogInventory[] }

export const inventoryCategories = ['Grain', 'Hops', 'Yeast', 'Nutrient', 'Adjunct', 'Chemical', 'Packaging', 'Other'] as const;

export function unitForCategory(category: string, preferredMass: string): string {
  if (category === 'Yeast') return 'packet';
  if (category === 'Packaging') return 'each';
  if (category === 'Chemical') return 'mL';
  if (category === 'Other') return 'each';
  return preferredMass;
}

export const initialCatalogEquipment: CatalogEquipment[] = [
  { id: 'equipment_kettle', name: 'Brew kettle', kind: 'kettle', specification_json: null },
  { id: 'equipment_mash_tun', name: 'Mash tun', kind: 'mash_tun', specification_json: null },
  { id: 'equipment_fermenter', name: 'Fermenter', kind: 'fermenter', specification_json: null },
  { id: 'equipment_keg', name: 'Keg', kind: 'keg', specification_json: null },
  { id: 'equipment_immersion_chiller', name: 'Immersion chiller', kind: 'chiller', specification_json: null },
  { id: 'equipment_hydrometer', name: 'Hydrometer', kind: 'hydrometer', specification_json: null },
  { id: 'equipment_thermometer', name: 'Thermometer', kind: 'thermometer', specification_json: null },
  { id: 'equipment_pressure_gauge', name: 'Pressure gauge', kind: 'pressure_gauge', specification_json: null },
  { id: 'equipment_refractometer', name: 'Refractometer', kind: 'refractometer', specification_json: null },
  { id: 'equipment_ph_meter', name: 'pH meter', kind: 'ph_meter', specification_json: null },
  { id: 'equipment_scale', name: 'Scale', kind: 'scale', specification_json: null },
  { id: 'equipment_vevor_35l', name: 'VEVOR Electric Brewing System 9.2 Gal/35 L Brewing Pot', kind: 'kettle', specification_json: '{"capacity_liters":35,"working_volume_liters":30}' },
  { id: 'equipment_biab_kettle', name: 'Brew in a bag kettle', kind: 'kettle', specification_json: null },
  { id: 'equipment_conical_fermenter', name: 'Conical fermenter', kind: 'fermenter', specification_json: null },
  { id: 'equipment_carboy', name: 'Glass carboy', kind: 'fermenter', specification_json: null },
  { id: 'equipment_bucket', name: 'Fermentation bucket', kind: 'fermenter', specification_json: null },
  { id: 'equipment_plate_chiller', name: 'Plate chiller', kind: 'chiller', specification_json: null },
  { id: 'equipment_counterflow_chiller', name: 'Counterflow chiller', kind: 'chiller', specification_json: null },
  { id: 'equipment_fermentation_fridge', name: 'Fermentation fridge', kind: 'refrigerator', specification_json: null },
  { id: 'equipment_temperature_controller', name: 'Temperature controller', kind: 'temperature_controller', specification_json: null },
  { id: 'equipment_wort_pump', name: 'Wort pump', kind: 'pump', specification_json: null },
  { id: 'equipment_co2_meter', name: 'CO₂ meter', kind: 'carbonation_meter', specification_json: null },
  { id: 'equipment_do_meter', name: 'Dissolved oxygen meter', kind: 'dissolved_oxygen_meter', specification_json: null }
];

export const initialCatalogInventory: CatalogInventory[] = [
  { id: 'inventory_maris_otter', name: 'Maris Otter malt', category: 'Grain', unit: 'g' },
  { id: 'inventory_pilsner_malt', name: 'Pilsner malt', category: 'Grain', unit: 'g' },
  { id: 'inventory_cascade_hops', name: 'Cascade hops', category: 'Hops', unit: 'g' },
  { id: 'inventory_citra_hops', name: 'Citra hops', category: 'Hops', unit: 'g' },
  { id: 'inventory_us05', name: 'SafAle US-05', category: 'Yeast', unit: 'packet' },
  { id: 'inventory_yeast_nutrient', name: 'Yeast nutrient', category: 'Nutrient', unit: 'g' },
  { id: 'inventory_starsan', name: 'Star San', category: 'Chemical', unit: 'mL' },
  { id: 'inventory_bottle_12oz', name: '12 oz bottle', category: 'Packaging', unit: 'each' },
  { id: 'inventory_crown_caps', name: 'Crown caps', category: 'Packaging', unit: 'each' },
  { id: 'inventory_two_row', name: '2-row pale malt', category: 'Grain', unit: 'g' },
  { id: 'inventory_wheat_malt', name: 'Wheat malt', category: 'Grain', unit: 'g' },
  { id: 'inventory_munich_malt', name: 'Munich malt', category: 'Grain', unit: 'g' },
  { id: 'inventory_crystal_60', name: 'Crystal 60 malt', category: 'Grain', unit: 'g' },
  { id: 'inventory_roasted_barley', name: 'Roasted barley', category: 'Grain', unit: 'g' },
  { id: 'inventory_centennial', name: 'Centennial hops', category: 'Hops', unit: 'g' },
  { id: 'inventory_saaz', name: 'Saaz hops', category: 'Hops', unit: 'g' },
  { id: 'inventory_mosaic', name: 'Mosaic hops', category: 'Hops', unit: 'g' },
  { id: 'inventory_s04', name: 'SafAle S-04', category: 'Yeast', unit: 'packet' },
  { id: 'inventory_w34_70', name: 'SafLager W-34/70', category: 'Yeast', unit: 'packet' },
  { id: 'inventory_dap', name: 'Diammonium phosphate', category: 'Nutrient', unit: 'g' },
  { id: 'inventory_yeast_energizer', name: 'Yeast energizer', category: 'Nutrient', unit: 'g' },
  { id: 'inventory_pbw', name: 'PBW cleaner', category: 'Chemical', unit: 'g' },
  { id: 'inventory_lactic_acid', name: 'Lactic acid', category: 'Adjunct', unit: 'mL' },
  { id: 'inventory_bottle_22oz', name: '22 oz bottle', category: 'Packaging', unit: 'each' },
  { id: 'inventory_bottle_500ml', name: '500 mL bottle', category: 'Packaging', unit: 'each' },
  { id: 'inventory_keg_5gal', name: '5 US gal keg', category: 'Packaging', unit: 'each' },
  { id: 'inventory_bottle_caps', name: 'Swing top bottle gaskets', category: 'Packaging', unit: 'each' },
  { id: 'inventory_priming_sugar', name: 'Priming sugar', category: 'Other', unit: 'g' }
];
