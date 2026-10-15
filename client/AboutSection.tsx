import { useEffect, useState } from 'react';
import { GithubOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Modal, Tag, Tooltip, Typography } from 'antd';
import { api } from './api.ts';
import { forceAppRefresh } from './appUpdate.ts';
import { clientBuildInfo } from './buildInfo.ts';
import type { BuildInfo, DeploymentInfo } from '../shared/buildInfo.ts';

function revision(info: BuildInfo): React.ReactNode {
  return <>{info.commit ? <a href={`https://github.com/keredson/yeast.win/commit/${info.commit}`}
    target="_blank" rel="noreferrer">{info.commit.slice(0, 12)}</a> : 'Unavailable'}
    {info.dirty && <Tag color="gold" className="deployment-dirty">dirty</Tag>}</>;
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Unavailable';
}

export function AboutSection() {
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<DeploymentInfo>('/about').then(result => { if (!cancelled) setDeployment(result); })
      .catch(cause => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);

  async function refreshApp() {
    setRefreshing(true); setRefreshError('');
    try { await forceAppRefresh(); }
    catch (cause) { setRefreshError(cause instanceof Error ? cause.message : String(cause)); setRefreshing(false); }
  }

  const differentBuild = deployment?.environment === 'production' && clientBuildInfo.environment === 'production'
    && !!deployment.commit && !!clientBuildInfo.commit && deployment.commit !== clientBuildInfo.commit;

  return <div className="about-page">
    <div className="section-heading"><div><div className="eyebrow">Project</div><h1>About Yeast.Win!</h1></div></div>
    <Card title="Yeast.Win!" className="account-card">
      <Typography.Paragraph>Yeast.Win! is a fermentation notebook for recipes, batches, equipment, and the things you learn along the way. Your brewery records stay available on this device and sync when you reconnect.</Typography.Paragraph>
      <a href="https://github.com/keredson/yeast.win" target="_blank" rel="noreferrer"><GithubOutlined /> View the source on GitHub ↗</a>
    </Card>
    <Card title="Deployment" className="account-card">
      {differentBuild && <Alert type="warning" showIcon message="This browser is running a different build from the server." />}
      {loadError && <Alert type="warning" showIcon message={`Server deployment details unavailable: ${loadError}`} />}
      <dl className="deployment-details">
        <dt>Environment</dt><dd>{deployment?.environment === 'development' ? 'Development'
          : deployment?.environment === 'production' ? 'Production' : 'Checking…'}</dd>
        <dt>Browser build</dt><dd className="browser-build-value">
          <span>{clientBuildInfo.environment === 'development' ? 'Development · ' : ''}{revision(clientBuildInfo)}</span>
          <Tooltip title="App update options"><Button type="text" size="small" shape="circle"
            icon={<ReloadOutlined />} aria-label="App update options" onClick={() => setRefreshOpen(true)} /></Tooltip>
        </dd>
        <dt>Server build</dt><dd>{deployment ? revision(deployment) : loadError ? 'Unavailable' : 'Checking…'}</dd>
        <dt>Built</dt><dd>{deployment ? date(deployment.builtAt) : loadError ? 'Unavailable' : 'Checking…'}</dd>
        <dt>Server started</dt><dd>{deployment ? date(deployment.startedAt) : loadError ? 'Unavailable' : 'Checking…'}</dd>
        <dt>PWA</dt><dd>{'serviceWorker' in navigator && navigator.serviceWorker.controller
          ? 'Installed on this device' : 'Not controlling this page'}</dd>
      </dl>
    </Card>
    <Modal title="Update app" open={refreshOpen} onCancel={() => { if (!refreshing) setRefreshOpen(false); }}
      footer={null} destroyOnHidden>
      <Typography.Paragraph>Force an update if this browser keeps showing an older build. This clears cached app files and reloads from the server. Saved brewery data stays on this device.</Typography.Paragraph>
      {refreshError && <Alert type="error" showIcon message={refreshError} className="form-alert" />}
      <Button type="primary" icon={<ReloadOutlined />} loading={refreshing}
        onClick={() => void refreshApp()}>Update and reload</Button>
    </Modal>
  </div>;
}
