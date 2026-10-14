import type { WireChange } from './schema.ts';

export interface MeasurementChannel { id: string; measurement_kind: string;
  measurement_min?: number | null; measurement_max?: number | null;
  measurement_unit?: string | null; measurement_scale?: string | null }
export interface CatalogMeasurementChannel extends MeasurementChannel { model_id: string }
export interface CatalogEquipment { id: string; name: string; kind: string; manufacturer?: string | null;
  product_url?: string | null; manufacturer_website_url?: string | null;
  image_src?: string; thumbnail_src?: string; manufacturer_logo_src?: string;
  has_liquid_containment?: boolean; has_pressure_rating?: boolean;
  has_heating?: boolean; has_cooling?: boolean; has_temperature_control?: boolean;
  capacity_liters?: number | null; built_in_temperature_control?: number | boolean | null; max_pressure_kpa?: number | null;
  rated_power_watts?: number | null; rated_heat_removal_watts?: number | null;
  boil_heat_loss_watts?: number | null;
  min_temperature_c?: number | null; max_temperature_c?: number | null;
  measurement_min?: number | null; measurement_max?: number | null;
  measurement_unit?: string | null; measurement_channels?: CatalogMeasurementChannel[] }
export interface CatalogInventory { id: string; name: string; category: string; unit: string;
  yield_pct?: number | null; color_lovibond?: number | null; alpha_acid_pct?: number | null;
  hop_form?: string | null; attenuation_pct?: number | null }

export interface CatalogChanges { serverCursor: string; changes: WireChange[] }
export const catalogSchemaVersion = 18;
export const vevorModelName = 'VEVOR Electric Brewing System 9.2 Gal/35 L';
export const catalogModelTables = {
  manufacturers: `CREATE TABLE IF NOT EXISTS manufacturers (
    name TEXT PRIMARY KEY NOT NULL, website_url TEXT)`,
  equipment_models: `CREATE TABLE IF NOT EXISTS equipment_models (
    id TEXT PRIMARY KEY NOT NULL, manufacturer TEXT, model_name TEXT, kind TEXT,
    product_url TEXT)`,
  model_images: `CREATE TABLE IF NOT EXISTS model_images (
    model_id TEXT PRIMARY KEY NOT NULL, image_bytes BLOB, image_mime_type TEXT,
    thumbnail_bytes BLOB, thumbnail_mime_type TEXT)`,
  manufacturer_logos: `CREATE TABLE IF NOT EXISTS manufacturer_logos (
    manufacturer_name TEXT PRIMARY KEY NOT NULL, image_bytes BLOB, mime_type TEXT)`,
  model_liquid_containment: `CREATE TABLE IF NOT EXISTS model_liquid_containment (
    model_id TEXT PRIMARY KEY NOT NULL, capacity_liters REAL)`,
  model_pressure_rating: `CREATE TABLE IF NOT EXISTS model_pressure_rating (
    model_id TEXT PRIMARY KEY NOT NULL, max_pressure_kpa REAL)`,
  model_heating: `CREATE TABLE IF NOT EXISTS model_heating (
    model_id TEXT PRIMARY KEY NOT NULL, rated_power_watts REAL)`,
  model_boil_characterization: `CREATE TABLE IF NOT EXISTS model_boil_characterization (
    model_id TEXT PRIMARY KEY NOT NULL, heat_loss_watts REAL)`,
  model_cooling: `CREATE TABLE IF NOT EXISTS model_cooling (
    model_id TEXT PRIMARY KEY NOT NULL, rated_heat_removal_watts REAL)`,
  model_temperature_control: `CREATE TABLE IF NOT EXISTS model_temperature_control (
    model_id TEXT PRIMARY KEY NOT NULL, min_temperature_c REAL, max_temperature_c REAL)`,
  model_measurement_channels: `CREATE TABLE IF NOT EXISTS model_measurement_channels (
    id TEXT PRIMARY KEY NOT NULL, model_id TEXT, measurement_kind TEXT,
    measurement_min REAL, measurement_max REAL, measurement_unit TEXT, measurement_scale TEXT)`
} as const;
export const catalogSupplyTables = {
  supplies: `CREATE TABLE IF NOT EXISTS supplies (
    id TEXT PRIMARY KEY NOT NULL, name TEXT, category TEXT, unit TEXT)`,
  supply_grain_specs: `CREATE TABLE IF NOT EXISTS supply_grain_specs (
    supply_id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL)`,
  supply_hop_specs: `CREATE TABLE IF NOT EXISTS supply_hop_specs (
    supply_id TEXT PRIMARY KEY NOT NULL, alpha_acid_pct REAL, hop_form TEXT)`,
  supply_yeast_specs: `CREATE TABLE IF NOT EXISTS supply_yeast_specs (
    supply_id TEXT PRIMARY KEY NOT NULL, attenuation_pct REAL)`
} as const;
export const catalogTables = [...Object.keys(catalogModelTables), ...Object.keys(catalogSupplyTables)] as const;

