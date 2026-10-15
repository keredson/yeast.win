import { clientApiVersion, clientApiVersionHeader, clientRevisionHeader } from '../shared/apiCompatibility.ts';

declare const __YEAST_BUILD_INFO__: { commit: string | null } | undefined;

export class AppUpdateRequiredError extends Error {
  constructor(readonly requiredClientApiVersion: number) {
    super('Update Yeast.Win! to continue.');
  }
}

export function apiRevisionHeaders(existing?: HeadersInit): Headers {
  const headers = new Headers(existing);
  const revision = typeof __YEAST_BUILD_INFO__ === 'undefined' ? null : __YEAST_BUILD_INFO__.commit;
  headers.set(clientRevisionHeader, revision || 'unknown');
  headers.set(clientApiVersionHeader, String(clientApiVersion));
  return headers;
}

export async function fetchWithApiRevision(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const response = await fetch(input, { ...init, headers: apiRevisionHeaders(headers) });
  if (response.status === 409) {
    const result = await response.clone().json().catch(() => null) as
      { code?: string; requiredClientApiVersion?: number } | null;
    if (result?.code === 'app_update_required') {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('yeast:app-update-required'));
      throw new AppUpdateRequiredError(result.requiredClientApiVersion || 0);
    }
  }
  return response;
}

export function apiAssetUrl(path: string): string {
  const revision = typeof __YEAST_BUILD_INFO__ === 'undefined' ? null : __YEAST_BUILD_INFO__.commit;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}client_rev=${encodeURIComponent(revision || 'unknown')}`;
}
