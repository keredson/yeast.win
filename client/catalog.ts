import initWasm, { type DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { catalogModelTables, catalogSupplyTables, catalogSchemaVersion, catalogTables,
  type CatalogEquipment, type CatalogInventory, type CatalogMeasurementChannel } from '../shared/catalog.ts';
import { changeColumns } from '../shared/schema.ts';
import { maxSequence, readSequence, syncProtocolVersion, validChangeTuple, type ChangeTuple } from '../shared/cborSync.ts';
import { fetchApi } from './api.ts';

let opened: Promise<DB> | undefined;
let syncing: Promise<boolean> | undefined;
let catalogMediaUrls: string[] = [];
const catalogRefreshIntervalMs = 7 * 24 * 60 * 60_000;

export function openLocalCatalog(): Promise<DB> {
  if (!opened) opened = (async () => {
    const sqlite = await initWasm(() => wasmUrl);
    const db = await sqlite.open('brewlog-catalog');
    const version = (await db.execO<{ user_version: number }>('PRAGMA user_version'))[0].user_version;
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
        await tx.exec('PRAGMA user_version = 12');
      });
    } else if (version > catalogSchemaVersion) {
      throw new Error(`This app cannot open catalog schema ${version}; update Brewlog first.`);
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
    return db;
  })().catch(error => { opened = undefined; throw error; });
  return opened;
}

