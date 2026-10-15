import { useEffect, useRef, useState } from 'react';
import { Alert, Spin } from 'antd';
import { api, ApiError } from './api.ts';
import { renderActivityGrid, type BrewerActivity } from './ActivityGrid.ts';
import './publicBrewer.css';

interface Brewer { username: string; full_name: string | null; has_avatar: boolean; hidden: boolean }

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
    {error && !brewer && <section className="public-brewer-card"><h1>{error === 'Brewer not found' ? error : 'Profile unavailable'}</h1>
      {error !== 'Brewer not found' && <p>{error}</p>}</section>}
    {!brewer && !error && <section className="public-brewer-card"><Spin description="Loading brewer" /></section>}
    {brewer && <><section className="public-brewer-card">
      <div className="public-brewer-avatar">{brewer.has_avatar
        ? <img src={`/api/brewer/${encodeURIComponent(brewer.username)}/avatar`} alt="" />
        : brewer.username[0].toUpperCase()}</div>
      <div><p className="public-eyebrow">Brewer</p><h1>{brewer.full_name || brewer.username}</h1>
        {brewer.full_name && <p className="public-brewer-handle">@{brewer.username}</p>}
        {brewer.hidden && <p className="public-brewer-hidden">This profile is hidden from visitors.</p>}
      </div>
    </section>
      <section className="public-activity-card" ref={activityContainer}>
        {!activity && !error && <Spin description="Loading activity" />}
        {error && <Alert type="warning" message={error} showIcon />}
      </section></>}
  </div>;
}
