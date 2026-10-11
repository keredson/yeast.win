import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Modal, Select, Spin, Typography } from 'antd';
import { api, type Session, type Workspace } from './api.ts';
import { openLocalDb, syncNow, type Batch, type Equipment, type InventoryItem, type LocalDb, type Recipe,
  listBatches, listEquipment, listInventory, listRecipes } from './db.ts';
import { BatchSection } from './BatchSection.tsx';
import { RecipeSection } from './RecipeSection.tsx';
import { InventorySection } from './InventorySection.tsx';
import { EquipmentSection } from './EquipmentSection.tsx';

type Section = 'batches' | 'recipes' | 'inventory' | 'equipment';

export function App() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [db, setDb] = useState<LocalDb | null>(null);
  const [section, setSection] = useState<Section>('batches');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [error, setError] = useState('');
  const [syncStatus, setSyncStatus] = useState('Local data ready');
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');

  useEffect(() => {
    api<Session>('/me').then(result => {
      setSession(result);
      setWorkspaceId(result.workspaces[0]?.id || null);
    }).catch(() => setSession(null)).finally(() => setLoading(false));
  }, []);

  const refresh = useCallback(async (activeDb: LocalDb) => {
    const [nextBatches, nextRecipes, nextInventory, nextEquipment] = await Promise.all([
      listBatches(activeDb), listRecipes(activeDb), listInventory(activeDb), listEquipment(activeDb)
    ]);
    setBatches(nextBatches);
    setRecipes(nextRecipes);
    setInventory(nextInventory);
    setEquipment(nextEquipment);
  }, []);

  const runSync = useCallback(async (activeDb: LocalDb, activeWorkspaceId: string) => {
    setSyncStatus('Syncing…');
    try {
      const received = await syncNow(activeDb, activeWorkspaceId);
      await refresh(activeDb);
      setSyncStatus(received ? `Synced · ${received} changes received` : 'Synced');
      setError('');
    } catch (cause) {
      setSyncStatus('Offline · changes saved locally');
      if (navigator.onLine) setError(cause instanceof Error ? cause.message : 'Sync failed');
    }
  }, [refresh]);

  useEffect(() => {
    if (!workspaceId || !session) return;
    let cancelled = false;
    setDb(null);
    openLocalDb(workspaceId).then(async activeDb => {
      if (cancelled) return;
      setDb(activeDb);
      await refresh(activeDb);
      await runSync(activeDb, workspaceId);
    }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { cancelled = true; };
  }, [workspaceId, session, refresh, runSync]);

  useEffect(() => {
    if (!db || !workspaceId) return;
    const callback = () => { void runSync(db, workspaceId); };
    const timer = window.setInterval(callback, 30_000);
    window.addEventListener('online', callback);
    return () => { window.clearInterval(timer); window.removeEventListener('online', callback); };
  }, [db, workspaceId, runSync]);

  const changed = useCallback(async () => {
    if (!db || !workspaceId) return;
    await refresh(db);
    void runSync(db, workspaceId);
  }, [db, workspaceId, refresh, runSync]);

  async function createWorkspace() {
    if (!workspaceName.trim() || !session) return;
    try {
      const workspace = await api<Workspace>('/workspaces', 'POST', { name: workspaceName.trim() });
      setSession({ ...session, workspaces: [...session.workspaces, workspace] });
      setWorkspaceId(workspace.id);
      setWorkspaceDialog(false);
      setWorkspaceName('');
      setSection('batches');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  if (loading) return <div className="loading-screen"><Spin size="large" /></div>;
  if (!session) return <Login onLogin={result => { setSession(result); setWorkspaceId(result.workspaces[0]?.id || null); }} />;

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-mark">B</span><div><strong>Brewlog</strong><small>Batch-first brewing</small></div></div>
      <div className="header-controls">
        <Select className="workspace-select" value={workspaceId} placeholder="Select workspace"
          options={session.workspaces.map(item => ({ label: item.name, value: item.id }))}
          onChange={value => { setWorkspaceId(value); setSection('batches'); }} />
        <Button onClick={() => setWorkspaceDialog(true)}>New workspace</Button>
        <Button onClick={async () => { await api('/logout', 'POST'); setSession(null); setDb(null); }}>Sign out</Button>
      </div>
    </header>

    <div className="app-body">
      <nav className="app-nav" aria-label="Sections">
        {(['batches', 'recipes', 'inventory', 'equipment'] as Section[]).map(item =>
          <button key={item} className={section === item ? 'nav-item active' : 'nav-item'} onClick={() => setSection(item)}>
            {item[0].toUpperCase() + item.slice(1)}
          </button>)}
        <div className="nav-spacer" />
        <span className="sync-label">{syncStatus}</span>
        {db && workspaceId && <Button size="small" onClick={() => void runSync(db, workspaceId)}>Sync now</Button>}
      </nav>
      <main className="app-main">
        {error && <Alert type="warning" showIcon closable onClose={() => setError('')} message={error} className="page-alert" />}
        {!workspaceId ? <Empty description="Create a workspace to begin"><Button type="primary" onClick={() => setWorkspaceDialog(true)}>New workspace</Button></Empty> :
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
    <Modal title="New workspace" open={workspaceDialog} onCancel={() => setWorkspaceDialog(false)} onOk={createWorkspace} okText="Create">
      <Input autoFocus maxLength={80} placeholder="e.g. Homebrew or Brewery" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} />
    </Modal>
  </div>;
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(values: { username: string; password: string }) {
    setBusy(true); setError('');
    try {
      await api('/login', 'POST', values);
      onLogin(await api<Session>('/me'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="login-page"><Card className="login-card">
    <div className="brand login-brand"><span className="brand-mark">B</span><div><strong>Brewlog</strong><small>Your batches, as they happened</small></div></div>
    <Typography.Title level={3}>Sign in</Typography.Title>
    {error && <Alert type="error" message={error} className="form-alert" />}
    <Form layout="vertical" onFinish={submit}>
      <Form.Item name="username" label="Username" rules={[{ required: true }]}><Input autoComplete="username" size="large" /></Form.Item>
      <Form.Item name="password" label="Password" rules={[{ required: true }]}><Input.Password autoComplete="current-password" size="large" /></Form.Item>
      <Button htmlType="submit" type="primary" size="large" block loading={busy}>Sign in</Button>
    </Form>
    <p className="muted login-note">First run? Set the owner username and password in <code>.env</code>, then restart the server.</p>
  </Card></div>;
}