export async function readLocalCatalog(db: DB): Promise<{ equipment: CatalogEquipment[]; inventory: CatalogInventory[] }> {
  const [models, liquid, pressure, heating, boil, cooling, control, channels, modelImages, logos, inventory, supplyImages] = await Promise.all([
    db.execO<{ id: string; name: string; kind: string; manufacturer: string | null;
      product_url: string | null; manufacturer_website_url: string | null }>(
      `SELECT m.id, m.model_name AS name, m.kind, m.manufacturer, m.product_url,
        maker.website_url AS manufacturer_website_url
        FROM equipment_models m LEFT JOIN manufacturers maker ON maker.name = m.manufacturer
        ORDER BY m.model_name COLLATE NOCASE`),
    db.execO<{ model_id: string; capacity_liters: number | null }>('SELECT * FROM model_liquid_containment'),
    db.execO<{ model_id: string; max_pressure_kpa: number | null }>('SELECT * FROM model_pressure_rating'),
    db.execO<{ model_id: string; rated_power_watts: number | null }>('SELECT * FROM model_heating'),
    db.execO<{ model_id: string; heat_loss_watts: number | null }>('SELECT * FROM model_boil_characterization'),
    db.execO<{ model_id: string; rated_heat_removal_watts: number | null }>('SELECT * FROM model_cooling'),
    db.execO<{ model_id: string; min_temperature_c: number | null; max_temperature_c: number | null }>(
      'SELECT * FROM model_temperature_control'),
    db.execO<CatalogMeasurementChannel>('SELECT * FROM model_measurement_channels'),
    db.execO<{ model_id: string; image_bytes: Uint8Array | null; image_mime_type: string | null;
      thumbnail_bytes: Uint8Array | null; thumbnail_mime_type: string | null }>('SELECT * FROM model_images'),
    db.execO<{ manufacturer_name: string; image_bytes: Uint8Array | null;
      mime_type: string | null }>('SELECT * FROM manufacturer_logos'),
    db.execO<CatalogInventory>(`SELECT s.id, s.name, s.category, s.unit,
      g.yield_pct, g.color_lovibond, h.alpha_acid_pct, h.hop_form, y.attenuation_pct,
      gc.grain_class, p.manufacturer, p.product_url, p.spec_source_url
      FROM supplies s LEFT JOIN supply_grain_specs g ON g.supply_id = s.id
      LEFT JOIN supply_hop_specs h ON h.supply_id = s.id
      LEFT JOIN supply_yeast_specs y ON y.supply_id = s.id
      LEFT JOIN supply_grain_classes gc ON gc.supply_id = s.id
      LEFT JOIN supply_products p ON p.supply_id = s.id ORDER BY s.name COLLATE NOCASE`),
    db.execO<{ supply_id: string; image_bytes: Uint8Array | null; image_mime_type: string | null }>(
      'SELECT * FROM supply_images')
  ]);
  const oldMediaUrls = catalogMediaUrls;
  catalogMediaUrls = [];
  const mediaUrl = (bytes: Uint8Array, mimeType: string): string => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
    catalogMediaUrls.push(url);
    return url;
  };
  const byId = new Map(models.map(model => [model.id, { ...model, measurement_channels: [] as CatalogMeasurementChannel[] }]));
  for (const row of modelImages) {
    const model = byId.get(row.model_id);
    if (model) Object.assign(model, {
      image_src: row.image_bytes && mediaUrl(row.image_bytes, row.image_mime_type || 'application/octet-stream'),
      thumbnail_src: row.thumbnail_bytes && mediaUrl(row.thumbnail_bytes,
        row.thumbnail_mime_type || 'application/octet-stream')
    });
  }
  const logosByName = new Map(logos.filter(row => row.image_bytes).map(row =>
    [row.manufacturer_name, mediaUrl(row.image_bytes!, row.mime_type || 'application/octet-stream')]));
  for (const model of byId.values()) {
    if (model.manufacturer) Object.assign(model, { manufacturer_logo_src: logosByName.get(model.manufacturer) });
  }
  const suppliesById = new Map(inventory.map(item => [item.id, item]));
  for (const row of supplyImages) {
    const item = suppliesById.get(row.supply_id);
    if (item && row.image_bytes) item.image_src = mediaUrl(row.image_bytes,
      row.image_mime_type || 'application/octet-stream');
  }
  for (const url of oldMediaUrls) URL.revokeObjectURL(url);
  for (const row of liquid) Object.assign(byId.get(row.model_id) || {},
    { has_liquid_containment: true, capacity_liters: row.capacity_liters });
  for (const row of pressure) Object.assign(byId.get(row.model_id) || {},
    { has_pressure_rating: true, max_pressure_kpa: row.max_pressure_kpa });
  for (const row of heating) Object.assign(byId.get(row.model_id) || {},
    { has_heating: true, rated_power_watts: row.rated_power_watts });
  for (const row of boil) Object.assign(byId.get(row.model_id) || {},
    { boil_heat_loss_watts: row.heat_loss_watts });
  for (const row of cooling) Object.assign(byId.get(row.model_id) || {},
    { has_cooling: true, rated_heat_removal_watts: row.rated_heat_removal_watts });
  for (const row of control) Object.assign(byId.get(row.model_id) || {}, {
    min_temperature_c: row.min_temperature_c, max_temperature_c: row.max_temperature_c,
    built_in_temperature_control: true, has_temperature_control: true
  });
  for (const channel of channels) byId.get(channel.model_id)?.measurement_channels.push(channel);
  const equipment: CatalogEquipment[] = [...byId.values()].map(model => {
    const primary = model.measurement_channels.find(channel => channel.measurement_kind ===
      (model.kind === 'hydrometer' || model.kind === 'refractometer' ? 'gravity' :
        model.kind === 'ph_meter' ? 'ph' : model.kind === 'scale' ? 'mass' :
          model.kind === 'pressure_gauge' ? 'pressure' : model.kind === 'carbonation_meter' ? 'carbonation' :
            model.kind === 'dissolved_oxygen_meter' ? 'dissolved_oxygen' : 'temperature'));
    return { ...model, measurement_min: primary?.measurement_min, measurement_max: primary?.measurement_max,
      measurement_unit: primary?.measurement_scale || primary?.measurement_unit };
  });
  return { equipment, inventory };
}

export function syncLocalCatalog(db: DB, onProgress?: (applied: number, total: number) => void): Promise<boolean> {
  if (syncing) return syncing;
  syncing = (async () => {
    const rows = await db.execO<{ key: string; value: string }>(
      "SELECT key, value FROM sync_state WHERE key IN ('serverCursor', 'serverSeq', 'lastRefreshAt')");
    const cursor = rows.find(row => row.key === 'serverCursor')?.value || '0';
    const lastRefreshAt = Number(rows.find(row => row.key === 'lastRefreshAt')?.value);
    const now = Date.now();
    if (lastRefreshAt > 0 && now >= lastRefreshAt && now - lastRefreshAt < catalogRefreshIntervalMs) return false;
    let seq = rows.find(row => row.key === 'serverSeq')?.value || '0';
    if (seq === '0' && cursor !== '0') seq = maxSequence;
    const response = await fetchApi(`/api/catalog/sync?version=${cursor}&seq=${seq}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Catalog sync failed');
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
    return true;
  })().finally(() => { syncing = undefined; });
  return syncing;
}
