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
