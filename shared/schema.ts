// All replicated tables use a single, immutable text primary key. CR-SQLite
// requires the same CRR schema on both peers before changes are exchanged.
const definitions: Record<string, string> = {
  products: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, catalog_product_id TEXT, created_at INTEGER NOT NULL`,
  batches: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`,
  batch_origins: `id TEXT PRIMARY KEY NOT NULL, source_batch_id TEXT NOT NULL`,
  recipes: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`,
  recipe_slugs: `id TEXT PRIMARY KEY NOT NULL, slug TEXT NOT NULL`,
  recipe_types: `id TEXT PRIMARY KEY NOT NULL, recipe_type TEXT NOT NULL`,
  recipe_events: `id TEXT PRIMARY KEY NOT NULL, recipe_id TEXT NOT NULL, event_type TEXT NOT NULL, title TEXT NOT NULL, planned_at INTEGER, anchor_event_id TEXT, offset_seconds INTEGER, anchor_point TEXT, duration_seconds INTEGER, instructions TEXT, sort_order INTEGER NOT NULL`,
  recipe_additions: `event_id TEXT PRIMARY KEY NOT NULL, item_category TEXT, item_name TEXT, catalog_item_id TEXT, stock_bucket_id TEXT, supply_id TEXT, quantity REAL, unit TEXT, display_unit TEXT`,
  recipe_temperature_control_events: `event_id TEXT PRIMARY KEY NOT NULL, phase TEXT, mode TEXT, target_value REAL, target_unit TEXT, equipment_id TEXT`,
  recipe_pressure_control_events: `event_id TEXT PRIMARY KEY NOT NULL, target_value REAL, target_unit TEXT, equipment_id TEXT`,
  recipe_measurement_targets: `event_id TEXT PRIMARY KEY NOT NULL, measurement_kind TEXT, target_value REAL, target_unit TEXT`,
  recipe_gravity_roles: `id TEXT PRIMARY KEY NOT NULL, recipe_id TEXT NOT NULL, role TEXT NOT NULL, event_id TEXT NOT NULL`,
  recipe_transfers: `event_id TEXT PRIMARY KEY NOT NULL, purpose TEXT, mash_equipment_id TEXT, to_vessel_id TEXT, to_vessel_name TEXT, quantity REAL, unit TEXT`,
  recipe_transfer_equipment: `id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, equipment_id TEXT NOT NULL`,
  recipe_packaging: `event_id TEXT PRIMARY KEY NOT NULL, container_name TEXT, container_size REAL, container_count INTEGER, container_unit TEXT, catalog_item_id TEXT, supply_id TEXT`,
  recipe_import_sources: `id TEXT PRIMARY KEY NOT NULL, filename TEXT NOT NULL, format TEXT NOT NULL, sha256 TEXT NOT NULL, byte_count INTEGER NOT NULL, content BLOB NOT NULL, imported_at INTEGER NOT NULL`,
  recipe_import_links: `id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, source_index INTEGER NOT NULL, external_id TEXT`,
  recipe_inputs: `id TEXT PRIMARY KEY NOT NULL, target_fermenter_volume_liters REAL, brewhouse_efficiency_pct REAL, wort_loss_liters REAL, batch_size_source TEXT`,
  recipe_event_inputs: `id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL, alpha_acid_pct REAL, hop_form TEXT, attenuation_pct REAL, grain_class TEXT`,
  batch_events: `id TEXT PRIMARY KEY NOT NULL, batch_id TEXT NOT NULL, recipe_event_id TEXT, event_type TEXT NOT NULL, title TEXT, planned_at INTEGER, anchor_event_id TEXT, offset_seconds INTEGER, anchor_point TEXT, duration_seconds INTEGER, instructions TEXT, actual_at INTEGER, skipped_at INTEGER, note TEXT, created_at INTEGER NOT NULL, created_by_account_id TEXT, recorded_by_account_id TEXT, source_id TEXT, external_id TEXT, received_at INTEGER`,
  batch_recipe_inputs: `id TEXT PRIMARY KEY NOT NULL, target_fermenter_volume_liters REAL, brewhouse_efficiency_pct REAL, wort_loss_liters REAL`,
  batch_event_inputs: `id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL, alpha_acid_pct REAL, hop_form TEXT, attenuation_pct REAL, grain_class TEXT, mash_efficiency_pct REAL, grain_absorption_l_per_kg REAL`,
  event_ends: `id TEXT PRIMARY KEY NOT NULL, ended_at INTEGER NOT NULL`,
  additions: `event_id TEXT PRIMARY KEY NOT NULL, item_category TEXT, catalog_item_id TEXT, stock_bucket_id TEXT, supply_id TEXT, item_name TEXT, quantity REAL, unit TEXT, display_unit TEXT, lot TEXT`,
  batch_measurement_targets: `event_id TEXT PRIMARY KEY NOT NULL, measurement_kind TEXT, target_value REAL, target_unit TEXT`,
  temperature_measurements: measurementColumns(),
  ph_measurements: measurementColumns(),
  gravity_measurements: measurementColumns(),
  batch_gravity_roles: `id TEXT PRIMARY KEY NOT NULL, batch_id TEXT NOT NULL, role TEXT NOT NULL, event_id TEXT NOT NULL`,
  volume_measurements: measurementColumns('location TEXT'),
  pressure_measurements: measurementColumns(),
  carbonation_measurements: measurementColumns(),
  dissolved_oxygen_measurements: measurementColumns(),
  temperature_control_events: `event_id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT, phase TEXT, mode TEXT, target_value REAL, target_unit TEXT, power_watts REAL, ended_at INTEGER`,
  pressure_control_events: `event_id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL, target_value REAL NOT NULL, target_unit TEXT NOT NULL`,
  transfers: `event_id TEXT PRIMARY KEY NOT NULL, purpose TEXT, mash_equipment_id TEXT, from_vessel_id TEXT, to_vessel_id TEXT, to_vessel_name TEXT, quantity REAL, unit TEXT`,
  transfer_equipment: `id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, equipment_id TEXT NOT NULL`,
  packaging: `event_id TEXT PRIMARY KEY NOT NULL, container_name TEXT, container_size REAL, container_unit TEXT, container_count INTEGER, stock_bucket_id TEXT, catalog_item_id TEXT, supply_id TEXT`,
  equipment_model_specs: `id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL,
    has_liquid_containment INTEGER, capacity_liters REAL,
    has_pressure_rating INTEGER, max_pressure_kpa REAL, has_heating INTEGER, rated_power_watts REAL,
    has_cooling INTEGER, rated_heat_removal_watts REAL, has_temperature_control INTEGER,
    min_temperature_c REAL, max_temperature_c REAL,
    mash_efficiency_pct REAL, grain_absorption_l_per_kg REAL, post_boil_loss_liters REAL`,
  product_media: `id TEXT PRIMARY KEY NOT NULL, product_url TEXT,
    image_bytes BLOB, image_mime_type TEXT`,
  brewery_process_defaults: `id TEXT PRIMARY KEY NOT NULL, wort_loss_liters REAL, mash_efficiency_pct REAL, default_batch_size_liters REAL`,
  equipment: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, model_id TEXT NOT NULL,
    slug TEXT, stock_id TEXT, added_at INTEGER, removed_at INTEGER, created_at INTEGER NOT NULL`,
  equipment_locations: `id TEXT PRIMARY KEY NOT NULL, location_id TEXT`,
  equipment_model_measurement_channels: `id TEXT PRIMARY KEY NOT NULL, model_id TEXT NOT NULL,
    measurement_kind TEXT NOT NULL, measurement_min REAL, measurement_max REAL,
    measurement_unit TEXT, measurement_scale TEXT, is_removed INTEGER NOT NULL DEFAULT 0`,
  equipment_liquid_containment: `equipment_id TEXT PRIMARY KEY NOT NULL, capacity_liters REAL`,
  equipment_pressure_rating: `equipment_id TEXT PRIMARY KEY NOT NULL, max_pressure_kpa REAL`,
  equipment_heating: `equipment_id TEXT PRIMARY KEY NOT NULL, rated_power_watts REAL`,
  equipment_cooling: `equipment_id TEXT PRIMARY KEY NOT NULL, rated_heat_removal_watts REAL`,
  equipment_temperature_control: `equipment_id TEXT PRIMARY KEY NOT NULL,
    min_temperature_c REAL, max_temperature_c REAL`,
  equipment_measurement_channels: `id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL,
    measurement_kind TEXT NOT NULL, measurement_min REAL, measurement_max REAL,
    measurement_unit TEXT, measurement_scale TEXT`,
  equipment_boil_calibration: `equipment_id TEXT PRIMARY KEY NOT NULL, heat_loss_watts REAL`,
  equipment_model_boil_characterization: `model_id TEXT PRIMARY KEY NOT NULL, heat_loss_watts REAL`,
  equipment_temperature_calibration: `equipment_id TEXT PRIMARY KEY NOT NULL, offset_c REAL`,
  equipment_measurement_calibration_points: `id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL,
    measurement_kind TEXT NOT NULL, reference_value REAL NOT NULL, observed_value REAL NOT NULL`,
  equipment_mash_assumptions: `equipment_id TEXT PRIMARY KEY NOT NULL,
    mash_efficiency_pct REAL, grain_absorption_l_per_kg REAL`,
  equipment_post_boil_losses: `equipment_id TEXT PRIMARY KEY NOT NULL, post_boil_loss_liters REAL`,
  equipment_use_events: `event_id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL`,
  supply_specs: `id TEXT PRIMARY KEY NOT NULL, category TEXT NOT NULL, default_unit TEXT NOT NULL`,
  supply_grain_specs: `supply_id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL, grain_class TEXT`,
  supply_other_fermentable_specs: `supply_id TEXT PRIMARY KEY NOT NULL, typical_brix REAL,
    extract_color_value REAL, extract_color_scale TEXT, extract_color_reference_value REAL,
    extract_color_reference_unit TEXT`,
  supply_hop_specs: `supply_id TEXT PRIMARY KEY NOT NULL, alpha_acid_pct REAL, hop_form TEXT`,
  supply_yeast_specs: `supply_id TEXT PRIMARY KEY NOT NULL, attenuation_pct REAL`,
  supply_container_specs: `supply_id TEXT PRIMARY KEY NOT NULL, container_kind TEXT, capacity_liters REAL,
    material TEXT, wood_species TEXT, wood_origin TEXT, connector_type TEXT`,
  supply_lots: `id TEXT PRIMARY KEY NOT NULL, supply_id TEXT NOT NULL, lot_code TEXT,
    crop_year INTEGER, best_before INTEGER, created_at INTEGER NOT NULL`,
  lot_grain_specs: `lot_id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL`,
  lot_other_fermentable_specs: `lot_id TEXT PRIMARY KEY NOT NULL, typical_brix REAL,
    extract_color_value REAL, extract_color_scale TEXT, extract_color_reference_value REAL,
    extract_color_reference_unit TEXT`,
  lot_hop_specs: `lot_id TEXT PRIMARY KEY NOT NULL, alpha_acid_pct REAL, hop_form TEXT`,
  lot_yeast_specs: `lot_id TEXT PRIMARY KEY NOT NULL, attenuation_pct REAL`,
  stock_buckets: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
    default_unit TEXT NOT NULL, supply_id TEXT, lot_id TEXT, created_at INTEGER NOT NULL`,
  stock_bucket_ingredient_properties: `id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL, alpha_acid_pct REAL, hop_form TEXT, attenuation_pct REAL`,
  inventory_locations: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, parent_id TEXT, created_at INTEGER NOT NULL`,
  inventory_location_slugs: `id TEXT PRIMARY KEY NOT NULL, slug TEXT NOT NULL`,
  inventory_location_addresses: `id TEXT PRIMARY KEY NOT NULL, address TEXT NOT NULL`,
  stock_bucket_locations: `id TEXT PRIMARY KEY NOT NULL, location_id TEXT`,
  inventory_moves: `id TEXT PRIMARY KEY NOT NULL, from_stock_bucket_id TEXT NOT NULL, to_stock_bucket_id TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, moved_at INTEGER NOT NULL`,
  stock_bucket_display_units: `id TEXT PRIMARY KEY NOT NULL, display_unit TEXT NOT NULL`,
  inventory_purchases: `id TEXT PRIMARY KEY NOT NULL, stock_bucket_id TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, purchased_at INTEGER NOT NULL, supplier TEXT, lot TEXT, cost REAL`,
  inventory_counts: `id TEXT PRIMARY KEY NOT NULL, stock_bucket_id TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, counted_at INTEGER NOT NULL, created_by_account_id TEXT`,
  inventory_discards: `id TEXT PRIMARY KEY NOT NULL, stock_bucket_id TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, discarded_at INTEGER NOT NULL, created_by_account_id TEXT`,
  photos: `id TEXT PRIMARY KEY NOT NULL, batch_id TEXT, batch_event_id TEXT, stock_bucket_id TEXT, mime_type TEXT NOT NULL, byte_count INTEGER NOT NULL, image BLOB NOT NULL, created_at INTEGER NOT NULL, created_by_account_id TEXT`,
  pill_bindings: `id TEXT PRIMARY KEY NOT NULL, batch_id TEXT NOT NULL, pill_id TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_until INTEGER`
};

