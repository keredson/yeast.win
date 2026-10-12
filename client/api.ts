export type { PreferredUnits } from '../shared/units.ts';
import type { PreferredUnits } from '../shared/units.ts';

export interface Workspace { id: string; name: string; slug: string | null }
export interface Session {
  account: { id: string; username: string; has_avatar: boolean };
  workspaces: Workspace[];
  preferred_units: PreferredUnits;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class ApiUnavailableError extends Error {
  constructor() { super('Cannot reach the server. Check that it is running and try again.'); }
}

export async function fetchApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const response = await fetch(input, init);
    if ([502, 503, 504].includes(response.status)) throw new ApiUnavailableError();
    return response;
  } catch (cause) {
    if (cause instanceof TypeError) throw new ApiUnavailableError();
    throw cause;
  }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetchApi(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(result.error || `Request failed (${response.status})`, response.status);
  return result;
}
