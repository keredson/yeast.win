import './public.css';

const root = document.getElementById('root')!;
const signedOutKey = 'brewlog:signed-out';
const cachedSessionKey = 'brewlog:last-session';
type Asset = { url: string; size: number };

function destination(): string {
  const value = new URLSearchParams(location.search).get('next');
  return value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    && !value.startsWith('/login') ? value : '/';
}

function loginPath(): string {
  const next = location.pathname + location.search;
  return `/login?next=${encodeURIComponent(next)}`;
}

function brand(): string {
  return '<div class="public-brand"><img src="/icon.svg" alt="" width="42" height="42"><strong>Yeast.Win!</strong></div>';
}

function splash(): void {
  root.innerHTML = `<main class="public-page splash-page"><div class="public-shell splash-shell">
    <header class="splash-header">${brand()}<nav class="splash-nav" aria-label="Landing page">
      <a class="splash-github" href="https://github.com/keredson/yeast.win" target="_blank" rel="noreferrer"><span class="splash-github-wide">Fork on GitHub</span><span class="splash-github-narrow">GitHub</span> <span aria-hidden="true">↗</span></a>
      <a class="splash-signin" href="/login">Sign in <span aria-hidden="true">↗</span></a>
    </nav></header>
    <section class="splash-hero">
      <div class="splash-copy">
        <p class="public-eyebrow">A fermentation notebook · Free and open source</p>
        <h1>Make something.<br><em>See what happens.</em></h1>
        <p class="splash-intro">Start with a recipe, a rough idea, or whatever you throw together. Keep a record of what you tried, what happened, and what you might change next time.</p>
        <div class="public-actions"><a class="public-primary" href="/login?mode=signup">Start your notebook <span aria-hidden="true">→</span></a>
          <a class="public-secondary" href="/login">I have an account</a></div>
        <p class="splash-note"><span aria-hidden="true">●</span> Your batches stay available on this device, even offline.</p>
      </div>
      <div class="splash-art" role="img" aria-label="Illustration of notes from an experimental fermentation batch">
        <div class="splash-art-glow"></div>
        <div class="splash-art-bubble splash-art-bubble-one"></div><div class="splash-art-bubble splash-art-bubble-two"></div>
        <div class="preview-card">
          <div class="preview-card-header"><span class="preview-kicker">BATCH NOTES</span><span class="preview-status"><span></span> Experiment 07</span></div>
          <h2>Ginger cider?</h2><p class="preview-subtitle">Started with juice and an idea</p>
          <div class="preview-timeline">
            <div class="preview-event"><span class="preview-marker">+</span><div><strong>Apple juice + ginger</strong><small>What went in · 4 L</small></div><time>09:30</time></div>
            <div class="preview-event"><span class="preview-marker">↗</span><div><strong>Pitch yeast</strong><small>Used QA23 this time</small></div><time>10:15</time></div>
            <div class="preview-event"><span class="preview-marker">◦</span><div><strong>Measure gravity</strong><small>First reading · 1.052</small></div><time>10:30</time></div>
          </div>
          <div class="preview-card-footer"><span class="preview-footer-icon" aria-hidden="true">✎</span><span>Next time: try less ginger.</span></div>
        </div>
      </div>
    </section>
    <section class="splash-details" aria-labelledby="splash-details-title">
      <div class="splash-section-heading"><p class="public-eyebrow">Designed for experimentation</p>
        <h2 id="splash-details-title">Follow the idea wherever it goes.</h2>
        <p>Yeast.Win! is a place for the batch you actually made. Use a recipe when you want one, or start making something and write down what happens.</p></div>
      <div class="splash-features">
        <article><span class="splash-feature-number">01 / Begin</span><h3>Start anywhere</h3>
          <p>Bring a recipe, a loose idea, or a few ingredients. Start wherever the experiment starts.</p></article>
        <article><span class="splash-feature-number">02 / Explore</span><h3>Write down the changes</h3>
          <p>Record ingredients, readings, observations, and unexpected turns as they happen.</p></article>
        <article><span class="splash-feature-number">03 / Reflect</span><h3>Keep the thread</h3>
          <p>Look back at what you tried, how it turned out, and what you want to try next.</p></article>
      </div>
    </section>
    <section class="splash-offline"><div><p class="public-eyebrow">Keep making, even offline</p>
      <h2>Take the notebook with you.</h2><p>Open your batches without a connection. Changes sync when you reconnect and use the app again.</p></div>
      <a href="/login?mode=signup">Get started <span aria-hidden="true">→</span></a></section>
    <footer class="splash-footer"><span>Yeast.Win! · Free and open source</span><span class="splash-footer-links"><span>Made for curious fermenters.</span>
      <a href="https://github.com/keredson/yeast.win" target="_blank" rel="noreferrer">Fork on GitHub <span aria-hidden="true">↗</span></a></span></footer>
  </div></main>`;
}

