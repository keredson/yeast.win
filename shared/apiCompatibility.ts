export const clientRevisionHeader = 'X-Yeast-Client-Rev';
export const clientApiVersionHeader = 'X-Yeast-Client-Api';
export const serverRevisionHeader = 'X-Yeast-Server-Rev';

// Increment when a client must understand a changed API contract. Only routes
// listed below reject older versions; unrelated endpoints remain available.
export const clientApiVersion = 2;

export interface AppUpdateConflict {
  code: 'app_update_required';
  error: string;
  requiredClientApiVersion: number;
}

export function appUpdateConflict(pathname: string, method: string | undefined,
  suppliedVersion: string | undefined): AppUpdateConflict | null {
  // The RAPT settings response switched from batch targets to brewery ownership.
  // Headerless clients predate update handling and still receive the legacy
  // `targets: []` field until they have refreshed.
  const requiredVersion = pathname === '/api/me/rapt' && method === 'GET' ? 2
    : /^\/api\/me\/rapt\/devices\/[^/]+\/assignment$/.test(pathname) ? 2 : 0;
  if (!requiredVersion || suppliedVersion === undefined) return null;
  const version = Number(suppliedVersion);
  if (Number.isSafeInteger(version) && version >= requiredVersion) return null;
  return { code: 'app_update_required', error: 'Update Yeast.Win! to continue.',
    requiredClientApiVersion: requiredVersion };
}
