import { useEffect, useRef, useState } from 'react';
import { UploadOutlined } from '@ant-design/icons';
import { Alert, Avatar, Button, Card, Input, Select, Switch } from 'antd';
import { fetchApi } from './api.ts';

interface Props {
  username: string;
  fullName: string | null;
  onFullNameChange: (fullName: string | null) => Promise<void>;
  avatarSrc?: string;
  onAvatarUploaded: () => void;
  hidePublicProfile: boolean | null;
  onHidePublicProfileChange: (hidden: boolean) => Promise<void>;
  timeZone: string | null;
  onTimeZoneChange: (timeZone: string) => Promise<void>;
}

const timeZones = Array.from(new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])).sort();

export function ProfileCard({ username, fullName, onFullNameChange, avatarSrc, onAvatarUploaded, hidePublicProfile, onHidePublicProfileChange,
  timeZone, onTimeZoneChange }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [fullNameDraft, setFullNameDraft] = useState(fullName || '');
  const [fullNameBusy, setFullNameBusy] = useState(false);
  const [fullNameError, setFullNameError] = useState('');
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityError, setVisibilityError] = useState('');
  const [timeZoneBusy, setTimeZoneBusy] = useState(false);
  const [timeZoneError, setTimeZoneError] = useState('');
  useEffect(() => setFullNameDraft(fullName || ''), [fullName]);

  async function updateFullName() {
    setFullNameBusy(true); setFullNameError('');
    try { await onFullNameChange(fullNameDraft.trim() || null); }
    catch (cause) { setFullNameError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setFullNameBusy(false); }
  }

  async function updateVisibility(hidden: boolean) {
    setVisibilityBusy(true); setVisibilityError('');
    try { await onHidePublicProfileChange(hidden); }
    catch (cause) { setVisibilityError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setVisibilityBusy(false); }
  }

  async function updateTimeZone(value: string) {
    setTimeZoneBusy(true); setTimeZoneError('');
    try { await onTimeZoneChange(value); }
    catch (cause) { setTimeZoneError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTimeZoneBusy(false); }
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
        const response = await fetchApi('/api/me/avatar', { method: 'PUT', credentials: 'same-origin',
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

  return <Card title="Profile" className="account-card">
    <div className="profile-row">
      <Avatar size={72} src={avatarSrc}>{username[0].toUpperCase()}</Avatar>
      <div><strong>{username}</strong><div className="muted">Your account avatar appears at the bottom of the navigation.</div>
        <input ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp"
          aria-label="Avatar image" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadAvatar(file); }} />
        <Button icon={<UploadOutlined />} loading={avatarBusy} onClick={() => fileInput.current?.click()}>Upload avatar</Button>
      </div>
    </div>
    {avatarError && <Alert type="error" message={avatarError} showIcon />}
    <div className="setting-row profile-full-name-row">
      <label htmlFor="profile-full-name"><strong>Full name</strong></label>
      <div className="profile-full-name-control">
        <Input id="profile-full-name" aria-label="Full name" autoComplete="name" maxLength={80}
          value={fullNameDraft} onChange={event => setFullNameDraft(event.target.value)}
          onPressEnter={() => void updateFullName()} />
        <Button loading={fullNameBusy} disabled={fullNameDraft.trim() === (fullName || '')}
          onClick={() => void updateFullName()}>Save</Button>
      </div>
    </div>
    {fullNameError && <Alert type="error" message={fullNameError} showIcon />}
    <div className="setting-row profile-visibility-row">
      <div><strong>Hide public profile</strong><div className="muted">When enabled, visitors cannot view your brewer page or avatar.</div></div>
      <Switch aria-label="Hide public profile" checked={hidePublicProfile === true} loading={visibilityBusy}
        onChange={value => void updateVisibility(value)} />
    </div>
    {visibilityError && <Alert type="error" message={visibilityError} showIcon />}
    <div className="setting-row profile-time-zone-row">
      <div><strong>Time zone</strong></div>
      <Select aria-label="Time zone" showSearch value={timeZone || 'UTC'} disabled={timeZoneBusy}
        options={timeZones.map(value => ({ value, label: value.replaceAll('_', ' ') }))}
        onChange={value => void updateTimeZone(value)} />
    </div>
    {timeZoneError && <Alert type="error" message={timeZoneError} showIcon />}
  </Card>;
}
