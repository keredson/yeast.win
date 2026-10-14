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
  hop_form?: string | null; attenuation_pct?: number | null; grain_class?: string | null;
  manufacturer?: string | null; product_url?: string | null;
  image_src?: string | null }

export interface CatalogChanges { serverCursor: string; changes: WireChange[] }
export const catalogSchemaVersion = 29;
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
    supply_id TEXT PRIMARY KEY NOT NULL, attenuation_pct REAL)`,
  supply_grain_classes: `CREATE TABLE IF NOT EXISTS supply_grain_classes (
    supply_id TEXT PRIMARY KEY NOT NULL, grain_class TEXT)`,
  supply_products: `CREATE TABLE IF NOT EXISTS supply_products (
    supply_id TEXT PRIMARY KEY NOT NULL, manufacturer TEXT, product_url TEXT)`,
  supply_images: `CREATE TABLE IF NOT EXISTS supply_images (
    supply_id TEXT PRIMARY KEY NOT NULL, image_bytes BLOB, image_mime_type TEXT)`
} as const;
export const catalogTables = [...Object.keys(catalogModelTables), ...Object.keys(catalogSupplyTables)] as const;

export const inventoryCategories = ['Grain', 'Hops', 'Yeast', 'Nutrient', 'Adjunct', 'Chemical', 'Packaging', 'Other'] as const;

export function unitForCategory(category: string, preferredMass: string): string {
  if (category === 'Grain') return 'lb + oz';
  if (category === 'Yeast') return 'packet';
  if (category === 'Packaging') return 'each';
  if (category === 'Chemical') return 'mL';
  if (category === 'Other') return 'each';
  return preferredMass;
}