function measurementColumns(extra = ''): string {
  return `event_id TEXT PRIMARY KEY NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, uncertainty REAL, equipment_id TEXT, source TEXT${extra ? `, ${extra}` : ''}`;
}

export const replicatedTables = Object.keys(definitions);
export const workspaceTableColumns: Record<string, string[]> = Object.fromEntries(
  Object.entries(definitions).map(([table, columns]) => [table,
    columns.split(',').map(column => column.trim().split(/\s+/)[0])])
);

export const schemaStatements = Object.entries(definitions).map(
  // CR-SQLite permits NOT NULL on the primary key, but requires a DEFAULT for
  // other NOT NULL columns so older peers can accept newly added fields.
  // Validate required values in application writes instead.
  ([name, columns]) => `CREATE TABLE IF NOT EXISTS ${name} (${columns.replaceAll(' NOT NULL', '').replaceAll('PRIMARY KEY', 'PRIMARY KEY NOT NULL')})`
);
export const workspaceViewStatements = [
  `CREATE VIEW equipment_models AS SELECT p.id, p.name, s.kind,
    p.catalog_product_id AS catalog_model_id,
    ${workspaceTableColumns.equipment_model_specs.filter(column => column !== 'id' && column !== 'kind')
      .map(column => `s.${column}`).join(', ')}, p.created_at
    FROM products p JOIN equipment_model_specs s ON s.id = p.id`,
  `CREATE VIEW supplies AS SELECT p.id, p.name, s.category, s.default_unit,
    p.catalog_product_id AS catalog_supply_id, p.created_at
    FROM products p JOIN supply_specs s ON s.id = p.id`
];
export const indexStatements = [
  `CREATE INDEX IF NOT EXISTS batch_events_timeline ON batch_events(batch_id, actual_at, id)`,
  `CREATE INDEX IF NOT EXISTS batch_events_type_time ON batch_events(batch_id, event_type, actual_at, id)`,
  `CREATE INDEX IF NOT EXISTS batch_events_by_batch ON batch_events(batch_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS recipe_events_by_recipe ON recipe_events(recipe_id, sort_order, id)`,
  `CREATE INDEX IF NOT EXISTS recipe_gravity_roles_by_event ON recipe_gravity_roles(event_id)`,
  `CREATE INDEX IF NOT EXISTS batch_gravity_roles_by_event ON batch_gravity_roles(event_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS recipe_gravity_role_once ON recipe_gravity_roles(recipe_id, role)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS batch_gravity_role_once ON batch_gravity_roles(batch_id, role)`,
  `CREATE INDEX IF NOT EXISTS recipe_import_links_by_source ON recipe_import_links(source_id, source_index)`,
  `CREATE INDEX IF NOT EXISTS pill_bindings_by_pill ON pill_bindings(pill_id, valid_from)`,
  `CREATE INDEX IF NOT EXISTS equipment_use_events_by_equipment ON equipment_use_events(equipment_id, event_id)`,
  `CREATE INDEX IF NOT EXISTS equipment_by_model ON equipment(model_id, removed_at, id)`,
  `CREATE INDEX IF NOT EXISTS equipment_by_stock_id ON equipment(stock_id)`,
  `CREATE INDEX IF NOT EXISTS equipment_locations_by_location ON equipment_locations(location_id, id)`,
  `CREATE INDEX IF NOT EXISTS stock_buckets_by_supply ON stock_buckets(supply_id, lot_id)`,
  `CREATE INDEX IF NOT EXISTS supply_lots_by_supply ON supply_lots(supply_id, lot_code)`
];

