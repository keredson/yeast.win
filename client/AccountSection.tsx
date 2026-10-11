import { Button, Card, Switch, Typography } from 'antd';

interface Props {
  username: string;
  breweryName: string | null;
  autoSync: boolean;
  onAutoSyncChange: (enabled: boolean) => void;
  onSignOut: () => void;
}

export function AccountSection({ username, breweryName, autoSync, onAutoSyncChange, onSignOut }: Props) {
  return <div className="account-page">
    <div className="section-heading"><div><div className="eyebrow">Account</div><h1>Settings</h1></div></div>
    <Card title="Account" className="account-card">
      <div className="setting-row"><span>Username</span><strong>{username}</strong></div>
      <div className="setting-row"><span>Current brewery</span><strong>{breweryName || 'None selected'}</strong></div>
    </Card>
    <Card title="Sync" className="account-card">
      <div className="setting-row">
        <div><strong>Automatic sync</strong><Typography.Paragraph type="secondary" className="setting-description">
          Sync when opening a brewery, after changes, on reconnect, and every 30 seconds while the app is open.
        </Typography.Paragraph></div>
        <Switch checked={autoSync} onChange={onAutoSyncChange} aria-label="Automatic sync" />
      </div>
      <Typography.Paragraph type="secondary" className="setting-description">
        Changes stay on this device until they sync. You can use the header icon to sync manually.
      </Typography.Paragraph>
    </Card>
    <Button onClick={onSignOut}>Sign out</Button>
  </div>;
}
