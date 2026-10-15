import { randomBytes } from 'node:crypto';
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
  batch_id: string | null;
}

export function raptConnection(auth: Database.Database, accountId: string): RaptConnection | null {
  return auth.prepare('SELECT account_id, token FROM rapt_connections WHERE account_id = ?')
    .get(accountId) as RaptConnection | undefined || null;
}

export function raptConnectionForToken(auth: Database.Database, token: string): RaptConnection | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return auth.prepare('SELECT account_id, token FROM rapt_connections WHERE token = ?')
    .get(token) as RaptConnection | undefined || null;
}

export function rotateRaptToken(auth: Database.Database, accountId: string): string {
  const token = randomBytes(32).toString('base64url');
  auth.prepare(`INSERT INTO rapt_connections(account_id, token, created_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`)
    .run(accountId, token, nowSeconds());
  return token;
}

export function ensureRaptToken(auth: Database.Database, accountId: string): string {
  auth.prepare(`INSERT OR IGNORE INTO rapt_connections(account_id, token, created_at) VALUES (?, ?, ?)`)
    .run(accountId, randomBytes(32).toString('base64url'), nowSeconds());
  return raptConnection(auth, accountId)!.token;
}

export function deleteRaptIntegration(auth: Database.Database, accountId: string): void {
  auth.transaction(() => {
    auth.prepare('DELETE FROM rapt_connections WHERE account_id = ?').run(accountId);
    auth.prepare('DELETE FROM rapt_assignments WHERE account_id = ?').run(accountId);
    auth.prepare('DELETE FROM rapt_devices WHERE account_id = ?').run(accountId);
  })();
}

export function raptDevices(auth: Database.Database, accountId: string): RaptDevice[] {
  return auth.prepare(`SELECT d.device_id, d.name, d.device_type, d.last_seen_at,
      a.workspace_id, a.batch_id
    FROM rapt_devices d LEFT JOIN rapt_assignments a
      ON a.account_id = d.account_id AND a.device_id = d.device_id AND a.valid_until IS NULL
    WHERE d.account_id = ? ORDER BY d.name, d.device_id`).all(accountId) as RaptDevice[];
}

export function assignRaptDevice(auth: Database.Database, accountId: string, deviceId: string,
  workspaceId: string, batchId: string, workspace: Database.Database): 'ok' | 'device_missing' | 'batch_missing' {
  if (!auth.prepare('SELECT 1 FROM rapt_devices WHERE account_id = ? AND device_id = ?')
    .get(accountId, deviceId)) return 'device_missing';
  if (!auth.prepare('SELECT 1 FROM workspaces WHERE owner_account_id = ? AND id = ?')
    .get(accountId, workspaceId)) return 'batch_missing';
  if (!workspace.prepare('SELECT 1 FROM batches WHERE id = ?').get(batchId)) return 'batch_missing';
  auth.transaction(() => {
    const current = auth.prepare(`SELECT workspace_id, batch_id FROM rapt_assignments
      WHERE account_id = ? AND device_id = ? AND valid_until IS NULL`).get(accountId, deviceId) as
      { workspace_id: string; batch_id: string } | undefined;
    if (current?.workspace_id === workspaceId && current.batch_id === batchId) return;
    const at = nowSeconds();
    auth.prepare(`UPDATE rapt_assignments SET valid_until = ?
      WHERE account_id = ? AND device_id = ? AND valid_until IS NULL`).run(at, accountId, deviceId);
    auth.prepare(`INSERT INTO rapt_assignments(id, account_id, device_id, workspace_id, batch_id, valid_from)
      VALUES (?, ?, ?, ?, ?, ?)`).run(createId(), accountId, deviceId, workspaceId, batchId, at);
  })();
  return 'ok';
}

export function unassignRaptDevice(auth: Database.Database, accountId: string, deviceId: string): void {
  auth.prepare(`UPDATE rapt_assignments SET valid_until = ?
    WHERE account_id = ? AND device_id = ? AND valid_until IS NULL`)
    .run(nowSeconds(), accountId, deviceId);
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
  auth.prepare(`INSERT INTO rapt_devices(account_id, device_id, name, device_type, last_seen_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, device_id) DO UPDATE SET
      name = excluded.name, device_type = excluded.device_type, last_seen_at = excluded.last_seen_at`)
    .run(accountId, reading.deviceId, reading.name, reading.deviceType, receivedAt);
  const assignment = auth.prepare(`SELECT a.workspace_id, a.batch_id FROM rapt_assignments a
    JOIN workspaces w ON w.id = a.workspace_id AND w.owner_account_id = a.account_id
    WHERE a.account_id = ? AND a.device_id = ? AND a.valid_from <= ?
      AND (a.valid_until IS NULL OR a.valid_until > ?)
    ORDER BY a.valid_from DESC LIMIT 1`).get(accountId, reading.deviceId, reading.actualAt, reading.actualAt) as
    { workspace_id: string; batch_id: string } | undefined;
  if (!assignment) return 'unassigned';
  const workspace = getWorkspace(assignment.workspace_id);
  return workspace.transaction(() => {
    if (!workspace.prepare('SELECT 1 FROM batches WHERE id = ?').get(assignment.batch_id)) return 'unassigned';
    const sourceId = `rapt:${accountId}:${reading.deviceId}`;
    if (workspace.prepare('SELECT 1 FROM batch_events WHERE source_id = ? AND external_id = ?')
      .get(sourceId, reading.sourceTimestamp)) return 'duplicate';
    const eventId = createId();
    workspace.prepare(`INSERT INTO batch_events(id, batch_id, event_type, title, actual_at, created_at,
      created_by_account_id, recorded_by_account_id, source_id, external_id, received_at)
      VALUES (?, ?, 'measurement', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventId, assignment.batch_id, `${reading.name} reading`, reading.actualAt, receivedAt,
        accountId, accountId, sourceId, reading.sourceTimestamp, receivedAt);
    workspace.prepare(`INSERT INTO gravity_measurements(event_id, value, unit, source)
      VALUES (?, ?, 'SG', 'rapt')`).run(eventId, reading.gravity);
    workspace.prepare(`INSERT INTO temperature_measurements(event_id, value, unit, source)
      VALUES (?, ?, '°C', 'rapt')`).run(eventId, reading.temperature);
    return 'recorded';
  })();
}
