import { useRef, useState } from 'react';
import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, SettingOutlined, SyncOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Avatar, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Tag, Tooltip, Typography } from 'antd';
import { api, type PreferredUnits, type Workspace } from './api.ts';
import { breweryMashEfficiency, breweryBatchSize, openLocalDb, updateBreweryMashEfficiency, updateBreweryBatchSize } from './db.ts';
import { appMashEfficiencyPct } from './recipeCalculations.ts';
import { appBatchSizeLiters } from '../shared/batchSize.ts';
import { convertUnit } from '../shared/units.ts';

interface Props {
  username: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  onCreateWorkspace: (name: string) => Promise<Workspace>;
  onUpdateWorkspace: (id: string, name: string, slug: string | null) => Promise<void>;
  onDeleteWorkspace: (id: string) => Promise<void>;
  avatarSrc?: string;
  onAvatarUploaded: () => void;
  preferredUnits: PreferredUnits;
  onPreferredUnitsChange: (units: PreferredUnits) => Promise<void>;
  syncingWorkspaceId: string | null;
  syncStatusFor: (id: string) => string;
  onManualSync: (id: string) => Promise<void>;
}

interface PasswordValues { currentPassword: string; newPassword: string; confirmPassword: string }
interface BreweryValues { name: string; slug?: string; batch_size: number | null; mash_efficiency: number | null }
interface RaptSetup {
  webhook_path: string | null;
  devices: { device_id: string; name: string; device_type: string; last_seen_at: number;
    workspace_id: string | null; batch_id: string | null }[];
  targets: { workspace_id: string; workspace_name: string; batch_id: string; batch_name: string }[];
}

const raptPayload = `{
  "device_id": "@device_id",
  "device_name": "@device_name",
  "device_type": "@device_type",
  "temperature": @temperature,
  "gravity": @gravity,
  "battery": @battery,
  "rssi": @rssi,
  "created_date": "@created_date"
}`;

