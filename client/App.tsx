import { useCallback, useEffect, useRef, useState } from 'react';
import { AppstoreOutlined, BookOutlined, DisconnectOutlined, EnvironmentOutlined, HomeOutlined, InboxOutlined, LogoutOutlined, MenuOutlined, SettingOutlined, ToolOutlined } from '@ant-design/icons';
import { Alert, Avatar, Breadcrumb, Button, Drawer, Dropdown, Empty, Layout, Menu, Popover, Progress, Select, Spin, Tooltip } from 'antd';
import { api, ApiError, ApiUnavailableError, ClientUpdateRequiredError, type PreferredUnits, type Session, type Workspace } from './api.ts';
import { checkForAppUpdate } from './appUpdate.ts';
import { defaultPreferredUnits } from '../shared/units.ts';
import { forgetLocalDb, openLocalDb, syncNow, type SyncProgress, type Batch, type Equipment, type InventoryRecord, type InventoryLocation, type LocalDb, type Recipe, type RecipeType,
  listBatches, listEquipment, listEquipmentModels, listInventory, listSupplies, listInventoryLocations, listRecipes } from './db.ts';
import { BatchSection } from './BatchSection.tsx';
import { DashboardSection } from './DashboardSection.tsx';
import { RecipeSection } from './RecipeSection.tsx';
import { RecipeTypeIcon } from './RecipeTypeIcon.tsx';
import { InventorySection } from './InventorySection.tsx';
import { inventorySupplyForPath, inventoryPathSegment } from './inventoryRoutes.ts';
import { equipmentModelForPath, equipmentModelPathSegment, equipmentUnitForPath,
  equipmentUnitPathSegment } from './equipmentRoutes.ts';
import { EquipmentSection } from './EquipmentSection.tsx';
import { LocationsSection } from './LocationsSection.tsx';
import { locationForPath, locationPathSegment } from './locationRoutes.ts';
import { recipeForPath, recipePathSegment } from './recipeRoutes.ts';
import { breadcrumbNodes, type BreadcrumbRecords, type BreadcrumbSection } from './breadcrumbs.ts';
import { routeFromPath, routePath, workspaceBase, type Route, type Section } from './appRoutes.ts';
import { AccountSection } from './AccountSection.tsx';
import { openLocalCatalog, syncLocalCatalog } from './catalog.ts';

function recordPath(section: BreadcrumbSection, id: string | null, base: string, records: BreadcrumbRecords): string {
  if (!id) return routePath(section, null, base);
  const supply = section === 'inventory' ? records.supplies.find(row => row.id === id)
    || records.supplies.find(row => row.id === records.inventory.find(stock => stock.id === id)?.supply_id) : null;
  const unit = section === 'equipment' ? records.equipment.find(row => row.id === id) : null;
  const model = section === 'equipment' ? records.equipmentModels.find(row => row.id === id) : null;
  const location = section === 'locations' ? records.locations.find(row => row.id === id) : null;
  const recipe = section === 'recipes' ? records.recipes.find(row => row.id === id) : null;
  const segment = supply ? inventoryPathSegment(supply, records.supplies)
    : unit ? equipmentUnitPathSegment(unit, records.equipment, records.equipmentModels)
      : model ? equipmentModelPathSegment(model, records.equipmentModels)
        : location ? locationPathSegment(location, records.locations)
          : recipe ? recipePathSegment(recipe, records.recipes) : id;
  return routePath(section, segment, base);
}
const navItems = [
  { key: 'batches', label: 'Batches', icon: AppstoreOutlined },
  { key: 'recipes', label: 'Recipes', icon: BookOutlined },
  { key: 'inventory', label: 'Inventory', icon: InboxOutlined },
  { key: 'equipment', label: 'Equipment', icon: ToolOutlined },
  { key: 'locations', label: 'Locations', icon: EnvironmentOutlined }
] as const;
type RecordSection = Exclude<Section, 'settings' | 'home'>;
type NavRecord = { id: string; name: string; recipe_type?: RecipeType | null };
type RecentItems = Record<RecordSection, string[]>;
const recordSections: RecordSection[] = ['batches', 'recipes', 'inventory', 'equipment', 'locations'];
const emptyRecents = (): RecentItems => ({ batches: [], recipes: [], inventory: [], equipment: [], locations: [] });

