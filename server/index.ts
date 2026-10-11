import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { accountForToken, clearSessionCookie, login, logout, readSessionCookie, register, sessionCookie } from './auth.ts';
import { closeWorkspaceDb, createWorkspace, openAuthDb, openWorkspaceDb } from './db.ts';
import { syncWorkspace, validateSyncRequest } from './sync.ts';
import { isValidId } from '../shared/schema.ts';

const authDb = openAuthDb();
const workspaceDbs = new Map<string, Database.Database>();
const distDir = resolve('dist');
const port = Number(process.env.BREWLOG_PORT || 3001);
const loginFailures = new Map<string, { count: number; resetAt: number }>();
const registrationAttempts = new Map<string, { count: number; resetAt: number }>();
const loginWindowMs = 15 * 60 * 1000;
const loginLimit = 10;
const registrationLimit = 20;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON request');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sessionToken(req: IncomingMessage) {
  return readSessionCookie(req.headers.cookie);
}

function secureRequest(req: IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true || req.headers['x-forwarded-proto'] === 'https';
}

function ownerWorkspaces(accountId: string) {
  return authDb.prepare('SELECT id, name FROM workspaces WHERE owner_account_id = ? ORDER BY created_at, id')
    .all(accountId) as { id: string; name: string }[];
}

function ownsWorkspace(accountId: string, workspaceId: string): boolean {
  return !!authDb.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_account_id = ?')
    .get(workspaceId, accountId);
}

function getWorkspaceDb(id: string): Database.Database {
  let db = workspaceDbs.get(id);
  if (!db) {
    db = openWorkspaceDb(id);
    workspaceDbs.set(id, db);
  }
  return db;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const file = resolve(distDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  const safeFile = file.startsWith(`${distDir}${sep}`) ? file : resolve(distDir, 'index.html');
  const path = existsSync(safeFile) ? safeFile : resolve(distDir, 'index.html');
  if (!existsSync(path)) return json(res, 404, { error: 'Build the PWA with yarn build, or use yarn dev.' });
  const mime: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm',
    '.png': 'image/png', '.webmanifest': 'application/manifest+json'
  };
  res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
  res.end(readFileSync(path));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
    if (pathname === '/api/register' && req.method === 'POST') {
      const registrationKey = req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const previous = registrationAttempts.get(registrationKey);
      const attempts = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + loginWindowMs };
      if (attempts.count >= registrationLimit) return json(res, 429, { error: 'Too many registrations. Try again later.' });
      registrationAttempts.set(registrationKey, { ...attempts, count: attempts.count + 1 });
      const body = await readJson(req, 4 * 1024) as { username?: unknown; password?: unknown };
      if (typeof body.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(body.username.trim())) {
        return json(res, 400, { error: 'Username must be 3–40 letters, numbers, underscores, or hyphens' });
      }
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) {
        return json(res, 400, { error: 'Password must be 8–256 characters' });
      }
      const token = register(authDb, body.username, body.password);
      if (!token) return json(res, 409, { error: 'Username is already taken' });
      return json(res, 201, { ok: true }, { 'Set-Cookie': sessionCookie(token, secureRequest(req)) });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024) as { username?: unknown; password?: unknown };
      if (typeof body.username !== 'string' || body.username.length > 40 || typeof body.password !== 'string'
        || body.password.length > 256) return json(res, 400, { error: 'Invalid username or password' });
      const loginKey = req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const previous = loginFailures.get(loginKey);
      const failures = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + loginWindowMs };
      if (failures.count >= loginLimit) return json(res, 429, { error: 'Too many login attempts. Try again later.' });
      const token = login(authDb, body.username, body.password);
      if (!token) {
        loginFailures.set(loginKey, { ...failures, count: failures.count + 1 });
        return json(res, 401, { error: 'Invalid username or password' });
      }
      loginFailures.delete(loginKey);
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, secureRequest(req)) });
    }

    const token = sessionToken(req);
    const account = accountForToken(authDb, token);
    if (!account) return json(res, 401, { error: 'Sign in required' });

    if (pathname === '/api/me' && req.method === 'GET') {
      return json(res, 200, { account, workspaces: ownerWorkspaces(account.id) });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      logout(authDb, token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(secureRequest(req)) });
    }
    if (pathname === '/api/workspaces' && req.method === 'GET') {
      return json(res, 200, { workspaces: ownerWorkspaces(account.id) });
    }
    if (pathname === '/api/workspaces' && req.method === 'POST') {
      const body = await readJson(req) as { name?: unknown };
      if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > 80) {
        return json(res, 400, { error: 'Brewery name must be 1–80 characters' });
      }
      return json(res, 201, createWorkspace(authDb, account.id, body.name.trim()));
    }
    const syncMatch = /^\/api\/workspaces\/([^/]+)\/sync$/.exec(pathname);
    if (syncMatch && req.method === 'POST') {
      const workspaceId = syncMatch[1];
      if (!isValidId(workspaceId) || !ownsWorkspace(account.id, workspaceId)) return json(res, 404, { error: 'Brewery not found' });
      const body = await readJson(req);
      if (!validateSyncRequest(body)) return json(res, 400, { error: 'Invalid sync request' });
      return json(res, 200, syncWorkspace(getWorkspaceDb(workspaceId), body));
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error instanceof Error ? error.message : 'Internal error' });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`Brewlog server listening on port ${port}`));

function shutdown() {
  server.close();
  for (const db of workspaceDbs.values()) closeWorkspaceDb(db);
  authDb.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