export function AccountSection({ username, workspaces, activeWorkspaceId,
  onCreateWorkspace, onUpdateWorkspace, onDeleteWorkspace,
  avatarSrc, onAvatarUploaded, preferredUnits, onPreferredUnitsChange,
  syncingWorkspaceId, syncStatusFor, onManualSync }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [passwordForm] = Form.useForm<PasswordValues>();
  const [breweryForm] = Form.useForm<BreweryValues>();
  const breweryLoadSequence = useRef(0);
  const loadedBreweryDefaults = useRef<{ id: string; batchSizeDisplay: number | null; mashEfficiency: number | null } | null>(null);
  const [breweryEditor, setBreweryEditor] = useState<Workspace | 'new' | null>(null);
  const [breweryEditorLoading, setBreweryEditorLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);
  const [breweryBusy, setBreweryBusy] = useState(false);
  const [breweryError, setBreweryError] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [raptSetup, setRaptSetup] = useState<RaptSetup | null>(null);
  const [raptOpen, setRaptOpen] = useState(false);
  const [raptBusy, setRaptBusy] = useState(false);
  const [raptDeviceBusy, setRaptDeviceBusy] = useState<string | null>(null);
  const [raptError, setRaptError] = useState('');
  const [raptCopied, setRaptCopied] = useState<'url' | 'payload' | null>(null);
  const [unitsBusy, setUnitsBusy] = useState(false);
  const [unitsError, setUnitsError] = useState('');
  async function refreshRapt() {
    setRaptSetup(await api<RaptSetup>('/me/rapt'));
  }
  async function openRaptSettings() {
    setRaptOpen(true); setRaptBusy(true); setRaptError(''); setRaptCopied(null);
    try {
      await api('/me/rapt/webhook', 'PUT');
      await refreshRapt();
    } catch (cause) { setRaptError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRaptBusy(false); }
  }
  async function copyRapt(value: string, kind: 'url' | 'payload') {
    setRaptError('');
    try { await navigator.clipboard.writeText(value); setRaptCopied(kind); }
    catch (cause) { setRaptError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function deleteRapt() {
    setRaptBusy(true); setRaptError(''); setRaptCopied(null);
    try {
      await api('/me/rapt/webhook', 'DELETE');
      setRaptSetup(null);
      setRaptOpen(false);
    }
    catch (cause) { setRaptError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRaptBusy(false); }
  }
  async function setRaptAssignment(deviceId: string, target: string | undefined) {
    setRaptDeviceBusy(deviceId); setRaptError('');
    try {
      if (target) {
        const selected = raptSetup?.targets.find(item => `${item.workspace_id}:${item.batch_id}` === target);
        if (!selected) throw new Error('Choose a batch');
        await api(`/me/rapt/devices/${deviceId}/assignment`, 'PUT',
          { workspace_id: selected.workspace_id, batch_id: selected.batch_id });
      } else await api(`/me/rapt/devices/${deviceId}/assignment`, 'DELETE');
      await refreshRapt();
    } catch (cause) { setRaptError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRaptDeviceBusy(null); }
  }
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

  async function openBreweryEditor(target: Workspace | 'new') {
    const sequence = ++breweryLoadSequence.current;
    setBreweryError('');
    loadedBreweryDefaults.current = null;
    breweryForm.setFieldsValue(target === 'new'
      ? { name: '', slug: undefined, batch_size: null, mash_efficiency: null }
      : { name: target.name, slug: target.slug || '', batch_size: null, mash_efficiency: null });
    setBreweryEditor(target);
    setBreweryEditorLoading(target !== 'new');
    if (target === 'new') return;
    try {
      const targetDb = await openLocalDb(target.id);
      const [liters, mashEfficiency] = await Promise.all([
        breweryBatchSize(targetDb), breweryMashEfficiency(targetDb)]);
      if (breweryLoadSequence.current !== sequence) return;
      const batchSizeDisplay = liters == null ? null
        : Number((convertUnit(liters, 'L', preferredUnits.volume) ?? liters).toFixed(2));
      loadedBreweryDefaults.current = { id: target.id, batchSizeDisplay, mashEfficiency };
      breweryForm.setFieldsValue({ batch_size: batchSizeDisplay, mash_efficiency: mashEfficiency });
    } catch (cause) {
      if (breweryLoadSequence.current === sequence) setBreweryError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (breweryLoadSequence.current === sequence) setBreweryEditorLoading(false); }
  }

  async function saveBrewery(values: BreweryValues) {
    if (!breweryEditor || breweryEditorLoading) return;
    setBreweryBusy(true); setBreweryError('');
    let created: Workspace | null = null;
    try {
      if (breweryEditor !== 'new' && loadedBreweryDefaults.current?.id !== breweryEditor.id) {
        throw new Error('Could not load this brewery’s defaults. Close and reopen the editor.');
      }
      const batchSize = values.batch_size ?? null;
      const mashEfficiency = values.mash_efficiency ?? null;
      if (batchSize != null && (!Number.isFinite(batchSize) || batchSize <= 0)) throw new Error('Enter a positive batch size');
      if (mashEfficiency != null && (!Number.isFinite(mashEfficiency) || mashEfficiency <= 0 || mashEfficiency > 100)) {
        throw new Error('Enter an efficiency between 0 and 100%');
      }
      let target = breweryEditor;
      if (target === 'new') {
        target = await onCreateWorkspace(values.name.trim());
        created = target;
        loadedBreweryDefaults.current = { id: target.id, batchSizeDisplay: null, mashEfficiency: null };
      }
      const targetDb = await openLocalDb(target.id);
      const previous = loadedBreweryDefaults.current?.id === target.id ? loadedBreweryDefaults.current : null;
      if (batchSize !== previous?.batchSizeDisplay && (previous || batchSize != null)) {
        const liters = batchSize == null ? null : convertUnit(batchSize, preferredUnits.volume, 'L');
        if (batchSize != null && liters == null) throw new Error('Choose a valid batch size');
        await updateBreweryBatchSize(targetDb, liters);
      }
      if (mashEfficiency !== previous?.mashEfficiency && (previous || mashEfficiency != null)) {
        await updateBreweryMashEfficiency(targetDb, mashEfficiency);
      }
      if (breweryEditor !== 'new') {
        await onUpdateWorkspace(target.id, values.name.trim(), (values.slug || '').trim() || null);
      }
      setBreweryEditor(null);
      breweryLoadSequence.current++;
      loadedBreweryDefaults.current = null;
      breweryForm.resetFields();
    } catch (cause) {
      if (created) {
        setBreweryEditor(created);
        breweryForm.setFieldValue('slug', created.slug || '');
      }
      setBreweryError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { setBreweryBusy(false); }
  }

  async function removeBrewery() {
    if (!deleteTarget) return;
    setBreweryBusy(true); setBreweryError('');
    try {
      await onDeleteWorkspace(deleteTarget.id);
      setDeleteTarget(null);
      setBreweryEditor(null);
      breweryLoadSequence.current++;
      loadedBreweryDefaults.current = null;
      breweryForm.resetFields();
    }
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
    <Card title="Breweries" className="account-card" extra={<Button type="text" shape="circle" icon={<PlusOutlined />}
      aria-label="New brewery" title="New brewery" onClick={() => void openBreweryEditor('new')} />}>
      {workspaces.length ? workspaces.map(brewery => <div className="setting-row brewery-row" key={brewery.id}>
        <div><strong>{brewery.name}</strong>{brewery.id === activeWorkspaceId && <Tag color="green">Selected</Tag>}
          <div className="muted">{brewery.slug === null ? 'Root URLs · /batches' : `/brewery/${brewery.slug}`}</div>
          <div className="muted">{syncingWorkspaceId === brewery.id ? 'Syncing…' : syncStatusFor(brewery.id)}</div></div>
        <div className="brewery-actions">
          <Tooltip title={`${syncStatusFor(brewery.id)} · Sync brewery and catalog`}><Button className="sync-button"
            type="text" shape="circle" icon={<SyncOutlined spin={syncingWorkspaceId === brewery.id} />}
            aria-label={`Sync ${brewery.name}`} disabled={!!syncingWorkspaceId}
            onClick={() => void onManualSync(brewery.id)} /></Tooltip>
          <Button type="text" shape="circle" icon={<EditOutlined />} aria-label={`Edit ${brewery.name}`}
            title="Edit brewery" onClick={() => void openBreweryEditor(brewery)} />
        </div>
      </div>) : <Typography.Paragraph type="secondary">No breweries yet. Add one to start brewing.</Typography.Paragraph>}
    </Card>
    <Modal title={breweryEditor === 'new' ? 'New brewery' : 'Edit brewery'} open={!!breweryEditor} footer={null}
      onCancel={() => { breweryLoadSequence.current++; setBreweryEditor(null); loadedBreweryDefaults.current = null;
        breweryForm.resetFields(); }} destroyOnHidden>
      <Form form={breweryForm} layout="vertical" onFinish={saveBrewery}>
        <Form.Item name="name" label="Brewery name" rules={[{ required: true, whitespace: true }, { max: 80 }]}>
          <Input autoFocus maxLength={80} disabled={breweryEditorLoading} placeholder="e.g. Homebrew or Downtown Brewery" />
        </Form.Item>
        {breweryEditor !== 'new' && <Form.Item name="slug" label="Brewery slug" rules={[
          { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: 'Use lowercase letters, numbers, and single hyphens' }, { max: 48 }]}>
          <Input maxLength={48} addonBefore="/brewery/" disabled={breweryEditorLoading} />
        </Form.Item>}
        {breweryEditor !== 'new' && <Typography.Paragraph type="secondary">
          Clear the slug to use root URLs such as /batches. Only one brewery can have no slug.
        </Typography.Paragraph>}
        <Form.Item name="batch_size" label={`Default batch size (${preferredUnits.volume})`}
          extra="Prefills new recipes. Clear to use the 5 US gal app default; existing recipes keep their saved size.">
          <InputNumber className="full-width" min={0.01} precision={2} disabled={breweryEditorLoading}
            placeholder={String(Number((convertUnit(appBatchSizeLiters, 'L', preferredUnits.volume) ?? appBatchSizeLiters).toFixed(2)))} />
        </Form.Item>
        <Form.Item name="mash_efficiency" label="Default mash efficiency (%)"
          extra={`Used when no equipment, recent batch, or imported efficiency is available. Clear to use the ${appMashEfficiencyPct}% app default.`}>
          <InputNumber className="full-width" min={1} max={100} precision={1} disabled={breweryEditorLoading}
            placeholder={String(appMashEfficiencyPct)} />
        </Form.Item>
        {breweryEditorLoading && <Typography.Paragraph type="secondary">Loading brewery defaults…</Typography.Paragraph>}
        {breweryError && <Alert type="error" message={breweryError} className="form-alert" />}
        <div className="brewery-editor-actions">
          <Button type="primary" htmlType="submit" loading={breweryBusy} disabled={breweryEditorLoading}>
            {breweryEditor === 'new' ? 'Create brewery' : 'Save brewery'}</Button>
          {breweryEditor !== 'new' && breweryEditor && <Button danger icon={<DeleteOutlined />} disabled={breweryBusy || breweryEditorLoading}
            onClick={() => { setBreweryError(''); setDeleteTarget(breweryEditor); }}>Delete brewery</Button>}
        </div>
      </Form>
    </Modal>
    <Modal title={`Delete ${deleteTarget?.name || 'brewery'}?`} open={!!deleteTarget} onCancel={() => setDeleteTarget(null)}
      onOk={() => void removeBrewery()} okText="Delete brewery" okButtonProps={{ danger: true, loading: breweryBusy }} destroyOnHidden>
      <Typography.Paragraph>This permanently deletes this brewery’s batches, recipes, inventory, equipment, and photos from the server and this device.</Typography.Paragraph>
      {breweryError && <Alert type="error" message={breweryError} />}
    </Modal>
    <Card title="Integrations" className="account-card integrations-card">
      <table className="integrations-table"><tbody><tr>
        <th scope="row"><strong>RAPT Pill</strong><span className="muted">Automatic Pill readings for batches</span></th>
        <td><Button type="text" shape="circle" icon={<SettingOutlined />} aria-label="RAPT Pill settings"
          title="RAPT Pill settings" onClick={() => void openRaptSettings()} /></td>
      </tr></tbody></table>
    </Card>
    <Modal title="RAPT Pill" open={raptOpen} onCancel={() => setRaptOpen(false)} footer={null}
      width={640} destroyOnHidden>
      <div className="rapt-settings">
        <Typography.Paragraph type="secondary" className="setting-description">
          Create a Custom Web Hook in your RAPT account with method POST. Select the Pills you want to send here.
          Only readings from Pills assigned below are added to batches.
        </Typography.Paragraph>
        <a href="https://app.rapt.io/integration/webhooks/list" target="_blank" rel="noreferrer">Open RAPT webhooks ↗</a>
        <label className="rapt-field-label" htmlFor="rapt-webhook-url">Webhook URL</label>
        <Input id="rapt-webhook-url" aria-label="RAPT webhook URL" readOnly
          value={raptSetup?.webhook_path ? `${window.location.origin}${raptSetup.webhook_path}` : ''}
          placeholder={raptBusy ? 'Creating webhook URL…' : 'Webhook URL unavailable'}
          suffix={<Button type="text" size="small" icon={<CopyOutlined />} aria-label="Copy RAPT webhook URL"
            title={raptCopied === 'url' ? 'Copied' : 'Copy URL'} disabled={!raptSetup?.webhook_path || raptBusy}
            onClick={() => { if (raptSetup?.webhook_path) void copyRapt(`${window.location.origin}${raptSetup.webhook_path}`, 'url'); }} />} />
        {raptCopied === 'url' && <span className="muted" role="status">URL copied</span>}
        <div className="setting-row"><strong>Payload</strong><Button icon={<CopyOutlined />}
          onClick={() => void copyRapt(raptPayload, 'payload')}>{raptCopied === 'payload' ? 'Copied' : 'Copy payload'}</Button></div>
        <pre className="rapt-payload">{raptPayload}</pre>
        <div className="setting-row"><strong>Your Pills</strong><Button onClick={() => void refreshRapt().catch(cause =>
          setRaptError(cause instanceof Error ? cause.message : String(cause)))}>Refresh</Button></div>
        {raptSetup?.devices.length ? raptSetup.devices.map(device => <div className="setting-row rapt-device" key={device.device_id}>
          <div><strong>{device.name}</strong><div className="muted">{device.device_type} · {device.device_id}</div></div>
          <Select aria-label={`Batch for ${device.name}`} placeholder="Unassigned" allowClear
            value={device.workspace_id && device.batch_id ? `${device.workspace_id}:${device.batch_id}` : undefined}
            disabled={raptDeviceBusy === device.device_id}
            options={raptSetup.targets.map(target => ({ value: `${target.workspace_id}:${target.batch_id}`,
              label: `${target.workspace_name} / ${target.batch_name}` }))}
            onChange={value => void setRaptAssignment(device.device_id, value)} />
        </div>) : <Typography.Paragraph type="secondary">
          No Pills received yet. Send a test reading from RAPT, then refresh.
        </Typography.Paragraph>}
        {raptError && <Alert type="error" message={raptError} showIcon />}
        <Popconfirm title="Delete the RAPT integration?"
          description="The webhook URL will stop working and Pill assignments will be removed. Recorded batch readings stay in the log."
          okText="Delete integration" okButtonProps={{ danger: true }} onConfirm={() => void deleteRapt()}>
          <Button danger disabled={raptBusy}>Delete integration</Button>
        </Popconfirm>
      </div>
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
  </div>;
}
