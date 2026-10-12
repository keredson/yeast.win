// All replicated tables use a single, immutable text primary key. CR-SQLite
// requires the same CRR schema on both peers before changes are exchanged.
const definitions: Record<string, string> = {
  batches: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`,
  recipes: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`,
  recipe_types: `id TEXT PRIMARY KEY NOT NULL, recipe_type TEXT NOT NULL`,
  recipe_events: `id TEXT PRIMARY KEY NOT NULL, recipe_id TEXT NOT NULL, event_type TEXT NOT NULL, title TEXT NOT NULL, planned_at INTEGER, anchor_event_id TEXT, offset_seconds INTEGER, details_json TEXT, sort_order INTEGER NOT NULL`,
  batch_events: `id TEXT PRIMARY KEY NOT NULL, batch_id TEXT NOT NULL, recipe_event_id TEXT, event_type TEXT NOT NULL, title TEXT, planned_at INTEGER, anchor_event_id TEXT, offset_seconds INTEGER, details_json TEXT, actual_at INTEGER, skipped_at INTEGER, note TEXT, created_at INTEGER NOT NULL, created_by_account_id TEXT, recorded_by_account_id TEXT, source_id TEXT, external_id TEXT, received_at INTEGER`,
  event_ends: `id TEXT PRIMARY KEY NOT NULL, ended_at INTEGER NOT NULL`,
  additions: `event_id TEXT PRIMARY KEY NOT NULL, inventory_item_id TEXT, item_name TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, lot TEXT`,
  temperature_measurements: measurementColumns(),
  ph_measurements: measurementColumns(),
  gravity_measurements: measurementColumns(),
  volume_measurements: measurementColumns('location TEXT'),
  pressure_measurements: measurementColumns(),
  carbonation_measurements: measurementColumns(),
  dissolved_oxygen_measurements: measurementColumns(),
  temperature_control_events: `event_id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL, mode TEXT NOT NULL, target_value REAL, target_unit TEXT, power_watts REAL, ended_at INTEGER`,
  pressure_control_events: `event_id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL, target_value REAL NOT NULL, target_unit TEXT NOT NULL`,
  transfers: `event_id TEXT PRIMARY KEY NOT NULL, from_vessel_id TEXT, to_vessel_id TEXT, quantity REAL, unit TEXT`,
  packaging: `event_id TEXT PRIMARY KEY NOT NULL, container_name TEXT NOT NULL, container_size REAL NOT NULL, container_unit TEXT NOT NULL, container_count INTEGER NOT NULL, inventory_item_id TEXT`,
  equipment: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, catalog_model_id TEXT, specification_json TEXT, created_at INTEGER NOT NULL`,
  equipment_archives: `id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL, archived_at INTEGER NOT NULL`,
  equipment_calibrations: `id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL, effective_at INTEGER NOT NULL, method TEXT NOT NULL, parameters_json TEXT NOT NULL, created_by_account_id TEXT`,
  equipment_characterization_observations: `id TEXT PRIMARY KEY NOT NULL, equipment_id TEXT NOT NULL, observed_at INTEGER NOT NULL, power_watts REAL, ambient_c REAL, liquid_c REAL, start_liters REAL, end_liters REAL, duration_seconds INTEGER`,
  inventory_items: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, default_unit TEXT NOT NULL, created_at INTEGER NOT NULL`,
  inventory_locations: `id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, parent_id TEXT, created_at INTEGER NOT NULL`,
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
  return `event_id TEXT PRIMARY KEY NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, uncertainty REAL, equipment_id TEXT, calibration_id TEXT, source TEXT${extra ? `, ${extra}` : ''}`;
}

export const replicatedTables = Object.keys(definitions);
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
export const workspaceSchemaVersion = 9;

export const inventoryLocationTables = ['inventory_locations', 'inventory_item_locations', 'inventory_moves'] as const;

export const removeEmptyDuplicateInventory = `DELETE FROM inventory_items WHERE id IN (
  SELECT empty.id FROM inventory_items empty WHERE EXISTS (
    SELECT 1 FROM inventory_items other WHERE other.id <> empty.id
      AND lower(trim(other.name)) = lower(trim(empty.name)) AND other.category = empty.category
      AND (other.created_at > empty.created_at OR other.created_at = empty.created_at AND other.id > empty.id
        OR EXISTS (SELECT 1 FROM inventory_purchases WHERE inventory_item_id = other.id)
        OR EXISTS (SELECT 1 FROM inventory_counts WHERE inventory_item_id = other.id)
        OR EXISTS (SELECT 1 FROM inventory_discards WHERE inventory_item_id = other.id)))
  AND NOT EXISTS (SELECT 1 FROM inventory_purchases WHERE inventory_item_id = empty.id)
  AND NOT EXISTS (SELECT 1 FROM inventory_counts WHERE inventory_item_id = empty.id)
  AND NOT EXISTS (SELECT 1 FROM inventory_discards WHERE inventory_item_id = empty.id)
  AND NOT EXISTS (SELECT 1 FROM additions WHERE inventory_item_id = empty.id)
  AND NOT EXISTS (SELECT 1 FROM packaging WHERE inventory_item_id = empty.id)
  AND NOT EXISTS (SELECT 1 FROM photos WHERE inventory_item_id = empty.id)
  AND NOT EXISTS (SELECT 1 FROM inventory_item_specs WHERE inventory_item_id = empty.id)
)`;
export const recategorizeLacticAcid = "UPDATE inventory_items SET category = 'Adjunct' WHERE category = 'Chemical' AND lower(trim(name)) = 'lactic acid'";

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
