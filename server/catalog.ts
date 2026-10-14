import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { catalogModelTables, catalogSupplyTables, catalogSchemaVersion,
  catalogTables, initialCatalogEquipment, initialCatalogInventory,
  antonPaarEquipment, vevorModelName,
  type CatalogChanges, type CatalogEquipment, type CatalogInventory } from '../shared/catalog.ts';
import { boilOffKinds, vesselKinds } from '../shared/equipment.ts';
import { catalogManufacturers, expandedCatalogEquipment,
  existingModelSources, catalogMeasurementUpdates } from '../shared/catalogEquipmentExpansion.ts';
import { encodeChange, type SqlChangeRow } from '../shared/wire.ts';
import { projectRoot } from './db.ts';

const selectChanges = `SELECT "table", pk, cid, val, col_version, db_version,
  COALESCE(site_id, crsql_site_id()) AS site_id, cl, seq
  FROM crsql_changes WHERE db_version > ? ORDER BY db_version, seq`;

function bundledModelIds(): string[] {
  return readdirSync(join(projectRoot, 'assets/catalog/models'))
    .filter(name => name.endsWith('.jpg') && !name.endsWith('-thumb.jpg'))
    .map(name => name.slice(0, -'.jpg'.length));
}

function seedModelImages(db: Database.Database): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO model_images
    (model_id, image_bytes, image_mime_type, thumbnail_bytes, thumbnail_mime_type)
    VALUES (?, ?, ?, ?, ?)`);
  for (const id of bundledModelIds()) {
    const path = join(projectRoot, 'assets/catalog/models', id);
    insert.run(id, readFileSync(`${path}.jpg`), 'image/jpeg', readFileSync(`${path}-thumb.jpg`), 'image/jpeg');
  }
}

function seedManufacturerLogos(db: Database.Database): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO manufacturer_logos
    (manufacturer_name, image_bytes, mime_type) VALUES (?, ?, ?)`);
  for (const maker of catalogManufacturers) {
    const slug = maker.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const path = join(projectRoot, 'assets/catalog/manufacturers', `${slug}.png`);
    if (existsSync(path)) insert.run(maker.name, readFileSync(path), 'image/png');
  }
}

