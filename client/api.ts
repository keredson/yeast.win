export type { PreferredUnits } from '../shared/units.ts';
import type { PreferredUnits } from '../shared/units.ts';

export interface Workspace { id: string; name: string }
export interface Session {
  account: { id: string; username: string; has_avatar: boolean };
  workspaces: Workspace[];
  preferred_units: PreferredUnits;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(result.error || `Request failed (${response.status})`, response.status);
  return result;
}