export const inventoryCategories = ['Grain', 'Hops', 'Yeast', 'Nutrient', 'Adjunct', 'Chemical', 'Packaging', 'Other'] as const;

export const antonPaarEquipment: CatalogEquipment[] = [
  { id: 'equipment_anton_paar_easydens', name: 'Anton Paar EasyDens', kind: 'hydrometer',
    measurement_min: 0.7, measurement_max: 1.2, measurement_unit: 'SG' },
  { id: 'equipment_anton_paar_smartref', name: 'Anton Paar SmartRef', kind: 'refractometer',
    measurement_min: 0, measurement_max: 85, measurement_unit: '°Brix' },
  { id: 'equipment_anton_paar_dma_35', name: 'Anton Paar DMA 35', kind: 'hydrometer' },
  { id: 'equipment_anton_paar_carboqc', name: 'Anton Paar CarboQC', kind: 'carbonation_meter' },
  { id: 'equipment_anton_paar_cboxqc', name: 'Anton Paar CboxQC', kind: 'carbonation_meter',
    measurement_channels: [{ id: 'equipment_anton_paar_cboxqc:dissolved_oxygen',
      model_id: 'equipment_anton_paar_cboxqc', measurement_kind: 'dissolved_oxygen', measurement_unit: 'mg/L' }] },
  { id: 'equipment_anton_paar_oxyqc', name: 'Anton Paar OxyQC', kind: 'dissolved_oxygen_meter',
    measurement_min: 0, measurement_max: 4, measurement_unit: 'ppm' },
  { id: 'equipment_anton_paar_oxyqc_wide_range', name: 'Anton Paar OxyQC Wide Range', kind: 'dissolved_oxygen_meter',
    measurement_min: 0.015, measurement_max: 45, measurement_unit: 'ppm' }
];

export function unitForCategory(category: string, preferredMass: string): string {
  if (category === 'Grain') return 'lb + oz';
  if (category === 'Yeast') return 'packet';
  if (category === 'Packaging') return 'each';
  if (category === 'Chemical') return 'mL';
  if (category === 'Other') return 'each';
  return preferredMass;
}