export function openCatalogDb(dataDir: string): Database.Database {
  const db = new Database(join(dataDir, 'catalog.sqlite'));
  db.pragma('journal_mode = WAL');
  db.loadExtension(resolve(projectRoot, 'vendor/crsqlite.so'));
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > catalogSchemaVersion) {
    db.close();
    throw new Error(`This server cannot open catalog version ${version}; update Brewlog first.`);
  }
  if (version === 11) {
    db.transaction(() => {
      const addModel = db.prepare(`INSERT INTO equipment_models(id, manufacturer, model_name, kind)
        VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
      const addChannel = db.prepare(`INSERT INTO model_measurement_channels
        (id, model_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const channelKinds: Record<string, string> = { hydrometer: 'gravity', refractometer: 'gravity',
        carbonation_meter: 'carbonation', dissolved_oxygen_meter: 'dissolved_oxygen' };
      for (const item of antonPaarEquipment) {
        if (!addModel.run(item.id, item.manufacturer ?? null, item.name, item.kind).changes) continue;
        const scale = ['SG', '°Plato', '°Brix'].includes(item.measurement_unit || '')
          ? item.measurement_unit : null;
        addChannel.run(`${item.id}:${channelKinds[item.kind]}`, item.id, channelKinds[item.kind],
          item.measurement_min ?? null, item.measurement_max ?? null,
          scale ? null : item.measurement_unit ?? null, scale);
        for (const channel of item.measurement_channels || []) {
          addChannel.run(channel.id, item.id, channel.measurement_kind,
            channel.measurement_min ?? null, channel.measurement_max ?? null,
            channel.measurement_unit ?? null, channel.measurement_scale ?? null);
        }
      }
      db.pragma('user_version = 12');
    })();
  } else if (version < 12) {
    const hasLegacyMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_meta'").get();
    const legacyVersion = hasLegacyMeta
      ? (db.prepare('SELECT version FROM catalog_meta LIMIT 1').get() as { version: number } | undefined)?.version : undefined;
    const oldEquipment = version === 10
      ? db.prepare('SELECT * FROM equipment').all() as CatalogEquipment[] : [];
    const oldInventory = version === 10
      ? db.prepare('SELECT * FROM inventory').all() as CatalogInventory[]
      : legacyVersion === 9 ? db.prepare('SELECT * FROM catalog_inventory').all() as CatalogInventory[] : [];
    db.transaction(() => {
      const clocks = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__crsql_clock'").all() as { name: string }[];
      for (const row of clocks) {
        db.prepare('SELECT crsql_as_table(?)').get(row.name.replace('__crsql_clock', ''));
      }
      for (const table of ['catalog_equipment', 'catalog_inventory', 'equipment', 'inventory',
        ...Object.keys(catalogModelTables)]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
      db.exec('DROP TABLE IF EXISTS catalog_meta');
      for (const statement of [...Object.values(catalogModelTables), ...Object.values(catalogSupplyTables)]) db.exec(statement);
      for (const table of catalogTables) db.prepare('SELECT crsql_as_crr(?)').get(table);
      const addModel = db.prepare(`INSERT INTO equipment_models(id, manufacturer, model_name, kind)
        VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
      const addLiquid = db.prepare('INSERT INTO model_liquid_containment(model_id, capacity_liters) VALUES (?, ?)');
      const addPressure = db.prepare('INSERT INTO model_pressure_rating(model_id, max_pressure_kpa) VALUES (?, ?)');
      const addHeating = db.prepare('INSERT INTO model_heating(model_id, rated_power_watts) VALUES (?, ?)');
      const addCooling = db.prepare('INSERT INTO model_cooling(model_id, rated_heat_removal_watts) VALUES (?, ?)');
      const addControl = db.prepare(`INSERT INTO model_temperature_control(model_id, min_temperature_c, max_temperature_c)
        VALUES (?, ?, ?)`);
      const addChannel = db.prepare(`INSERT INTO model_measurement_channels
        (id, model_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const addInventory = db.prepare(`INSERT INTO supplies(id, name, category, unit) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`);
      for (const item of [...oldEquipment, ...initialCatalogEquipment]) {
        if (!addModel.run(item.id, item.manufacturer ?? null, item.name, item.kind).changes) continue;
        if (vesselKinds.has(item.kind) || item.capacity_liters != null) addLiquid.run(item.id, item.capacity_liters ?? null);
        if (item.max_pressure_kpa != null) addPressure.run(item.id, item.max_pressure_kpa);
        if (boilOffKinds.has(item.kind) || item.rated_power_watts != null) addHeating.run(item.id, item.rated_power_watts ?? null);
        if (item.rated_heat_removal_watts != null) addCooling.run(item.id, item.rated_heat_removal_watts);
        if (item.built_in_temperature_control || boilOffKinds.has(item.kind)
          || item.kind === 'fermentation_temperature_control') {
          addControl.run(item.id, item.min_temperature_c ?? null, item.max_temperature_c ?? null);
        }
        const measurementKind: Record<string, string> = { hydrometer: 'gravity', refractometer: 'gravity',
          thermometer: 'temperature', ph_meter: 'ph', pressure_gauge: 'pressure',
          carbonation_meter: 'carbonation', dissolved_oxygen_meter: 'dissolved_oxygen', scale: 'mass' };
        const kind = measurementKind[item.kind];
        if (kind) {
          const scale = ['SG', '°Plato', '°Brix', 'pH'].includes(item.measurement_unit || '')
            ? item.measurement_unit : null;
          addChannel.run(`${item.id}:${kind}`, item.id, kind, item.measurement_min ?? null,
            item.measurement_max ?? null, scale ? null : item.measurement_unit ?? null, scale);
        }
        for (const channel of item.measurement_channels || []) {
          addChannel.run(channel.id, item.id, channel.measurement_kind,
            channel.measurement_min ?? null, channel.measurement_max ?? null,
            channel.measurement_unit ?? null, channel.measurement_scale ?? null);
        }
        if (['equipment_tilt', 'equipment_rapt_pill'].includes(item.id)) {
          addChannel.run(`${item.id}:temperature`, item.id, 'temperature', null, null, '°C', null);
        }
      }
      for (const item of [...oldInventory, ...initialCatalogInventory]) {
        addInventory.run(item.id, item.name, item.category, item.unit);
      }
      db.pragma('user_version = 12');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) === 12) {
    db.transaction(() => {
      db.exec(catalogModelTables.model_boil_characterization);
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'model_boil_characterization__crsql_clock'").get()) {
        db.prepare("SELECT crsql_as_crr('model_boil_characterization')").get();
      }
      db.pragma('user_version = 13');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) === 13) {
    db.transaction(() => {
      for (const statement of Object.values(catalogSupplyTables)) db.exec(statement);
      for (const table of Object.keys(catalogSupplyTables)) {
        if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(`${table}__crsql_clock`)) {
          db.prepare('SELECT crsql_as_crr(?)').get(table);
        }
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inventory'").get()) {
        db.exec('INSERT OR IGNORE INTO supplies(id, name, category, unit) SELECT id, name, category, unit FROM inventory');
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'inventory__crsql_clock'").get()) {
          db.prepare("SELECT crsql_as_table('inventory')").get();
        }
        db.exec('DROP TABLE inventory');
      }
      const crystal = db.prepare('SELECT 1 FROM supplies WHERE id = ?').get('inventory_crystal_60');
      if (crystal) db.prepare('INSERT OR IGNORE INTO supply_grain_specs(supply_id, color_lovibond) VALUES (?, ?)')
        .run('inventory_crystal_60', 60);
      db.pragma('user_version = 14');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) === 14) {
    // CR-SQLite refreshes the altered table's triggers on commit. Creating and
    // writing a second CRR in that same transaction leaves its schema cache stale.
    db.transaction(() => {
      const missingColumns = ['product_url'].filter(column =>
        !(db.pragma('table_info(equipment_models)') as { name: string }[]).some(row => row.name === column));
      if (missingColumns.length) {
        db.prepare("SELECT crsql_begin_alter('equipment_models')").get();
        for (const column of missingColumns) db.exec(`ALTER TABLE equipment_models ADD COLUMN ${column} TEXT`);
        db.prepare("SELECT crsql_commit_alter('equipment_models')").get();
      }
    })();
    db.transaction(() => {
      db.exec(catalogModelTables.manufacturers);
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'manufacturers__crsql_clock'").get()) {
        db.prepare("SELECT crsql_as_crr('manufacturers')").get();
      }
      const addManufacturer = db.prepare(`INSERT INTO manufacturers(name, website_url) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET website_url = COALESCE(manufacturers.website_url, excluded.website_url)`);
      for (const maker of catalogManufacturers) addManufacturer.run(maker.name, maker.website_url);
      for (const row of db.prepare('SELECT DISTINCT manufacturer FROM equipment_models WHERE manufacturer IS NOT NULL').all() as { manufacturer: string }[]) {
        addManufacturer.run(row.manufacturer, null);
      }
      const updateModel = db.prepare(`UPDATE equipment_models SET
        manufacturer = COALESCE(manufacturer, @manufacturer),
        product_url = COALESCE(product_url, @product_url) WHERE id = @id`);
      const insertModel = db.prepare(`INSERT OR IGNORE INTO equipment_models
        (id, manufacturer, model_name, kind, product_url)
        VALUES (@id, @manufacturer, @name, @kind, @product_url)`);
      const fill = (table: string, column: string, id: string, value: number | undefined) => {
        if (value == null) return;
        db.prepare(`INSERT INTO ${table}(model_id, ${column}) VALUES (?, ?)
          ON CONFLICT(model_id) DO UPDATE SET ${column} = COALESCE(${table}.${column}, excluded.${column})`).run(id, value);
      };
      const addChannel = db.prepare(`INSERT OR IGNORE INTO model_measurement_channels
        (id, model_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const addModelValues = (item: CatalogEquipment) => {
        if (vesselKinds.has(item.kind)) db.prepare('INSERT OR IGNORE INTO model_liquid_containment(model_id) VALUES (?)').run(item.id);
        if (boilOffKinds.has(item.kind)) db.prepare('INSERT OR IGNORE INTO model_heating(model_id) VALUES (?)').run(item.id);
        fill('model_liquid_containment', 'capacity_liters', item.id, item.capacity_liters ?? undefined);
        fill('model_pressure_rating', 'max_pressure_kpa', item.id, item.max_pressure_kpa ?? undefined);
        fill('model_heating', 'rated_power_watts', item.id, item.rated_power_watts ?? undefined);
        fill('model_cooling', 'rated_heat_removal_watts', item.id, item.rated_heat_removal_watts ?? undefined);
        if (item.built_in_temperature_control) db.prepare(`INSERT OR IGNORE INTO model_temperature_control
          (model_id, min_temperature_c, max_temperature_c) VALUES (?, ?, ?)`).run(item.id,
          item.min_temperature_c ?? null, item.max_temperature_c ?? null);
        const measurementKinds: Record<string, string> = { hydrometer: 'gravity', thermometer: 'temperature',
          ph_meter: 'ph', refractometer: 'gravity', scale: 'mass' };
        const measurementKind = measurementKinds[item.kind];
        if (measurementKind) {
          const scale = ['SG', '°Plato', '°Brix', 'pH'].includes(item.measurement_unit || '') ? item.measurement_unit : null;
          addChannel.run(`${item.id}:${measurementKind}`, item.id, measurementKind,
            item.measurement_min ?? null, item.measurement_max ?? null,
            scale ? null : item.measurement_unit ?? null, scale);
        }
        for (const channel of item.measurement_channels || []) addChannel.run(channel.id, item.id,
          channel.measurement_kind, channel.measurement_min ?? null, channel.measurement_max ?? null,
          channel.measurement_unit ?? null, channel.measurement_scale ?? null);
      };
      for (const item of expandedCatalogEquipment) {
        const params = { ...item, manufacturer: item.manufacturer ?? null, product_url: item.product_url ?? null };
        insertModel.run(params);
        updateModel.run(params);
        addModelValues(item);
      }
      for (const [id, source] of Object.entries(existingModelSources)) {
        updateModel.run({ id, manufacturer: source.manufacturer ?? null, product_url: source.product_url ?? null });
        if (source.capacity_liters != null) fill('model_liquid_containment', 'capacity_liters', id, source.capacity_liters);
        if (source.rated_power_watts != null) fill('model_heating', 'rated_power_watts', id, source.rated_power_watts);
        if (source.measurement_min != null || source.measurement_max != null) {
          const kind = id === 'equipment_thermapen_one' ? 'temperature' : 'gravity';
          const scale = ['SG', '°Plato', '°Brix', 'pH'].includes(source.measurement_unit || '');
          db.prepare(`UPDATE model_measurement_channels SET
            measurement_min = COALESCE(measurement_min, ?), measurement_max = COALESCE(measurement_max, ?),
            measurement_unit = COALESCE(measurement_unit, ?), measurement_scale = COALESCE(measurement_scale, ?)
            WHERE id = ?`).run(source.measurement_min ?? null, source.measurement_max ?? null,
            scale ? null : source.measurement_unit ?? null, scale ? source.measurement_unit : null, `${id}:${kind}`);
        }
      }
      const inferredManufacturers: [string, string][] = [
        ['equipment_anton_paar_', 'Anton Paar'], ['equipment_rapt_', 'KegLand'],
        ['equipment_fermzilla_', 'KegLand'], ['equipment_brewzilla_', 'KegLand'],
        ['equipment_digiboil_', 'KegLand'], ['equipment_grainfather_', 'Grainfather']
      ];
      const assignManufacturer = db.prepare(`UPDATE equipment_models SET manufacturer = ?
        WHERE id = ? AND manufacturer IS NULL`);
      for (const { id } of db.prepare('SELECT id FROM equipment_models').all() as { id: string }[]) {
        const maker = inferredManufacturers.find(([prefix]) => id.startsWith(prefix))?.[1];
        if (maker) assignManufacturer.run(maker, id);
      }
      db.pragma('user_version = 15');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) === 15) {
    db.transaction(() => {
      for (const table of ['model_images', 'manufacturer_logos'] as const) {
        db.exec(catalogModelTables[table]);
        if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(`${table}__crsql_clock`)) {
          db.prepare('SELECT crsql_as_crr(?)').get(table);
        }
      }
      db.pragma('user_version = 16');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) === 16) {
    for (const [table, columns] of [
      ['equipment_models', ['image_url', 'thumbnail_url']],
      ['manufacturers', ['logo_url']]
    ] as const) {
      db.transaction(() => {
        const present = new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map(row => row.name));
        if (!columns.some(column => present.has(column))) return;
        db.prepare('SELECT crsql_begin_alter(?)').get(table);
        for (const column of columns) if (present.has(column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        db.prepare('SELECT crsql_commit_alter(?)').get(table);
      })();
    }
    db.transaction(() => {
      db.pragma('user_version = 17');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) === 17) {
    for (const [table, renamed, added] of [
      ['model_images', [['image_webp', 'image_bytes'], ['thumbnail_webp', 'thumbnail_bytes']],
        ['image_mime_type', 'thumbnail_mime_type']],
      ['manufacturer_logos', [['image_webp', 'image_bytes']], ['mime_type']]
    ] as const) {
      db.transaction(() => {
        const present = new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map(row => row.name));
        if (!renamed.some(([old]) => present.has(old)) && !added.some(column => !present.has(column))) return;
        db.prepare('SELECT crsql_begin_alter(?)').get(table);
        for (const [old, current] of renamed) if (present.has(old)) db.exec(`ALTER TABLE ${table} RENAME COLUMN ${old} TO ${current}`);
        for (const column of added) if (!present.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
        db.prepare('SELECT crsql_commit_alter(?)').get(table);
      })();
    }
    db.transaction(() => {
      const mime = (column: string) => `CASE
        WHEN substr(${column}, 1, 3) = x'FFD8FF' THEN 'image/jpeg'
        WHEN substr(${column}, 1, 4) = x'89504E47' THEN 'image/png'
        WHEN substr(${column}, 1, 4) = x'52494646' AND substr(${column}, 9, 4) = x'57454250' THEN 'image/webp'
        ELSE 'application/octet-stream' END`;
      db.exec(`UPDATE model_images SET
        image_mime_type = ${mime('image_bytes')} WHERE image_bytes IS NOT NULL AND image_mime_type IS NULL`);
      db.exec(`UPDATE model_images SET
        thumbnail_mime_type = ${mime('thumbnail_bytes')}
        WHERE thumbnail_bytes IS NOT NULL AND thumbnail_mime_type IS NULL`);
      db.exec(`UPDATE manufacturer_logos SET mime_type = ${mime('image_bytes')}
        WHERE image_bytes IS NOT NULL AND mime_type IS NULL`);
      seedModelImages(db);
      const insertLogo = db.prepare(`INSERT OR IGNORE INTO manufacturer_logos
        (manufacturer_name, image_bytes, mime_type) VALUES (?, ?, ?)`);
      for (const maker of catalogManufacturers) {
        const slug = maker.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const path = join(projectRoot, 'assets/catalog/manufacturers', `${slug}.png`);
        if (existsSync(path)) insertLogo.run(maker.name, readFileSync(path), 'image/png');
      }
      db.pragma('user_version = 18');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) === 18) {
    // Replace only bytes that exactly match the former bundled images. A catalog
    // editor may have changed a photo independently of the bundled default.
    const legacy = JSON.parse(readFileSync(join(projectRoot, 'assets/catalog/legacy-webp-sha256.json'), 'utf8')) as {
      models: Record<string, { image: string; thumbnail: string }>;
      logos: Record<string, string>;
    };
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    db.transaction(() => {
      const model = db.prepare('SELECT image_bytes, thumbnail_bytes FROM model_images WHERE model_id = ?');
      const updateImage = db.prepare(`UPDATE model_images SET image_bytes = ?, image_mime_type = 'image/jpeg'
        WHERE model_id = ?`);
      const updateThumbnail = db.prepare(`UPDATE model_images SET thumbnail_bytes = ?, thumbnail_mime_type = 'image/jpeg'
        WHERE model_id = ?`);
      for (const [id, prior] of Object.entries(legacy.models)) {
        const row = model.get(id) as { image_bytes: Buffer | null; thumbnail_bytes: Buffer | null } | undefined;
        if (!row) continue;
        const path = join(projectRoot, 'assets/catalog/models', id);
        if (row.image_bytes && hash(row.image_bytes) === prior.image) {
          updateImage.run(readFileSync(`${path}.jpg`), id);
        }
        if (row.thumbnail_bytes && hash(row.thumbnail_bytes) === prior.thumbnail) {
          updateThumbnail.run(readFileSync(`${path}-thumb.jpg`), id);
        }
      }
      const logo = db.prepare('SELECT image_bytes FROM manufacturer_logos WHERE manufacturer_name = ?');
      const updateLogo = db.prepare(`UPDATE manufacturer_logos SET image_bytes = ?, mime_type = 'image/png'
        WHERE manufacturer_name = ?`);
      for (const maker of catalogManufacturers) {
        const slug = maker.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const prior = legacy.logos[slug];
        if (!prior) continue;
        const row = logo.get(maker.name) as { image_bytes: Buffer | null } | undefined;
        if (row?.image_bytes && hash(row.image_bytes) === prior) {
          updateLogo.run(readFileSync(join(projectRoot, 'assets/catalog/manufacturers', `${slug}.png`)), maker.name);
        }
      }
      db.pragma('user_version = 19');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) === 19) {
    db.transaction(() => {
      db.prepare(`UPDATE equipment_models SET product_url = ?
        WHERE id = ? AND product_url = ?`).run(
          'https://us.grainfather.com/products/g40-brewing-system', 'equipment_grainfather_g40',
          'https://us.grainfather.com/pages/compare-the-grainfather-brewing-systems');
      const updateModel = db.prepare(`UPDATE equipment_models SET
        manufacturer = COALESCE(manufacturer, ?), product_url = COALESCE(product_url, ?)
        WHERE id = ?`);
      const fill = (table: string, column: string, id: string, value: number | null | undefined) => {
        if (value == null) return;
        db.prepare(`INSERT INTO ${table}(model_id, ${column}) VALUES (?, ?)
          ON CONFLICT(model_id) DO UPDATE SET ${column} = COALESCE(${table}.${column}, excluded.${column})`)
          .run(id, value);
      };
      for (const item of [...expandedCatalogEquipment, ...Object.entries(existingModelSources)
        .map(([id, source]) => ({ id, ...source }))]) {
        updateModel.run(item.manufacturer ?? null, item.product_url ?? null, item.id);
        fill('model_liquid_containment', 'capacity_liters', item.id, item.capacity_liters);
        fill('model_heating', 'rated_power_watts', item.id, item.rated_power_watts);
        fill('model_cooling', 'rated_heat_removal_watts', item.id, item.rated_heat_removal_watts);
        fill('model_temperature_control', 'min_temperature_c', item.id, item.min_temperature_c);
        fill('model_temperature_control', 'max_temperature_c', item.id, item.max_temperature_c);
      }
      const fillChannel = db.prepare(`INSERT INTO model_measurement_channels
        (id, model_id, measurement_kind, measurement_min, measurement_max, measurement_unit, measurement_scale)
        VALUES (@id, @model_id, @measurement_kind, @measurement_min, @measurement_max, @measurement_unit, @measurement_scale)
        ON CONFLICT(id) DO UPDATE SET
          measurement_min = COALESCE(model_measurement_channels.measurement_min, excluded.measurement_min),
          measurement_max = COALESCE(model_measurement_channels.measurement_max, excluded.measurement_max),
          measurement_unit = COALESCE(model_measurement_channels.measurement_unit, excluded.measurement_unit),
          measurement_scale = COALESCE(model_measurement_channels.measurement_scale, excluded.measurement_scale)`);
      for (const item of catalogMeasurementUpdates) fillChannel.run({
        id: `${item.model_id}:${item.measurement_kind}`,
        model_id: item.model_id,
        measurement_kind: item.measurement_kind,
        measurement_min: item.measurement_min,
        measurement_max: item.measurement_max,
        measurement_unit: 'measurement_unit' in item ? item.measurement_unit : null,
        measurement_scale: 'measurement_scale' in item ? item.measurement_scale : null
      });
      // Version 16 seeded the media available at that time. Later bundled
      // photos and logos need their own CRR rows on upgraded catalogs too.
      seedModelImages(db);
      seedManufacturerLogos(db);
      db.pragma('user_version = 20');
    })();
  }
  db.prepare(`UPDATE equipment_models SET model_name = ?
    WHERE id = ? AND model_name IN (?, ?)`).run(vevorModelName, 'equipment_vevor_35l',
    'VEVOR Electric Brewing System 9.2 Gal/35 L Brewing Pot', 'VEVOR 35 L');
  return db;
}

export function catalogChanges(db: Database.Database, clientCursor: bigint): CatalogChanges {
  const cursor = BigInt((db.prepare('SELECT crsql_db_version() AS version').get() as { version: number | bigint }).version);
  if (clientCursor > cursor) throw new Error('Catalog cursor is ahead of the server');
  const rows = db.prepare(selectChanges).all(clientCursor) as SqlChangeRow[];
  return { serverCursor: String(cursor), changes: rows.map(encodeChange) };
}
