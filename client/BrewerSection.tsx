import { useEffect, useRef, useState } from 'react';
import { Alert, Avatar, Card, Spin } from 'antd';
import { api, ApiError } from './api.ts';
import { renderActivityGrid, type BrewerActivity } from './ActivityGrid.ts';

interface Brewer { username: string; has_avatar: boolean; hidden: boolean }

export function BrewerSection({ username }: { username: string }) {
  const [brewer, setBrewer] = useState<Brewer | null>(null);
  const [activity, setActivity] = useState<BrewerActivity | null>(null);
  const [error, setError] = useState('');
  const activityContainer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setBrewer(null); setActivity(null); setError('');
    void api<Brewer>(`/brewer/${encodeURIComponent(username)}`).then(result => {
      if (!cancelled) setBrewer(result);
      return api<BrewerActivity>(`/brewer/${encodeURIComponent(username)}/activity`);
    }).then(result => { if (!cancelled) setActivity(result); })
      .catch(cause => { if (!cancelled) setError(cause instanceof ApiError && cause.status === 404
        ? 'Brewer not found' : cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [username]);

  useEffect(() => {
    if (activity && activityContainer.current) renderActivityGrid(activityContainer.current, activity);
  }, [activity]);

  return <div className="brewer-page">
    <div className="section-heading"><div><div className="eyebrow">Brewer</div><h1>{brewer?.username || (error === 'Brewer not found' ? error : username)}</h1></div></div>
    {error && <Alert type={error === 'Brewer not found' ? 'info' : 'warning'} message={error} showIcon />}
    {brewer && <><Card className="account-card"><div className="profile-row">
      <Avatar size={88} src={brewer.has_avatar ? `/api/brewer/${encodeURIComponent(brewer.username)}/avatar` : undefined}>
        {brewer.username[0].toUpperCase()}</Avatar>
      <div><strong>{brewer.username}</strong>{brewer.hidden && <div className="muted">This profile is hidden from visitors.</div>}</div>
    </div></Card>
      <Card className="account-card"><div ref={activityContainer}>
        {!activity && !error && <Spin description="Loading activity" />}
      </div></Card></>}
  </div>;
}
