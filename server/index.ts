import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { accountForToken, changePassword, clearSessionCookie, getAvatar, getPreferredUnits, login, logout,
  publicBrewer, publicBrewerAvatar, readSessionCookie, register, saveAvatar, saveFullName, savePreferredUnits, saveTimeZone,
  setPublicProfileHidden, sessionCookie, sessionCookieName,
  usernameExists } from './auth.ts';
import { assertCrSqliteAvailable, closeWorkspaceDb, createWorkspace, dataDir, deleteWorkspace, openAuthDb, openWorkspaceDb, projectRoot, updateWorkspace } from './db.ts';
import { openCatalogDb } from './catalog.ts';
import { receiveCborChanges, streamCborChanges } from './sync.ts';
import { syncContentType } from '../shared/cborSync.ts';
import { syncSchemaConflict, syncSchemaHeader } from '../shared/syncSchema.ts';
import { isValidId } from '../shared/schema.ts';
import { validPreferredUnits } from '../shared/units.ts';
import { requestAddress, requestIsSecure } from './http.ts';
import { runtimeDeploymentInfo } from './buildInfo.ts';
import { brewerActivity } from './brewerActivity.ts';
import { registrationTimeZone, validTimeZone } from './timeZone.ts';
import { deleteRaptIntegration, ensureRaptToken, ingestRaptReading, parseRaptReading, raptConnection, raptConnectionForToken,
  raptDevices, rotateRaptToken, setRaptBrewery } from './rapt.ts';

assertCrSqliteAvailable();
const authDb = openAuthDb();
const catalogDb = openCatalogDb(dataDir);
const workspaceDbs = new Map<string, Database.Database>();
const distDir = resolve(projectRoot, 'dist');
const startedAt = new Date().toISOString();
const port = Number(process.env.BREWLOG_PORT || 3001);
const host = process.env.BREWLOG_HOST || '0.0.0.0';
const trustCloudflare = process.env.BREWLOG_TRUST_CLOUDFLARE === 'true';
const devSocket = process.env.BREWLOG_DEV_SOCKET;
const productionSocket = process.env.BREWLOG_SOCKET;
if (devSocket && (process.env.BREWLOG_DEV_ROOT !== projectRoot
  || devSocket !== resolve(projectRoot, '.brewlog-api.sock'))) {
  throw new Error('Development API socket must belong to this checkout.');
}
const cookieName = sessionCookieName(devSocket || productionSocket || port);
const loginFailures = new Map<string, { count: number; resetAt: number }>();
const registrationAttempts = new Map<string, { count: number; resetAt: number }>();
const passwordFailures = new Map<string, { count: number; resetAt: number }>();
const raptRequests = new Map<string, { count: number; resetAt: number }>();
const loginWindowMs = 15 * 60 * 1000;
const loginLimit = 10;
const registrationLimit = 20;

function validFullName(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
    && value.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
}

