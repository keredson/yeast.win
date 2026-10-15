import './publicBrewer.css';
import { renderActivityGrid, type BrewerActivity } from './ActivityGrid.ts';

export async function showPublicBrewer(username: string): Promise<void> {
  const root = document.getElementById('root')!;
  root.innerHTML = `<main class="public-page"><div class="public-shell"><header class="splash-header">
    <a class="public-brand-link" href="/"><div class="public-brand"><img src="/icon.svg" alt="" width="42" height="42"><strong>Yeast.Win!</strong></div></a>
    <a class="public-brewer-login" href="/login?next=${encodeURIComponent(`/brewer/${username}`)}">Log in / Join <span aria-hidden="true">↗</span></a>
    </header><section class="public-brewer-card" aria-live="polite"><p>Loading brewer…</p></section></div></main>`;
  const card = root.querySelector<HTMLElement>('.public-brewer-card')!;
  try {
    const response = await fetch(`/api/brewer/${encodeURIComponent(username)}`, { cache: 'no-store' });
    if (response.status === 404) {
      card.innerHTML = '<h1>Brewer not found</h1><p>There is no brewer at this address.</p>';
      return;
    }
    if (!response.ok) throw new Error('Could not load this brewer.');
    const brewer = await response.json() as { username: string; has_avatar: boolean; hidden: boolean };
    card.innerHTML = '<div class="public-brewer-avatar"></div><div><p class="public-eyebrow">Brewer</p><h1></h1></div>';
    card.querySelector('h1')!.textContent = brewer.username;
    if (brewer.hidden) {
      const notice = document.createElement('p');
      notice.className = 'public-brewer-hidden';
      notice.textContent = 'This profile is hidden from visitors.';
      card.querySelector('div:last-child')!.append(notice);
    }
    const avatar = card.querySelector<HTMLElement>('.public-brewer-avatar')!;
    if (brewer.has_avatar) {
      const image = document.createElement('img');
      image.src = `/api/brewer/${encodeURIComponent(brewer.username)}/avatar`;
      image.alt = '';
      avatar.append(image);
    } else avatar.textContent = brewer.username[0].toUpperCase();
    const activityCard = document.createElement('section');
    activityCard.className = 'public-activity-card';
    card.after(activityCard);
    try {
      const activityResponse = await fetch(`/api/brewer/${encodeURIComponent(username)}/activity`, { cache: 'no-store' });
      if (!activityResponse.ok) throw new Error('Activity unavailable');
      renderActivityGrid(activityCard, await activityResponse.json() as BrewerActivity);
    } catch { activityCard.textContent = 'Activity is unavailable right now.'; }
  } catch {
    card.innerHTML = '<h1>Profile unavailable</h1><p>Could not load this brewer. Try again later.</p>';
  }
}
