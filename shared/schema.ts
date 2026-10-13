// All replicated tables use a single, immutable text primary key. CR-SQLite
// requires the same CRR schema on both peers before changes are exchanged.
const definitions: Record<string, string> = {
  batches: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`,
  recipes: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`,
  recipe_types: `id TEXT PRIMARY KEY NOT NULL, recipe_type TEXT NOT NULL`,
  recipe_events: `id TEXT PRIMARY KEY NOT NULL, recipe_id TEXT NOT NULL, event_type TEXT NOT NULL, title TEXT NOT NULL, planned_at INTEGER, anchor_event_id TEXT, offset_seconds INTEGER, anchor_point TEXT, duration_seconds INTEGER, instructions TEXT, sort_order INTEGER NOT NULL`,
  recipe_additions: `event_id TEXT PRIMARY KEY NOT NULL, item_category TEXT, item_name TEXT, catalog_item_id TEXT, inventory_item_id TEXT, quantity REAL, unit TEXT, display_unit TEXT`,
  recipe_temperature_control_events: `event_id TEXT PRIMARY KEY NOT NULL, phase TEXT, mode TEXT, target_value REAL, target_unit TEXT, equipment_id TEXT`,
  recipe_pressure_control_events: `event_id TEXT PRIMARY KEY NOT NULL, target_value REAL, target_unit TEXT, equipment_id TEXT`,
  recipe_measurement_targets: `event_id TEXT PRIMARY KEY NOT NULL, measurement_kind TEXT, target_value REAL, target_unit TEXT`,
  recipe_transfers: `event_id TEXT PRIMARY KEY NOT NULL, purpose TEXT, mash_equipment_id TEXT, to_vessel_id TEXT, to_vessel_name TEXT, quantity REAL, unit TEXT`,
  recipe_packaging: `event_id TEXT PRIMARY KEY NOT NULL, container_name TEXT, container_size REAL, container_count INTEGER, container_unit TEXT`,
  recipe_import_sources: `id TEXT PRIMARY KEY NOT NULL, filename TEXT NOT NULL, format TEXT NOT NULL, sha256 TEXT NOT NULL, byte_count INTEGER NOT NULL, content BLOB NOT NULL, imported_at INTEGER NOT NULL`,
  recipe_import_links: `id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, source_index INTEGER NOT NULL, external_id TEXT`,
  recipe_inputs: `id TEXT PRIMARY KEY NOT NULL, target_fermenter_volume_liters REAL, brewhouse_efficiency_pct REAL`,
  recipe_event_inputs: `id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL, alpha_acid_pct REAL, hop_form TEXT, attenuation_pct REAL`,
  batch_events: `id TEXT PRIMARY KEY NOT NULL, batch_id TEXT NOT NULL, recipe_event_id TEXT, event_type TEXT NOT NULL, title TEXT, planned_at INTEGER, anchor_event_id TEXT, offset_seconds INTEGER, anchor_point TEXT, duration_seconds INTEGER, instructions TEXT, actual_at INTEGER, skipped_at INTEGER, note TEXT, created_at INTEGER NOT NULL, created_by_account_id TEXT, recorded_by_account_id TEXT, source_id TEXT, external_id TEXT, received_at INTEGER`,
  batch_recipe_inputs: `id TEXT PRIMARY KEY NOT NULL, target_fermenter_volume_liters REAL, brewhouse_efficiency_pct REAL`,
  batch_event_inputs: `id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL, alpha_acid_pct REAL, hop_form TEXT, attenuation_pct REAL, mash_efficiency_pct REAL, grain_absorption_l_per_kg REAL, mash_deadspace_liters REAL, kettle_retention_liters REAL`,
  event_ends: `id TEXT PRIMARY KEY NOT NULL, ended_at INTEGER NOT NULL`,
  additions: `event_id TEXT PRIMARY KEY NOT NULL, item_category TEXT, catalog_item_id TEXT, inventory_item_id TEXT, item_name TEXT, quantity REAL, unit TEXT, display_unit TEXT, lot TEXT`,
  batch_measurement_targets: `event_id TEXT PRIMARY KEY NOT NULL, measurement_kind TEXT, target_value REAL, target_unit TEXT`,
  temperature_measurements: measurementColumns(),
  ph_measurements: measurementColumns(),
  gravity_measurements: measurementColumns(),
  volume_measurements: measurementColumns('location TEXT'),
  pressure_measurements: measurementColumns(),
  carbonation_measurements: measurementColumns(),
  dissolved_oxygen_measurements: measurementColumns(),
  temperature_control_events: `event_id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT, phase TEXT, mode TEXT, target_value REAL, target_unit TEXT, power_watts REAL, ended_at INTEGER`,
  pressure_control_events: `event_id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL, target_value REAL NOT NULL, target_unit TEXT NOT NULL`,
  transfers: `event_id TEXT PRIMARY KEY NOT NULL, purpose TEXT, mash_equipment_id TEXT, from_vessel_id TEXT, to_vessel_id TEXT, to_vessel_name TEXT, quantity REAL, unit TEXT`,
  packaging: `event_id TEXT PRIMARY KEY NOT NULL, container_name TEXT NOT NULL, container_size REAL NOT NULL, container_unit TEXT NOT NULL, container_count INTEGER NOT NULL, inventory_item_id TEXT`,
  equipment: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
    catalog_model_id TEXT, slug TEXT, created_at INTEGER NOT NULL`,
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
  equipment_temperature_calibration: `equipment_id TEXT PRIMARY KEY NOT NULL, offset_c REAL`,
  equipment_measurement_calibration_points: `id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL,
    measurement_kind TEXT NOT NULL, reference_value REAL NOT NULL, observed_value REAL NOT NULL`,
  equipment_mash_assumptions: `equipment_id TEXT PRIMARY KEY NOT NULL,
    mash_efficiency_pct REAL, grain_absorption_l_per_kg REAL,
    mash_deadspace_liters REAL, kettle_retention_liters REAL`,
  equipment_archives: `id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL, archived_at INTEGER NOT NULL`,
  inventory_items: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, default_unit TEXT NOT NULL, created_at INTEGER NOT NULL`,
  inventory_ingredient_properties: `id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL, alpha_acid_pct REAL, hop_form TEXT, attenuation_pct REAL`,
  inventory_locations: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, parent_id TEXT, created_at INTEGER NOT NULL`,
  inventory_location_slugs: `id TEXT PRIMARY KEY NOT NULL, slug TEXT NOT NULL`,
  inventory_location_addresses: `id TEXT PRIMARY KEY NOT NULL, address TEXT NOT NULL`,
  inventory_item_locations: `id TEXT PRIMARY KEY NOT NULL, location_id TEXT`,
  inventory_moves: `id TEXT PRIMARY KEY NOT NULL, from_item_id TEXT NOT NULL, to_item_id TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, moved_at INTEGER NOT NULL`,
  inventory_display_units: `id TEXT PRIMARY KEY NOT NULL, display_unit TEXT NOT NULL`,
  inventory_item_specs: `id TEXT PRIMARY KEY NOT NULL, inventory_item_id TEXT NOT NULL, capacity_liters REAL`,
  inventory_purchases: `id TEXT PRIMARY KEY NOT NULL, inventory_item_id TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, purchased_at INTEGER NOT NULL, supplier TEXT, lot TEXT, cost REAL`,
  inventory_counts: `id TEXT PRIMARY KEY NOT NULL, inventory_item_id TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, counted_at INTEGER NOT NULL, created_by_account_id TEXT`,
  inventory_discards: `id TEXT PRIMARY KEY NOT NULL, inventory_item_id TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, discarded_at INTEGER NOT NULL, created_by_account_id TEXT`,
  photos: `id TEXT PRIMARY KEY NOT NULL, batch_id TEXT, batch_event_id TEXT, inventory_item_id TEXT, mime_type TEXT NOT NULL, byte_count INTEGER NOT NULL, image BLOB NOT NULL, created_at INTEGER NOT NULL, created_by_account_id TEXT`,
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

export function legacyEquipmentCopyStatements(columns: string[]): string[] {
  const has = (...names: string[]) => names.every(name => columns.includes(name));
  const statements: string[] = [];
  const copy = (needed: string[], statement: string) => { if (has(...needed)) statements.push(statement); };
  copy(['capacity_liters'], `INSERT OR IGNORE INTO equipment_liquid_containment(equipment_id, capacity_liters)
    SELECT id, capacity_liters FROM equipment_legacy_migration WHERE capacity_liters IS NOT NULL`);
  copy(['max_pressure_kpa'], `INSERT OR IGNORE INTO equipment_pressure_rating(equipment_id, max_pressure_kpa)
    SELECT id, max_pressure_kpa FROM equipment_legacy_migration WHERE max_pressure_kpa IS NOT NULL`);
  copy(['rated_power_watts'], `INSERT OR IGNORE INTO equipment_heating(equipment_id, rated_power_watts)
    SELECT id, rated_power_watts FROM equipment_legacy_migration
    WHERE rated_power_watts IS NOT NULL OR kind IN ('electric_kettle', 'all_in_one')`);
  if (has('built_in_temperature_control')) statements.push(`INSERT OR IGNORE INTO equipment_temperature_control(equipment_id)
    SELECT id FROM equipment_legacy_migration
    WHERE built_in_temperature_control = 1 OR kind IN ('electric_kettle', 'all_in_one', 'fermentation_temperature_control')`);
  copy(['measurement_min', 'measurement_max', 'measurement_unit'], `INSERT OR IGNORE INTO equipment_measurement_channels
    (id, equipment_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
    SELECT id || ':' || CASE
      WHEN kind IN ('hydrometer', 'refractometer') THEN 'gravity'
      WHEN kind = 'thermometer' THEN 'temperature'
      WHEN kind = 'ph_meter' THEN 'ph'
      WHEN kind = 'pressure_gauge' THEN 'pressure'
      WHEN kind = 'carbonation_meter' THEN 'carbonation'
      WHEN kind = 'dissolved_oxygen_meter' THEN 'dissolved_oxygen'
      WHEN kind = 'scale' THEN 'mass' END,
      id, CASE
      WHEN kind IN ('hydrometer', 'refractometer') THEN 'gravity'
      WHEN kind = 'thermometer' THEN 'temperature'
      WHEN kind = 'ph_meter' THEN 'ph'
      WHEN kind = 'pressure_gauge' THEN 'pressure'
      WHEN kind = 'carbonation_meter' THEN 'carbonation'
      WHEN kind = 'dissolved_oxygen_meter' THEN 'dissolved_oxygen'
      WHEN kind = 'scale' THEN 'mass' END,
      measurement_min, measurement_max,
      CASE WHEN measurement_unit IN ('SG', '°Plato', '°Brix', 'pH') THEN NULL ELSE measurement_unit END,
      CASE WHEN measurement_unit IN ('SG', '°Plato', '°Brix', 'pH') THEN measurement_unit ELSE NULL END
    FROM equipment_legacy_migration WHERE kind IN ('hydrometer', 'refractometer', 'thermometer', 'ph_meter',
      'pressure_gauge', 'carbonation_meter', 'dissolved_oxygen_meter', 'scale')`);
  copy(['boil_heat_loss_watts'], `INSERT OR IGNORE INTO equipment_boil_calibration(equipment_id, heat_loss_watts)
    SELECT id, boil_heat_loss_watts FROM equipment_legacy_migration WHERE boil_heat_loss_watts IS NOT NULL`);
  copy(['temperature_offset_c'], `INSERT OR IGNORE INTO equipment_temperature_calibration(equipment_id, offset_c)
    SELECT id, temperature_offset_c FROM equipment_legacy_migration WHERE temperature_offset_c IS NOT NULL`);
  const assumptions = ['mash_efficiency_pct', 'grain_absorption_l_per_kg', 'mash_deadspace_liters', 'kettle_retention_liters'];
  if (has(...assumptions)) statements.push(`INSERT OR IGNORE INTO equipment_mash_assumptions
    (equipment_id, ${assumptions.join(', ')}) SELECT id, ${assumptions.join(', ')} FROM equipment_legacy_migration
    WHERE ${assumptions.map(column => `${column} IS NOT NULL`).join(' OR ')}`);
  const readings: [string, string, string, string][] = [
    ['ph_meter', 'ph', '4', 'buffer_4_observed'], ['ph_meter', 'ph', '7', 'buffer_7_observed'],
    ['hydrometer', 'gravity', 'reference_sg', 'observed_sg'],
    ['refractometer', 'gravity', 'reference_brix', 'observed_brix'],
    ['scale', 'mass', 'reference_g', 'observed_g'],
    ['pressure_gauge', 'pressure', 'reference_kpa', 'observed_kpa'],
    ['carbonation_meter', 'carbonation', 'reference_volumes', 'observed_volumes'],
    ['dissolved_oxygen_meter', 'dissolved_oxygen', 'reference_mg_l', 'observed_mg_l']
  ];
  for (const [kind, measurement, reference, observed] of readings) {
    const referenceIsColumn = !['4', '7'].includes(reference);
    if (!has(observed) || referenceIsColumn && !has(reference)) continue;
    statements.push(`INSERT OR IGNORE INTO equipment_measurement_calibration_points
      (id, equipment_id, measurement_kind, reference_value, observed_value)
      SELECT id || ':${measurement}:${referenceIsColumn ? 'reference' : reference}', id, '${measurement}',
        ${reference}, ${observed} FROM equipment_legacy_migration
      WHERE kind = '${kind}' AND ${observed} IS NOT NULL${referenceIsColumn ? ` AND ${reference} IS NOT NULL` : ''}`);
  }
  return statements;
}
export const schemaStatements = Object.entries(definitions).map(
  // CR-SQLite permits NOT NULL on the primary key, but requires a DEFAULT for
  // other NOT NULL columns so older peers can accept newly added fields.
  // Validate required values in application writes instead.
  ([name, columns]) => `CREATE TABLE IF NOT EXISTS ${name} (${columns.replaceAll(' NOT NULL', '').replaceAll('PRIMARY KEY', 'PRIMARY KEY NOT NULL')})`
);
export const indexStatements = [
  `CREATE INDEX IF NOT EXISTS batch_events_timeline ON batch_events(batch_id, actual_at, id)`,
  `CREATE INDEX IF NOT EXISTS batch_events_type_time ON batch_events(batch_id, event_type, actual_at, id)`,
  `CREATE INDEX IF NOT EXISTS batch_events_by_batch ON batch_events(batch_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS recipe_events_by_recipe ON recipe_events(recipe_id, sort_order, id)`,
  `CREATE INDEX IF NOT EXISTS recipe_import_links_by_source ON recipe_import_links(source_id, source_index)`,
  `CREATE INDEX IF NOT EXISTS pill_bindings_by_pill ON pill_bindings(pill_id, valid_from)`
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
export const workspaceSchemaVersion = 19;
export const retiredReplicatedTables = ['equipment_calibrations', 'equipment_characterization_observations'] as const;

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