function SectionNavigation({ route, recent, records, onNavigate }: {
  route: Route; recent: RecentItems; records: Record<RecordSection, NavRecord[]>;
  onNavigate: (section: RecordSection | 'home' | 'settings', id: string | null) => void;
}) {
  const items = [{ key: 'home', label: 'Home', icon: <HomeOutlined /> }, ...navItems.flatMap(({ key, label, icon: Icon }) => {
    const links = (key === 'inventory' || key === 'equipment' || key === 'locations' ? [] : recent[key]).map(id => records[key].find(item => item.id === id))
      .filter((item): item is NavRecord => !!item);
    return [{ key, label, icon: <Icon /> }, ...links.map(item => ({
      key: `${key}:${item.id}`, className: 'nav-recent-item',
      label: <span className="nav-recent-label">
        {key === 'recipes' && <RecipeTypeIcon type={item.recipe_type || null} compact />}
        <span className="nav-recent-title" title={item.name}>{item.name}</span>
      </span>
    }))];
  }), { key: 'settings', label: 'Settings', icon: <SettingOutlined /> }];
  return <Menu mode="inline"
    selectedKeys={[route.selectedId && route.section !== 'inventory' && route.section !== 'equipment' && route.section !== 'locations'
      ? `${route.section}:${route.selectedId}` : route.section]}
    items={items}
    onClick={({ key }) => { const [section, id] = key.split(':'); onNavigate(section as RecordSection | 'home' | 'settings', id || null); }} />;
}
const cachedSessionKey = 'brewlog:last-session';
const signedOutKey = 'brewlog:signed-out';
const profileOpen = new URLSearchParams(location.search).has('profileOpen');
const activeBreweryKey = 'brewlog:active-brewery';

function initialBrewery(workspaces: Workspace[]): string | null {
  const linked = new URLSearchParams(location.search).get('brewery');
  const slug = routeFromPath(location.pathname).slug;
  const remembered = localStorage.getItem(activeBreweryKey);
  if (linked) return workspaces.find(item => item.id === linked)?.id || workspaces[0]?.id || null;
  if (slug) return workspaces.find(item => item.slug === slug)?.id || workspaces[0]?.id || null;
  if (routeFromPath(location.pathname).section === 'settings') return workspaces.find(item => item.id === remembered)?.id || workspaces[0]?.id || null;
  return workspaces.find(item => item.slug === null)?.id || workspaces[0]?.id || null;
}

