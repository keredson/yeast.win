import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { catalogModelTables, catalogSupplyTables, catalogSchemaVersion, catalogTables,
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
      const [table, keyColumn, valueColumn] = kind === 'supply'
        ? ['supply_images', 'supply_id', 'image_url']
        : kind === 'logo'
          ? ['manufacturer_logos', 'manufacturer_name', 'logo_url']
          : ['model_images', 'model_id', kind === 'thumbnail' ? 'thumbnail_url' : 'image_url'];
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
  const rows = await db.execO<{ url: string }>(`SELECT image_url AS url FROM supply_images WHERE image_url IS NOT NULL
    UNION SELECT image_url FROM model_images WHERE image_url IS NOT NULL
    UNION SELECT thumbnail_url FROM model_images WHERE thumbnail_url IS NOT NULL
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
    const began = performance.now();
    const profile = (step: string) => { if (profileOpen)
      console.info(`[open catalog] ${step}: ${(performance.now() - began).toFixed(1)} ms`); };
    const sqlite = await initWasm(() => wasmUrl);
    profile('SQLite WASM ready');
    const db = await sqlite.open('brewlog-catalog');
    profile('Catalog file open');
    const version = (await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version;
    if (version === catalogSchemaVersion) {
      const containerClock = await db.execO<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name = 'supply_container_specs__crsql_clock'");
      if (containerClock.length) { profile('Catalog schema ready'); return db; }
    }
    if (version === 11) {
      await db.exec('PRAGMA user_version = 12');
    } else if (version < 12) {
      const oldClocks = await db.execO<{ name: string }>(`SELECT name FROM sqlite_master
        WHERE name LIKE '%__crsql_clock'`);
      await db.tx(async tx => {
        // Catalog schemas change together on both peers. Replay the server's
        // CR-SQLite history from zero after replacing the local tables.
        for (const row of oldClocks) {
          await tx.exec('SELECT crsql_as_table(?)', [row.name.replace('__crsql_clock', '')]);
        }
        for (const table of ['catalog_equipment', 'catalog_inventory', 'equipment', 'inventory',
          ...Object.keys(catalogModelTables)]) await tx.exec(`DROP TABLE IF EXISTS "${table}"`);
        await tx.exec('DROP TABLE IF EXISTS catalog_meta');
        await tx.exec('DROP TABLE IF EXISTS catalog_sync_state');
        for (const statement of [...Object.values(catalogModelTables), ...Object.values(catalogSupplyTables)]) await tx.exec(statement);
        for (const table of catalogTables) await tx.exec('SELECT crsql_as_crr(?)', [table]);
        await tx.exec('CREATE TABLE IF NOT EXISTS sync_state(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
        await tx.exec('DELETE FROM sync_state');
        await tx.exec(`PRAGMA user_version = ${catalogSchemaVersion}`);
      });
    } else if (version > catalogSchemaVersion) {
      throw new Error(`This app cannot open catalog schema ${version}; update Yeast.Win! first.`);
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 12) {
      await db.tx(async tx => {
        await tx.exec(catalogModelTables.model_boil_characterization);
        const clock = await tx.execO<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name = 'model_boil_characterization__crsql_clock'");
        if (!clock.length) await tx.exec("SELECT crsql_as_crr('model_boil_characterization')");
        await tx.exec('PRAGMA user_version = 13');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 13) {
      await db.tx(async tx => {
        for (const statement of Object.values(catalogSupplyTables)) await tx.exec(statement);
        for (const table of Object.keys(catalogSupplyTables)) {
          const clock = await tx.execO<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name = ?", [`${table}__crsql_clock`]);
          if (!clock.length) await tx.exec('SELECT crsql_as_crr(?)', [table]);
        }
        const old = await tx.execO<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inventory'");
        if (old.length) {
          await tx.exec('INSERT OR IGNORE INTO supplies(id, name, category, unit) SELECT id, name, category, unit FROM inventory');
          const clock = await tx.execO<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'inventory__crsql_clock'");
          if (clock.length) await tx.exec("SELECT crsql_as_table('inventory')");
          await tx.exec('DROP TABLE inventory');
        }
        await tx.exec('PRAGMA user_version = 14');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 14) {
      await db.tx(async tx => {
        const columns = await tx.execO<{ name: string }>('PRAGMA table_info(equipment_models)');
        const missingColumns = ['product_url'].filter(column =>
          !columns.some(row => row.name === column));
        if (missingColumns.length) {
          await tx.exec("SELECT crsql_begin_alter('equipment_models')");
          for (const column of missingColumns) await tx.exec(`ALTER TABLE equipment_models ADD COLUMN ${column} TEXT`);
          await tx.exec("SELECT crsql_commit_alter('equipment_models')");
        }
      });
      await db.tx(async tx => {
        await tx.exec(catalogModelTables.manufacturers);
        const clock = await tx.execO<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name = 'manufacturers__crsql_clock'");
        if (!clock.length) await tx.exec("SELECT crsql_as_crr('manufacturers')");
        const syncState = await tx.execO<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'");
        if (syncState.length) await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 15');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 15) {
      await db.tx(async tx => {
        for (const table of ['model_images', 'manufacturer_logos'] as const) {
          await tx.exec(catalogModelTables[table]);
          const clock = await tx.execO<{ name: string }>(
            'SELECT name FROM sqlite_master WHERE name = ?', [`${table}__crsql_clock`]);
          if (!clock.length) await tx.exec('SELECT crsql_as_crr(?)', [table]);
        }
        const syncState = await tx.execO<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'");
        if (syncState.length) await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 16');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 16) {
      for (const [table, columns] of [
        ['equipment_models', ['image_url', 'thumbnail_url']],
        ['manufacturers', ['logo_url']]
      ] as const) {
        await db.tx(async tx => {
          const present = new Set((await tx.execO<{ name: string }>(`PRAGMA table_info(${table})`))
            .map(row => row.name));
          if (!columns.some(column => present.has(column))) return;
          await tx.exec('SELECT crsql_begin_alter(?)', [table]);
          for (const column of columns) if (present.has(column)) await tx.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
          await tx.exec('SELECT crsql_commit_alter(?)', [table]);
        });
      }
      await db.tx(async tx => {
        const syncState = await tx.execO<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'");
        if (syncState.length) await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 17');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 17) {
      for (const [table, renamed, added] of [
        ['model_images', [['image_webp', 'image_bytes'], ['thumbnail_webp', 'thumbnail_bytes']],
          ['image_mime_type', 'thumbnail_mime_type']],
        ['manufacturer_logos', [['image_webp', 'image_bytes']], ['mime_type']]
      ] as const) {
        await db.tx(async tx => {
          const present = new Set((await tx.execO<{ name: string }>(`PRAGMA table_info(${table})`))
            .map(row => row.name));
          if (!renamed.some(([old]) => present.has(old)) && !added.some(column => !present.has(column))) return;
          await tx.exec('SELECT crsql_begin_alter(?)', [table]);
          for (const [old, current] of renamed) if (present.has(old))
            await tx.exec(`ALTER TABLE ${table} RENAME COLUMN ${old} TO ${current}`);
          for (const column of added) if (!present.has(column))
            await tx.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
          await tx.exec('SELECT crsql_commit_alter(?)', [table]);
        });
      }
      await db.tx(async tx => {
        const mime = (column: string) => `CASE
          WHEN substr(${column}, 1, 3) = x'FFD8FF' THEN 'image/jpeg'
          WHEN substr(${column}, 1, 4) = x'89504E47' THEN 'image/png'
          WHEN substr(${column}, 1, 4) = x'52494646' AND substr(${column}, 9, 4) = x'57454250' THEN 'image/webp'
          ELSE 'application/octet-stream' END`;
        await tx.exec(`UPDATE model_images SET image_mime_type = ${mime('image_bytes')}
          WHERE image_bytes IS NOT NULL AND image_mime_type IS NULL`);
        await tx.exec(`UPDATE model_images SET thumbnail_mime_type = ${mime('thumbnail_bytes')}
          WHERE thumbnail_bytes IS NOT NULL AND thumbnail_mime_type IS NULL`);
        await tx.exec(`UPDATE manufacturer_logos SET mime_type = ${mime('image_bytes')}
          WHERE image_bytes IS NOT NULL AND mime_type IS NULL`);
        const syncState = await tx.execO<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'");
        if (syncState.length) await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 18');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 18) {
      await db.tx(async tx => {
        const syncState = await tx.execO<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'");
        if (syncState.length) await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 19');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 19) {
      await db.tx(async tx => {
        const syncState = await tx.execO<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'");
        if (syncState.length) await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 20');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 20) {
      await db.tx(async tx => {
        await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 21');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 21) {
      await db.tx(async tx => {
        for (const table of ['supply_grain_classes', 'supply_products', 'supply_images'] as const) {
          await tx.exec(catalogSupplyTables[table]);
          const clock = await tx.execO<{ name: string }>(
            'SELECT name FROM sqlite_master WHERE name = ?', [`${table}__crsql_clock`]);
          if (!clock.length) await tx.exec('SELECT crsql_as_crr(?)', [table]);
        }
        await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 22');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 22) {
      await db.tx(async tx => {
        await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 23');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 23) {
      await db.tx(async tx => {
        await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 24');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 24) {
      await db.tx(async tx => {
        await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 25');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 25) {
      await db.tx(async tx => {
        await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 26');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 26) {
      await db.tx(async tx => {
        const columns = new Set((await tx.execO<{ name: string }>('PRAGMA table_info(supply_products)'))
          .map(row => row.name));
        if (columns.has('spec_source_url')) {
          await tx.exec(`CREATE TEMP TABLE migration_supply_products AS
            SELECT supply_id, manufacturer, COALESCE(NULLIF(product_url, ''), spec_source_url) AS product_url
            FROM supply_products`);
          const clock = await tx.execO<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE name = 'supply_products__crsql_clock'");
          if (clock.length) await tx.exec("SELECT crsql_as_table('supply_products')");
          await tx.exec('DROP TABLE supply_products');
          await tx.exec(catalogSupplyTables.supply_products);
          await tx.exec("SELECT crsql_as_crr('supply_products')");
          await tx.exec(`INSERT INTO supply_products(supply_id, manufacturer, product_url)
            SELECT supply_id, manufacturer, product_url FROM migration_supply_products`);
          await tx.exec('DROP TABLE migration_supply_products');
        }
        await tx.exec('DELETE FROM sync_state');
        await tx.exec('PRAGMA user_version = 27');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 27) {
      await db.tx(async tx => {
        await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 28');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 28) {
      await db.tx(async tx => {
        // The authoritative catalog was consolidated from two server histories.
        // Old cursors cannot identify which history a device followed.
        for (const table of catalogTables) {
          const clock = await tx.execO<{ name: string }>(
            'SELECT name FROM sqlite_master WHERE name = ?', [`${table}__crsql_clock`]);
          if (clock.length) await tx.exec('SELECT crsql_as_table(?)', [table]);
          await tx.exec(`DROP TABLE IF EXISTS "${table}"`);
        }
        for (const statement of [...Object.values(catalogModelTables), ...Object.values(catalogSupplyTables)]) {
          await tx.exec(statement);
        }
        for (const table of catalogTables) await tx.exec('SELECT crsql_as_crr(?)', [table]);
        await tx.exec('DELETE FROM sync_state');
        await tx.exec('PRAGMA user_version = 29');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 29) {
      await db.exec('PRAGMA user_version = 30');
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 30) {
      await db.tx(async tx => {
        await tx.exec('PRAGMA user_version = 31');
      });
    }
    if ((await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version === 31) {
      await db.tx(async tx => {
        for (const [table, urlColumns, oldColumns] of [
          ['model_images', ['image_url', 'thumbnail_url'],
            ['image_bytes', 'image_mime_type', 'thumbnail_bytes', 'thumbnail_mime_type', 'image_webp', 'thumbnail_webp']],
          ['manufacturer_logos', ['logo_url'], ['image_bytes', 'mime_type', 'image_webp']],
          ['supply_images', ['image_url'], ['image_bytes', 'image_mime_type']]
        ] as const) {
          let present = new Set((await tx.execO<{ name: string }>(`PRAGMA table_info(${table})`)).map(row => row.name));
          if (urlColumns.some(column => !present.has(column)) || oldColumns.some(column => present.has(column))) {
            await tx.exec('SELECT crsql_begin_alter(?)', [table]);
            for (const column of urlColumns) if (!present.has(column))
              await tx.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
            for (const column of oldColumns) if (present.has(column))
              await tx.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
            await tx.exec('SELECT crsql_commit_alter(?)', [table]);
          }
        }
        // The server's new media URLs must be replayed even when the last
        // catalog refresh happened before this schema upgrade.
        await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
        await tx.exec('PRAGMA user_version = 32');
      });
    }
    // Reconcile a schema already marked current by an interrupted or concurrent upgrade.
    await db.tx(async tx => {
      await tx.exec(catalogSupplyTables.supply_other_fermentable_specs);
      const specsClock = await tx.execO<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name = 'supply_other_fermentable_specs__crsql_clock'");
      if (!specsClock.length) await tx.exec("SELECT crsql_as_crr('supply_other_fermentable_specs')");
      await tx.exec(catalogSupplyTables.supply_container_specs);
      const containerClock = await tx.execO<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name = 'supply_container_specs__crsql_clock'");
      if (!containerClock.length) await tx.exec("SELECT crsql_as_crr('supply_container_specs')");
      if (version < 34) await tx.exec("DELETE FROM sync_state WHERE key = 'lastRefreshAt'");
      const table = await tx.execO<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'supply_categories'");
      if (table.length) {
        const clock = await tx.execO<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name = 'supply_categories__crsql_clock'");
        if (clock.length) await tx.exec("SELECT crsql_as_table('supply_categories')");
        await tx.exec('DROP TABLE supply_categories');
      }
      await tx.exec(`PRAGMA user_version = ${catalogSchemaVersion}`);
    });
    profile('Catalog schema ready');
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
    "m.model_name || ' ' || coalesce(m.manufacturer, '') || ' ' || m.kind");
  const unlimited = !!search.ids || search.limit === null;
  const limit = unlimited ? '' : ' LIMIT ?';
  const args = unlimited ? where.args : [...where.args, Math.min(5000, Math.max(1, search.limit ?? 80))];
  const rows = await db.execO<CatalogEquipment>(`SELECT m.id, m.model_name AS name, m.kind, m.manufacturer, m.product_url,
    maker.website_url AS manufacturer_website_url,
    liquid.model_id IS NOT NULL AS has_liquid_containment, liquid.capacity_liters,
    pressure.model_id IS NOT NULL AS has_pressure_rating, pressure.max_pressure_kpa,
    heating.model_id IS NOT NULL AS has_heating, heating.rated_power_watts,
    boil.heat_loss_watts AS boil_heat_loss_watts,
    cooling.model_id IS NOT NULL AS has_cooling, cooling.rated_heat_removal_watts,
    control.model_id IS NOT NULL AS has_temperature_control,
    control.model_id IS NOT NULL AS built_in_temperature_control,
    control.min_temperature_c, control.max_temperature_c,
    image.image_url IS NOT NULL AS has_image, image.thumbnail_url IS NOT NULL AS has_thumbnail,
    logo.logo_url IS NOT NULL AS has_manufacturer_logo
    FROM equipment_models m LEFT JOIN manufacturers maker ON maker.name = m.manufacturer
    LEFT JOIN model_liquid_containment liquid ON liquid.model_id = m.id
    LEFT JOIN model_pressure_rating pressure ON pressure.model_id = m.id
    LEFT JOIN model_heating heating ON heating.model_id = m.id
    LEFT JOIN model_boil_characterization boil ON boil.model_id = m.id
    LEFT JOIN model_cooling cooling ON cooling.model_id = m.id
    LEFT JOIN model_temperature_control control ON control.model_id = m.id
    LEFT JOIN model_images image ON image.model_id = m.id
    LEFT JOIN manufacturer_logos logo ON logo.manufacturer_name = m.manufacturer
    ${where.clause} ORDER BY m.model_name COLLATE NOCASE${limit}`, args);
  if (!rows.length) return [];
  const byId = new Map(rows.map(row => [row.id, {
    ...row,
    has_image: Boolean(row.has_image), has_thumbnail: Boolean(row.has_thumbnail),
    has_manufacturer_logo: Boolean(row.has_manufacturer_logo),
    measurement_channels: [] as CatalogMeasurementChannel[]
  }]));
  const channels = await db.execO<CatalogMeasurementChannel>(`SELECT * FROM model_measurement_channels
    WHERE model_id IN (${rows.map(() => '?').join(', ')})`, rows.map(row => row.id));
  for (const channel of channels) byId.get(channel.model_id)?.measurement_channels.push(channel);
  return [...byId.values()].map(model => {
    const primary = model.measurement_channels.find(channel => channel.measurement_kind ===
      (model.kind === 'hydrometer' || model.kind === 'refractometer' ? 'gravity' :
        model.kind === 'ph_meter' ? 'ph' : model.kind === 'scale' ? 'mass' :
          model.kind === 'pressure_gauge' ? 'pressure' : model.kind === 'carbonation_meter' ? 'carbonation' :
            model.kind === 'dissolved_oxygen_meter' ? 'dissolved_oxygen' : 'temperature'));
    return { ...model, measurement_min: primary?.measurement_min, measurement_max: primary?.measurement_max,
      measurement_unit: primary?.measurement_scale || primary?.measurement_unit };
  });
}

/** Search local supply rows in SQLite rather than caching the catalog in React. */
export async function queryCatalogSupplies(search: CatalogSearch = {}): Promise<CatalogInventory[]> {
  const db = await openLocalCatalog();
  const where = catalogWhere(search, 's.id', 's.category',
    "s.name || ' ' || coalesce(p.manufacturer, '') || ' ' || s.category");
  const unlimited = !!search.ids || search.limit === null;
  const limit = unlimited ? '' : ' LIMIT ?';
  const args = unlimited ? where.args : [...where.args, Math.min(5000, Math.max(1, search.limit ?? 80))];
  const rows = await db.execO<CatalogInventory>(`SELECT s.id, s.name, s.category, s.unit,
      g.yield_pct, g.color_lovibond, h.alpha_acid_pct, h.hop_form, y.attenuation_pct,
      other.typical_brix, other.extract_color_value, other.extract_color_scale,
      other.extract_color_reference_value, other.extract_color_reference_unit,
      gc.grain_class, p.manufacturer, p.product_url,
      container.container_kind, container.capacity_liters, container.material,
      container.wood_species, container.wood_origin, container.connector_type,
      image.image_url IS NOT NULL AS has_image
      FROM supplies s LEFT JOIN supply_grain_specs g ON g.supply_id = s.id
      LEFT JOIN supply_other_fermentable_specs other ON other.supply_id = s.id
      LEFT JOIN supply_hop_specs h ON h.supply_id = s.id
      LEFT JOIN supply_yeast_specs y ON y.supply_id = s.id
      LEFT JOIN supply_grain_classes gc ON gc.supply_id = s.id
      LEFT JOIN supply_container_specs container ON container.supply_id = s.id
      LEFT JOIN supply_products p ON p.supply_id = s.id
      LEFT JOIN supply_images image ON image.supply_id = s.id
      ${where.clause} ORDER BY s.name COLLATE NOCASE${limit}`, args);
  return rows.map(row => ({ ...row, has_image: Boolean(row.has_image) }));
}

export async function catalogModelKinds(): Promise<string[]> {
  const db = await openLocalCatalog();
  return (await db.execO<{ kind: string }>('SELECT DISTINCT kind FROM equipment_models WHERE kind IS NOT NULL ORDER BY kind'))
    .map(row => row.kind);
}

export async function findCatalogSupply(category: string, name: string): Promise<CatalogInventory | null> {
  const db = await openLocalCatalog();
  const match = await db.execO<{ id: string }>(`SELECT id FROM supplies WHERE category = ? AND name = ? COLLATE NOCASE LIMIT 1`,
    [category, name]);
  return match.length ? (await queryCatalogSupplies({ ids: [match[0].id] }))[0] || null : null;
}

export function referencedCatalogSupplyIds(events: { details: {
  catalog_item_id?: string; inventory_item_id?: string; supply_id?: string } }[],
  inventory: { id: string; supply_id?: string | null; catalog_supply_id?: string | null }[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const details = event.details;
    const item = (details.inventory_item_id ? inventory.find(row => row.id === details.inventory_item_id) : undefined)
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
