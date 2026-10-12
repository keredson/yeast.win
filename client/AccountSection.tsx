import { useRef, useState } from 'react';
import { DeleteOutlined, EditOutlined, PlusOutlined, SyncOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Avatar, Button, Card, Form, Input, Modal, Select, Switch, Tag, Tooltip, Typography } from 'antd';
import { api, type PreferredUnits, type Workspace } from './api.ts';

interface Props {
  username: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  onCreateWorkspace: (name: string) => Promise<void>;
  onUpdateWorkspace: (id: string, name: string, slug: string | null) => Promise<void>;
  onDeleteWorkspace: (id: string) => Promise<void>;
  avatarSrc?: string;
  onAvatarUploaded: () => void;
  preferredUnits: PreferredUnits;
  onPreferredUnitsChange: (units: PreferredUnits) => Promise<void>;
  syncPhase: 'idle' | 'syncing' | 'synced' | 'failed';
  syncStatus: string;
  canSync: boolean;
  onManualSync: () => void;
  autoSync: boolean;
  onAutoSyncChange: (enabled: boolean) => void;
  onSignOut: () => void;
}

interface PasswordValues { currentPassword: string; newPassword: string; confirmPassword: string }

export function AccountSection({ username, workspaces, activeWorkspaceId, onCreateWorkspace, onUpdateWorkspace, onDeleteWorkspace,
  avatarSrc, onAvatarUploaded, preferredUnits, onPreferredUnitsChange,
  syncPhase, syncStatus, canSync, onManualSync, autoSync, onAutoSyncChange, onSignOut }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [passwordForm] = Form.useForm<PasswordValues>();
  const [breweryForm] = Form.useForm<{ name: string; slug?: string }>();
  const [breweryEditor, setBreweryEditor] = useState<Workspace | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);
  const [breweryBusy, setBreweryBusy] = useState(false);
  const [breweryError, setBreweryError] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [unitsBusy, setUnitsBusy] = useState(false);
  const [unitsError, setUnitsError] = useState('');

  async function uploadAvatar(file: File) {
    setAvatarBusy(true);
    setAvatarError('');
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
        throw new Error('Choose a JPEG, PNG, or WebP image under 5 MB');
      }
      const image = await createImageBitmap(file);
      try {
        if (image.width > 4096 || image.height > 4096) throw new Error('Avatar image is too large');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not prepare avatar');
        const side = Math.min(image.width, image.height);
        context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 256, 256);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result =>
          result ? resolve(result) : reject(new Error('Could not encode avatar')), 'image/jpeg', 0.85));
        const response = await fetch('/api/me/avatar', { method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        if (!response.ok) {
          const result = await response.json() as { error?: string };
          throw new Error(result.error || 'Avatar upload failed');
        }
        onAvatarUploaded();
      } finally { image.close(); }
    } catch (cause) { setAvatarError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setAvatarBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function updatePassword(values: PasswordValues) {
    setPasswordBusy(true);
    setPasswordError('');
    setPasswordChanged(false);
    try {
      await api('/me/password', 'POST', { currentPassword: values.currentPassword, newPassword: values.newPassword });
      passwordForm.resetFields();
      setPasswordOpen(false);
      setPasswordChanged(true);
    } catch (cause) { setPasswordError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPasswordBusy(false); }
  }

  async function updateUnits(next: PreferredUnits) {
    setUnitsBusy(true);
    setUnitsError('');
    try { await onPreferredUnitsChange(next); }
    catch (cause) { setUnitsError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUnitsBusy(false); }
  }

  function openBreweryEditor(target: Workspace | 'new') {
    setBreweryError('');
    breweryForm.setFieldsValue(target === 'new' ? { name: '', slug: undefined } : { name: target.name, slug: target.slug || '' });
    setBreweryEditor(target);
  }

  async function saveBrewery(values: { name: string; slug?: string }) {
    if (!breweryEditor) return;
    setBreweryBusy(true); setBreweryError('');
    try {
      if (breweryEditor === 'new') await onCreateWorkspace(values.name.trim());
      else await onUpdateWorkspace(breweryEditor.id, values.name.trim(), (values.slug || '').trim() || null);
      setBreweryEditor(null);
      breweryForm.resetFields();
    } catch (cause) { setBreweryError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBreweryBusy(false); }
  }

  async function removeBrewery() {
    if (!deleteTarget) return;
    setBreweryBusy(true); setBreweryError('');
    try { await onDeleteWorkspace(deleteTarget.id); setDeleteTarget(null); }
    catch (cause) { setBreweryError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBreweryBusy(false); }
  }

  return <div className="account-page">
    <div className="section-heading"><div><div className="eyebrow">Account</div><h1>Settings</h1></div></div>
    <Card title="Profile" className="account-card">
      <div className="profile-row">
        <Avatar size={72} src={avatarSrc}>{username[0].toUpperCase()}</Avatar>
        <div><strong>{username}</strong><div className="muted">Your account avatar appears in the header.</div>
          <input ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp"
            aria-label="Avatar image" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadAvatar(file); }} />
          <Button icon={<UploadOutlined />} loading={avatarBusy} onClick={() => fileInput.current?.click()}>Upload avatar</Button>
        </div>
      </div>
      {avatarError && <Alert type="error" message={avatarError} showIcon />}
    </Card>
    <Card title="Breweries" className="account-card" extra={<Button type="text" shape="circle" icon={<PlusOutlined />}
      aria-label="New brewery" title="New brewery" onClick={() => openBreweryEditor('new')} />}>
      {workspaces.length ? workspaces.map(brewery => <div className="setting-row brewery-row" key={brewery.id}>
        <div><strong>{brewery.name}</strong>{brewery.id === activeWorkspaceId && <Tag color="green">Selected</Tag>}
          <div className="muted">{brewery.slug === null ? 'Root URLs · /batches' : `/brewery/${brewery.slug}`}</div></div>
        <div className="brewery-actions">
          <Button type="text" shape="circle" icon={<EditOutlined />} aria-label={`Edit ${brewery.name}`}
            title="Edit brewery" onClick={() => openBreweryEditor(brewery)} />
          <Button type="text" shape="circle" danger icon={<DeleteOutlined />} aria-label={`Delete ${brewery.name}`}
            title="Delete brewery" onClick={() => { setBreweryError(''); setDeleteTarget(brewery); }} />
        </div>
      </div>) : <Typography.Paragraph type="secondary">No breweries yet. Add one to start brewing.</Typography.Paragraph>}
    </Card>
    <Modal title={breweryEditor === 'new' ? 'New brewery' : 'Edit brewery'} open={!!breweryEditor} footer={null}
      onCancel={() => { setBreweryEditor(null); breweryForm.resetFields(); }} destroyOnHidden>
      <Form form={breweryForm} layout="vertical" onFinish={saveBrewery}>
        <Form.Item name="name" label="Brewery name" rules={[{ required: true, whitespace: true }, { max: 80 }]}>
          <Input autoFocus maxLength={80} placeholder="e.g. Homebrew or Downtown Brewery" />
        </Form.Item>
        {breweryEditor !== 'new' && <Form.Item name="slug" label="Brewery slug" rules={[
          { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: 'Use lowercase letters, numbers, and single hyphens' }, { max: 48 }]}>
          <Input maxLength={48} addonBefore="/brewery/" />
        </Form.Item>}
        {breweryEditor !== 'new' && <Typography.Paragraph type="secondary">
          Clear the slug to use root URLs such as /batches. Only one brewery can have no slug.
        </Typography.Paragraph>}
        {breweryError && <Alert type="error" message={breweryError} className="form-alert" />}
        <Button type="primary" htmlType="submit" loading={breweryBusy}>{breweryEditor === 'new' ? 'Create brewery' : 'Save brewery'}</Button>
      </Form>
    </Modal>
    <Modal title={`Delete ${deleteTarget?.name || 'brewery'}?`} open={!!deleteTarget} onCancel={() => setDeleteTarget(null)}
      onOk={() => void removeBrewery()} okText="Delete brewery" okButtonProps={{ danger: true, loading: breweryBusy }} destroyOnHidden>
      <Typography.Paragraph>This permanently deletes this brewery’s batches, recipes, inventory, equipment, and photos from the server and this device.</Typography.Paragraph>
      {breweryError && <Alert type="error" message={breweryError} />}
    </Modal>
    <Card title="Security" className="account-card">
      {passwordChanged && <Alert type="success" message="Password changed. Other sessions have been signed out." showIcon />}
      <Button onClick={() => { setPasswordError(''); setPasswordOpen(true); }}>Change password</Button>
    </Card>
    <Modal title="Change password" open={passwordOpen} onCancel={() => { setPasswordOpen(false); passwordForm.resetFields(); }}
      footer={null} destroyOnHidden>
      <Form form={passwordForm} layout="vertical" onFinish={updatePassword}>
        <Form.Item name="currentPassword" label="Current password" rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="newPassword" label="New password" rules={[{ required: true }, { min: 8, max: 256, message: 'Use 8–256 characters' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="confirmPassword" label="Confirm new password" dependencies={['newPassword']}
          rules={[{ required: true }, ({ getFieldValue }) => ({ validator(_, value) {
            return value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('Passwords do not match'));
          } })]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        {passwordError && <Alert type="error" message={passwordError} showIcon className="form-alert" />}
        <Button type="primary" htmlType="submit" loading={passwordBusy}>Change password</Button>
      </Form>
    </Modal>
    <Card title="Preferred units" className="account-card">
      <Typography.Paragraph type="secondary" className="setting-description">Used as defaults when logging new values. Existing records keep their entered units.</Typography.Paragraph>
      <div className="unit-grid">
        <label>Temperature<Select aria-label="Preferred temperature unit" value={preferredUnits.temperature}
          disabled={unitsBusy} options={[{ value: '°C', label: '°C' }, { value: '°F', label: '°F' }]}
          onChange={value => void updateUnits({ ...preferredUnits, temperature: value })} /></label>
        <label>Volume<Select aria-label="Preferred volume unit" value={preferredUnits.volume}
          disabled={unitsBusy} options={[{ value: 'L', label: 'L' }, { value: 'US gal', label: 'US gal' }]}
          onChange={value => void updateUnits({ ...preferredUnits, volume: value })} /></label>
        <label>Mass<Select aria-label="Preferred mass unit" value={preferredUnits.mass}
          disabled={unitsBusy} options={[{ value: 'g', label: 'g' }, { value: 'oz', label: 'oz' }, { value: 'lb + oz', label: 'lb + oz' }]}
          onChange={value => void updateUnits({ ...preferredUnits, mass: value })} /></label>
        <label>Pressure<Select aria-label="Preferred pressure unit" value={preferredUnits.pressure}
          disabled={unitsBusy} options={[{ value: 'kPa', label: 'kPa' }, { value: 'psi', label: 'psi' }]}
          onChange={value => void updateUnits({ ...preferredUnits, pressure: value })} /></label>
      </div>
      {unitsError && <Alert type="error" message={unitsError} showIcon />}
    </Card>
    <Card title="Sync" className="account-card">
      <div className="setting-row"><div><strong>Sync status</strong><div className="muted">{syncPhase === 'syncing' ? 'Syncing…' : syncPhase === 'failed' ? `Sync failed · ${syncStatus}` : syncStatus}</div></div>
        <Tooltip title={`${syncStatus} · Click to sync`}><Button className="sync-button" type="text" shape="circle" aria-label="Sync now"
          icon={<SyncOutlined spin={syncPhase === 'syncing'} />} disabled={!canSync} onClick={onManualSync} /></Tooltip></div>
      <div className="setting-row">
        <div><strong>Automatic sync</strong><Typography.Paragraph type="secondary" className="setting-description">
          Sync when opening a brewery, after changes, on reconnect, and every 30 seconds while the app is open.
        </Typography.Paragraph></div>
        <Switch checked={autoSync} onChange={onAutoSyncChange} aria-label="Automatic sync" />
      </div>
      <Typography.Paragraph type="secondary" className="setting-description">
        Changes stay on this device until they sync. Use the sync icon above to sync manually.
      </Typography.Paragraph>
    </Card>
    <Button onClick={onSignOut}>Sign out</Button>
  </div>;
}