function login(message = ''): void {
  const mode = new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'login';
  root.innerHTML = `<main class="public-page"><div class="public-shell">${brand()}
    <section class="public-card"><a class="public-back" href="/">← Home</a>
    <h1>${mode === 'signup' ? 'Create your account' : 'Sign in'}</h1>
    <div class="public-tabs"><a class="${mode === 'login' ? 'selected' : ''}" href="/login${location.search.includes('next=') ? `?next=${encodeURIComponent(destination())}` : ''}">Sign in</a>
    <a class="${mode === 'signup' ? 'selected' : ''}" href="/login?mode=signup&next=${encodeURIComponent(destination())}">Create account</a></div>
    <p class="public-error" role="alert" hidden></p>
    <form id="account-form"><label>Username<input name="username" autocomplete="username" maxlength="40" required></label>
    <label>Password<input name="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" maxlength="256" required></label>
    ${mode === 'signup' ? '<label>Confirm password<input name="confirm_password" type="password" autocomplete="new-password" maxlength="256" required></label>' : ''}
    <button class="public-primary" type="submit">${mode === 'signup' ? 'Create my account' : 'Sign in'}</button></form></section></div></main>`;
  const showError = (value: string) => {
    const error = root.querySelector<HTMLElement>('.public-error')!;
    error.textContent = value;
    error.hidden = !value;
  };
  showError(message);
  root.querySelector('form')!.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const username = String(data.get('username') || '').trim();
    const password = String(data.get('password') || '');
    if (mode === 'signup' && !/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(username)) {
      showError('Use 3–40 letters, numbers, _ or - for the username.'); return;
    }
    if (mode === 'signup' && password.length < 8) { showError('Use at least 8 characters for the password.'); return; }
    if (mode === 'signup' && password !== data.get('confirm_password')) { showError('Passwords do not match.'); return; }
    const button = form.querySelector('button')!;
    button.disabled = true;
    try {
      const response = await fetch(`/api/${mode === 'signup' ? 'register' : 'login'}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || `Sign in failed (${response.status})`);
      localStorage.removeItem(signedOutKey);
      history.replaceState(null, '', destination());
      await loadApp();
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : 'Could not sign in. Try again.');
      button.disabled = false;
    }
  });
}

function loader(): { update: (loaded: number, total: number) => void; stage: (message: string) => void } {
  root.innerHTML = `<main class="public-page"><div class="public-shell">${brand()}
    <section class="public-card public-loading" role="status" aria-live="polite"><h1>Opening Yeast.Win!</h1>
    <p class="public-stage">Preparing the app…</p><progress max="100"></progress>
    <p class="public-count"></p></section></div></main>`;
  const progress = root.querySelector('progress')!;
  const count = root.querySelector('.public-count')!;
  return {
    update(loaded, total) {
      progress.value = total ? Math.min(100, Math.round(loaded / total * 100)) : 0;
      count.textContent = total ? `${progress.value}% downloaded` : '';
    },
    stage(message) { root.querySelector('.public-stage')!.textContent = message; }
  };
}

async function prefetchAssets(update: (loaded: number, total: number) => void): Promise<void> {
  let response: Response;
  try { response = await fetch('/app-assets.json', { cache: 'no-cache' }); }
  catch { return; }
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) return;
  const { assets } = await response.json() as { assets: Asset[] };
  if (!Array.isArray(assets) || !assets.every(asset => asset.url.startsWith('/assets/') && Number.isSafeInteger(asset.size))) return;
  const total = assets.reduce((sum, asset) => sum + asset.size, 0);
  let loaded = 0;
  update(0, total);
  const cache = 'caches' in window ? await caches.open('brewlog-app-assets-v1') : null;
  await Promise.all(assets.map(async asset => {
    if (cache && await cache.match(asset.url)) { loaded += asset.size; update(loaded, total); return; }
    const file = await fetch(asset.url, { cache: 'force-cache' });
    if (!file.ok || !file.body) throw new Error(`Could not download ${asset.url}`);
    const copy = file.clone();
    const reader = file.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      loaded += value.byteLength;
      update(loaded, total);
    }
    if (cache) await cache.put(asset.url, copy);
    if (received !== asset.size) update(loaded, total);
  }));
}

async function loadApp(): Promise<void> {
  let display: ReturnType<typeof loader> | null = null;
  let stage = 'Downloading the app…';
  let progress: [number, number] = [0, 0];
  const setStage = (message: string) => { stage = message; display?.stage(message); };
  // A cached app can start before a loading card would be useful. Keep the
  // progress UI for cold loads and slower reloads without flashing it on each visit.
  const showLoader = window.setTimeout(() => {
    display = loader();
    display.stage(stage);
    display.update(...progress);
  }, 250);
  try {
    await prefetchAssets((loaded, total) => {
      progress = [loaded, total];
      display?.update(loaded, total);
    });
    setStage('Starting the app…');
    await import('./main.tsx');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    root.innerHTML = `<main class="public-page"><div class="public-shell">${brand()}
      <section class="public-card"><h1>Could not open Yeast.Win!</h1><p class="public-error"></p>
      <button class="public-primary" type="button">Try again</button></section></div></main>`;
    root.querySelector('.public-error')!.textContent = message;
    root.querySelector('button')!.addEventListener('click', () => void loadApp());
  } finally { window.clearTimeout(showLoader); }
}

async function start(): Promise<void> {
  if (localStorage.getItem(signedOutKey) !== '1') {
    try {
      const response = await fetch('/api/me', { credentials: 'same-origin' });
      if (response.ok) {
        if (location.pathname === '/login') history.replaceState(null, '', destination());
        await loadApp(); return;
      }
      if (response.status === 401) localStorage.removeItem(cachedSessionKey);
      else if (localStorage.getItem(cachedSessionKey)) { await loadApp(); return; }
    } catch {
      if (localStorage.getItem(cachedSessionKey)) { await loadApp(); return; }
    }
  }
  if (location.pathname === '/') splash();
  else {
    if (location.pathname !== '/login') history.replaceState(null, '', loginPath());
    login();
  }
}

void start();
