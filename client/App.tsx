import { useCallback, useEffect, useRef, useState } from 'react';
import { SyncOutlined } from '@ant-design/icons';
import { Alert, Avatar, Button, Card, Empty, Form, Input, Modal, Select, Spin, Tooltip, Typography } from 'antd';
import { api, ApiError, type Session, type Workspace } from './api.ts';
import { openLocalDb, syncNow, type Batch, type Equipment, type InventoryItem, type LocalDb, type Recipe,
  listBatches, listEquipment, listInventory, listRecipes } from './db.ts';
import { BatchSection } from './BatchSection.tsx';
import { RecipeSection } from './RecipeSection.tsx';
import { InventorySection } from './InventorySection.tsx';
import { EquipmentSection } from './EquipmentSection.tsx';
import { AccountSection } from './AccountSection.tsx';

type Section = 'batches' | 'recipes' | 'inventory' | 'equipment' | 'me';
const newBreweryOption = '~new-brewery';
const cachedSessionKey = 'brewlog:last-session';
const signedOutKey = 'brewlog:signed-out';
const autoSyncKey = 'brewlog:auto-sync';

function cachedSession(): Session | null {
  try {
    const value = JSON.parse(localStorage.getItem(cachedSessionKey) || 'null') as Session | null;
    if (value && typeof value.account?.id === 'string' && Array.isArray(value.workspaces)
      && value.workspaces.every(item => typeof item.id === 'string' && typeof item.name === 'string')) return value;
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
  const [section, setSection] = useState<Section>(() => location.pathname === '/me' ? 'me' : 'batches');
  const [autoSync, setAutoSync] = useState(() => localStorage.getItem(autoSyncKey) !== '0');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [error, setError] = useState('');
  const [syncPhase, setSyncPhase] = useState<'idle' | 'syncing' | 'synced' | 'failed'>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');

  useEffect(() => {
    if (localStorage.getItem(signedOutKey) === '1') {
      setLoading(false);
      return;
    }
    api<Session>('/me').then(result => {
      rememberSession(result);
      setSession(result);
      setWorkspaceId(result.workspaces[0]?.id || null);
    }).catch(cause => {
      if (cause instanceof ApiError && cause.status === 401) localStorage.removeItem(cachedSessionKey);
      const remembered = cause instanceof ApiError && cause.status === 401 ? null : cachedSession();
      setSession(remembered);
      setWorkspaceId(remembered?.workspaces[0]?.id || null);
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
    const onBackOrForward = () => setSection(location.pathname === '/me' ? 'me' : 'batches');
    window.addEventListener('popstate', onBackOrForward);
    return () => window.removeEventListener('popstate', onBackOrForward);
  }, []);

  function showSection(next: Section) {
    const path = next === 'me' ? '/me' : '/';
    if (location.pathname !== path) history.pushState(null, '', path);
    setSection(next);
  }

  async function signOut() {
    try { await api('/logout', 'POST'); } catch { /* Clear local access even while offline. */ }
    localStorage.removeItem(cachedSessionKey);
    localStorage.setItem(signedOutKey, '1');
    setSession(null);
    setOpenedDb(null);
    history.replaceState(null, '', '/');
    setSection('batches');
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
      setOpenedDb(null);
      setWorkspaceDialog(false);
      setWorkspaceName('');
      showSection('batches');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  if (loading) return <div className="loading-screen"><Spin size="large" /></div>;
  if (!session) return <AccountAccess onAuthenticated={result => { setSession(result); setWorkspaceId(result.workspaces[0]?.id || null); }} />;

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-mark">B</span><div><strong>Brewlog</strong><small>Batch-first brewing</small></div></div>
      <div className="header-controls">
        <Select className="workspace-select" value={workspaceId} placeholder="Select brewery"
          aria-label="Brewery"
          options={[...session.workspaces.map(item => ({ label: item.name, value: item.id })),
            { label: '＋ New brewery', value: newBreweryOption }]}
          onChange={value => {
            if (value === newBreweryOption) setWorkspaceDialog(true);
            else { setWorkspaceId(value); setOpenedDb(null); showSection('batches'); }
          }} />
        <Tooltip title={`${syncPhase === 'syncing' ? 'Syncing…' : syncPhase === 'failed' ? 'Sync failed · ' : ''}${timeSinceSync(lastSyncedAt, now)} · Click to sync`}>
          <Button className={`sync-button sync-${syncPhase}`} type="text" shape="circle" aria-label="Sync now"
            icon={<SyncOutlined spin={syncPhase === 'syncing'} />} disabled={!db || !workspaceId}
            onClick={() => { if (db && workspaceId) void runSync(db, workspaceId); }} />
        </Tooltip>
        <Tooltip title="Account settings">
          <Button className="avatar-button" type="text" shape="circle" aria-label="Account settings" onClick={() => showSection('me')}>
            <Avatar size={32}>{session.account.username[0].toUpperCase()}</Avatar>
          </Button>
        </Tooltip>
      </div>
    </header>

    <div className="app-body">
      <nav className="app-nav" aria-label="Sections">
        {(['batches', 'recipes', 'inventory', 'equipment'] as Section[]).map(item =>
          <button key={item} className={section === item ? 'nav-item active' : 'nav-item'} onClick={() => showSection(item)}>
            {item[0].toUpperCase() + item.slice(1)}
          </button>)}
        <div className="nav-spacer" />
      </nav>
      <main className="app-main">
        {error && <Alert type="warning" showIcon closable onClose={() => setError('')} message={error} className="page-alert" />}
        {section === 'me' ? <AccountSection username={session.account.username}
          breweryName={session.workspaces.find(item => item.id === workspaceId)?.name || null}
          autoSync={autoSync} onAutoSyncChange={enabled => { localStorage.setItem(autoSyncKey, enabled ? '1' : '0'); setAutoSync(enabled); }}
          onSignOut={signOut} /> : !workspaceId ? <Empty description="Create a brewery to begin"><Button type="primary" onClick={() => setWorkspaceDialog(true)}>New brewery</Button></Empty> :
          !db ? <div className="loading-screen"><Spin tip="Opening local database" /></div> : <>
            {section === 'batches' && <BatchSection key={workspaceId} db={db} accountId={session.account.id} batches={batches}
              equipment={equipment} inventory={inventory} onChanged={changed} />}
            {section === 'recipes' && <RecipeSection key={workspaceId} db={db} accountId={session.account.id} recipes={recipes}
              onChanged={changed} onBatchStarted={() => setSection('batches')} />}
            {section === 'inventory' && <InventorySection key={workspaceId} db={db} accountId={session.account.id} items={inventory} onChanged={changed} />}
            {section === 'equipment' && <EquipmentSection key={workspaceId} db={db} equipment={equipment} onChanged={changed} />}
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
    <div className="brand login-brand"><span className="brand-mark">B</span><div><strong>Brewlog</strong><small>Your batches, as they happened</small></div></div>
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
