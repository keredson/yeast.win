import type { Workspace } from './api.ts';

export type Section = 'home' | 'batches' | 'recipes' | 'inventory' | 'equipment' | 'locations' | 'me';
export interface Route { section: Section; selectedId: string | null; slug: string | null }
const detailPaths = { batches: 'batch', recipes: 'recipe', inventory: 'inventory', equipment: 'equipment', locations: 'location' } as const;

export function routeFromPath(path: string): Route {
  if (path === '/me') return { section: 'me', selectedId: null, slug: null };
  const prefix = /^\/brewery\/([a-z0-9-]+)(?=\/|$)/.exec(path);
  const slug = prefix?.[1] || null;
  const localPath = prefix ? path.slice(prefix[0].length) || '/' : path;
  if (localPath === '/') return { section: 'home', selectedId: null, slug };
  const equipmentUnit = /^\/equipment\/([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)$/.exec(localPath);
  if (equipmentUnit) return { section: 'equipment', selectedId: equipmentUnit[1], slug };
  for (const section of ['batches', 'recipes', 'inventory', 'equipment', 'locations'] as const) {
    if (localPath === `/${section}`) return { section, selectedId: null, slug };
    const segmentPattern = section === 'inventory' || section === 'equipment' || section === 'locations' || section === 'recipes' ? '[A-Za-z0-9_-]+' : '[A-Za-z0-9_-]{10,32}';
    const match = new RegExp(`^/${detailPaths[section]}/(${segmentPattern})$`).exec(localPath);
    if (match) return { section, selectedId: match[1], slug };
  }
  return { section: 'home', selectedId: null, slug };
}

export function workspaceBase(workspaceId: string | null, workspaces: Workspace[]): string {
  const workspace = workspaces.find(item => item.id === workspaceId);
  return workspace?.slug ? `/brewery/${workspace.slug}` : '';
}

export function routePath(section: Section, selectedId: string | null, base: string): string {
  if (section === 'me') return '/me';
  if (section === 'home') return base || '/';
  return selectedId ? `${base}/${detailPaths[section]}/${selectedId}` : `${base}/${section}`;
}
