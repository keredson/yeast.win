// All replicated tables use a single, immutable text primary key. CR-SQLite
// requires the same CRR schema on both peers before changes are exchanged.
const definitions: Record<string, string> = {
  batches: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`,
  batch_origins: `id TEXT PRIMARY KEY NOT NULL, source_batch_id TEXT NOT NULL`,
  recipes: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`,
  recipe_slugs: `id TEXT PRIMARY KEY NOT NULL, slug TEXT NOT NULL`,
  recipe_types: `id TEXT PRIMARY KEY NOT NULL, recipe_type TEXT NOT NULL`,
  recipe_events: `id TEXT PRIMARY KEY NOT NULL, recipe_id TEXT NOT NULL, event_type TEXT NOT NULL, title TEXT NOT NULL, planned_at INTEGER, anchor_event_id TEXT, offset_seconds INTEGER, anchor_point TEXT, duration_seconds INTEGER, instructions TEXT, sort_order INTEGER NOT NULL`,
  recipe_additions: `event_id TEXT PRIMARY KEY NOT NULL, item_category TEXT, item_name TEXT, catalog_item_id TEXT, inventory_item_id TEXT, supply_id TEXT, quantity REAL, unit TEXT, display_unit TEXT`,
  recipe_temperature_control_events: `event_id TEXT PRIMARY KEY NOT NULL, phase TEXT, mode TEXT, target_value REAL, target_unit TEXT, equipment_id TEXT`,
  recipe_pressure_control_events: `event_id TEXT PRIMARY KEY NOT NULL, target_value REAL, target_unit TEXT, equipment_id TEXT`,
  recipe_measurement_targets: `event_id TEXT PRIMARY KEY NOT NULL, measurement_kind TEXT, target_value REAL, target_unit TEXT`,
  recipe_gravity_roles: `id TEXT PRIMARY KEY NOT NULL, recipe_id TEXT NOT NULL, role TEXT NOT NULL, event_id TEXT NOT NULL`,
  recipe_transfers: `event_id TEXT PRIMARY KEY NOT NULL, purpose TEXT, mash_equipment_id TEXT, to_vessel_id TEXT, to_vessel_name TEXT, quantity REAL, unit TEXT`,
  recipe_transfer_equipment: `id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, equipment_id TEXT NOT NULL`,
  recipe_packaging: `event_id TEXT PRIMARY KEY NOT NULL, container_name TEXT, container_size REAL, container_count INTEGER, container_unit TEXT`,
  recipe_import_sources: `id TEXT PRIMARY KEY NOT NULL, filename TEXT NOT NULL, format TEXT NOT NULL, sha256 TEXT NOT NULL, byte_count INTEGER NOT NULL, content BLOB NOT NULL, imported_at INTEGER NOT NULL`,
  recipe_import_links: `id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, source_index INTEGER NOT NULL, external_id TEXT`,
  recipe_inputs: `id TEXT PRIMARY KEY NOT NULL, target_fermenter_volume_liters REAL, brewhouse_efficiency_pct REAL, wort_loss_liters REAL, batch_size_source TEXT`,
  recipe_event_inputs: `id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL, alpha_acid_pct REAL, hop_form TEXT, attenuation_pct REAL, grain_class TEXT`,
  batch_events: `id TEXT PRIMARY KEY NOT NULL, batch_id TEXT NOT NULL, recipe_event_id TEXT, event_type TEXT NOT NULL, title TEXT, planned_at INTEGER, anchor_event_id TEXT, offset_seconds INTEGER, anchor_point TEXT, duration_seconds INTEGER, instructions TEXT, actual_at INTEGER, skipped_at INTEGER, note TEXT, created_at INTEGER NOT NULL, created_by_account_id TEXT, recorded_by_account_id TEXT, source_id TEXT, external_id TEXT, received_at INTEGER`,
  batch_recipe_inputs: `id TEXT PRIMARY KEY NOT NULL, target_fermenter_volume_liters REAL, brewhouse_efficiency_pct REAL, wort_loss_liters REAL`,
  batch_event_inputs: `id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL, alpha_acid_pct REAL, hop_form TEXT, attenuation_pct REAL, grain_class TEXT, mash_efficiency_pct REAL, grain_absorption_l_per_kg REAL`,
  event_ends: `id TEXT PRIMARY KEY NOT NULL, ended_at INTEGER NOT NULL`,
  additions: `event_id TEXT PRIMARY KEY NOT NULL, item_category TEXT, catalog_item_id TEXT, inventory_item_id TEXT, supply_id TEXT, item_name TEXT, quantity REAL, unit TEXT, display_unit TEXT, lot TEXT`,
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
  packaging: `event_id TEXT PRIMARY KEY NOT NULL, container_name TEXT NOT NULL, container_size REAL NOT NULL, container_unit TEXT NOT NULL, container_count INTEGER NOT NULL, inventory_item_id TEXT`,
  equipment_models: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
    catalog_model_id TEXT, has_liquid_containment INTEGER, capacity_liters REAL,
    has_pressure_rating INTEGER, max_pressure_kpa REAL, has_heating INTEGER, rated_power_watts REAL,
    has_cooling INTEGER, rated_heat_removal_watts REAL, has_temperature_control INTEGER,
    min_temperature_c REAL, max_temperature_c REAL,
    mash_efficiency_pct REAL, grain_absorption_l_per_kg REAL, post_boil_loss_liters REAL,
    created_at INTEGER NOT NULL`,
  equipment_model_media: `id TEXT PRIMARY KEY NOT NULL, product_url TEXT,
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
  equipment_archives: `id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL, archived_at INTEGER NOT NULL`,
  equipment_use_events: `event_id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL`,
  supplies: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
    default_unit TEXT NOT NULL, catalog_supply_id TEXT, created_at INTEGER NOT NULL`,
  supply_media: `id TEXT PRIMARY KEY NOT NULL, product_url TEXT,
    image_bytes BLOB, image_mime_type TEXT`,
  supply_grain_specs: `supply_id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL, grain_class TEXT`,
  supply_other_fermentable_specs: `supply_id TEXT PRIMARY KEY NOT NULL, typical_brix REAL,
    extract_color_value REAL, extract_color_scale TEXT, extract_color_reference_value REAL,
    extract_color_reference_unit TEXT`,
  supply_hop_specs: `supply_id TEXT PRIMARY KEY NOT NULL, alpha_acid_pct REAL, hop_form TEXT`,
  supply_yeast_specs: `supply_id TEXT PRIMARY KEY NOT NULL, attenuation_pct REAL`,
  supply_lots: `id TEXT PRIMARY KEY NOT NULL, supply_id TEXT NOT NULL, lot_code TEXT,
    crop_year INTEGER, best_before INTEGER, created_at INTEGER NOT NULL`,
  lot_grain_specs: `lot_id TEXT PRIMARY KEY NOT NULL, yield_pct REAL, color_lovibond REAL`,
  lot_other_fermentable_specs: `lot_id TEXT PRIMARY KEY NOT NULL, typical_brix REAL,
    extract_color_value REAL, extract_color_scale TEXT, extract_color_reference_value REAL,
    extract_color_reference_unit TEXT`,
  lot_hop_specs: `lot_id TEXT PRIMARY KEY NOT NULL, alpha_acid_pct REAL, hop_form TEXT`,
  lot_yeast_specs: `lot_id TEXT PRIMARY KEY NOT NULL, attenuation_pct REAL`,
  inventory_items: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
    default_unit TEXT NOT NULL, supply_id TEXT, lot_id TEXT, created_at INTEGER NOT NULL`,
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
  const assumptions = ['mash_efficiency_pct', 'grain_absorption_l_per_kg'];
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

export function legacyEquipmentModelStatements(columns: string[]): string[] {
  const old = 'equipment_legacy_migration';
  const catalog = columns.includes('catalog_model_id') ? 'e.catalog_model_id' : 'NULL';
  const kind = columns.includes('kind') ? 'e.kind' : "'other'";
  const name = columns.includes('name') ? 'e.name' : 'e.id';
  const created = columns.includes('created_at') ? 'e.created_at' : '0';
  const modelId = `COALESCE(${catalog}, e.id)`;
  return [
    `INSERT OR IGNORE INTO equipment_models(id, name, kind, catalog_model_id,
      has_liquid_containment, capacity_liters, has_pressure_rating, max_pressure_kpa,
      has_heating, rated_power_watts, has_cooling, rated_heat_removal_watts,
      has_temperature_control, min_temperature_c, max_temperature_c,
      mash_efficiency_pct, grain_absorption_l_per_kg, created_at)
      SELECT ${modelId}, ${name}, ${kind}, ${catalog},
      CASE WHEN liquid.equipment_id IS NOT NULL THEN 1 END, liquid.capacity_liters,
      CASE WHEN pressure.equipment_id IS NOT NULL THEN 1 END, pressure.max_pressure_kpa,
      CASE WHEN heat.equipment_id IS NOT NULL THEN 1 END, heat.rated_power_watts,
      CASE WHEN cool.equipment_id IS NOT NULL THEN 1 END, cool.rated_heat_removal_watts,
      CASE WHEN control.equipment_id IS NOT NULL THEN 1 END, control.min_temperature_c, control.max_temperature_c,
      assumptions.mash_efficiency_pct, assumptions.grain_absorption_l_per_kg,
      ${created} FROM ${old} e
      LEFT JOIN equipment_liquid_containment liquid ON liquid.equipment_id = e.id
      LEFT JOIN equipment_pressure_rating pressure ON pressure.equipment_id = e.id
      LEFT JOIN equipment_heating heat ON heat.equipment_id = e.id
      LEFT JOIN equipment_cooling cool ON cool.equipment_id = e.id
      LEFT JOIN equipment_temperature_control control ON control.equipment_id = e.id
      LEFT JOIN equipment_mash_assumptions assumptions ON assumptions.equipment_id = e.id`,
    `UPDATE equipment SET model_id = (SELECT ${modelId} FROM ${old} e WHERE e.id = equipment.id),
      added_at = COALESCE(added_at, created_at)
      WHERE id IN (SELECT id FROM ${old})`,
    `INSERT OR IGNORE INTO equipment_model_measurement_channels
      (id, model_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
      SELECT equipment.model_id || ':' || c.measurement_kind, equipment.model_id, c.measurement_kind,
        c.measurement_min, c.measurement_max, c.measurement_unit, c.measurement_scale
      FROM equipment_measurement_channels c JOIN equipment ON equipment.id = c.equipment_id
      JOIN equipment_models m ON m.id = equipment.model_id WHERE m.catalog_model_id IS NULL`,
    `UPDATE recipe_temperature_control_events SET equipment_id =
      (SELECT model_id FROM equipment WHERE equipment.id = recipe_temperature_control_events.equipment_id)
      WHERE equipment_id IN (SELECT id FROM equipment)`,
    `UPDATE recipe_pressure_control_events SET equipment_id =
      (SELECT model_id FROM equipment WHERE equipment.id = recipe_pressure_control_events.equipment_id)
      WHERE equipment_id IN (SELECT id FROM equipment)`,
    `UPDATE recipe_transfers SET mash_equipment_id =
      (SELECT model_id FROM equipment WHERE equipment.id = recipe_transfers.mash_equipment_id)
      WHERE mash_equipment_id IN (SELECT id FROM equipment)`,
    `UPDATE recipe_transfers SET to_vessel_id =
      (SELECT model_id FROM equipment WHERE equipment.id = recipe_transfers.to_vessel_id)
      WHERE to_vessel_id IN (SELECT id FROM equipment)`
  ];
}

export const supplyMigrationStatements = [
  `INSERT OR IGNORE INTO supplies(id, name, category, default_unit, created_at)
    SELECT 'supply:' || lower(trim(category)) || ':' || lower(trim(name)),
      MIN(name), MIN(category), MIN(default_unit), MIN(created_at)
    FROM inventory_items GROUP BY lower(trim(category)), lower(trim(name))`,
  `UPDATE inventory_items SET supply_id = 'supply:' || lower(trim(category)) || ':' || lower(trim(name))
    WHERE supply_id IS NULL`,
  `INSERT OR IGNORE INTO supply_lots(id, supply_id, created_at)
    SELECT id || ':legacy-lot', supply_id, created_at FROM inventory_items WHERE supply_id IS NOT NULL`,
  `UPDATE inventory_items SET lot_id = id || ':legacy-lot' WHERE lot_id IS NULL`,
  `UPDATE supply_lots SET lot_code = (
    SELECT MIN(trim(p.lot)) FROM inventory_purchases p
    WHERE p.inventory_item_id = substr(supply_lots.id, 1, length(supply_lots.id) - length(':legacy-lot'))
      AND p.lot IS NOT NULL AND trim(p.lot) <> ''
    HAVING COUNT(DISTINCT trim(p.lot)) = 1)
    WHERE id LIKE '%:legacy-lot' AND lot_code IS NULL
      AND 1 = (SELECT COUNT(DISTINCT trim(p.lot)) FROM inventory_purchases p
        WHERE p.inventory_item_id = substr(supply_lots.id, 1, length(supply_lots.id) - length(':legacy-lot'))
          AND p.lot IS NOT NULL AND trim(p.lot) <> '')`,
  `INSERT OR IGNORE INTO supply_grain_specs(supply_id, yield_pct, color_lovibond)
    SELECT i.supply_id, p.yield_pct, p.color_lovibond FROM inventory_items i
    JOIN inventory_ingredient_properties p ON p.id = i.id
    WHERE i.category IN ('Grain', 'Adjunct') AND (p.yield_pct IS NOT NULL OR p.color_lovibond IS NOT NULL)
    ORDER BY i.id`,
  `INSERT OR IGNORE INTO supply_hop_specs(supply_id, alpha_acid_pct, hop_form)
    SELECT i.supply_id, p.alpha_acid_pct, p.hop_form FROM inventory_items i
    JOIN inventory_ingredient_properties p ON p.id = i.id
    WHERE i.category = 'Hops' AND (p.alpha_acid_pct IS NOT NULL OR p.hop_form IS NOT NULL) ORDER BY i.id`,
  `INSERT OR IGNORE INTO supply_yeast_specs(supply_id, attenuation_pct)
    SELECT i.supply_id, p.attenuation_pct FROM inventory_items i
    JOIN inventory_ingredient_properties p ON p.id = i.id
    WHERE i.category = 'Yeast' AND p.attenuation_pct IS NOT NULL ORDER BY i.id`,
  `INSERT OR IGNORE INTO lot_grain_specs(lot_id, yield_pct, color_lovibond)
    SELECT i.lot_id, p.yield_pct, p.color_lovibond FROM inventory_items i
    JOIN inventory_ingredient_properties p ON p.id = i.id WHERE i.category IN ('Grain', 'Adjunct')`,
  `INSERT OR IGNORE INTO lot_hop_specs(lot_id, alpha_acid_pct, hop_form)
    SELECT i.lot_id, p.alpha_acid_pct, p.hop_form FROM inventory_items i
    JOIN inventory_ingredient_properties p ON p.id = i.id WHERE i.category = 'Hops'`,
  `INSERT OR IGNORE INTO lot_yeast_specs(lot_id, attenuation_pct)
    SELECT i.lot_id, p.attenuation_pct FROM inventory_items i
    JOIN inventory_ingredient_properties p ON p.id = i.id WHERE i.category = 'Yeast'`,
  `UPDATE recipe_additions SET supply_id =
    (SELECT supply_id FROM inventory_items WHERE id = recipe_additions.inventory_item_id)
    WHERE supply_id IS NULL AND inventory_item_id IN (SELECT id FROM inventory_items)`,
  `UPDATE additions SET supply_id =
    (SELECT supply_id FROM inventory_items WHERE id = additions.inventory_item_id)
    WHERE supply_id IS NULL AND inventory_item_id IN (SELECT id FROM inventory_items)`
];
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
  `CREATE INDEX IF NOT EXISTS inventory_items_by_supply ON inventory_items(supply_id, lot_id)`,
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
export const workspaceSchemaVersion = 38;
// Earlier builds identified OG and FG by title. Assign the matching gravity
// steps once during upgrade so titles can subsequently change without changing
// the meaning of a measurement. Existing explicit assignments always win.
export const gravityRoleMigrationStatements = (['recipe', 'batch'] as const).flatMap(scope =>
  (['og', 'fg'] as const).map(role => {
    const owner = `${scope}_id`;
    const eventTable = `${scope}_events`;
    const targetTable = `${scope}_measurement_targets`;
    const roleTable = `${scope}_gravity_roles`;
    const name = role === 'og' ? 'original' : 'final';
    return `INSERT OR IGNORE INTO ${roleTable}(id, ${owner}, role, event_id)
      SELECT ${owner} || ':${role}', ${owner}, '${role}', id FROM (
        SELECT e.id, e.${owner}, ROW_NUMBER() OVER (PARTITION BY e.${owner}
          ORDER BY e.${scope === 'recipe' ? 'sort_order' : 'created_at'} ${role === 'fg' ? 'DESC' : 'ASC'}, e.id) AS position
        FROM ${eventTable} e JOIN ${targetTable} t ON t.event_id = e.id
        WHERE e.event_type = 'measurement' AND t.measurement_kind = 'gravity'
          AND (lower(e.title) LIKE '%${name}%gravity%'
            OR lower(trim(e.title)) IN ('${role}', 'measure ${role}', '${role} reading'))
      ) WHERE position = 1`;
  }));
export const primingSugarCategoryMigrationStatements = [
  `UPDATE inventory_items SET category = 'Adjunct' WHERE category = 'Other' AND supply_id IN
    (SELECT id FROM supplies WHERE catalog_supply_id = 'inventory_priming_sugar')`,
  `UPDATE supplies SET category = 'Adjunct'
    WHERE catalog_supply_id = 'inventory_priming_sugar' AND category = 'Other'`
] as const;
export const otherFermentablesMigrationStatements = [
  `UPDATE supplies SET category = 'Other fermentables'
    WHERE catalog_supply_id = 'inventory_priming_sugar' AND category IN ('Other', 'Adjunct')`,
  `UPDATE inventory_items SET category = 'Other fermentables'
    WHERE supply_id IN (SELECT id FROM supplies WHERE catalog_supply_id = 'inventory_priming_sugar')
      AND category IN ('Other', 'Adjunct')`,
  `UPDATE recipe_additions SET item_category = 'Other fermentables'
    WHERE item_category IN ('Other', 'Adjunct') AND
      (catalog_item_id = 'inventory_priming_sugar' OR supply_id IN
        (SELECT id FROM supplies WHERE catalog_supply_id = 'inventory_priming_sugar'))`,
  `UPDATE additions SET item_category = 'Other fermentables'
    WHERE item_category IN ('Other', 'Adjunct') AND
      (catalog_item_id = 'inventory_priming_sugar' OR supply_id IN
        (SELECT id FROM supplies WHERE catalog_supply_id = 'inventory_priming_sugar'))`
] as const;
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