export const initialCatalogEquipment: CatalogEquipment[] = [
  // Models are named from manufacturer product pages; popularity is informed by MoreBeer's best-sellers list.
  { id: 'equipment_digiboil_35l', name: 'KegLand DigiBoil 35L', kind: 'electric_kettle', capacity_liters: 35 },
  { id: 'equipment_digiboil_65l', name: 'KegLand DigiBoil 65L', kind: 'electric_kettle', capacity_liters: 65 },
  { id: 'equipment_brewzilla_35l_g4', name: 'KegLand BrewZilla Gen 4.1 35L', kind: 'all_in_one', capacity_liters: 35 },
  { id: 'equipment_brewzilla_65l_g4', name: 'KegLand BrewZilla Gen 4 65L', kind: 'all_in_one', capacity_liters: 65 },
  { id: 'equipment_grainfather_g30', name: 'Grainfather G30', kind: 'all_in_one' },
  { id: 'equipment_grainfather_g40', name: 'Grainfather G40', kind: 'all_in_one' },
  { id: 'equipment_anvil_foundry_10_5', name: 'Anvil Foundry 10.5 gal', kind: 'all_in_one' },
  { id: 'equipment_grainfather_gf30', name: 'Grainfather GF30 Conical Fermenter', kind: 'fermenter', built_in_temperature_control: true },
  { id: 'equipment_fermzilla_all_rounder_30l', name: 'KegLand FermZilla All Rounder 30 L', kind: 'fermenter', capacity_liters: 30, max_pressure_kpa: 241.316505 },
  { id: 'equipment_rapt_chamber', name: 'KegLand RAPT Fermentation Chamber', kind: 'fermentation_temperature_control' },
  { id: 'equipment_inkbird_itc_308', name: 'Inkbird ITC-308', kind: 'fermentation_temperature_control' },
  { id: 'equipment_rapt_controller', name: 'KegLand RAPT Temperature Controller', kind: 'fermentation_temperature_control' },
  { id: 'equipment_grainfather_gc4', name: 'Grainfather GC4 Glycol Chiller', kind: 'fermentation_temperature_control' },
  { id: 'equipment_rapt_glycol', name: 'KegLand RAPT Glycol Chiller', kind: 'fermentation_temperature_control' },
  { id: 'equipment_tilt', name: 'Tilt Hydrometer and Thermometer', kind: 'hydrometer' },
  { id: 'equipment_rapt_pill', name: 'KegLand RAPT Pill Hydrometer and Thermometer', kind: 'hydrometer' },
  { id: 'equipment_thermapen_one', name: 'ThermoWorks Thermapen ONE', kind: 'thermometer' },
  { id: 'equipment_apera_ph60', name: 'Apera PH60 pH Tester', kind: 'ph_meter' },
  { id: 'equipment_escali_primo', name: 'Escali Primo Digital Scale', kind: 'scale' },
  { id: 'equipment_kettle', name: 'Brew kettle', kind: 'kettle' },
  { id: 'equipment_mash_tun', name: 'Mash tun', kind: 'mash_tun' },
  { id: 'equipment_fermenter', name: 'Fermenter', kind: 'fermenter' },
  { id: 'equipment_keg', name: 'Keg', kind: 'keg' },
  { id: 'equipment_immersion_chiller', name: 'Immersion chiller', kind: 'chiller' },
  { id: 'equipment_hydrometer', name: 'Hydrometer', kind: 'hydrometer' },
  { id: 'equipment_thermometer', name: 'Thermometer', kind: 'thermometer' },
  { id: 'equipment_pressure_gauge', name: 'Pressure gauge', kind: 'pressure_gauge' },
  { id: 'equipment_refractometer', name: 'Refractometer', kind: 'refractometer' },
  { id: 'equipment_ph_meter', name: 'pH meter', kind: 'ph_meter' },
  { id: 'equipment_scale', name: 'Scale', kind: 'scale' },
  { id: 'equipment_vevor_35l', name: vevorModelName, kind: 'all_in_one', capacity_liters: 35 },
  { id: 'equipment_biab_kettle', name: 'Brew in a bag kettle', kind: 'kettle' },
  { id: 'equipment_conical_fermenter', name: 'Conical fermenter', kind: 'fermenter' },
  { id: 'equipment_carboy', name: 'Glass carboy', kind: 'fermenter' },
  { id: 'equipment_bucket', name: 'Fermentation bucket', kind: 'fermenter' },
  { id: 'equipment_plate_chiller', name: 'Plate chiller', kind: 'chiller' },
  { id: 'equipment_counterflow_chiller', name: 'Counterflow chiller', kind: 'chiller' },
  { id: 'equipment_fermentation_fridge', name: 'Fermentation fridge', kind: 'fermentation_temperature_control' },
  { id: 'equipment_temperature_controller', name: 'Temperature controller', kind: 'fermentation_temperature_control' },
  { id: 'equipment_wort_pump', name: 'Wort pump', kind: 'pump' },
  { id: 'equipment_co2_meter', name: 'CO₂ meter', kind: 'carbonation_meter' },
  { id: 'equipment_do_meter', name: 'Dissolved oxygen meter', kind: 'dissolved_oxygen_meter' },
  ...antonPaarEquipment
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
