export interface CatalogEquipment { id: string; name: string; kind: string; specification_json: string | null }
export interface CatalogInventory { id: string; name: string; category: string; unit: string }
export interface CatalogSnapshot { version: number; equipment: CatalogEquipment[]; inventory: CatalogInventory[] }

export const inventoryCategories = ['Grain', 'Hops', 'Yeast', 'Nutrient', 'Chemical', 'Packaging', 'Other'] as const;

export function unitForCategory(category: string, preferredMass: string): string {
  if (category === 'Yeast') return 'packet';
  if (category === 'Packaging') return 'each';
  if (category === 'Chemical') return 'ml';
  if (category === 'Other') return 'each';
  return preferredMass;
}

export const initialCatalogEquipment: CatalogEquipment[] = [
  { id: 'equipment_kettle', name: 'Brew kettle', kind: 'kettle', specification_json: null },
  { id: 'equipment_mash_tun', name: 'Mash tun', kind: 'mash_tun', specification_json: null },
  { id: 'equipment_fermenter', name: 'Fermenter', kind: 'fermenter', specification_json: null },
  { id: 'equipment_immersion_chiller', name: 'Immersion chiller', kind: 'chiller', specification_json: null },
  { id: 'equipment_hydrometer', name: 'Hydrometer', kind: 'hydrometer', specification_json: null },
  { id: 'equipment_thermometer', name: 'Thermometer', kind: 'thermometer', specification_json: null },
  { id: 'equipment_pressure_gauge', name: 'Pressure gauge', kind: 'pressure_gauge', specification_json: null },
  { id: 'equipment_refractometer', name: 'Refractometer', kind: 'refractometer', specification_json: null },
  { id: 'equipment_ph_meter', name: 'pH meter', kind: 'ph_meter', specification_json: null },
  { id: 'equipment_scale', name: 'Scale', kind: 'scale', specification_json: null }
];

export const initialCatalogInventory: CatalogInventory[] = [
  { id: 'inventory_maris_otter', name: 'Maris Otter malt', category: 'Grain', unit: 'g' },
  { id: 'inventory_pilsner_malt', name: 'Pilsner malt', category: 'Grain', unit: 'g' },
  { id: 'inventory_cascade_hops', name: 'Cascade hops', category: 'Hops', unit: 'g' },
  { id: 'inventory_citra_hops', name: 'Citra hops', category: 'Hops', unit: 'g' },
  { id: 'inventory_us05', name: 'SafAle US-05', category: 'Yeast', unit: 'packet' },
  { id: 'inventory_yeast_nutrient', name: 'Yeast nutrient', category: 'Nutrient', unit: 'g' },
  { id: 'inventory_starsan', name: 'Star San', category: 'Chemical', unit: 'ml' },
  { id: 'inventory_bottle_12oz', name: '12 oz bottle', category: 'Packaging', unit: 'each' },
  { id: 'inventory_crown_caps', name: 'Crown caps', category: 'Packaging', unit: 'each' }
];
