import { useCallback, useEffect, useRef, useState } from 'react';
import { AppstoreOutlined, BookOutlined, DisconnectOutlined, EnvironmentOutlined, InboxOutlined, MenuOutlined, ToolOutlined } from '@ant-design/icons';
import { Alert, Avatar, Button, Card, Drawer, Empty, Form, Input, Layout, Menu, Popover, Select, Spin, Tooltip, Typography } from 'antd';
import { api, ApiError, ApiUnavailableError, type PreferredUnits, type Session, type Workspace } from './api.ts';
import { defaultPreferredUnits } from '../shared/units.ts';
import { forgetLocalDb, openLocalDb, syncNow, type Batch, type Equipment, type InventoryItem, type InventoryLocation, type LocalDb, type Recipe, type RecipeType,
  listBatches, listEquipment, listInventory, listInventoryLocations, listRecipes } from './db.ts';
import { BatchSection } from './BatchSection.tsx';
import { RecipeSection } from './RecipeSection.tsx';
import { RecipeTypeIcon } from './RecipeTypeIcon.tsx';
import { InventorySection } from './InventorySection.tsx';
import { inventoryItemForPath, inventoryPathSegment } from './inventoryRoutes.ts';
import { equipmentItemForPath, equipmentPathSegment } from './equipmentRoutes.ts';
import { EquipmentSection } from './EquipmentSection.tsx';
import { LocationsSection } from './LocationsSection.tsx';
import { locationForPath } from './locationRoutes.ts';
import { AccountSection } from './AccountSection.tsx';
import { openLocalCatalog, readLocalCatalog, syncLocalCatalog } from './catalog.ts';
import type { CatalogEquipment, CatalogInventory } from '../shared/catalog.ts';

type Section = 'batches' | 'recipes' | 'inventory' | 'equipment' | 'locations' | 'me';
interface Route { section: Section; selectedId: string | null; slug: string | null }
const detailPaths = { batches: 'batch', recipes: 'recipe', inventory: 'inventory', equipment: 'equipment', locations: 'location' } as const;

function routeFromPath(path: string): Route {
  if (path === '/me') return { section: 'me', selectedId: null, slug: null };
  const prefix = /^\/brewery\/([a-z0-9-]+)(?=\/|$)/.exec(path);
  const slug = prefix?.[1] || null;
  const localPath = prefix ? path.slice(prefix[0].length) || '/' : path;
  for (const section of ['batches', 'recipes', 'inventory', 'equipment', 'locations'] as const) {
    if (localPath === `/${section}`) return { section, selectedId: null, slug };
    const segmentPattern = section === 'inventory' || section === 'equipment' || section === 'locations' ? '[A-Za-z0-9_-]+' : '[A-Za-z0-9_-]{10,32}';
    const match = new RegExp(`^/${detailPaths[section]}/(${segmentPattern})$`).exec(localPath);
    if (match) return { section, selectedId: match[1], slug };
  }
  return { section: 'batches', selectedId: null, slug };
}

function workspaceBase(workspaceId: string | null, workspaces: Workspace[]): string {
  const workspace = workspaces.find(item => item.id === workspaceId);
  return workspace?.slug ? `/brewery/${workspace.slug}` : '';
}

function routePath(section: Section, selectedId: string | null, base: string): string {
  if (section === 'me') return '/me';
  return selectedId ? `${base}/${detailPaths[section]}/${selectedId}` : `${base}/${section}`;
}
const navItems = [
  { key: 'batches', label: 'Batches', icon: AppstoreOutlined },
  { key: 'recipes', label: 'Recipes', icon: BookOutlined },
  { key: 'inventory', label: 'Inventory', icon: InboxOutlined },
  { key: 'locations', label: 'Locations', icon: EnvironmentOutlined },
  { key: 'equipment', label: 'Equipment', icon: ToolOutlined }
] as const;
type RecordSection = Exclude<Section, 'me'>;
type NavRecord = { id: string; name: string; recipe_type?: RecipeType | null };
type RecentItems = Record<RecordSection, string[]>;
const recordSections: RecordSection[] = ['batches', 'recipes', 'inventory', 'equipment', 'locations'];
const emptyRecents = (): RecentItems => ({ batches: [], recipes: [], inventory: [], equipment: [], locations: [] });

