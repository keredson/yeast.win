import { useCallback, useEffect, useRef, useState } from 'react';
import { AppstoreOutlined, BookOutlined, InboxOutlined, MenuOutlined, ToolOutlined } from '@ant-design/icons';
import { Alert, Avatar, Button, Card, Drawer, Empty, Form, Input, Layout, Menu, Modal, Select, Spin, Tooltip, Typography } from 'antd';
import { api, ApiError, type PreferredUnits, type Session, type Workspace } from './api.ts';
import { defaultPreferredUnits } from '../shared/units.ts';
import { openLocalDb, syncNow, type Batch, type Equipment, type InventoryItem, type LocalDb, type Recipe,
  listBatches, listEquipment, listInventory, listRecipes } from './db.ts';
import { BatchSection } from './BatchSection.tsx';
import { RecipeSection } from './RecipeSection.tsx';
import { InventorySection } from './InventorySection.tsx';
import { EquipmentSection } from './EquipmentSection.tsx';
import { AccountSection } from './AccountSection.tsx';
import { openLocalCatalog, readLocalCatalog, syncLocalCatalog } from './catalog.ts';
import type { CatalogEquipment, CatalogInventory } from '../shared/catalog.ts';

type Section = 'batches' | 'recipes' | 'inventory' | 'equipment' | 'me';
interface Route { section: Section; selectedId: string | null; slug: string | null }
const detailPaths = { batches: 'batch', recipes: 'recipe', inventory: 'inventory', equipment: 'equipment' } as const;

function routeFromPath(path: string): Route {
  if (path === '/me') return { section: 'me', selectedId: null, slug: null };
  const prefix = /^\/brewery\/([a-z0-9-]+)(?=\/|$)/.exec(path);
  const slug = prefix?.[1] || null;
  const localPath = prefix ? path.slice(prefix[0].length) || '/' : path;
  for (const section of ['batches', 'recipes', 'inventory', 'equipment'] as const) {
    if (localPath === `/${section}`) return { section, selectedId: null, slug };
    const match = new RegExp(`^/${detailPaths[section]}/([A-Za-z0-9_-]{10,32})$`).exec(localPath);
    if (match) return { section, selectedId: match[1], slug };
  }
  return { section: 'batches', selectedId: null, slug };
}

function workspaceBase(workspaceId: string | null, workspaces: Workspace[]): string {
  const index = workspaces.findIndex(item => item.id === workspaceId);
  return index <= 0 ? '' : `/brewery/${workspaces[index].slug}`;
}

function routePath(section: Section, selectedId: string | null, base: string): string {
  if (section === 'me') return '/me';
  return selectedId ? `${base}/${detailPaths[section]}/${selectedId}` : `${base}/${section}`;
}
const navItems = [
  { key: 'batches', label: 'Batches', icon: AppstoreOutlined },
  { key: 'recipes', label: 'Recipes', icon: BookOutlined },
  { key: 'inventory', label: 'Inventory', icon: InboxOutlined },
  { key: 'equipment', label: 'Equipment', icon: ToolOutlined }
] as const;
type RecordSection = Exclude<Section, 'me'>;
type RecentItems = Record<RecordSection, string[]>;
const recordSections: RecordSection[] = ['batches', 'recipes', 'inventory', 'equipment'];
const emptyRecents = (): RecentItems => ({ batches: [], recipes: [], inventory: [], equipment: [] });

function SectionNavigation({ route, recent, records, onNavigate }: {
  route: Route; recent: RecentItems; records: Record<RecordSection, { id: string; name: string }[]>;
  onNavigate: (section: RecordSection, id: string | null) => void;
}) {
  const items = navItems.map(({ key, label, icon: Icon }) => ({
    key, label, icon: <Icon />,
    onTitleClick: () => onNavigate(key, null),
    children: [
      { key: `${key}:all`, label: `All ${label.toLowerCase()}` },
      ...recent[key].map(id => records[key].find(item => item.id === id)).filter((item): item is { id: string; name: string } => !!item)
        .map(item => ({ key: `${key}:${item.id}`, label: <span className="nav-recent-title" title={item.name}>{item.name}</span> }))
    ]
  }));
  return <Menu mode="inline" openKeys={route.section === 'me' ? [] : [route.section]}
    selectedKeys={route.section === 'me' ? [] : [`${route.section}:${route.selectedId || 'all'}`]}
    items={items}
    onClick={({ key }) => { const [section, id] = key.split(':'); onNavigate(section as RecordSection, id === 'all' ? null : id); }} />;
}
const newBreweryOption = '~new-brewery';
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
  return workspaces[0]?.id || null;
}