function normalizeFullName(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

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

async function readCbor(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  if (!req.headers['content-type']?.startsWith(syncContentType)) throw new Error('Expected CBOR sync request');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Sync request is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sessionToken(req: IncomingMessage) {
  return readSessionCookie(req.headers.cookie, cookieName);
}

function secureRequest(req: IncomingMessage): boolean {
  return requestIsSecure((req.socket as { encrypted?: boolean }).encrypted === true,
    req.headers['x-forwarded-proto'], trustCloudflare);
}

function clientAddress(req: IncomingMessage): string {
  return requestAddress(req.socket.remoteAddress, req.headers['cf-connecting-ip'], trustCloudflare);
}

function jpegDimensions(image: Buffer): { width: number; height: number } | null {
  if (image.length < 16 || image[0] !== 0xff || image[1] !== 0xd8
    || image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset + 4 < image.length) {
    if (image[offset++] !== 0xff) return null;
    while (image[offset] === 0xff) offset++;
    const marker = image[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > image.length) return null;
    const length = image.readUInt16BE(offset);
    if (length < 2 || offset + length > image.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      return { height: image.readUInt16BE(offset + 3), width: image.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function ownerWorkspaces(accountId: string) {
  return authDb.prepare('SELECT id, name, slug FROM workspaces WHERE owner_account_id = ? ORDER BY created_at, rowid')
    .all(accountId) as { id: string; name: string; slug: string | null }[];
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
  const body = readFileSync(path);
  res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (pathname === '/api/healthz' && req.method === 'GET') return json(res, 200, { ok: true });
    if (pathname === '/api/about' && req.method === 'GET')
      return json(res, 200, runtimeDeploymentInfo(projectRoot, distDir, !!devSocket, startedAt));
    const publicBrewerMatch = /^\/api\/brewer\/([A-Za-z0-9][A-Za-z0-9_-]{2,39})(\/avatar|\/activity)?$/.exec(pathname);
    if (publicBrewerMatch && req.method === 'GET') {
      const viewerId = accountForToken(authDb, sessionToken(req))?.id;
      const brewer = publicBrewer(authDb, publicBrewerMatch[1], viewerId);
      if (!brewer) return json(res, 404, { error: 'Brewer not found' });
      if (publicBrewerMatch[2]) {
        if (publicBrewerMatch[2] === '/activity') {
          const owner = authDb.prepare('SELECT id, time_zone FROM accounts WHERE lower(username) = ?')
            .get(brewer.username) as { id: string; time_zone: string | null };
          const result = brewerActivity(authDb, owner.id, validTimeZone(owner.time_zone) ? owner.time_zone : 'UTC',
            ownerWorkspaces(owner.id).map(workspace => workspace.id), getWorkspaceDb);
          return json(res, 200, result);
        }
        const image = publicBrewerAvatar(authDb, publicBrewerMatch[1], viewerId);
        if (!image) return json(res, 404, { error: 'Avatar not found' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': image.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(image);
      }
      return json(res, 200, brewer);
    }
    const raptWebhookMatch = /^\/api\/webhooks\/rapt\/([^/]+)$/.exec(pathname);
    if (raptWebhookMatch && req.method === 'POST') {
      const connection = raptConnectionForToken(authDb, raptWebhookMatch[1]);
      if (!connection) return json(res, 404, { error: 'Webhook not found' });
      const now = Date.now();
      const previous = raptRequests.get(connection.account_id);
      const attempts = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + 60_000 };
      if (attempts.count >= 120) return json(res, 429, { error: 'Too many readings' });
      raptRequests.set(connection.account_id, { ...attempts, count: attempts.count + 1 });
      let body: unknown;
      try { body = await readJson(req, 8 * 1024); }
      catch { return json(res, 400, { error: 'Expected a JSON reading under 8 KB' }); }
      const reading = parseRaptReading(body);
      if (!reading) return json(res, 400, { error: 'Invalid RAPT reading' });
      const result = ingestRaptReading(authDb, connection.account_id, reading, getWorkspaceDb);
      return json(res, result === 'unassigned' ? 202 : 200, { status: result });
    }
    if (pathname === '/api/username' && req.method === 'GET') {
      const username = url.searchParams.get('username')?.trim();
      if (!username || username.length > 40) return json(res, 400, { error: 'Enter a username up to 40 characters' });
      return json(res, 200, { exists: usernameExists(authDb, username) }, { 'Cache-Control': 'no-store' });
    }
    if (pathname === '/api/register' && req.method === 'POST') {
      const registrationKey = clientAddress(req);
      const now = Date.now();
      const previous = registrationAttempts.get(registrationKey);
      const attempts = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + loginWindowMs };
      if (attempts.count >= registrationLimit) return json(res, 429, { error: 'Too many registrations. Try again later.' });
      registrationAttempts.set(registrationKey, { ...attempts, count: attempts.count + 1 });
      const body = await readJson(req, 4 * 1024) as { username?: unknown; password?: unknown; unit_system?: unknown;
        time_zone?: unknown; full_name?: unknown };
      if (typeof body.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(body.username.trim())) {
        return json(res, 400, { error: 'Username must be 3–40 letters, numbers, underscores, or hyphens' });
      }
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) {
        return json(res, 400, { error: 'Password must be 8–256 characters' });
      }
      if (body.unit_system !== 'metric' && body.unit_system !== 'imperial') {
        return json(res, 400, { error: 'Choose metric or imperial units' });
      }
      if (!validFullName(body.full_name)) return json(res, 400, { error: 'Full name must be 80 characters or fewer' });
      const token = register(authDb, body.username, body.password, body.unit_system,
        registrationTimeZone(clientAddress(req), body.time_zone), normalizeFullName(body.full_name));
      if (!token) return json(res, 409, { error: 'Username is already taken' });
      return json(res, 201, { ok: true }, { 'Set-Cookie': sessionCookie(token, secureRequest(req), cookieName) });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024) as { username?: unknown; password?: unknown };
      if (typeof body.username !== 'string' || body.username.length > 40 || typeof body.password !== 'string'
        || body.password.length > 256) return json(res, 400, { error: 'Invalid username or password' });
      const loginKey = clientAddress(req);
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
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, secureRequest(req), cookieName) });
    }

    const token = sessionToken(req);
    const account = accountForToken(authDb, token);
    if (!account) return json(res, 401, { error: 'Sign in required' });

    if (pathname === '/api/me' && req.method === 'GET') {
      return json(res, 200, { account, workspaces: ownerWorkspaces(account.id), preferred_units: getPreferredUnits(authDb, account.id) });
    }
    if (pathname === '/api/me/profile' && req.method === 'PATCH') {
      const body = await readJson(req, 1024) as { hide_public_profile?: unknown; full_name?: unknown };
      const hasVisibility = Object.hasOwn(body, 'hide_public_profile');
      const hasFullName = Object.hasOwn(body, 'full_name');
      if (!hasVisibility && !hasFullName) return json(res, 400, { error: 'No profile changes provided' });
      if (hasVisibility && typeof body.hide_public_profile !== 'boolean')
        return json(res, 400, { error: 'Choose whether to hide your public profile' });
      if (hasFullName && !validFullName(body.full_name))
        return json(res, 400, { error: 'Full name must be 80 characters or fewer' });
      if (hasVisibility) setPublicProfileHidden(authDb, account.id, body.hide_public_profile as boolean);
      const fullName = hasFullName ? normalizeFullName(body.full_name) : account.full_name;
      if (hasFullName) saveFullName(authDb, account.id, fullName);
      return json(res, 200, { hide_public_profile: hasVisibility ? body.hide_public_profile : account.hide_public_profile,
        full_name: fullName });
    }
    if (pathname === '/api/me/time-zone' && req.method === 'PATCH') {
      const body = await readJson(req, 1024) as { time_zone?: unknown };
      if (!validTimeZone(body.time_zone)) return json(res, 400, { error: 'Choose a valid time zone' });
      saveTimeZone(authDb, account.id, body.time_zone);
      return json(res, 200, { time_zone: body.time_zone });
    }
    if (pathname === '/api/me/rapt' && req.method === 'GET') {
      const connection = raptConnection(authDb, account.id);
      return json(res, 200, { webhook_path: connection ? `/api/webhooks/rapt/${connection.token}` : null,
        devices: raptDevices(authDb, account.id, getWorkspaceDb), workspaces: ownerWorkspaces(account.id) });
    }
    if (pathname === '/api/me/rapt/webhook' && req.method === 'POST') {
      const secret = rotateRaptToken(authDb, account.id);
      return json(res, 200, { webhook_path: `/api/webhooks/rapt/${secret}` });
    }
    if (pathname === '/api/me/rapt/webhook' && req.method === 'PUT') {
      const secret = ensureRaptToken(authDb, account.id);
      return json(res, 200, { webhook_path: `/api/webhooks/rapt/${secret}` });
    }
    if (pathname === '/api/me/rapt/webhook' && req.method === 'DELETE') {
      deleteRaptIntegration(authDb, account.id);
      return json(res, 200, { ok: true });
    }
    const raptBreweryMatch = /^\/api\/me\/rapt\/devices\/([A-Za-z0-9_-]{8,64})\/brewery$/.exec(pathname);
    if (raptBreweryMatch && req.method === 'PUT') {
      const body = await readJson(req, 4 * 1024) as { workspace_id?: unknown };
      if (!body || body.workspace_id !== null && !isValidId(body.workspace_id))
        return json(res, 400, { error: 'Choose a brewery' });
      const result = setRaptBrewery(authDb, account.id, raptBreweryMatch[1], body.workspace_id, getWorkspaceDb);
      if (result !== 'ok') return json(res, 404, { error: result === 'device_missing' ? 'Pill not found' : 'Brewery not found' });
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/catalog/sync' && req.method === 'GET') {
      const conflict = syncSchemaConflict(req.headers[syncSchemaHeader.toLowerCase()] as string | undefined,
        catalogDb.pragma('user_version', { simple: true }) as number);
      if (conflict) return json(res, 409, conflict);
      const version = url.searchParams.get('version') || '0';
      const seq = url.searchParams.get('seq') || '0';
      if (!/^\d+$/.test(version) || !/^\d+$/.test(seq)) return json(res, 400, { error: 'Invalid catalog cursor' });
      return await streamCborChanges(catalogDb, res, version, seq);
    }
    if (pathname === '/api/me/preferences' && req.method === 'PATCH') {
      const units = await readJson(req, 4 * 1024);
      if (!validPreferredUnits(units)) return json(res, 400, { error: 'Choose valid preferred units' });
      savePreferredUnits(authDb, account.id, units);
      return json(res, 200, { preferred_units: units });
    }
    if (pathname === '/api/me/password' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024) as { currentPassword?: unknown; newPassword?: unknown };
      if (!body || typeof body.currentPassword !== 'string' || body.currentPassword.length > 256
        || typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 256) {
        return json(res, 400, { error: 'New password must be 8–256 characters' });
      }
      const now = Date.now();
      const previous = passwordFailures.get(account.id);
      const failures = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + loginWindowMs };
      if (failures.count >= loginLimit) return json(res, 429, { error: 'Too many password attempts. Try again later.' });
      if (!changePassword(authDb, account.id, body.currentPassword, body.newPassword, token!)) {
        passwordFailures.set(account.id, { ...failures, count: failures.count + 1 });
        return json(res, 403, { error: 'Current password is incorrect' });
      }
      passwordFailures.delete(account.id);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/me/avatar' && req.method === 'GET') {
      const image = getAvatar(authDb, account.id);
      if (!image) return json(res, 404, { error: 'Avatar not found' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': image.length,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(image);
    }
    if (pathname === '/api/me/avatar' && req.method === 'PUT') {
      if (req.headers['content-type'] !== 'image/jpeg') return json(res, 415, { error: 'Upload a JPEG avatar' });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 512 * 1024) return json(res, 413, { error: 'Avatar must be under 512 KB' });
        chunks.push(chunk);
      }
      const image = Buffer.concat(chunks);
      const dimensions = jpegDimensions(image);
      if (!dimensions || dimensions.width < 1 || dimensions.height < 1
        || dimensions.width > 512 || dimensions.height > 512) {
        return json(res, 400, { error: 'Avatar must be a JPEG no larger than 512 × 512 pixels' });
      }
      saveAvatar(authDb, account.id, image);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      logout(authDb, token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(secureRequest(req), cookieName) });
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
    const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/.exec(pathname);
    if (workspaceMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const workspaceId = workspaceMatch[1];
      if (!isValidId(workspaceId) || !ownsWorkspace(account.id, workspaceId)) return json(res, 404, { error: 'Brewery not found' });
      if (req.method === 'PATCH') {
        const body = await readJson(req, 4 * 1024) as { name?: unknown; slug?: unknown };
        if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80) {
          return json(res, 400, { error: 'Brewery name must be 1–80 characters' });
        }
        if (body.slug !== null && (typeof body.slug !== 'string'
          || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug) || body.slug.length > 48)) {
          return json(res, 400, { error: 'Slug must be empty for root URLs, or 1–48 lowercase letters, numbers, and single hyphens' });
        }
        try {
          return json(res, 200, updateWorkspace(authDb, account.id, workspaceId, body.name.trim(), body.slug));
        } catch (cause) {
          if (cause instanceof Error && cause.message.includes('UNIQUE constraint failed')) {
            return json(res, 409, { error: body.slug === null ? 'Another brewery already uses root URLs' : 'That slug is already used by another brewery' });
          }
          throw cause;
        }
      }
      deleteWorkspace(authDb, account.id, workspaceId, () => {
        const open = workspaceDbs.get(workspaceId);
        if (open) { closeWorkspaceDb(open); workspaceDbs.delete(workspaceId); }
      });
      return json(res, 200, { ok: true });
    }
    const binarySyncMatch = /^\/api\/workspaces\/([^/]+)\/sync\/(upload|download)$/.exec(pathname);
    if (binarySyncMatch && (req.method === 'POST' || req.method === 'GET')) {
      const [, workspaceId, action] = binarySyncMatch;
      if (!isValidId(workspaceId) || !ownsWorkspace(account.id, workspaceId)) return json(res, 404, { error: 'Brewery not found' });
      const workspaceDb = getWorkspaceDb(workspaceId);
      const conflict = syncSchemaConflict(req.headers[syncSchemaHeader.toLowerCase()] as string | undefined,
        workspaceDb.pragma('user_version', { simple: true }) as number);
      if (conflict) return json(res, 409, conflict);
      if (action === 'upload' && req.method === 'POST') {
        let result: Uint8Array;
        try { result = receiveCborChanges(workspaceDb, await readCbor(req)); }
        catch (cause) {
          if (cause instanceof Error && /Invalid CBOR|Expected CBOR|too large/i.test(cause.message))
            return json(res, 400, { error: cause.message });
          throw cause;
        }
        res.writeHead(200, { 'Content-Type': syncContentType, 'Cache-Control': 'no-store' });
        return res.end(result);
      }
      if (action === 'download' && req.method === 'GET') {
        const version = url.searchParams.get('version') || '0';
        const seq = url.searchParams.get('seq') || '0';
        if (!/^\d+$/.test(version) || !/^\d+$/.test(seq)) return json(res, 400, { error: 'Invalid sync cursor' });
        return await streamCborChanges(workspaceDb, res, version, seq);
      }
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'Internal server error' });
  }
});

if (devSocket) server.listen(devSocket, () => console.log(`Yeast.Win! server listening on ${devSocket}`));
else if (productionSocket) server.listen(productionSocket,
  () => console.log(`Yeast.Win! server listening on ${productionSocket}`));
else server.listen(port, host, () => console.log(`Yeast.Win! server listening on ${host}:${port}`));

function shutdown() {
  server.close();
  for (const db of workspaceDbs.values()) closeWorkspaceDb(db);
  authDb.close();
  catalogDb.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