function SectionNavigation({ route, recent, records, onNavigate }: {
  route: Route; recent: RecentItems; records: Record<RecordSection, NavRecord[]>;
  onNavigate: (section: RecordSection, id: string | null) => void;
}) {
  const items = navItems.flatMap(({ key, label, icon: Icon }) => {
    const links = (key === 'inventory' || key === 'equipment' || key === 'locations' ? [] : recent[key]).map(id => records[key].find(item => item.id === id))
      .filter((item): item is NavRecord => !!item);
    return [{ key, label, icon: <Icon /> }, ...links.map(item => ({
      key: `${key}:${item.id}`, className: 'nav-recent-item',
      label: <span className="nav-recent-label">
        {key === 'recipes' && <RecipeTypeIcon type={item.recipe_type || null} compact />}
        <span className="nav-recent-title" title={item.name}>{item.name}</span>
      </span>
    }))];
  });
  return <Menu mode="inline"
    selectedKeys={route.section === 'me' ? [] : [route.selectedId && route.section !== 'inventory' && route.section !== 'equipment' && route.section !== 'locations'
      ? `${route.section}:${route.selectedId}` : route.section]}
    items={items}
    onClick={({ key }) => { const [section, id] = key.split(':'); onNavigate(section as RecordSection, id || null); }} />;
}
const cachedSessionKey = 'brewlog:last-session';
const signedOutKey = 'brewlog:signed-out';
const autoSyncKey = 'brewlog:auto-sync';
const activeBreweryKey = 'brewlog:active-brewery';

function initialBrewery(workspaces: Workspace[]): string | null {
  const linked = new URLSearchParams(location.search).get('brewery');
  const slug = routeFromPath(location.pathname).slug;
  const remembered = localStorage.getItem(activeBreweryKey);
  if (linked) return workspaces.find(item => item.id === linked)?.id || workspaces[0]?.id || null;
  if (slug) return workspaces.find(item => item.slug === slug)?.id || workspaces[0]?.id || null;
  if (location.pathname === '/me') return workspaces.find(item => item.id === remembered)?.id || workspaces[0]?.id || null;
  return workspaces.find(item => item.slug === null)?.id || workspaces[0]?.id || null;
}

function canonicalizeLocation(workspaces: Workspace[]): void {
  const linked = new URLSearchParams(location.search).get('brewery');
  const route = routeFromPath(location.pathname);
  if (route.section === 'me') return;
  const workspace = linked ? workspaces.find(item => item.id === linked)
    : route.slug ? workspaces.find(item => item.slug === route.slug)
      : workspaces.find(item => item.slug === null);
  const target = workspace || workspaces[0];
  const path = target ? routePath(route.section, workspace ? route.selectedId : null, workspaceBase(target.id, workspaces)) : '/me';
  if (location.pathname + location.search !== path) history.replaceState(null, '', path);
}

function cachedSession(): Session | null {
  try {
    const value = JSON.parse(localStorage.getItem(cachedSessionKey) || 'null') as Session | null;
    if (value && typeof value.account?.id === 'string' && Array.isArray(value.workspaces)
      && value.workspaces.every(item => typeof item.id === 'string' && typeof item.name === 'string')) {
      const used = new Set<string>();
      const workspaces = value.workspaces.map(item => {
        const base = item.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'brewery';
        let slug: string | null = item.slug === null ? null : typeof item.slug === 'string' && item.slug ? item.slug : base;
        if (slug) {
          for (let number = 2; used.has(slug); number++) slug = `${base}-${number}`;
          used.add(slug);
        }
        return { ...item, slug };
      });
      return { ...value, workspaces };
    }
  } catch { /* Ignore corrupt local metadata. */ }
  return null;
}