function canonicalizeLocation(workspaces: Workspace[]): void {
  const linked = new URLSearchParams(location.search).get('brewery');
  const route = routeFromPath(location.pathname);
  if (route.section === 'settings') {
    if (location.pathname !== '/settings' || location.search) history.replaceState(null, '', '/settings');
    return;
  }
  const workspace = linked ? workspaces.find(item => item.id === linked)
    : route.slug ? workspaces.find(item => item.slug === route.slug)
      : workspaces.find(item => item.slug === null);
  const target = workspace || workspaces[0];
  const path = target ? routePath(route.section, workspace ? route.selectedId : null, workspaceBase(target.id, workspaces)) : '/settings';
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

const activeWindowMs = 5 * 60_000;

function useAppActive(): boolean {
  const lastActivity = useRef(Date.now());
  const [active, setActive] = useState(document.visibilityState === 'visible');

  useEffect(() => {
    const markActivity = () => {
      if (document.visibilityState !== 'visible') return;
      lastActivity.current = Date.now();
      setActive(true);
    };
    const checkActivity = () => {
      setActive(document.visibilityState === 'visible' && Date.now() - lastActivity.current < activeWindowMs);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') markActivity();
      else setActive(false);
    };
    window.addEventListener('focus', markActivity);
    window.addEventListener('pointerdown', markActivity);
    window.addEventListener('keydown', markActivity);
    window.addEventListener('scroll', markActivity, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = window.setInterval(checkActivity, 15_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', markActivity);
      window.removeEventListener('pointerdown', markActivity);
      window.removeEventListener('keydown', markActivity);
      window.removeEventListener('scroll', markActivity, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return active;
}

export function App() {
  const appActive = useAppActive();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [openedDb, setOpenedDb] = useState<{ workspaceId: string; db: LocalDb } | null>(null);
  const db = openedDb?.workspaceId === workspaceId ? openedDb.db : null;
  const activeWorkspaceId = useRef(workspaceId);
  activeWorkspaceId.current = workspaceId;
  const lastAutomaticSyncAttempt = useRef(new Map<string, number>());
  const [route, setRoute] = useState<Route>(() => routeFromPath(location.pathname));
  const section = route.section;
  const activeSection = useRef(section);
  activeSection.current = section;
  const [batches, setBatches] = useState<Batch[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [inventory, setInventory] = useState<InventoryRecord[]>([]);
  const [supplies, setSupplies] = useState<InventoryRecord[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [inventoryWorkspaceId, setInventoryWorkspaceId] = useState<string | null>(null);
  const [equipmentWorkspaceId, setEquipmentWorkspaceId] = useState<string | null>(null);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [equipmentModels, setEquipmentModels] = useState<Equipment[]>([]);
  const [sectionData, setSectionData] = useState<{ workspaceId: string; section: Section; catalogRevision: number } | null>(null);
  const [recent, setRecent] = useState<RecentItems>(emptyRecents);
  const [recentRecords, setRecentRecords] = useState<{ batches: NavRecord[]; recipes: NavRecord[] }>({ batches: [], recipes: [] });
  const [catalogRevision, setCatalogRevision] = useState(0);
  const currentCatalogRevision = useRef(catalogRevision);
  currentCatalogRevision.current = catalogRevision;
  const [error, setError] = useState('');
  const [serverDisconnected, setServerDisconnected] = useState(false);
  const [syncPhase, setSyncPhase] = useState<'idle' | 'syncing' | 'synced' | 'failed'>('idle');
  const [manualSyncWorkspaceId, setManualSyncWorkspaceId] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [catalogSyncProgress, setCatalogSyncProgress] = useState<{ applied: number; total: number } | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(Date.now());

  useEffect(() => {
    if (localStorage.getItem(signedOutKey) === '1') {
      setLoading(false);
      location.replace('/');
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
      if (!remembered) {
        const next = location.pathname + location.search;
        location.replace(location.pathname === '/' ? '/' : `/login?next=${encodeURIComponent(next)}`);
        return;
      }
      if (remembered) canonicalizeLocation(remembered.workspaces);
      setSession(remembered);
      setWorkspaceId(remembered ? initialBrewery(remembered.workspaces) : null);
      setRoute(routeFromPath(location.pathname));
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLastSyncedAt(workspaceId ? Number(localStorage.getItem(lastSyncKey(workspaceId))) || null : null);
    setSyncPhase('idle');
  }, [workspaceId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session || !appActive || !db) return;
    let cancelled = false;
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const catalogDb = await openLocalCatalog();
        let catalogChecked = false;
        const refreshed = await syncLocalCatalog(catalogDb, (applied, total) => {
          catalogChecked = true;
          if (!cancelled) setCatalogSyncProgress({ applied, total });
        });
        if (profileOpen) console.info(`[open catalog] Sync complete; changed: ${refreshed}`);
        if (!cancelled) setCatalogSyncProgress(null);
        if (cancelled) return;
        if (catalogChecked) setServerDisconnected(false);
        if (!refreshed) return;
        setCatalogRevision(revision => revision + 1);
      } catch (cause) {
        if (profileOpen) console.info(`[open catalog] Sync failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        if (!cancelled) setCatalogSyncProgress(null);
        if (!cancelled && cause instanceof ApiUnavailableError) setServerDisconnected(true);
        if (!cancelled && cause instanceof ClientUpdateRequiredError) {
          setError('Updating the app to continue syncing…');
          if (!await checkForAppUpdate() && !cancelled)
            setError('This app needs an update before it can sync. Reopen it once the new version is available. Your local changes are saved.');
        }
        // Cached catalog remains searchable offline.
      } finally { running = false; }
    };
    const refreshCatalog = () => {
      void load().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    };
    refreshCatalog();
    const timer = window.setInterval(refreshCatalog, 60 * 60_000);
    window.addEventListener('online', refreshCatalog);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('online', refreshCatalog); };
  }, [session?.account.id, appActive, db]);

  useEffect(() => {
    const onBackOrForward = () => {
      if (session) canonicalizeLocation(session.workspaces);
      const next = routeFromPath(location.pathname);
      setRoute(next);
      if (next.section === 'settings' || !session) return;
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
    if (route.section !== 'settings' && route.section !== 'home' && route.selectedId) {
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
    const found = inventorySupplyForPath(route.selectedId, supplies, inventory);
    if (!found) return;
    const path = routePath('inventory', inventoryPathSegment(found, supplies), workspaceBase(workspaceId, session?.workspaces || []));
    if (location.pathname !== path) history.replaceState(null, '', path);
    if (route.selectedId !== found.id) setRoute(current => ({ ...current, selectedId: found.id }));
  }, [route.section, route.selectedId, inventory, supplies, inventoryWorkspaceId, workspaceId, session?.workspaces]);

  useEffect(() => {
    if (route.section !== 'equipment' || !route.selectedId || equipmentWorkspaceId !== workspaceId) return;
    const model = equipmentModelForPath(route.selectedId, equipmentModels);
    const unit = model ? undefined : equipmentUnitForPath(route.selectedId, equipment, equipmentModels);
    const found = model || unit;
    if (!found) return;
    const segment = model ? equipmentModelPathSegment(model, equipmentModels)
      : equipmentUnitPathSegment(unit!, equipment, equipmentModels);
    const path = routePath('equipment', segment, workspaceBase(workspaceId, session?.workspaces || []));
    if (location.pathname !== path) history.replaceState(null, '', path);
    if (route.selectedId !== found.id) setRoute(current => ({ ...current, selectedId: found.id }));
  }, [route.section, route.selectedId, equipment, equipmentModels, equipmentWorkspaceId, workspaceId, session?.workspaces]);

  useEffect(() => {
    if (route.section !== 'locations' || !route.selectedId || inventoryWorkspaceId !== workspaceId) return;
    const found = locationForPath(route.selectedId, locations);
    if (!found) return;
    const path = routePath('locations', locationPathSegment(found, locations), workspaceBase(workspaceId, session?.workspaces || []));
    if (location.pathname !== path) history.replaceState(null, '', path);
    if (route.selectedId !== found.id) setRoute(current => ({ ...current, selectedId: found.id }));
  }, [route.section, route.selectedId, locations, inventoryWorkspaceId, workspaceId, session?.workspaces]);

  useEffect(() => {
    if (route.section !== 'recipes' || !route.selectedId || !db) return;
    const found = recipeForPath(route.selectedId, recipes);
    if (!found) return;
    const path = routePath('recipes', recipePathSegment(found, recipes), workspaceBase(workspaceId, session?.workspaces || []));
    if (location.pathname !== path) history.replaceState(null, '', path);
    if (route.selectedId !== found.id) setRoute(current => ({ ...current, selectedId: found.id }));
  }, [route.section, route.selectedId, recipes, db, workspaceId, session?.workspaces]);

  function showSection(next: Section, targetWorkspaceId = workspaceId) {
    const base = workspaceBase(targetWorkspaceId, session?.workspaces || []);
    const path = routePath(next, null, base);
    if (location.pathname !== path || location.search) history.pushState(null, '', path);
    setRoute({ section: next, selectedId: null, slug: next === 'settings' ? null : base.split('/')[2] || null });
    setMenuOpen(false);
  }

  function showItem(next: RecordSection, id: string | null) {
    const base = workspaceBase(workspaceId, session?.workspaces || []);
    const inventoryItem = next === 'inventory' && id
      ? supplies.find(row => row.id === id) || supplies.find(row => row.id === inventory.find(stock => stock.id === id)?.supply_id) : null;
    const recipeItem = next === 'recipes' && id ? recipes.find(row => row.id === id) : null;
    const path = recordPath(next, id, base, { batches, recipes, inventory, supplies, equipment, equipmentModels, locations });
    if (location.pathname !== path || location.search) history.pushState(null, '', path);
    setRoute({ section: next, selectedId: inventoryItem?.id || recipeItem?.id || id, slug: base.split('/')[2] || null });
  }

  async function signOut() {
    try { await api('/logout', 'POST'); } catch { /* Clear local access even while offline. */ }
    localStorage.removeItem(cachedSessionKey);
    localStorage.setItem(signedOutKey, '1');
    setSession(null);
    setOpenedDb(null);
    location.replace('/');
  }

  const refresh = useCallback(async (activeDb: LocalDb, targetWorkspaceId: string,
    targetSection: Section = activeSection.current, targetCatalogRevision = currentCatalogRevision.current) => {
    const needsBatches = targetSection === 'batches' || targetSection === 'equipment';
    const needsRecipes = targetSection === 'recipes' || targetSection === 'batches';
    const needsInventory = ['inventory', 'recipes', 'batches', 'locations'].includes(targetSection);
    const needsSupplies = ['inventory', 'recipes', 'locations'].includes(targetSection);
    const needsEquipment = ['equipment', 'recipes', 'batches', 'locations'].includes(targetSection);
    const needsLocations = ['locations', 'equipment'].includes(targetSection);
    const [nextBatches, nextRecipes, nextInventory, nextSupplies, nextEquipment, nextModels, nextLocations] = await Promise.all([
      needsBatches ? listBatches(activeDb) : Promise.resolve([]),
      needsRecipes ? listRecipes(activeDb) : Promise.resolve([]),
      needsInventory ? listInventory(activeDb) : Promise.resolve([]),
      needsSupplies ? listSupplies(activeDb) : Promise.resolve([]),
      needsEquipment ? listEquipment(activeDb) : Promise.resolve([]),
      needsEquipment ? listEquipmentModels(activeDb) : Promise.resolve([]),
      needsLocations ? listInventoryLocations(activeDb) : Promise.resolve([])
    ]);
    if (activeWorkspaceId.current !== targetWorkspaceId || activeSection.current !== targetSection) return;
    setBatches(nextBatches);
    setRecipes(nextRecipes);
    setInventory(nextInventory);
    setSupplies(nextSupplies);
    setLocations(nextLocations);
    setInventoryWorkspaceId(targetWorkspaceId);
    setEquipment(nextEquipment);
    setEquipmentModels(nextModels);
    setEquipmentWorkspaceId(targetWorkspaceId);
    setSectionData({ workspaceId: targetWorkspaceId, section: targetSection, catalogRevision: targetCatalogRevision });
  }, []);

  useEffect(() => {
    if (!db || !workspaceId) return;
    if (sectionData?.workspaceId === workspaceId && sectionData.section === section
      && sectionData.catalogRevision === catalogRevision) return;
    void refresh(db, workspaceId, section).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [db, workspaceId, section, catalogRevision, sectionData, refresh]);

  useEffect(() => {
    if (!db) { setRecentRecords({ batches: [], recipes: [] }); return; }
    let cancelled = false;
    const batchesSql = recent.batches.length ? `SELECT id, name FROM batches WHERE id IN (${recent.batches.map(() => '?').join(',')})` : null;
    const recipesSql = recent.recipes.length ? `SELECT r.id, r.name, t.recipe_type FROM recipes r
      LEFT JOIN recipe_types t ON t.id = r.id WHERE r.id IN (${recent.recipes.map(() => '?').join(',')})` : null;
    void Promise.all([
      batchesSql ? db.execO<NavRecord>(batchesSql, recent.batches) : Promise.resolve([]),
      recipesSql ? db.execO<NavRecord>(recipesSql!, recent.recipes) : Promise.resolve([])
    ]).then(([batchRows, recipeRows]) => {
      if (cancelled) return;
      setRecentRecords({ batches: recent.batches.flatMap(id => batchRows.filter(row => row.id === id)),
        recipes: recent.recipes.flatMap(id => recipeRows.filter(row => row.id === id)) });
    }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [db, recent, sectionData]);

  const runSync = useCallback(async (activeDb: LocalDb, targetWorkspaceId: string, includeCatalog = false) => {
    if (activeWorkspaceId.current === targetWorkspaceId) {
      setSyncPhase('syncing');
      setSyncProgress(null);
    }
    try {
      const [breweryResult, catalogResult] = await Promise.allSettled([
        syncNow(activeDb, targetWorkspaceId, progress => {
          if (activeWorkspaceId.current === targetWorkspaceId) setSyncProgress(progress);
        }),
        includeCatalog ? (async () => {
          const catalogDb = await openLocalCatalog();
          return syncLocalCatalog(catalogDb, (applied, total) => {
            if (activeWorkspaceId.current === targetWorkspaceId) setCatalogSyncProgress({ applied, total });
          }, true);
        })() : Promise.resolve(false)
      ]);
      if (activeWorkspaceId.current === targetWorkspaceId) setCatalogSyncProgress(null);
      if (catalogResult.status === 'fulfilled' && catalogResult.value) {
        setCatalogRevision(revision => revision + 1);
      }
      if (activeWorkspaceId.current === targetWorkspaceId
        && (breweryResult.status === 'fulfilled' || catalogResult.status === 'fulfilled' && catalogResult.value)) {
        await refresh(activeDb, targetWorkspaceId);
      }
      if (breweryResult.status === 'rejected') throw breweryResult.reason;
      if (catalogResult.status === 'rejected') {
        if (catalogResult.reason instanceof ClientUpdateRequiredError) throw catalogResult.reason;
        throw new Error(`Catalog sync failed: ${
          catalogResult.reason instanceof Error ? catalogResult.reason.message : String(catalogResult.reason)}`);
      }
      const syncedAt = Date.now();
      localStorage.setItem(lastSyncKey(targetWorkspaceId), String(syncedAt));
      if (activeWorkspaceId.current === targetWorkspaceId) setLastSyncedAt(syncedAt);
      setNow(syncedAt);
      if (activeWorkspaceId.current === targetWorkspaceId) {
        setSyncPhase('synced');
        setSyncProgress(null);
      }
      setServerDisconnected(false);
      setError('');
    } catch (cause) {
      if (activeWorkspaceId.current === targetWorkspaceId) {
        setSyncPhase('failed');
        setSyncProgress(null);
        setCatalogSyncProgress(null);
      }
      if (cause instanceof ClientUpdateRequiredError) {
        setError('Updating the app to continue syncing…');
        const updated = await checkForAppUpdate();
        if (!updated && activeWorkspaceId.current === targetWorkspaceId)
          setError('This app needs an update before it can sync. Reopen it once the new version is available. Your local changes are saved.');
      } else if (cause instanceof ApiUnavailableError) setServerDisconnected(true);
      else if (navigator.onLine) setError(cause instanceof Error ? cause.message : 'Sync failed');
    }
  }, [refresh]);

  async function manualSyncWorkspace(id: string) {
    if (!session?.workspaces.some(item => item.id === id)) return;
    setManualSyncWorkspaceId(id);
    try { await runSync(await openLocalDb(id), id, true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setManualSyncWorkspaceId(null); }
  }

  const runAutomaticSync = useCallback((activeDb: LocalDb, targetWorkspaceId: string) => {
    const now = Date.now();
    const lastAttempt = Math.max(lastAutomaticSyncAttempt.current.get(targetWorkspaceId) || 0,
      Number(localStorage.getItem(lastSyncKey(targetWorkspaceId))) || 0);
    if (now - lastAttempt < 60_000) return;
    lastAutomaticSyncAttempt.current.set(targetWorkspaceId, now);
    void runSync(activeDb, targetWorkspaceId);
  }, [runSync]);

  useEffect(() => {
    if (!workspaceId || !session) return;
    let cancelled = false;
    setOpenedDb(null);
    const openingStarted = performance.now();
    openLocalDb(workspaceId).then(async activeDb => {
      if (cancelled) return;
      if (profileOpen)
        console.info(`[open data] Database ready: ${(performance.now() - openingStarted).toFixed(1)} ms`);
      await refresh(activeDb, workspaceId);
      if (profileOpen)
        console.info(`[open data] Initial lists ready: ${(performance.now() - openingStarted).toFixed(1)} ms`);
      if (!cancelled) setOpenedDb({ workspaceId, db: activeDb });
    }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { cancelled = true; };
  }, [workspaceId, session, refresh]);

  useEffect(() => {
    if (!db || !workspaceId || !appActive) return;
    const callback = () => { runAutomaticSync(db, workspaceId); };
    callback();
    const timer = window.setInterval(callback, 5 * 60_000);
    window.addEventListener('online', callback);
    return () => { window.clearInterval(timer); window.removeEventListener('online', callback); };
  }, [db, workspaceId, runAutomaticSync, appActive]);

  const changed = useCallback(async () => {
    if (!db || !workspaceId) return;
    await refresh(db, workspaceId);
  }, [db, workspaceId, refresh]);

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
  if (!session) return <div className="loading-screen"><Spin size="large" /></div>;
  const avatarSrc = session.account.has_avatar ? `/api/me/avatar?v=${avatarVersion}` : undefined;
  const preferredUnits = session.preferred_units || defaultPreferredUnits;
  const activeBase = workspaceBase(workspaceId, session.workspaces);
  const workspaceProgress = syncPhase === 'syncing' && syncProgress
    ? { label: syncProgress.phase === 'uploading' ? 'Sending' : 'Applying', ...syncProgress } : null;
  const headerProgress = workspaceProgress && catalogSyncProgress
    ? { label: 'Syncing brewery and catalog', applied: workspaceProgress.applied + catalogSyncProgress.applied,
      total: workspaceProgress.total + catalogSyncProgress.total }
    : workspaceProgress || (catalogSyncProgress ? { label: 'Updating catalog', ...catalogSyncProgress } : null);
  const breadcrumbRecords = { batches, recipes, inventory, supplies, equipment, equipmentModels, locations };
  const crumbs = section !== 'settings' && section !== 'home' && db
    ? breadcrumbNodes(section, route.selectedId, breadcrumbRecords) : [];

  return <div className="app-shell">
    <header className="app-header">
      <div className="header-brand-row">
        <Button className="mobile-menu-button" type="text" shape="circle" aria-label="Open navigation"
          icon={<MenuOutlined />} onClick={() => setMenuOpen(true)} />
        <div className="brand"><img className="brand-mark" src="/icon.svg" alt="" /><strong>Yeast.Win!</strong></div>
      </div>
      <div className="header-controls">
        {headerProgress && <Tooltip title={`${headerProgress.label}: ${headerProgress.applied} of ${headerProgress.total} changes`}>
          <div className="header-sync-progress" role="status" aria-live="polite"
            aria-label={`${headerProgress.label}: ${headerProgress.applied} of ${headerProgress.total} changes`}>
            <Progress type="circle" percent={headerProgress.total
              ? Math.round(headerProgress.applied / headerProgress.total * 100) : 100}
              showInfo={false} size={28} strokeWidth={11} strokeColor="#e7b464" trailColor="#56736f" />
          </div>
        </Tooltip>}
        {session.workspaces.length > 1 && <Select className="workspace-select" value={workspaceId}
          aria-label="Brewery"
          options={session.workspaces.map(item => ({ label: item.name, value: item.id }))}
          onChange={value => {
            setWorkspaceId(value); localStorage.setItem(activeBreweryKey, value); setOpenedDb(null); showSection('home', value);
          }} />}
        {serverDisconnected && <Popover trigger="click" title="Server disconnected" content={<div className="connection-popover">
          <p>Your brewing entries are saved on this device.</p>
          <p>They will sync when the server is available again.</p>
        </div>}>
          <Button className="connection-button" type="text" shape="circle" aria-label="Server disconnected"
            icon={<DisconnectOutlined />} />
        </Popover>}
        <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: [
          { key: 'username', label: session.account.username, disabled: true },
          { key: 'logout', label: 'Log out', icon: <LogoutOutlined /> }
        ], onClick: ({ key }) => { if (key === 'logout') void signOut(); } }}>
          <Button className="avatar-button" type="text" shape="circle" aria-label="Account menu">
            <Avatar size={32} src={avatarSrc}>{session.account.username[0].toUpperCase()}</Avatar>
          </Button>
        </Dropdown>
      </div>
    </header>

    <div className="app-body">
      <Layout.Sider className="app-nav" width={220} theme="light" aria-label="Sections">
        <SectionNavigation route={route} recent={recent} records={{ batches: recentRecords.batches, recipes: recentRecords.recipes,
          inventory: [], equipment: [], locations: [] }}
          onNavigate={(name, id) => name !== 'home' && name !== 'settings' && id ? showItem(name, id) : showSection(name)} />
      </Layout.Sider>
      <Drawer className="mobile-nav-drawer" title="Sections" placement="left" width={250} open={menuOpen} onClose={() => setMenuOpen(false)}>
        <div className="drawer-nav"><SectionNavigation route={route} recent={recent} records={{ batches: recentRecords.batches, recipes: recentRecords.recipes,
          inventory: [], equipment: [], locations: [] }}
          onNavigate={(name, id) => { if (name !== 'home' && name !== 'settings' && id) showItem(name, id);
            else showSection(name); setMenuOpen(false); }} /></div>
      </Drawer>
      <main className="app-main">
        {error && <Alert type="warning" showIcon closable onClose={() => setError('')} message={error} className="page-alert" />}
        {crumbs.length > 0 && <Breadcrumb className="app-breadcrumb" aria-label="Breadcrumb" items={crumbs.map((crumb, index) => ({
          title: index === crumbs.length - 1 ? <span aria-current="page" title={crumb.label}>{crumb.label}</span>
            : <a href={crumb.section === 'home' ? routePath('home', null, activeBase)
              : recordPath(crumb.section, crumb.id, activeBase, breadcrumbRecords)} title={crumb.label}
              aria-label={crumb.section === 'home' ? 'Home' : undefined}
              onClick={event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                if (crumb.section !== 'home' && crumb.id) showItem(crumb.section, crumb.id);
                else showSection(crumb.section);
              }}>{crumb.section === 'home' ? <HomeOutlined aria-hidden="true" /> : crumb.label}</a>
        }))} />}
        {section === 'settings' ? <AccountSection username={session.account.username} avatarSrc={avatarSrc}
          workspaces={session.workspaces} activeWorkspaceId={workspaceId} db={db}
          onCreateWorkspace={createWorkspace} onUpdateWorkspace={renameWorkspace} onDeleteWorkspace={removeWorkspace}
          onAvatarUploaded={() => { const updated = { ...session, account: { ...session.account, has_avatar: true } };
            rememberSession(updated); setSession(updated); setAvatarVersion(Date.now()); }}
          preferredUnits={preferredUnits} onPreferredUnitsChange={updatePreferredUnits}
          syncingWorkspaceId={manualSyncWorkspaceId || (syncPhase === 'syncing' ? workspaceId : null)}
          syncStatusFor={id => timeSinceSync(id === workspaceId ? lastSyncedAt
            : Number(localStorage.getItem(lastSyncKey(id))) || null, now)}
          onManualSync={manualSyncWorkspace} /> : !workspaceId
          ? <Empty description="Add a brewery in Settings to begin">
            <Button type="primary" onClick={() => showSection('settings')}>Open Settings</Button></Empty> :
          !db ? <div className="loading-screen"><Spin description="Opening data on this device" /></div>
            : section !== 'home' && (sectionData?.workspaceId !== workspaceId || sectionData.section !== section)
              ? <div className="loading-screen"><Spin description="Loading section" /></div> : <>
            {section === 'home' && <DashboardSection />}
            {section === 'batches' && <BatchSection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} batches={batches} recipes={recipes}
              equipment={equipment} equipmentModels={equipmentModels} inventory={inventory} catalogRevision={catalogRevision} preferredUnits={preferredUnits}
              selectedId={route.selectedId} onSelect={id => showItem('batches', id)} onChanged={changed} />}
            {section === 'recipes' && <RecipeSection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} recipes={recipes}
              equipment={equipment} equipmentModels={equipmentModels} inventory={inventory} supplies={supplies} catalogRevision={catalogRevision} preferredUnits={preferredUnits}
              selectedId={route.selectedId ? recipeForPath(route.selectedId, recipes)?.id || route.selectedId : null}
              onSelect={id => showItem('recipes', id)}
              onChanged={changed} onBatchStarted={id => showItem('batches', id)} />}
            {section === 'inventory' && (inventoryWorkspaceId !== workspaceId ? <div className="loading-screen"><Spin description="Loading inventory" /></div>
              : <InventorySection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} items={inventory}
                supplies={supplies} catalogRevision={catalogRevision} preferredUnits={preferredUnits} selectedId={route.selectedId
                  ? inventorySupplyForPath(route.selectedId, supplies, inventory)?.id || route.selectedId : null}
                onSelect={id => showItem('inventory', id)} onChanged={changed} />)}
            {section === 'locations' && (inventoryWorkspaceId !== workspaceId ? <div className="loading-screen"><Spin description="Loading locations" /></div>
              : <LocationsSection key={workspaceId} db={db} basePath={activeBase} locations={locations} items={inventory} supplies={supplies}
                equipment={equipment} equipmentModels={equipmentModels} onEquipmentSelect={id => showItem('equipment', id)}
                selectedId={route.selectedId ? locationForPath(route.selectedId, locations)?.id || route.selectedId : null}
                onSelect={id => showItem('locations', id)} onInventorySelect={id => showItem('inventory', id)} onChanged={changed} />)}
            {section === 'equipment' && (equipmentWorkspaceId !== workspaceId ? <div className="loading-screen"><Spin description="Loading equipment" /></div>
              : <EquipmentSection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} batches={batches} equipment={equipment} models={equipmentModels}
                locations={locations}
                catalogRevision={catalogRevision} preferredUnits={preferredUnits} selectedId={route.selectedId
                  ? equipmentModelForPath(route.selectedId, equipmentModels)?.id
                    || equipmentUnitForPath(route.selectedId, equipment, equipmentModels)?.id || route.selectedId : null}
                onSelect={id => showItem('equipment', id)} onSelectBatch={id => showItem('batches', id)} onChanged={changed} />)}
          </>}
      </main>
    </div>
  </div>;
}
