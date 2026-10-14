export const syncSchemaHeader = 'X-Brewlog-Schema-Version';

export type SyncSchemaConflict = {
  code: 'client_update_required' | 'server_update_required';
  error: string;
  requiredSchemaVersion: number;
};

export function syncSchemaConflict(clientVersion: string | undefined, serverVersion: number): SyncSchemaConflict | null {
  const parsed = clientVersion && /^\d+$/.test(clientVersion) ? Number(clientVersion) : NaN;
  if (parsed === serverVersion) return null;
  if (Number.isSafeInteger(parsed) && parsed > serverVersion) return {
    code: 'server_update_required', error: 'The server needs an update before this app can sync.',
    requiredSchemaVersion: serverVersion
  };
  return { code: 'client_update_required', error: 'This app needs an update before it can sync.',
    requiredSchemaVersion: serverVersion };
}