function rememberSession(value: Session) {
  localStorage.setItem(cachedSessionKey, JSON.stringify(value));
}

function lastSyncKey(workspaceId: string) { return `brewlog:last-sync:${workspaceId}`; }

function timeSinceSync(lastSyncedAt: number | null, now: number): string {
  if (lastSyncedAt === null) return 'Never synced';
  const seconds = Math.max(0, Math.floor((now - lastSyncedAt) / 1000));
  if (seconds < 60) return `Last synced ${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last synced ${hours} hr ago`;
  return `Last synced ${Math.floor(hours / 24)} days ago`;
}

export function App() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [openedDb, setOpenedDb] = useState<{ workspaceId: string; db: LocalDb } | null>(null);
  const db = openedDb?.workspaceId === workspaceId ? openedDb.db : null;
  const activeWorkspaceId = useRef(workspaceId);
  activeWorkspaceId.current = workspaceId;
  const [route, setRoute] = useState<Route>(() => routeFromPath(location.pathname));
  const section = route.section;
  const [autoSync, setAutoSync] = useState(() => localStorage.getItem(autoSyncKey) !== '0');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [inventoryWorkspaceId, setInventoryWorkspaceId] = useState<string | null>(null);
  const [equipmentWorkspaceId, setEquipmentWorkspaceId] = useState<string | null>(null);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [recent, setRecent] = useState<RecentItems>(emptyRecents);
  const [catalogEquipment, setCatalogEquipment] = useState<CatalogEquipment[]>([]);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [catalogInventory, setCatalogInventory] = useState<CatalogInventory[]>([]);
  const [error, setError] = useState('');
  const [serverDisconnected, setServerDisconnected] = useState(false);
  const [syncPhase, setSyncPhase] = useState<'idle' | 'syncing' | 'synced' | 'failed'>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(Date.now());

  useEffect(() => {
    if (localStorage.getItem(signedOutKey) === '1') {
      setLoading(false);
      return;
    }
    api<Session>('/me').then(result => {
      setServerDisconnected(false);
      canonicalizeLocation(result.workspaces);
      rememberSession(result);
      setSession(result);
      setWorkspaceId(initialBrewery(result.workspaces));
      setRoute(routeFromPath(location.pathname));
    }).catch(cause => {
      if (cause instanceof ApiUnavailableError) setServerDisconnected(true);
      if (cause instanceof ApiError && cause.status === 401) localStorage.removeItem(cachedSessionKey);
      const remembered = cause instanceof ApiError && cause.status === 401 ? null : cachedSession();
      if (remembered) canonicalizeLocation(remembered.workspaces);
      setSession(remembered);
      setWorkspaceId(remembered ? initialBrewery(remembered.workspaces) : null);
      setRoute(routeFromPath(location.pathname));
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const checkConnection = () => {
      void api('/health').then(() => {
        if (!cancelled) setServerDisconnected(false);
      }).catch(cause => {
        if (!cancelled) setServerDisconnected(cause instanceof ApiUnavailableError);
      });
    };
    checkConnection();
    const timer = window.setInterval(checkConnection, 30_000);
    window.addEventListener('online', checkConnection);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('online', checkConnection); };
  }, [session?.account.id]);

  useEffect(() => {
    setLastSyncedAt(workspaceId ? Number(localStorage.getItem(lastSyncKey(workspaceId))) || null : null);
    setSyncPhase('idle');
  }, [workspaceId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const load = async () => {
      const catalogDb = await openLocalCatalog();
      const cached = await readLocalCatalog(catalogDb);
      if (!cancelled) { setCatalogEquipment(cached.equipment); setCatalogInventory(cached.inventory); }
      try {
        await syncLocalCatalog(catalogDb);
        const updated = await readLocalCatalog(catalogDb);
        if (!cancelled) {
          setCatalogEquipment(updated.equipment);
          setCatalogInventory(updated.inventory);
          setCatalogRevision(revision => revision + 1);
        }
      } catch { /* Cached catalog remains searchable offline. */ }
    };
    const refreshCatalog = () => {
      void load().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    };
    refreshCatalog();
    const timer = window.setInterval(refreshCatalog, 5 * 60_000);
    window.addEventListener('online', refreshCatalog);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('online', refreshCatalog); };
  }, [session?.account.id]);

  useEffect(() => {
    if (!db || !workspaceId || !catalogRevision) return;
    let cancelled = false;
    void listEquipment(db).then(items => {
      if (!cancelled && activeWorkspaceId.current === workspaceId) setEquipment(items);
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [db, workspaceId, catalogRevision]);

  useEffect(() => {
    if (location.pathname === '/') history.replaceState(null, '', '/batches');
    const onBackOrForward = () => {
      if (session) canonicalizeLocation(session.workspaces);
      const next = routeFromPath(location.pathname);
      setRoute(next);
      if (next.section === 'me' || !session) return;
      const workspace = next.slug ? session.workspaces.find(item => item.slug === next.slug)
        : session.workspaces.find(item => item.slug === null);
      if (workspace) {
        setWorkspaceId(workspace.id);
        localStorage.setItem(activeBreweryKey, workspace.id);
      }
    };
    window.addEventListener('popstate', onBackOrForward);
    return () => window.removeEventListener('popstate', onBackOrForward);
  }, [session]);

  useEffect(() => {
    if (!workspaceId) return;
    const next = emptyRecents();
    for (const name of recordSections) {
      try {
        const saved = JSON.parse(localStorage.getItem(`brewlog:recent:${workspaceId}:${name}`) || '[]') as unknown;
        next[name] = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string').slice(0, 5) : [];
      } catch { next[name] = []; }
    }
    if (route.section !== 'me' && route.selectedId) {
      const name = route.section;
      if (name !== 'recipes' || !next[name].includes(route.selectedId)) {
        next[name] = [route.selectedId, ...next[name].filter(id => id !== route.selectedId)].slice(0, 5);
        localStorage.setItem(`brewlog:recent:${workspaceId}:${name}`, JSON.stringify(next[name]));
      }
    }
    setRecent(next);
  }, [workspaceId, route]);

  useEffect(() => {
    if (route.section !== 'inventory' || !route.selectedId || inventoryWorkspaceId !== workspaceId) return;
    const found = inventoryItemForPath(route.selectedId, inventory);
    if (!found) return;
    const path = routePath('inventory', inventoryPathSegment(found, inventory), workspaceBase(workspaceId, session?.workspaces || []));
    if (location.pathname !== path) history.replaceState(null, '', path);
    if (route.selectedId !== found.id) setRoute(current => ({ ...current, selectedId: found.id }));
  }, [route.section, route.selectedId, inventory, inventoryWorkspaceId, workspaceId, session?.workspaces]);

  useEffect(() => {
    if (route.section !== 'equipment' || !route.selectedId || equipmentWorkspaceId !== workspaceId) return;
    const found = equipmentItemForPath(route.selectedId, equipment);
    if (!found) return;
    const path = routePath('equipment', equipmentPathSegment(found, equipment), workspaceBase(workspaceId, session?.workspaces || []));
    if (location.pathname !== path) history.replaceState(null, '', path);
    if (route.selectedId !== found.id) setRoute(current => ({ ...current, selectedId: found.id }));
  }, [route.section, route.selectedId, equipment, equipmentWorkspaceId, workspaceId, session?.workspaces]);

  useEffect(() => {
    if (route.section !== 'locations' || !route.selectedId || inventoryWorkspaceId !== workspaceId) return;
    const found = locationForPath(route.selectedId, locations);
    if (!found) return;
    const path = routePath('locations', found.slug, workspaceBase(workspaceId, session?.workspaces || []));
    if (location.pathname !== path) history.replaceState(null, '', path);
    if (route.selectedId !== found.id) setRoute(current => ({ ...current, selectedId: found.id }));
  }, [route.section, route.selectedId, locations, inventoryWorkspaceId, workspaceId, session?.workspaces]);

  function showSection(next: Section, targetWorkspaceId = workspaceId) {
    const base = workspaceBase(targetWorkspaceId, session?.workspaces || []);
    const path = routePath(next, null, base);
    if (location.pathname !== path || location.search) history.pushState(null, '', path);
    setRoute({ section: next, selectedId: null, slug: next === 'me' ? null : base.split('/')[2] || null });
    setMenuOpen(false);
  }

  function showItem(next: Exclude<Section, 'me'>, id: string | null) {
    const base = workspaceBase(workspaceId, session?.workspaces || []);
    const inventoryItem = next === 'inventory' && id ? inventory.find(row => row.id === id) : null;
    const equipmentItem = next === 'equipment' && id ? equipment.find(row => row.id === id) : null;
    const locationItem = next === 'locations' && id ? locations.find(row => row.id === id) : null;
    const segment = inventoryItem ? inventoryPathSegment(inventoryItem, inventory)
      : equipmentItem ? equipmentPathSegment(equipmentItem, equipment) : locationItem ? locationItem.slug : id;
    const path = routePath(next, segment, base);
    if (location.pathname !== path || location.search) history.pushState(null, '', path);
    setRoute({ section: next, selectedId: id, slug: base.split('/')[2] || null });
  }

  async function signOut() {
    try { await api('/logout', 'POST'); } catch { /* Clear local access even while offline. */ }
    localStorage.removeItem(cachedSessionKey);
    localStorage.setItem(signedOutKey, '1');
    setSession(null);
    setOpenedDb(null);
    history.replaceState(null, '', '/');
    setRoute({ section: 'batches', selectedId: null, slug: null });
  }

  const refresh = useCallback(async (activeDb: LocalDb, targetWorkspaceId: string) => {
    const [nextBatches, nextRecipes, nextInventory, nextEquipment, nextLocations] = await Promise.all([
      listBatches(activeDb), listRecipes(activeDb), listInventory(activeDb), listEquipment(activeDb), listInventoryLocations(activeDb)
    ]);
    if (activeWorkspaceId.current !== targetWorkspaceId) return;
    setBatches(nextBatches);
    setRecipes(nextRecipes);
    setInventory(nextInventory);
    setLocations(nextLocations);
    setInventoryWorkspaceId(targetWorkspaceId);
    setEquipment(nextEquipment);
    setEquipmentWorkspaceId(targetWorkspaceId);
  }, []);

  const runSync = useCallback(async (activeDb: LocalDb, targetWorkspaceId: string) => {
    if (activeWorkspaceId.current !== targetWorkspaceId) return;
    setSyncPhase('syncing');
    try {
      await syncNow(activeDb, targetWorkspaceId);
      if (activeWorkspaceId.current !== targetWorkspaceId) return;
      await refresh(activeDb, targetWorkspaceId);
      const syncedAt = Date.now();
      localStorage.setItem(lastSyncKey(targetWorkspaceId), String(syncedAt));
      setLastSyncedAt(syncedAt);
      setNow(syncedAt);
      setSyncPhase('synced');
      setServerDisconnected(false);
      setError('');
    } catch (cause) {
      if (activeWorkspaceId.current !== targetWorkspaceId) return;
      setSyncPhase('failed');
      if (cause instanceof ApiUnavailableError) setServerDisconnected(true);
      else if (navigator.onLine) setError(cause instanceof Error ? cause.message : 'Sync failed');
    }
  }, [refresh]);

  useEffect(() => {
    if (!workspaceId || !session) return;
    let cancelled = false;
    setOpenedDb(null);
    openLocalDb(workspaceId).then(async activeDb => {
      if (cancelled) return;
      setOpenedDb({ workspaceId, db: activeDb });
      await refresh(activeDb, workspaceId);
      if (autoSync) await runSync(activeDb, workspaceId);
    }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { cancelled = true; };
  }, [workspaceId, session, refresh, runSync, autoSync]);

  useEffect(() => {
    if (!db || !workspaceId || !autoSync) return;
    const callback = () => { void runSync(db, workspaceId); };
    const timer = window.setInterval(callback, 30_000);
    window.addEventListener('online', callback);
    return () => { window.clearInterval(timer); window.removeEventListener('online', callback); };
  }, [db, workspaceId, runSync, autoSync]);

  const changed = useCallback(async () => {
    if (!db || !workspaceId) return;
    await refresh(db, workspaceId);
    if (autoSync) void runSync(db, workspaceId);
  }, [db, workspaceId, refresh, runSync, autoSync]);

  async function createWorkspace(name: string) {
    if (!session) return;
    const workspace = await api<Workspace>('/workspaces', 'POST', { name });
    const updated = { ...session, workspaces: [...session.workspaces, workspace] };
    rememberSession(updated);
    setSession(updated);
    setWorkspaceId(workspace.id);
    localStorage.setItem(activeBreweryKey, workspace.id);
    setOpenedDb(null);
  }

  async function renameWorkspace(id: string, name: string, slug: string | null) {
    if (!session) return;
    const workspace = await api<Workspace>(`/workspaces/${id}`, 'PATCH', { name, slug });
    const updated = { ...session, workspaces: session.workspaces.map(item => item.id === id ? workspace : item) };
    rememberSession(updated);
    setSession(updated);
  }

  async function removeWorkspace(id: string) {
    if (!session) return;
    await api(`/workspaces/${id}`, 'DELETE');
    const workspaces = session.workspaces.filter(item => item.id !== id);
    const updated = { ...session, workspaces };
    rememberSession(updated);
    setSession(updated);
    if (workspaceId === id) {
      const fallback = workspaces[0]?.id || null;
      activeWorkspaceId.current = fallback;
      setWorkspaceId(fallback);
      setOpenedDb(null);
      if (fallback) localStorage.setItem(activeBreweryKey, fallback);
      else localStorage.removeItem(activeBreweryKey);
    }
    localStorage.removeItem(lastSyncKey(id));
    for (const name of recordSections) localStorage.removeItem(`brewlog:recent:${id}:${name}`);
    try { await forgetLocalDb(id); }
    catch (cause) { setError(`Brewery deleted, but its local cache could not be removed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }

  async function updatePreferredUnits(units: PreferredUnits) {
    if (!session) return;
    await api('/me/preferences', 'PATCH', units);
    const updated = { ...session, preferred_units: units };
    rememberSession(updated);
    setSession(updated);
  }

  if (loading) return <div className="loading-screen"><Spin size="large" /></div>;
  if (!session) return <AccountAccess onAuthenticated={result => { setSession(result); setWorkspaceId(initialBrewery(result.workspaces));
    if (location.pathname === '/') showSection('batches'); }} />;
  const avatarSrc = session.account.has_avatar ? `/api/me/avatar?v=${avatarVersion}` : undefined;
  const preferredUnits = session.preferred_units || defaultPreferredUnits;
  const activeBase = workspaceBase(workspaceId, session.workspaces);

  return <div className="app-shell">
    <header className="app-header">
      <div className="header-brand-row">
        <Button className="mobile-menu-button" type="text" shape="circle" aria-label="Open navigation"
          icon={<MenuOutlined />} onClick={() => setMenuOpen(true)} />
        <div className="brand"><img className="brand-mark" src="/icon.svg" alt="" /><div><strong>Brewlog</strong><small>Batch-first brewing</small></div></div>
      </div>
      <div className="header-controls">
        <Select className="workspace-select" value={workspaceId} placeholder="No breweries" disabled={!session.workspaces.length}
          aria-label="Brewery"
          options={session.workspaces.map(item => ({ label: item.name, value: item.id }))}
          onChange={value => {
            setWorkspaceId(value); localStorage.setItem(activeBreweryKey, value); setOpenedDb(null); showSection('batches', value);
          }} />
        {serverDisconnected && <Popover trigger="click" title="Server disconnected" content={<div className="connection-popover">
          <p>Your brewing entries are saved on this device.</p>
          <p>{autoSync ? 'They will sync when the server is available again.' : 'Sync them from Settings when the server is available again.'}</p>
        </div>}>
          <Button className="connection-button" type="text" shape="circle" aria-label="Server disconnected"
            icon={<DisconnectOutlined />} />
        </Popover>}
        <Tooltip title="Account settings">
          <Button className="avatar-button" type="text" shape="circle" aria-label="Account settings" onClick={() => showSection('me')}>
            <Avatar size={32} src={avatarSrc}>{session.account.username[0].toUpperCase()}</Avatar>
          </Button>
        </Tooltip>
      </div>
    </header>

    <div className="app-body">
      <Layout.Sider className="app-nav" width={220} theme="light" aria-label="Sections">
        <SectionNavigation route={route} recent={recent} records={{ batches, recipes, inventory, equipment, locations }}
          onNavigate={(name, id) => id ? showItem(name, id) : showSection(name)} />
      </Layout.Sider>
      <Drawer className="mobile-nav-drawer" title="Sections" placement="left" width={250} open={menuOpen} onClose={() => setMenuOpen(false)}>
        <div className="drawer-nav"><SectionNavigation route={route} recent={recent} records={{ batches, recipes, inventory, equipment, locations }}
          onNavigate={(name, id) => { id ? showItem(name, id) : showSection(name); setMenuOpen(false); }} /></div>
      </Drawer>
      <main className="app-main">
        {error && <Alert type="warning" showIcon closable onClose={() => setError('')} message={error} className="page-alert" />}
        {section === 'me' ? <AccountSection username={session.account.username} avatarSrc={avatarSrc}
          workspaces={session.workspaces} activeWorkspaceId={workspaceId}
          onCreateWorkspace={createWorkspace} onUpdateWorkspace={renameWorkspace} onDeleteWorkspace={removeWorkspace}
          onAvatarUploaded={() => { const updated = { ...session, account: { ...session.account, has_avatar: true } };
            rememberSession(updated); setSession(updated); setAvatarVersion(Date.now()); }}
          preferredUnits={preferredUnits} onPreferredUnitsChange={updatePreferredUnits}
          syncPhase={syncPhase} syncStatus={timeSinceSync(lastSyncedAt, now)} canSync={!!db && !!workspaceId}
          onManualSync={() => { if (db && workspaceId) void runSync(db, workspaceId); }}
          autoSync={autoSync} onAutoSyncChange={enabled => { localStorage.setItem(autoSyncKey, enabled ? '1' : '0'); setAutoSync(enabled); }}
          onSignOut={signOut} /> : !workspaceId ? <Empty description="Add a brewery in Settings to begin">
            <Button type="primary" onClick={() => showSection('me')}>Open Settings</Button></Empty> :
          !db ? <div className="loading-screen"><Spin tip="Opening local database" /></div> : <>
            {section === 'batches' && <BatchSection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} batches={batches} recipes={recipes}
              equipment={equipment} inventory={inventory} catalogInventory={catalogInventory} preferredUnits={preferredUnits}
              selectedId={route.selectedId} onSelect={id => showItem('batches', id)} onChanged={changed} />}
            {section === 'recipes' && <RecipeSection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} recipes={recipes}
              equipment={equipment} inventory={inventory} catalogInventory={catalogInventory} preferredUnits={preferredUnits}
              selectedId={route.selectedId} onSelect={id => showItem('recipes', id)}
              onChanged={changed} onBatchStarted={id => showItem('batches', id)} />}
            {section === 'inventory' && (inventoryWorkspaceId !== workspaceId ? <div className="loading-screen"><Spin description="Loading inventory" /></div>
              : <InventorySection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} items={inventory}
                catalog={catalogInventory} preferredUnits={preferredUnits} selectedId={route.selectedId
                  ? inventoryItemForPath(route.selectedId, inventory)?.id || route.selectedId : null}
                onSelect={id => showItem('inventory', id)} onChanged={changed} />)}
            {section === 'locations' && (inventoryWorkspaceId !== workspaceId ? <div className="loading-screen"><Spin description="Loading locations" /></div>
              : <LocationsSection key={workspaceId} db={db} basePath={activeBase} locations={locations} items={inventory}
                selectedId={route.selectedId ? locationForPath(route.selectedId, locations)?.id || route.selectedId : null}
                onSelect={id => showItem('locations', id)} onInventorySelect={id => showItem('inventory', id)} onChanged={changed} />)}
            {section === 'equipment' && (equipmentWorkspaceId !== workspaceId ? <div className="loading-screen"><Spin description="Loading equipment" /></div>
              : <EquipmentSection key={workspaceId} db={db} basePath={activeBase} equipment={equipment}
                catalog={catalogEquipment} preferredUnits={preferredUnits} selectedId={route.selectedId
                  ? equipmentItemForPath(route.selectedId, equipment)?.id || route.selectedId : null}
                onSelect={id => showItem('equipment', id)} onChanged={changed} />)}
          </>}
      </main>
    </div>
  </div>;
}

function AccountAccess({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(values: { username: string; password: string; confirm_password?: string }) {
    setBusy(true); setError('');
    try {
      if (mode === 'signup' && values.password !== values.confirm_password) throw new Error('Passwords do not match');
      await api(mode === 'signup' ? '/register' : '/login', 'POST', {
        username: values.username.trim(), password: values.password
      });
      const session = await api<Session>('/me');
      localStorage.removeItem(signedOutKey);
      rememberSession(session);
      onAuthenticated(session);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="login-page"><Card className="login-card">
    <div className="brand login-brand"><img className="brand-mark" src="/icon.svg" alt="" /><div><strong>Brewlog</strong><small>Your batches, as they happened</small></div></div>
    <div className="auth-switch" role="group" aria-label="Account access">
      <button type="button" className={mode === 'login' ? 'active' : ''} aria-pressed={mode === 'login'}
        onClick={() => { setMode('login'); setError(''); }}>Sign in</button>
      <button type="button" className={mode === 'signup' ? 'active' : ''} aria-pressed={mode === 'signup'}
        onClick={() => { setMode('signup'); setError(''); }}>Create account</button>
    </div>
    <Typography.Title level={3}>{mode === 'signup' ? 'Create your account' : 'Sign in'}</Typography.Title>
    {error && <Alert type="error" message={error} className="form-alert" />}
    <Form key={mode} layout="vertical" onFinish={submit}>
      <Form.Item name="username" label="Username" rules={[{ required: true },
        ...(mode === 'signup' ? [{ pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/, message: 'Use 3–40 letters, numbers, _ or -' }] : [])]}>
        <Input autoComplete="username" size="large" maxLength={40} />
      </Form.Item>
      <Form.Item name="password" label="Password" rules={[{ required: true },
        ...(mode === 'signup' ? [{ min: 8, message: 'Use at least 8 characters' }] : [])]}>
        <Input.Password autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} size="large" maxLength={256} />
      </Form.Item>
      {mode === 'signup' && <Form.Item name="confirm_password" label="Confirm password" rules={[{ required: true }]}>
        <Input.Password autoComplete="new-password" size="large" maxLength={256} />
      </Form.Item>}
      <Button htmlType="submit" type="primary" size="large" block loading={busy}>
        {mode === 'signup' ? 'Create my account' : 'Sign in'}
      </Button>
    </Form>
  </Card></div>;
}
