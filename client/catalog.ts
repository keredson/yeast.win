import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { catalogProductTables, catalogModelTables, catalogSupplyTables, catalogSchemaVersion, catalogTables,
  type CatalogEquipment, type CatalogInventory, type CatalogMeasurementChannel } from '../shared/catalog.ts';
import { changeColumns } from '../shared/schema.ts';
import { maxSequence, readSequence, syncProtocolVersion, validChangeTuple, type ChangeTuple } from '../shared/cborSync.ts';
import { syncSchemaHeader } from '../shared/syncSchema.ts';
import { fetchApi, syncError } from './api.ts';

let opened: Promise<DB> | undefined;
let syncing: Promise<boolean> | undefined;
type CatalogMediaKind = 'supply' | 'model' | 'thumbnail' | 'logo';
const mediaCache = new Map<string, Promise<string | null>>();
let mediaGeneration = 0;
const profileOpen = new URLSearchParams(location.search).has('profileOpen');

export function catalogMediaGeneration(): number { return mediaGeneration; }

function invalidateCatalogMedia(): void {
  mediaCache.clear();
  mediaGeneration++;
}

export function catalogMediaUrl(kind: CatalogMediaKind, id: string): Promise<string | null> {
  const key = `${kind}:${id}`;
  let pending = mediaCache.get(key);
  if (!pending) {
    pending = (async () => {
      const db = await openLocalCatalog();
      const [table, keyColumn, valueColumn] = kind === 'logo'
        ? ['manufacturer_logos', 'manufacturer_name', 'logo_url']
        : ['products', 'id', kind === 'thumbnail' ? 'thumbnail_url' : 'image_url'];
      const row = (await db.execO<{ url: string | null }>(
        `SELECT ${valueColumn} AS url FROM ${table} WHERE ${keyColumn} = ?`, [id]))[0];
      return row?.url || null;
    })().catch(cause => {
      if (mediaCache.get(key) === pending) mediaCache.delete(key);
      throw cause;
    });
    mediaCache.set(key, pending);
  }
  return pending;
}
const catalogRefreshIntervalMs = 24 * 60 * 60_000;
const catalogImageCacheName = 'brewlog-catalog-images-v1';

