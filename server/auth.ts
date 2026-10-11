import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { createWorkspace } from './db.ts';
import { nowSeconds } from '../shared/schema.ts';

export interface Account { id: string; username: string }
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

export function bootstrapOwner(db: Database.Database): void {
  const row = db.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number };
  if (row.count > 0) return;
  const username = process.env.BREWLOG_OWNER_USERNAME?.trim();
  const password = process.env.BREWLOG_OWNER_PASSWORD;
  if (!username || !password || password.length < 12) {
    console.warn('Owner setup needed: set BREWLOG_OWNER_USERNAME and BREWLOG_OWNER_PASSWORD (12+ characters) in .env, then restart.');
    return;
  }
  const id = nanoid();
  db.prepare('INSERT INTO accounts(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, username, passwordHash(password), nowSeconds());
  createWorkspace(db, id, 'Homebrew');
  console.log(`Created owner account ${username} and Homebrew workspace.`);
}

export function login(db: Database.Database, username: string, password: string): string | null {
  const row = db.prepare('SELECT id, password_hash FROM accounts WHERE username = ?')
    .get(username) as { id: string; password_hash: string } | undefined;
  if (!row || !validPassword(password, row.password_hash)) return null;
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash, account_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash(token), row.id, nowSeconds() + sessionSeconds);
  return token;
}

export function accountForToken(db: Database.Database, token: string | undefined): Account | null {
  if (!token) return null;
  const row = db.prepare(`SELECT a.id, a.username FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ?`)
    .get(tokenHash(token), nowSeconds()) as Account | undefined;
  return row || null;
}

export function logout(db: Database.Database, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function readSessionCookie(cookie: string | undefined): string | undefined {
  return cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('brewlog_session='))
    ?.slice('brewlog_session='.length);
}

export function sessionCookie(token: string, secure: boolean): string {
  return `brewlog_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionSeconds}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `brewlog_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}
