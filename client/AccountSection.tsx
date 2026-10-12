import { useRef, useState } from 'react';
import { SyncOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Avatar, Button, Card, Form, Input, Modal, Select, Switch, Tooltip, Typography } from 'antd';
import { api, type PreferredUnits } from './api.ts';

interface Props {
  username: string;
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

export function AccountSection({ username, avatarSrc, onAvatarUploaded, preferredUnits, onPreferredUnitsChange,
  syncPhase, syncStatus, canSync, onManualSync, autoSync, onAutoSyncChange, onSignOut }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [passwordForm] = Form.useForm<PasswordValues>();
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
