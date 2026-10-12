import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { createWorkspace } from './db.ts';
import { nowSeconds } from '../shared/schema.ts';
import { defaultPreferredUnits, type PreferredUnits } from '../shared/units.ts';

export interface Account { id: string; username: string; has_avatar: boolean }
const sessionSeconds = 30 * 24 * 60 * 60;

function passwordHash(password: string, salt = randomBytes(16).toString('hex')): string {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function validPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = Buffer.from(passwordHash(password, salt).split(':')[1], 'hex');
  const saved = Buffer.from(expected, 'hex');
  return actual.length === saved.length && timingSafeEqual(actual, saved);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function createSession(db: Database.Database, accountId: string): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash, account_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash(token), accountId, nowSeconds() + sessionSeconds);
  return token;
}

export function register(db: Database.Database, username: string, password: string): string | null {
  const normalized = username.trim().toLowerCase();
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM accounts WHERE lower(username) = ?').get(normalized)) return null;
    const id = nanoid();
    db.prepare('INSERT INTO accounts(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(id, normalized, passwordHash(password), nowSeconds());
    createWorkspace(db, id, 'Homebrew');
    return createSession(db, id);
  })();
}

export function login(db: Database.Database, username: string, password: string): string | null {
  const row = db.prepare('SELECT id, password_hash FROM accounts WHERE lower(username) = ?')
    .get(username.trim().toLowerCase()) as { id: string; password_hash: string } | undefined;
  if (!row || !validPassword(password, row.password_hash)) return null;
  return createSession(db, row.id);
}

export function accountForToken(db: Database.Database, token: string | undefined): Account | null {
  if (!token) return null;
  const row = db.prepare(`SELECT a.id, a.username,
      EXISTS(SELECT 1 FROM account_avatars v WHERE v.account_id = a.id) AS has_avatar FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ?`)
    .get(tokenHash(token), nowSeconds()) as { id: string; username: string; has_avatar: number } | undefined;
  return row ? { ...row, has_avatar: !!row.has_avatar } : null;
}

export function changePassword(db: Database.Database, accountId: string, currentPassword: string,
  newPassword: string, currentToken: string): boolean {
  const row = db.prepare('SELECT password_hash FROM accounts WHERE id = ?')
    .get(accountId) as { password_hash: string } | undefined;
  if (!row || !validPassword(currentPassword, row.password_hash)) return false;
  db.transaction(() => {
    db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash(newPassword), accountId);
    db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?')
      .run(accountId, tokenHash(currentToken));
  })();
  return true;
}

export function saveAvatar(db: Database.Database, accountId: string, image: Buffer): void {
  db.prepare(`INSERT INTO account_avatars(account_id, image_jpeg, uploaded_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET image_jpeg = excluded.image_jpeg, uploaded_at = excluded.uploaded_at`)
    .run(accountId, image, nowSeconds());
}

export function getAvatar(db: Database.Database, accountId: string): Buffer | null {
  const row = db.prepare('SELECT image_jpeg FROM account_avatars WHERE account_id = ?')
    .get(accountId) as { image_jpeg: Buffer } | undefined;
  return row?.image_jpeg || null;
}

export function getPreferredUnits(db: Database.Database, accountId: string): PreferredUnits {
  const row = db.prepare(`SELECT temperature_unit, volume_unit, mass_unit, pressure_unit
    FROM account_preferences WHERE account_id = ?`).get(accountId) as {
      temperature_unit: PreferredUnits['temperature']; volume_unit: PreferredUnits['volume'];
      mass_unit: PreferredUnits['mass']; pressure_unit: PreferredUnits['pressure'];
    } | undefined;
  return row ? { temperature: row.temperature_unit, volume: row.volume_unit,
    mass: row.mass_unit, pressure: row.pressure_unit } : defaultPreferredUnits;
}

export function savePreferredUnits(db: Database.Database, accountId: string, units: PreferredUnits): void {
  db.prepare(`INSERT INTO account_preferences(account_id, temperature_unit, volume_unit, mass_unit, pressure_unit)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
    temperature_unit = excluded.temperature_unit, volume_unit = excluded.volume_unit,
    mass_unit = excluded.mass_unit, pressure_unit = excluded.pressure_unit`)
    .run(accountId, units.temperature, units.volume, units.mass, units.pressure);
}

export function logout(db: Database.Database, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function sessionCookieName(port: number): string {
  return `brewlog_session_${port}`;
}

export function readSessionCookie(cookie: string | undefined, name: string): string | undefined {
  return cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function sessionCookie(token: string, secure: boolean, name: string): string {
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionSeconds}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean, name: string): string {
  return `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}
