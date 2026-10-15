export const clientRevisionHeader = 'X-Yeast-Client-Rev';
export const endpointVersionHeader = 'X-Yeast-Endpoint-Version';
export const serverRevisionHeader = 'X-Yeast-Server-Rev';

interface EndpointContract { method: string; path: string; version: number; changeId: string }

// Keep each method/path's version and change ID on one line. A breaking change
// edits that line with a fresh random UUID, so independent branches bumping the
// same endpoint produce a merge conflict even if both choose the same integer.
export const endpointContracts: readonly EndpointContract[] = [
  { method: 'GET', path: '/api/healthz', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/about', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/brewer/:username', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/brewer/:username/avatar', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/brewer/:username/activity', version: 1, changeId: 'baseline' },
  { method: 'POST', path: '/api/webhooks/rapt/:token', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/username', version: 1, changeId: 'baseline' },
  { method: 'POST', path: '/api/register', version: 1, changeId: 'baseline' },
  { method: 'POST', path: '/api/login', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/me', version: 1, changeId: 'baseline' },
  { method: 'PATCH', path: '/api/me/profile', version: 1, changeId: 'baseline' },
  { method: 'PATCH', path: '/api/me/time-zone', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/me/rapt', version: 2, changeId: 'c1616970-e2f0-4ef2-8db1-992284ed20dc' },
  { method: 'POST', path: '/api/me/rapt/webhook', version: 1, changeId: 'baseline' },
  { method: 'PUT', path: '/api/me/rapt/webhook', version: 1, changeId: 'baseline' },
  { method: 'DELETE', path: '/api/me/rapt/webhook', version: 1, changeId: 'baseline' },
  { method: 'PUT', path: '/api/me/rapt/devices/:id/brewery', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/catalog/sync', version: 1, changeId: 'baseline' },
  { method: 'PATCH', path: '/api/me/preferences', version: 1, changeId: 'baseline' },
  { method: 'POST', path: '/api/me/password', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/me/avatar', version: 1, changeId: 'baseline' },
  { method: 'PUT', path: '/api/me/avatar', version: 1, changeId: 'baseline' },
  { method: 'POST', path: '/api/logout', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/workspaces', version: 1, changeId: 'baseline' },
  { method: 'POST', path: '/api/workspaces', version: 1, changeId: 'baseline' },
  { method: 'PATCH', path: '/api/workspaces/:id', version: 1, changeId: 'baseline' },
  { method: 'DELETE', path: '/api/workspaces/:id', version: 1, changeId: 'baseline' },
  { method: 'POST', path: '/api/workspaces/:id/sync/upload', version: 1, changeId: 'baseline' },
  { method: 'GET', path: '/api/workspaces/:id/sync/download', version: 1, changeId: 'baseline' },
  // Retired routes remain listed so update-aware old tabs get a useful error.
  { method: 'PUT', path: '/api/me/rapt/devices/:id/assignment', version: 2, changeId: '849d63ee-e42d-4263-a45b-81e2c38a1474' },
  { method: 'DELETE', path: '/api/me/rapt/devices/:id/assignment', version: 2, changeId: '1384abe4-ec69-4118-a315-55cd39377d56' }
];

function pathMatches(pattern: string, pathname: string): boolean {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  return expected.length === actual.length && expected.every((part, index) =>
    part.startsWith(':') ? actual[index].length > 0 : part === actual[index]);
}

export function endpointContract(pathname: string, method: string | undefined): EndpointContract | null {
  return endpointContracts.find(entry => entry.method === method && pathMatches(entry.path, pathname)) || null;
}

export interface AppUpdateConflict {
  code: 'app_update_required';
  error: string;
  requiredEndpointVersion: number;
}

export interface ServerUpdateConflict {
  code: 'server_update_required';
  error: string;
  serverEndpointVersion: number;
}

export function endpointVersionConflict(contract: EndpointContract | null, suppliedVersion: string | undefined):
  AppUpdateConflict | ServerUpdateConflict | null {
  // Headerless deployed clients predate update handling. Keep compatible
  // response fields, such as the RAPT settings `targets: []`, for those tabs.
  if (!contract || suppliedVersion === undefined) return null;
  const version = Number(suppliedVersion);
  if (Number.isSafeInteger(version) && version === contract.version) return null;
  if (Number.isSafeInteger(version) && version > contract.version) return {
    code: 'server_update_required', error: 'The server needs an update to support this app.',
    serverEndpointVersion: contract.version
  };
  return { code: 'app_update_required', error: 'Update Yeast.Win! to continue.',
    requiredEndpointVersion: contract.version };
}
