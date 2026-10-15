import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createId } from '../shared/id.ts';
import { nowSeconds } from '../shared/schema.ts';

export interface RaptConnection { account_id: string; token: string }
export interface RaptDevice {
  device_id: string;
  name: string;
  device_type: string;
  last_seen_at: number;
  workspace_id: string | null;
  equipment_id: string | null;
  batch_id: string | null;
  batch_name: string | null;
}

export function raptConnection(auth: Database.Database, accountId: string): RaptConnection | null {
  return auth.prepare('SELECT account_id, token FROM rapt_connections WHERE account_id = ?')
    .get(accountId) as RaptConnection | undefined || null;
}

export function raptConnectionForToken(auth: Database.Database, token: string): RaptConnection | null {
  if (!/^[A-Za-z0-9_-]{21}(?:[A-Za-z0-9_-]{22})?$/.test(token)) return null;
  return auth.prepare('SELECT account_id, token FROM rapt_connections WHERE token = ?')
    .get(token) as RaptConnection | undefined || null;
}

export function rotateRaptToken(auth: Database.Database, accountId: string): string {
  const token = nanoid();
  auth.prepare(`INSERT INTO rapt_connections(account_id, token, created_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`)
    .run(accountId, token, nowSeconds());
  return token;
}

export function ensureRaptToken(auth: Database.Database, accountId: string): string {
  auth.prepare(`INSERT OR IGNORE INTO rapt_connections(account_id, token, created_at) VALUES (?, ?, ?)`)
    .run(accountId, nanoid(), nowSeconds());
  return raptConnection(auth, accountId)!.token;
}

export function deleteRaptIntegration(auth: Database.Database, accountId: string): void {
  auth.transaction(() => {
    auth.prepare('DELETE FROM rapt_connections WHERE account_id = ?').run(accountId);
    auth.prepare('DELETE FROM rapt_assignments WHERE account_id = ?').run(accountId);
    auth.prepare('DELETE FROM rapt_devices WHERE account_id = ?').run(accountId);
  })();
}

type WorkspaceGetter = (id: string) => Database.Database;
type DeviceLink = { name: string; workspace_id: string | null; equipment_id: string | null;
  legacy_migrated: number; brewery_choice_made: number };

function equipmentId(accountId: string, workspaceId: string, deviceId: string): string {
  return `rp_${createHash('sha256').update(`${accountId}:${workspaceId}:${deviceId}`).digest('base64url').slice(0, 20)}`;
}

function deviceLink(auth: Database.Database, accountId: string, deviceId: string): DeviceLink | undefined {
  return auth.prepare(`SELECT name, workspace_id, equipment_id, legacy_migrated, brewery_choice_made FROM rapt_devices
    WHERE account_id = ? AND device_id = ?`).get(accountId, deviceId) as DeviceLink | undefined;
}