export const changeColumns = [
  'table', 'pk', 'cid', 'val', 'col_version', 'db_version', 'site_id', 'cl', 'seq'
] as const;

export type BinaryWire = { type: 'binary'; base64: string };
export type IntegerWire = { type: 'integer'; decimal: string };
export type WireValue = string | number | null | BinaryWire | IntegerWire;

export interface WireChange {
  table: string;
  pk: BinaryWire;
  cid: string;
  val: WireValue;
  col_version: string;
  db_version: string;
  site_id: BinaryWire;
  cl: string;
  seq: string;
}

export interface SyncRequest {
  serverCursor: string;
  localCursor: string;
  changes: WireChange[];
}

export interface SyncResponse {
  serverCursor: string;
  acceptedLocalCursor: string;
  changes: WireChange[];
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
export const workspaceSchemaVersion = 1;
export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,32}$/.test(value);
}

export function validateChange(input: unknown): input is WireChange {
  if (!input || typeof input !== 'object') return false;
  const c = input as Partial<WireChange>;
  return typeof c.table === 'string' && replicatedTables.includes(c.table)
    && !!c.pk && c.pk.type === 'binary' && typeof c.pk.base64 === 'string' && c.pk.base64.length < 512
    && typeof c.cid === 'string' && c.cid.length < 100
    && typeof c.col_version === 'string' && /^\d+$/.test(c.col_version)
    && typeof c.db_version === 'string' && /^\d+$/.test(c.db_version)
    && typeof c.cl === 'string' && /^\d+$/.test(c.cl)
    && typeof c.seq === 'string' && /^\d+$/.test(c.seq)
    && !!c.site_id && c.site_id.type === 'binary'
    && typeof c.site_id.base64 === 'string' && c.site_id.base64.length < 128
    && (c.val === null || typeof c.val === 'string' || typeof c.val === 'number'
      || (typeof c.val === 'object' && c.val !== null &&
        ((c.val as BinaryWire).type === 'binary' || (c.val as IntegerWire).type === 'integer')));
}
