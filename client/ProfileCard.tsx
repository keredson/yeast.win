import { useRef, useState } from 'react';
import { UploadOutlined } from '@ant-design/icons';
import { Alert, Avatar, Button, Card } from 'antd';

interface Props {
  username: string;
  avatarSrc?: string;
  onAvatarUploaded: () => void;
}

export function ProfileCard({ username, avatarSrc, onAvatarUploaded }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState('');

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
  </Card>;
}