function ensureEquipment(workspace: Database.Database, accountId: string, workspaceId: string,
  deviceId: string, name: string): string {
  const id = equipmentId(accountId, workspaceId, deviceId);
  workspace.transaction(() => {
    const existing = workspace.prepare('SELECT id, removed_at FROM equipment WHERE id = ?')
      .get(id) as { id: string; removed_at: number | null } | undefined;
    if (existing) {
      if (existing.removed_at != null) workspace.prepare('UPDATE equipment SET removed_at = NULL, name = ? WHERE id = ?')
        .run(name, id);
      return;
    }
    let model = workspace.prepare(`SELECT p.id FROM products p JOIN equipment_model_specs s ON s.id = p.id
      WHERE p.catalog_product_id = 'equipment_rapt_pill' LIMIT 1`).get() as { id: string } | undefined;
    if (!model) {
      const modelId = createId();
      workspace.prepare(`INSERT INTO products(id, name, catalog_product_id, created_at) VALUES
        (?, 'KegLand RAPT Pill Hydrometer and Thermometer', 'equipment_rapt_pill', ?)`).run(modelId, nowSeconds());
      workspace.prepare("INSERT INTO equipment_model_specs(id, kind) VALUES (?, 'hydrometer')").run(modelId);
      model = { id: modelId };
    }
    const at = nowSeconds();
    workspace.prepare(`INSERT INTO equipment(id, name, model_id, added_at, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(id, name, model.id, at, at);
  })();
  return id;
}

function activeUse(workspace: Database.Database, id: string): { batch_id: string; batch_name: string } | undefined {
  return workspace.prepare(`SELECT e.batch_id, b.name AS batch_name FROM batch_events e
    JOIN equipment_use_events u ON u.event_id = e.id JOIN batches b ON b.id = e.batch_id
    LEFT JOIN event_ends x ON x.id = e.id
    WHERE u.equipment_id = ? AND e.actual_at IS NOT NULL AND e.skipped_at IS NULL AND x.id IS NULL
    ORDER BY e.actual_at DESC, e.id DESC LIMIT 1`).get(id) as
    { batch_id: string; batch_name: string } | undefined;
}

function endUses(workspace: Database.Database, id: string, at: number): void {
  workspace.prepare(`INSERT OR IGNORE INTO event_ends(id, ended_at)
    SELECT e.id, ? FROM batch_events e JOIN equipment_use_events u ON u.event_id = e.id
    LEFT JOIN event_ends x ON x.id = e.id WHERE u.equipment_id = ? AND x.id IS NULL`)
    .run(at, id);
}

function migrateDevice(auth: Database.Database, accountId: string, deviceId: string, getWorkspace: WorkspaceGetter): void {
  const device = deviceLink(auth, accountId, deviceId);
  if (!device || device.legacy_migrated) return;
  const assignments = auth.prepare(`SELECT a.id, a.workspace_id, a.batch_id, a.valid_from, a.valid_until
    FROM rapt_assignments a JOIN workspaces w ON w.id = a.workspace_id AND w.owner_account_id = a.account_id
    WHERE a.account_id = ? AND a.device_id = ? ORDER BY a.valid_from, a.id`).all(accountId, deviceId) as
    { id: string; workspace_id: string; batch_id: string; valid_from: number; valid_until: number | null }[];
  let last: { workspace_id: string; equipment_id: string } | null = null;
  for (const assignment of assignments) {
    const workspace = getWorkspace(assignment.workspace_id);
    if (!workspace.prepare('SELECT 1 FROM batches WHERE id = ?').get(assignment.batch_id)) continue;
    if (last && last.workspace_id !== assignment.workspace_id) {
      const oldWorkspace = getWorkspace(last.workspace_id);
      oldWorkspace.transaction(() => {
        endUses(oldWorkspace, last!.equipment_id, assignment.valid_from);
        oldWorkspace.prepare('UPDATE equipment SET removed_at = ? WHERE id = ? AND removed_at IS NULL')
          .run(assignment.valid_from, last!.equipment_id);
      })();
    }
    const id = ensureEquipment(workspace, accountId, assignment.workspace_id, deviceId, device.name);
    workspace.transaction(() => {
      const eventId = `ra_${assignment.id}`;
      workspace.prepare(`INSERT OR IGNORE INTO batch_events(id, batch_id, event_type, title, actual_at,
        created_at, created_by_account_id, recorded_by_account_id, source_id)
        VALUES (?, ?, 'equipment_use', ?, ?, ?, ?, ?, ?)`)
        .run(eventId, assignment.batch_id, `Use ${device.name}`, assignment.valid_from,
          assignment.valid_from, accountId, accountId, `rapt-assignment:${assignment.id}`);
      workspace.prepare('INSERT OR IGNORE INTO equipment_use_events(event_id, equipment_id) VALUES (?, ?)')
        .run(eventId, id);
      if (assignment.valid_until != null) workspace.prepare('INSERT OR IGNORE INTO event_ends(id, ended_at) VALUES (?, ?)')
        .run(eventId, assignment.valid_until);
      for (const table of ['gravity_measurements', 'temperature_measurements']) workspace.prepare(`UPDATE ${table}
        SET equipment_id = ? WHERE equipment_id IS NULL AND event_id IN (
          SELECT id FROM batch_events WHERE batch_id = ? AND source_id = ?
          AND actual_at >= ? AND (? IS NULL OR actual_at < ?))`)
        .run(id, assignment.batch_id, `rapt:${accountId}:${deviceId}`, assignment.valid_from,
          assignment.valid_until, assignment.valid_until);
    })();
    last = { workspace_id: assignment.workspace_id, equipment_id: id };
  }
  auth.prepare(`UPDATE rapt_devices SET workspace_id = ?, equipment_id = ?, legacy_migrated = 1,
    brewery_choice_made = CASE WHEN ? THEN 1 ELSE brewery_choice_made END
    WHERE account_id = ? AND device_id = ?`).run(last?.workspace_id || device.workspace_id,
    last?.equipment_id || device.equipment_id, !!last ? 1 : 0, accountId, deviceId);
}

export function raptDevices(auth: Database.Database, accountId: string, getWorkspace: WorkspaceGetter): RaptDevice[] {
  const rows = auth.prepare(`SELECT device_id FROM rapt_devices WHERE account_id = ?`)
    .all(accountId) as { device_id: string }[];
  const owners = auth.prepare('SELECT id FROM workspaces WHERE owner_account_id = ?')
    .all(accountId) as { id: string }[];
  for (const row of rows) {
    migrateDevice(auth, accountId, row.device_id, getWorkspace);
    const link = deviceLink(auth, accountId, row.device_id)!;
    if (link.workspace_id && !link.equipment_id && auth.prepare(
      'SELECT 1 FROM workspaces WHERE id = ? AND owner_account_id = ?').get(link.workspace_id, accountId))
      setRaptBrewery(auth, accountId, row.device_id, link.workspace_id, getWorkspace);
    if (owners.length === 1 && !link.workspace_id && !link.brewery_choice_made)
      setRaptBrewery(auth, accountId, row.device_id, owners[0].id, getWorkspace);
  }
  return auth.prepare(`SELECT device_id, name, device_type, last_seen_at, workspace_id, equipment_id
    FROM rapt_devices WHERE account_id = ? ORDER BY name, device_id`).all(accountId).map(raw => {
    const row = raw as Omit<RaptDevice, 'batch_id' | 'batch_name'>;
    if (row.workspace_id && row.equipment_id) {
      if (!auth.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_account_id = ?')
        .get(row.workspace_id, accountId)) {
        auth.prepare(`UPDATE rapt_devices SET workspace_id = NULL, equipment_id = NULL
          WHERE account_id = ? AND device_id = ?`).run(accountId, row.device_id);
        return { ...row, workspace_id: null, equipment_id: null, batch_id: null, batch_name: null };
      }
      const workspace = getWorkspace(row.workspace_id);
      const unit = workspace.prepare('SELECT removed_at FROM equipment WHERE id = ?').get(row.equipment_id) as
        { removed_at: number | null } | undefined;
      if (!unit || unit.removed_at != null) {
        auth.prepare(`UPDATE rapt_devices SET workspace_id = NULL, equipment_id = NULL
          WHERE account_id = ? AND device_id = ?`).run(accountId, row.device_id);
        return { ...row, workspace_id: null, equipment_id: null, batch_id: null, batch_name: null };
      }
      const use = activeUse(workspace, row.equipment_id);
      return { ...row, batch_id: use?.batch_id || null, batch_name: use?.batch_name || null };
    }
    return { ...row, batch_id: null, batch_name: null };
  });
}

export function setRaptBrewery(auth: Database.Database, accountId: string, deviceId: string,
  workspaceId: string | null, getWorkspace: WorkspaceGetter): 'ok' | 'device_missing' | 'brewery_missing' {
  migrateDevice(auth, accountId, deviceId, getWorkspace);
  const device = deviceLink(auth, accountId, deviceId);
  if (!device) return 'device_missing';
  if (workspaceId && !auth.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_account_id = ?')
    .get(workspaceId, accountId)) return 'brewery_missing';
  if (device.workspace_id === workspaceId && (!workspaceId || device.equipment_id)) return 'ok';
  const at = nowSeconds();
  if (device.workspace_id && device.equipment_id && auth.prepare(
    'SELECT 1 FROM workspaces WHERE id = ? AND owner_account_id = ?').get(device.workspace_id, accountId)) {
    const previous = getWorkspace(device.workspace_id);
    previous.transaction(() => {
      endUses(previous, device.equipment_id!, at);
      previous.prepare('UPDATE equipment SET removed_at = ? WHERE id = ? AND removed_at IS NULL')
        .run(at, device.equipment_id);
    })();
  }
  const nextId = workspaceId ? ensureEquipment(getWorkspace(workspaceId), accountId, workspaceId, deviceId, device.name) : null;
  auth.prepare(`UPDATE rapt_devices SET workspace_id = ?, equipment_id = ?, legacy_migrated = 1,
    brewery_choice_made = 1
    WHERE account_id = ? AND device_id = ?`).run(workspaceId, nextId, accountId, deviceId);
  return 'ok';
}

interface RaptReading {
  deviceId: string;
  name: string;
  deviceType: string;
  temperature: number;
  gravity: number;
  battery: number | null;
  rssi: number | null;
  sourceTimestamp: string;
  actualAt: number;
}

export function parseRaptReading(input: unknown, now = nowSeconds()): RaptReading | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const deviceId = value.device_id ?? value.id;
  const name = value.device_name ?? value.name;
  const deviceType = value.device_type ?? 'Hydrometer';
  const temperature = value.temperature ?? value.temp;
  const gravity = value.gravity ?? value.sg;
  const timestamp = value.created_date ?? value.ts;
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)
    || typeof name !== 'string' || !name.trim() || name.length > 120
    || typeof deviceType !== 'string' || !deviceType.trim() || deviceType.length > 80
    || typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < -20 || temperature > 100
    || typeof gravity !== 'number' || !Number.isFinite(gravity) || gravity < 0.9 || gravity > 1.2
    || typeof timestamp !== 'string' || timestamp.length > 80
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(timestamp)) return null;
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) return null;
  const actualAt = Math.floor(millis / 1000);
  if (actualAt < 946684800 || actualAt > now + 300) return null;
  const battery = value.battery == null ? null : value.battery;
  const rssi = value.rssi == null ? null : value.rssi;
  if (battery !== null && (typeof battery !== 'number' || !Number.isFinite(battery) || battery < 0 || battery > 100)) return null;
  if (rssi !== null && (typeof rssi !== 'number' || !Number.isFinite(rssi) || rssi < -150 || rssi > 0)) return null;
  return { deviceId, name: name.trim(), deviceType: deviceType.trim(), temperature, gravity,
    battery: battery as number | null, rssi: rssi as number | null, sourceTimestamp: timestamp, actualAt };
}

export type RaptIngestResult = 'recorded' | 'duplicate' | 'unassigned';

export function ingestRaptReading(auth: Database.Database, accountId: string, reading: RaptReading,
  getWorkspace: (id: string) => Database.Database): RaptIngestResult {
  const receivedAt = nowSeconds();
  const isNew = !deviceLink(auth, accountId, reading.deviceId);
  auth.prepare(`INSERT INTO rapt_devices(account_id, device_id, name, device_type, last_seen_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, device_id) DO UPDATE SET
      name = excluded.name, device_type = excluded.device_type, last_seen_at = excluded.last_seen_at`)
    .run(accountId, reading.deviceId, reading.name, reading.deviceType, receivedAt);
  migrateDevice(auth, accountId, reading.deviceId, getWorkspace);
  let device = deviceLink(auth, accountId, reading.deviceId)!;
  if (isNew && !device.workspace_id) {
    const owners = auth.prepare('SELECT id FROM workspaces WHERE owner_account_id = ?')
      .all(accountId) as { id: string }[];
    if (owners.length === 1) {
      setRaptBrewery(auth, accountId, reading.deviceId, owners[0].id, getWorkspace);
      device = deviceLink(auth, accountId, reading.deviceId)!;
    }
  }
  if (!device.workspace_id || !device.equipment_id) return 'unassigned';
  if (!auth.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_account_id = ?')
    .get(device.workspace_id, accountId)) {
    auth.prepare(`UPDATE rapt_devices SET workspace_id = NULL, equipment_id = NULL
      WHERE account_id = ? AND device_id = ?`).run(accountId, reading.deviceId);
    return 'unassigned';
  }
  const workspace = getWorkspace(device.workspace_id);
  return workspace.transaction(() => {
    const unit = workspace.prepare('SELECT removed_at, name FROM equipment WHERE id = ?')
      .get(device.equipment_id) as { removed_at: number | null; name: string } | undefined;
    if (!unit || unit.removed_at != null) {
      auth.prepare(`UPDATE rapt_devices SET workspace_id = NULL, equipment_id = NULL
        WHERE account_id = ? AND device_id = ?`).run(accountId, reading.deviceId);
      return 'unassigned';
    }
    if (unit.name !== reading.name) workspace.prepare('UPDATE equipment SET name = ? WHERE id = ?')
      .run(reading.name, device.equipment_id);
    const use = workspace.prepare(`SELECT e.batch_id FROM batch_events e
      JOIN equipment_use_events u ON u.event_id = e.id LEFT JOIN event_ends x ON x.id = e.id
      WHERE u.equipment_id = ? AND e.actual_at IS NOT NULL AND e.skipped_at IS NULL
      AND e.actual_at <= ? AND (x.ended_at IS NULL OR x.ended_at > ?)
      ORDER BY e.actual_at DESC, e.id DESC LIMIT 1`).get(device.equipment_id, reading.actualAt, reading.actualAt) as
      { batch_id: string } | undefined;
    if (!use || !workspace.prepare('SELECT 1 FROM batches WHERE id = ?').get(use.batch_id)) return 'unassigned';
    const sourceId = `rapt:${accountId}:${reading.deviceId}`;
    if (workspace.prepare('SELECT 1 FROM batch_events WHERE source_id = ? AND external_id = ?')
      .get(sourceId, reading.sourceTimestamp)) return 'duplicate';
    const eventId = createId();
    workspace.prepare(`INSERT INTO batch_events(id, batch_id, event_type, title, actual_at, created_at,
      created_by_account_id, recorded_by_account_id, source_id, external_id, received_at)
      VALUES (?, ?, 'measurement', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventId, use.batch_id, `${reading.name} reading`, reading.actualAt, receivedAt,
        accountId, accountId, sourceId, reading.sourceTimestamp, receivedAt);
    workspace.prepare(`INSERT INTO gravity_measurements(event_id, value, unit, source, equipment_id)
      VALUES (?, ?, 'SG', 'rapt', ?)`).run(eventId, reading.gravity, device.equipment_id);
    workspace.prepare(`INSERT INTO temperature_measurements(event_id, value, unit, source, equipment_id)
      VALUES (?, ?, '°C', 'rapt', ?)`).run(eventId, reading.temperature, device.equipment_id);
    return 'recorded';
  })();
}
