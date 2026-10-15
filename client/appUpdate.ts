let updateCheck: Promise<boolean> | undefined;

/** Ask the installed service worker for a new app build. The updated worker takes
 * control before we reload, so the next page can run its local migrations. */
export function checkForAppUpdate(): Promise<boolean> {
  if (updateCheck) return updateCheck;
  updateCheck = (async () => {
    if (!('serviceWorker' in navigator)) return false;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return false;
    return new Promise<boolean>(resolve => {
      let finished = false;
      const finish = (updated: boolean) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('controllerchange', changed);
        resolve(updated);
      };
      const changed = () => {
        finish(true);
        window.location.reload();
      };
      navigator.serviceWorker.addEventListener('controllerchange', changed);
      const timeout = window.setTimeout(() => finish(false), 15_000);
      void registration.update().then(() => {
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
      }).catch(() => finish(false));
    });
  })().catch(() => false).finally(() => { updateCheck = undefined; });
  return updateCheck;
}

/** Replace cached app files with the current deployment without touching local databases. */
export async function forceAppRefresh(): Promise<void> {
  let response: Response;
  try { response = await fetch(`/api/healthz?refresh=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' }); }
  catch { throw new Error('Connect to the server before refreshing the app.'); }
  if (!response.ok) throw new Error('The server is unavailable. Try again when it responds.');

  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.filter(registration => registration.scope === `${location.origin}/`
      && [registration.active, registration.waiting, registration.installing].some(worker =>
        worker && new URL(worker.scriptURL).pathname === '/sw.js')).map(registration => registration.unregister()));
  }
  if ('caches' in window) {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('workbox-precache') || name === 'brewlog-app-assets-v1')
      .map(name => caches.delete(name)));
  }
  const destination = new URL(location.href);
  destination.searchParams.set('app-refresh', String(Date.now()));
  location.replace(destination.href);
}
