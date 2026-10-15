import { clientRevisionHeader, endpointContract, endpointVersionHeader } from '../shared/apiCompatibility.ts';

declare const __YEAST_BUILD_INFO__: { commit: string | null } | undefined;

export class AppUpdateRequiredError extends Error {
  constructor(readonly requiredEndpointVersion: number) {
    super('Update Yeast.Win! to continue.');
  }
}

export class ServerUpdateRequiredError extends Error {
  constructor(readonly serverEndpointVersion: number) {
    super('The server needs an update to support this app.');
  }
}

function requestPath(input: RequestInfo | URL): string {
  const url = input instanceof Request ? input.url : String(input);
  return new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.origin).pathname;
}

function expectedVersion(input: RequestInfo | URL, method: string): number {
  const path = requestPath(input);
  const contract = endpointContract(path, method);
  if (!contract && path.startsWith('/api/')) throw new Error(`No API contract for ${method} ${path}`);
  return contract?.version || 1;
}

function browserRevision(): string {
  return (typeof __YEAST_BUILD_INFO__ === 'undefined' ? null : __YEAST_BUILD_INFO__.commit) || 'unknown';
}

export function apiRevisionHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  headers.set(clientRevisionHeader, browserRevision());
  headers.set(endpointVersionHeader, String(expectedVersion(input, method)));
  return headers;
}

function requireAppUpdate(version: number): never {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('yeast:app-update-required'));
  throw new AppUpdateRequiredError(version);
}

export async function fetchWithApiRevision(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const wantedVersion = expectedVersion(input, method);
  const response = await fetch(input, { ...init, headers: apiRevisionHeaders(input, init) });
  if (response.status === 409) {
    const result = await response.clone().json().catch(() => null) as
      { code?: string; requiredEndpointVersion?: number; serverEndpointVersion?: number } | null;
    if (result?.code === 'app_update_required') requireAppUpdate(result.requiredEndpointVersion || 0);
    if (result?.code === 'server_update_required') throw new ServerUpdateRequiredError(result.serverEndpointVersion || 0);
  }
  if (response.ok) {
    // A pre-protocol server has no endpoint-version header and represents v1.
    const suppliedVersion = Number(response.headers.get(endpointVersionHeader) || '1');
    if (!Number.isSafeInteger(suppliedVersion) || suppliedVersion < wantedVersion)
      throw new ServerUpdateRequiredError(suppliedVersion || 0);
    if (suppliedVersion > wantedVersion) requireAppUpdate(suppliedVersion);
  }
  return response;
}

export function apiAssetUrl(path: string): string {
  const separator = path.includes('?') ? '&' : '?';
  const version = expectedVersion(path, 'GET');
  return `${path}${separator}client_rev=${encodeURIComponent(browserRevision())}&endpoint_version=${version}`;
}