function canonicalizeLocation(workspaces: Workspace[]): void {
  const linked = new URLSearchParams(location.search).get('brewery');
  const route = routeFromPath(location.pathname);
  if (route.section === 'me') return;
  const workspace = linked ? workspaces.find(item => item.id === linked)
    : route.slug ? workspaces.find(item => item.slug === route.slug) : null;
  if (linked || route.slug) {
    const path = workspace ? routePath(route.section, route.selectedId, workspaceBase(workspace.id, workspaces)) : '/batches';
    if (location.pathname + location.search !== path) history.replaceState(null, '', path);
  }
}

function cachedSession(): Session | null {
  try {
    const value = JSON.parse(localStorage.getItem(cachedSessionKey) || 'null') as Session | null;
    if (value && typeof value.account?.id === 'string' && Array.isArray(value.workspaces)
      && value.workspaces.every(item => typeof item.id === 'string' && typeof item.name === 'string')) {
      const used = new Set<string>();
      const workspaces = [...value.workspaces].sort((a, b) =>
        Number(b.name === 'Homebrew') - Number(a.name === 'Homebrew')).map(item => {
        const base = item.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'brewery';
        let slug = typeof item.slug === 'string' && item.slug ? item.slug : base;
        for (let number = 2; used.has(slug); number++) slug = `${base}-${number}`;
        used.add(slug);
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
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [recent, setRecent] = useState<RecentItems>(emptyRecents);
  const [catalogEquipment, setCatalogEquipment] = useState<CatalogEquipment[]>([]);
  const [catalogInventory, setCatalogInventory] = useState<CatalogInventory[]>([]);
  const [error, setError] = useState('');
  const [syncPhase, setSyncPhase] = useState<'idle' | 'syncing' | 'synced' | 'failed'>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(Date.now());

  useEffect(() => {
    if (localStorage.getItem(signedOutKey) === '1') {
      setLoading(false);
      return;
    }
    api<Session>('/me').then(result => {
      canonicalizeLocation(result.workspaces);
      rememberSession(result);
      setSession(result);
      setWorkspaceId(initialBrewery(result.workspaces));
      setRoute(routeFromPath(location.pathname));
    }).catch(cause => {
      if (cause instanceof ApiError && cause.status === 401) localStorage.removeItem(cachedSessionKey);
      const remembered = cause instanceof ApiError && cause.status === 401 ? null : cachedSession();
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
    if (!session) return;
    let cancelled = false;
    const load = async () => {
      const catalogDb = await openLocalCatalog();
      const cached = await readLocalCatalog(catalogDb);
      if (!cancelled) { setCatalogEquipment(cached.equipment); setCatalogInventory(cached.inventory); }
      try {
        await syncLocalCatalog(catalogDb);
        const updated = await readLocalCatalog(catalogDb);
        if (!cancelled) { setCatalogEquipment(updated.equipment); setCatalogInventory(updated.inventory); }
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
    if (location.pathname === '/') history.replaceState(null, '', '/batches');
    const onBackOrForward = () => {
      if (session) canonicalizeLocation(session.workspaces);
      const next = routeFromPath(location.pathname);
      setRoute(next);
      if (next.section === 'me' || !session) return;
      const workspace = next.slug ? session.workspaces.find(item => item.slug === next.slug) : session.workspaces[0];
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
      next[name] = [route.selectedId, ...next[name].filter(id => id !== route.selectedId)].slice(0, 5);
      localStorage.setItem(`brewlog:recent:${workspaceId}:${name}`, JSON.stringify(next[name]));
    }
    setRecent(next);
  }, [workspaceId, route]);

  function showSection(next: Section, targetWorkspaceId = workspaceId) {
    const base = workspaceBase(targetWorkspaceId, session?.workspaces || []);
    const path = routePath(next, null, base);
    if (location.pathname !== path || location.search) history.pushState(null, '', path);
    setRoute({ section: next, selectedId: null, slug: next === 'me' ? null : base.split('/')[2] || null });
    setMenuOpen(false);
  }

  function showItem(next: Exclude<Section, 'me'>, id: string | null) {
    const base = workspaceBase(workspaceId, session?.workspaces || []);
    const path = routePath(next, id, base);
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
    const [nextBatches, nextRecipes, nextInventory, nextEquipment] = await Promise.all([
      listBatches(activeDb), listRecipes(activeDb), listInventory(activeDb), listEquipment(activeDb)
    ]);
    if (activeWorkspaceId.current !== targetWorkspaceId) return;
    setBatches(nextBatches);
    setRecipes(nextRecipes);
    setInventory(nextInventory);
    setEquipment(nextEquipment);
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
      setError('');
    } catch (cause) {
      if (activeWorkspaceId.current !== targetWorkspaceId) return;
      setSyncPhase('failed');
      if (navigator.onLine) setError(cause instanceof Error ? cause.message : 'Sync failed');
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

  async function createWorkspace() {
    if (!workspaceName.trim() || !session) return;
    try {
      const workspace = await api<Workspace>('/workspaces', 'POST', { name: workspaceName.trim() });
      const updated = { ...session, workspaces: [...session.workspaces, workspace] };
      rememberSession(updated);
      setSession(updated);
      setWorkspaceId(workspace.id);
      localStorage.setItem(activeBreweryKey, workspace.id);
      setOpenedDb(null);
      setWorkspaceDialog(false);
      setWorkspaceName('');
      const path = `/brewery/${workspace.slug}/batches`;
      history.pushState(null, '', path);
      setRoute({ section: 'batches', selectedId: null, slug: workspace.slug });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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
        <Select className="workspace-select" value={workspaceId} placeholder="Select brewery"
          aria-label="Brewery"
          options={[...session.workspaces.map(item => ({ label: item.name, value: item.id })),
            { label: '＋ New brewery', value: newBreweryOption }]}
          onChange={value => {
            if (value === newBreweryOption) setWorkspaceDialog(true);
            else { setWorkspaceId(value); localStorage.setItem(activeBreweryKey, value); setOpenedDb(null); showSection('batches', value); }
          }} />
        <Tooltip title="Account settings">
          <Button className="avatar-button" type="text" shape="circle" aria-label="Account settings" onClick={() => showSection('me')}>
            <Avatar size={32} src={avatarSrc}>{session.account.username[0].toUpperCase()}</Avatar>
          </Button>
        </Tooltip>
      </div>
    </header>

    <div className="app-body">
      <Layout.Sider className="app-nav" width={220} theme="light" aria-label="Sections">
        <SectionNavigation route={route} recent={recent} records={{ batches, recipes, inventory, equipment }}
          onNavigate={(name, id) => id ? showItem(name, id) : showSection(name)} />
      </Layout.Sider>
      <Drawer className="mobile-nav-drawer" title="Sections" placement="left" width={250} open={menuOpen} onClose={() => setMenuOpen(false)}>
        <div className="drawer-nav"><SectionNavigation route={route} recent={recent} records={{ batches, recipes, inventory, equipment }}
          onNavigate={(name, id) => { id ? showItem(name, id) : showSection(name); setMenuOpen(false); }} /></div>
      </Drawer>
      <main className="app-main">
        {error && <Alert type="warning" showIcon closable onClose={() => setError('')} message={error} className="page-alert" />}
        {section === 'me' ? <AccountSection username={session.account.username} avatarSrc={avatarSrc}
          onAvatarUploaded={() => { const updated = { ...session, account: { ...session.account, has_avatar: true } };
            rememberSession(updated); setSession(updated); setAvatarVersion(Date.now()); }}
          preferredUnits={preferredUnits} onPreferredUnitsChange={updatePreferredUnits}
          syncPhase={syncPhase} syncStatus={timeSinceSync(lastSyncedAt, now)} canSync={!!db && !!workspaceId}
          onManualSync={() => { if (db && workspaceId) void runSync(db, workspaceId); }}
          autoSync={autoSync} onAutoSyncChange={enabled => { localStorage.setItem(autoSyncKey, enabled ? '1' : '0'); setAutoSync(enabled); }}
          onSignOut={signOut} /> : !workspaceId ? <Empty description="Create a brewery to begin"><Button type="primary" onClick={() => setWorkspaceDialog(true)}>New brewery</Button></Empty> :
          !db ? <div className="loading-screen"><Spin tip="Opening local database" /></div> : <>
            {section === 'batches' && <BatchSection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} batches={batches}
              equipment={equipment} inventory={inventory} preferredUnits={preferredUnits}
              selectedId={route.selectedId} onSelect={id => showItem('batches', id)} onChanged={changed} />}
            {section === 'recipes' && <RecipeSection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} recipes={recipes}
              selectedId={route.selectedId} onSelect={id => showItem('recipes', id)}
              onChanged={changed} onBatchStarted={id => showItem('batches', id)} />}
            {section === 'inventory' && <InventorySection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} items={inventory}
              catalog={catalogInventory} preferredUnits={preferredUnits} selectedId={route.selectedId} onSelect={id => showItem('inventory', id)} onChanged={changed} />}
            {section === 'equipment' && <EquipmentSection key={workspaceId} db={db} basePath={activeBase} accountId={session.account.id} equipment={equipment}
              catalog={catalogEquipment} selectedId={route.selectedId} onSelect={id => showItem('equipment', id)} onChanged={changed} />}
          </>}
      </main>
    </div>
    <Modal title="New brewery" open={workspaceDialog} onCancel={() => setWorkspaceDialog(false)} onOk={createWorkspace} okText="Create">
      <Input autoFocus maxLength={80} placeholder="e.g. Homebrew or Downtown Brewery" aria-label="Brewery name" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} />
    </Modal>
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