export async function downloadCatalogImages(onProgress?: (done: number, total: number) => void): Promise<{ downloaded: number; failed: number }> {
  const db = await openLocalCatalog();
  const rows = await db.execO<{ url: string }>(`SELECT image_url AS url FROM products WHERE image_url IS NOT NULL
    UNION SELECT thumbnail_url FROM products WHERE thumbnail_url IS NOT NULL
    UNION SELECT logo_url FROM manufacturer_logos WHERE logo_url IS NOT NULL`);
  const urls = [...new Set(rows.map(row => row.url).filter(url => /^https:\/\//i.test(url)))];
  const cache = await caches.open(catalogImageCacheName);
  let next = 0;
  let done = 0;
  let downloaded = 0;
  let failed = 0;
  onProgress?.(0, urls.length);
  async function worker(): Promise<void> {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        if (!await cache.match(url)) {
          const response = await fetch(url, { mode: 'no-cors', cache: 'no-store' });
          if (response.status !== 0 && !response.ok) throw new Error(`Image request failed: ${response.status}`);
          await cache.put(url, response);
          downloaded++;
        }
      } catch { failed++; }
      onProgress?.(++done, urls.length);
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  return { downloaded, failed };
}

export function openLocalCatalog(): Promise<DB> {
  if (!opened) opened = (async () => {
    const sqlite = await initWasm(() => wasmUrl);
    const db = await sqlite.open('brewlog-catalog');
    const version = (await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version;
    const ready = version === catalogSchemaVersion && (await db.execO<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name = 'products__crsql_clock'")).length > 0;
    if (ready) return db;
    // The catalog is a read-only cache on devices. Rebuild outdated local copies
    // from the server's complete CRR state instead of retaining upgrade history.
    await db.tx(async tx => {
      const tables = await tx.execO<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'crsql_%' AND name NOT LIKE '%__crsql_%'`);
      const clocks = new Set((await tx.execO<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name LIKE '%__crsql_clock'"))
        .map(row => row.name));
      for (const row of tables) {
        if (clocks.has(`${row.name}__crsql_clock`)) await tx.exec('SELECT crsql_as_table(?)', [row.name]);
        await tx.exec(`DROP TABLE IF EXISTS "${row.name}"`);
      }
      for (const statement of [...Object.values(catalogProductTables),
        ...Object.values(catalogModelTables), ...Object.values(catalogSupplyTables)]) await tx.exec(statement);
      for (const table of catalogTables) await tx.exec('SELECT crsql_as_crr(?)', [table]);
      await tx.exec('CREATE TABLE sync_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
      await tx.exec(`PRAGMA user_version = ${catalogSchemaVersion}`);
    });
    return db;
  })().catch(error => { opened = undefined; throw error; });
  return opened;
}

export interface CatalogSearch {
  ids?: string[];
  category?: string;
  query?: string;
  limit?: number | null;
}

function catalogWhere(search: CatalogSearch, idColumn: string, categoryColumn: string | null,
  nameExpression: string): { clause: string; args: (string | number)[] } {
  const conditions: string[] = [];
  const args: (string | number)[] = [];
  if (search.ids) {
    if (!search.ids.length) return { clause: 'WHERE 0', args };
    conditions.push(`${idColumn} IN (${search.ids.map(() => '?').join(', ')})`);
    args.push(...search.ids);
  }
  if (categoryColumn && search.category) {
    conditions.push(`${categoryColumn} = ?`);
    args.push(search.category);
  }
  if (search.query?.trim()) {
    conditions.push(`instr(lower(${nameExpression}), lower(?)) > 0`);
    args.push(search.query.trim());
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', args };
}

/** Return only the model rows a screen needs, with image availability as booleans. */
export async function queryCatalogModels(search: CatalogSearch = {}): Promise<CatalogEquipment[]> {
  const db = await openLocalCatalog();
  const where = catalogWhere(search, 'm.id', 'm.kind',
    "p.name || ' ' || coalesce(p.manufacturer, '') || ' ' || m.kind");
  const unlimited = !!search.ids || search.limit === null;
  const limit = unlimited ? '' : ' LIMIT ?';
  const args = unlimited ? where.args : [...where.args, Math.min(5000, Math.max(1, search.limit ?? 80))];
  const rows = await db.execO<CatalogEquipment>(`SELECT m.id, p.name, m.kind, p.manufacturer, p.product_url,
    maker.website_url AS manufacturer_website_url,
    liquid.model_id IS NOT NULL AS has_liquid_containment, liquid.capacity_liters,
    pressure.model_id IS NOT NULL AS has_pressure_rating, pressure.max_pressure_kpa,
    heating.model_id IS NOT NULL AS has_heating, heating.rated_power_watts,
    boil.heat_loss_watts AS boil_heat_loss_watts,
    cooling.model_id IS NOT NULL AS has_cooling, cooling.rated_heat_removal_watts,
    control.model_id IS NOT NULL AS has_temperature_control,
    control.model_id IS NOT NULL AS built_in_temperature_control,
    control.min_temperature_c, control.max_temperature_c,
    p.image_url IS NOT NULL AS has_image, p.thumbnail_url IS NOT NULL AS has_thumbnail,
    logo.logo_url IS NOT NULL AS has_manufacturer_logo
    FROM equipment_models m JOIN products p ON p.id = m.id
    LEFT JOIN manufacturers maker ON maker.name = p.manufacturer
    LEFT JOIN model_liquid_containment liquid ON liquid.model_id = m.id
    LEFT JOIN model_pressure_rating pressure ON pressure.model_id = m.id
    LEFT JOIN model_heating heating ON heating.model_id = m.id
    LEFT JOIN model_boil_characterization boil ON boil.model_id = m.id
    LEFT JOIN model_cooling cooling ON cooling.model_id = m.id
    LEFT JOIN model_temperature_control control ON control.model_id = m.id
    LEFT JOIN manufacturer_logos logo ON logo.manufacturer_name = p.manufacturer
    ${where.clause} ORDER BY p.name COLLATE NOCASE${limit}`, args);
  const byId = new Map(rows.map(row => [row.id, {
    ...row,
    has_image: Boolean(row.has_image), has_thumbnail: Boolean(row.has_thumbnail),
    has_manufacturer_logo: Boolean(row.has_manufacturer_logo),
    measurement_channels: [] as CatalogMeasurementChannel[]
  }]));
  const channels = rows.length ? await db.execO<CatalogMeasurementChannel>(`SELECT * FROM model_measurement_channels
    WHERE model_id IN (${rows.map(() => '?').join(', ')})`, rows.map(row => row.id)) : [];
  for (const channel of channels) byId.get(channel.model_id)?.measurement_channels.push(channel);
  const models = [...byId.values()].map(model => {
    const primary = model.measurement_channels.find(channel => channel.measurement_kind ===
      (model.kind === 'hydrometer' || model.kind === 'refractometer' ? 'gravity' :
        model.kind === 'ph_meter' ? 'ph' : model.kind === 'scale' ? 'mass' :
          model.kind === 'pressure_gauge' ? 'pressure' : model.kind === 'carbonation_meter' ? 'carbonation' :
            model.kind === 'dissolved_oxygen_meter' ? 'dissolved_oxygen' : 'temperature'));
    return { ...model, measurement_min: primary?.measurement_min, measurement_max: primary?.measurement_max,
      measurement_unit: primary?.measurement_scale || primary?.measurement_unit };
  });
  if (search.category && search.category !== 'keg') return models;
  const kegs = (await queryCatalogSupplies({ ...search, category: 'Packaging' }))
    .filter(product => product.container_kind === 'keg' && !byId.has(product.id))
    .map(product => ({ id: product.id, name: product.name, kind: 'keg',
      manufacturer: product.manufacturer, product_url: product.product_url,
      capacity_liters: product.capacity_liters, has_liquid_containment: true,
      has_image: product.has_image, has_thumbnail: false,
      measurement_channels: [] as CatalogMeasurementChannel[] }));
  return [...models, ...kegs].sort((a, b) => a.name.localeCompare(b.name));
}

/** Search local supply rows in SQLite rather than caching the catalog in React. */
export async function queryCatalogSupplies(search: CatalogSearch = {}): Promise<CatalogInventory[]> {
  const db = await openLocalCatalog();
  const where = catalogWhere(search, 's.id', 's.category',
    "p.name || ' ' || coalesce(p.manufacturer, '') || ' ' || s.category");
  const unlimited = !!search.ids || search.limit === null;
  const limit = unlimited ? '' : ' LIMIT ?';
  const args = unlimited ? where.args : [...where.args, Math.min(5000, Math.max(1, search.limit ?? 80))];
  const rows = await db.execO<CatalogInventory>(`SELECT s.id, p.name, s.category, s.unit,
      g.yield_pct, g.color_lovibond, h.alpha_acid_pct, h.hop_form, y.attenuation_pct,
      other.typical_brix, other.extract_color_value, other.extract_color_scale,
      other.extract_color_reference_value, other.extract_color_reference_unit,
      gc.grain_class, p.manufacturer, p.product_url,
      container.container_kind, container.capacity_liters, container.material,
      container.wood_species, container.wood_origin, container.connector_type,
      p.image_url IS NOT NULL AS has_image
      FROM supplies s JOIN products p ON p.id = s.id
      LEFT JOIN supply_grain_specs g ON g.supply_id = s.id
      LEFT JOIN supply_other_fermentable_specs other ON other.supply_id = s.id
      LEFT JOIN supply_hop_specs h ON h.supply_id = s.id
      LEFT JOIN supply_yeast_specs y ON y.supply_id = s.id
      LEFT JOIN supply_grain_classes gc ON gc.supply_id = s.id
      LEFT JOIN supply_container_specs container ON container.supply_id = s.id
      ${where.clause} ORDER BY p.name COLLATE NOCASE${limit}`, args);
  return rows.map(row => ({ ...row, has_image: Boolean(row.has_image) }));
}

export async function catalogModelKinds(): Promise<string[]> {
  const db = await openLocalCatalog();
  return (await db.execO<{ kind: string }>('SELECT DISTINCT kind FROM equipment_models WHERE kind IS NOT NULL ORDER BY kind'))
    .map(row => row.kind);
}

export async function findCatalogSupply(category: string, name: string): Promise<CatalogInventory | null> {
  const db = await openLocalCatalog();
  const match = await db.execO<{ id: string }>(`SELECT s.id FROM supplies s JOIN products p ON p.id = s.id
    WHERE s.category = ? AND p.name = ? COLLATE NOCASE LIMIT 1`,
    [category, name]);
  return match.length ? (await queryCatalogSupplies({ ids: [match[0].id] }))[0] || null : null;
}

export function referencedCatalogSupplyIds(events: { details: {
  catalog_item_id?: string; stock_bucket_id?: string; supply_id?: string } }[],
  inventory: { id: string; supply_id?: string | null; catalog_supply_id?: string | null }[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const details = event.details;
    const item = (details.stock_bucket_id ? inventory.find(row => row.id === details.stock_bucket_id) : undefined)
      || (details.supply_id ? inventory.find(row => row.id === details.supply_id || row.supply_id === details.supply_id) : undefined);
    const id = details.catalog_item_id || item?.catalog_supply_id;
    if (id) ids.add(id);
  }
  return [...ids];
}

export async function syncLocalCatalog(db: DB, onProgress?: (applied: number, total: number) => void,
  force = false): Promise<boolean> {
  if (syncing) {
    if (!force) return syncing;
    await syncing;
  }
  syncing = (async () => {
    const rows = await db.execO<{ key: string; value: string }>(
      "SELECT key, value FROM sync_state WHERE key IN ('serverCursor', 'serverSeq', 'lastRefreshAt')");
    const cursor = rows.find(row => row.key === 'serverCursor')?.value || '0';
    const lastRefreshAt = Number(rows.find(row => row.key === 'lastRefreshAt')?.value);
    const now = Date.now();
    if (!force && lastRefreshAt > 0 && now >= lastRefreshAt && now - lastRefreshAt < catalogRefreshIntervalMs) return false;
    let seq = rows.find(row => row.key === 'serverSeq')?.value || '0';
    if (seq === '0' && cursor !== '0') seq = maxSequence;
    const response = await fetchApi(`/api/catalog/sync?version=${cursor}&seq=${seq}`,
      { credentials: 'same-origin', headers: { [syncSchemaHeader]: String(catalogSchemaVersion) } });
    if (!response.ok) throw await syncError(response, 'Catalog sync failed');
    if (!response.body) throw new Error('Catalog sync response cannot be streamed');
    const stream = readSequence(response.body);
    const first = await stream.next();
    const header = first.value;
    if (first.done || !Array.isArray(header) || header.length !== 3 || header[0] !== syncProtocolVersion
      || !Number.isSafeInteger(header[1]) || header[1] < 0 || !/^\d+$/.test(header[2]))
      throw new Error('Invalid catalog sync header');
    const total = header[1] as number;
    const targetVersion = header[2] as string;
    let applied = 0;
    onProgress?.(0, total);
    const insert = `INSERT INTO crsql_changes (${changeColumns.map(column => `"${column}"`).join(', ')})
      VALUES (${changeColumns.map(() => '?').join(', ')})`;
    let batch: ChangeTuple[] = [];
    const apply = async () => {
      if (!batch.length) return;
      const changes = batch;
      batch = [];
      const last = changes.at(-1)!;
      await db.tx(async tx => {
        for (const change of changes) await tx.exec(insert, change);
        await tx.exec(`INSERT INTO sync_state(key,value) VALUES ('serverCursor',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(last[5])]);
        await tx.exec(`INSERT INTO sync_state(key,value) VALUES ('serverSeq',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(last[8])]);
      });
      applied += changes.length;
      onProgress?.(applied, total);
    };
    for await (const item of stream) {
      if (!validChangeTuple(item) || !catalogTables.includes(item[0] as typeof catalogTables[number]))
        throw new Error('Invalid catalog change');
      batch.push(item);
      if (batch.length >= 64) await apply();
    }
    await apply();
    if (applied !== total) throw new Error('Incomplete catalog sync');
    await db.tx(async tx => {
      await tx.exec(`INSERT INTO sync_state(key,value) VALUES ('serverCursor',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [targetVersion]);
      await tx.exec(`INSERT INTO sync_state(key,value) VALUES ('serverSeq',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [maxSequence]);
      await tx.exec(`INSERT INTO sync_state(key,value) VALUES ('lastRefreshAt',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(Date.now())]);
    });
    if (applied) invalidateCatalogMedia();
    return applied > 0;
  })().finally(() => { syncing = undefined; });
  return syncing;
}
