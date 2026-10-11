import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  headless: true, args: ['--no-sandbox']
});
const baseUrl = process.env.BREWLOG_TEST_URL || 'http://127.0.0.1:5173';
const username = process.env.BREWLOG_TEST_USERNAME || 'smoke';
const password = process.env.BREWLOG_TEST_PASSWORD || 'smoke-test-password-123';
const errors = [];

async function signIn(page) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Batches' }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'New', exact: true }).waitFor();
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await signIn(page);
  console.log('Signed in and opened local SQLite');

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Batch name').fill(`Smoke batch ${Date.now()}`);
  const batchName = await page.getByLabel('Batch name').inputValue();
  await page.getByRole('button', { name: 'Create batch' }).click();
  await page.getByRole('heading', { name: batchName }).waitFor();
  console.log('Created batch:', batchName);

  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByLabel('What needs to happen?').fill('Add nutrient');
  await page.getByRole('button', { name: 'Add planned event' }).click();
  await page.getByText('Add nutrient', { exact: true }).waitFor();
  console.log('Added planned event');

  await page.getByRole('button', { name: 'Log event' }).click();
  const eventNote = `Brew day ${Date.now()}`;
  await page.getByLabel('Note').fill(eventNote);
  await page.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.event-card').getByText(eventNote).waitFor();
  await page.getByRole('dialog', { name: 'Log an event' }).waitFor({ state: 'hidden' });
  console.log('Logged actual event');

  await page.reload();
  await page.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
  await page.locator('.event-card').getByText(eventNote).waitFor();
  console.log('Reloaded persisted local data');

  await page.route('**/api/**', route => route.abort());
  await page.reload();
  await page.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
  await page.locator('.event-card').getByText(eventNote).waitFor();
  await page.unroute('**/api/**');
  console.log('Opened batch offline after reload');

  if (process.env.BREWLOG_TEST_PWA_OFFLINE === '1') {
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 30_000 });
    await context.setOffline(true);
    await page.reload();
    await page.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
    await page.locator('.event-card').getByText(eventNote).waitFor();
    await context.setOffline(false);
    console.log('Opened installed PWA without network');
  }

  for (const [name, width, height] of [['small-mobile', 320, 720], ['mobile', 390, 844], ['tablet', 820, 1024], ['desktop', 1280, 900]]) {
    await page.setViewportSize({ width, height });
    for (const section of ['Batches', 'Recipes', 'Inventory', 'Equipment']) {
      await page.getByRole('button', { name: section, exact: true }).click();
      await page.getByRole('heading', { name: section, exact: true }).waitFor();
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        sidebarColumns: getComputedStyle(document.querySelector('.section-grid')).gridTemplateColumns.split(' ').length,
        batchColumns: document.querySelector('.batch-columns')
          ? getComputedStyle(document.querySelector('.batch-columns')).gridTemplateColumns.split(' ').length : 0,
        choiceDirection: document.querySelector('.choice-list')
          ? getComputedStyle(document.querySelector('.choice-list')).flexDirection : ''
      }));
      if (layout.overflow) {
        const offenders = await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
          .filter(element => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed')
          .slice(0, 12).map(element => `${element.tagName}.${element.className} ${Math.round(element.getBoundingClientRect().right)}`));
        throw new Error(`${name} ${section} has horizontal page overflow: ${offenders.join(', ')}`);
      }
      if (section === 'Batches') {
        if (name.includes('mobile') && layout.choiceDirection !== 'row') throw new Error('Mobile batch picker is not horizontal');
        if (name === 'desktop' && (layout.sidebarColumns !== 2 || layout.batchColumns !== 2)) {
          throw new Error('Desktop layout should have side-by-side lists and timeline columns');
        }
        if (name === 'tablet' && layout.sidebarColumns !== 2) throw new Error('Tablet should retain a sidebar');
      }
      if (section === 'Batches' || name.includes('mobile')) {
        await page.screenshot({ path: `/tmp/brewlog-${name}-${section.toLowerCase()}.png`, fullPage: true });
      }
    }
    console.log(`${name} viewport: ${width}×${height}`);
  }

  await page.getByRole('button', { name: 'Batches', exact: true }).click();

  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9V+c0AAAAASUVORK5CYII=', 'base64');
  await page.locator('.photo-section input[type="file"]').setInputFiles({ name: 'brew.png', mimeType: 'image/png', buffer: imageBytes });
  await page.locator('.photo-grid img').waitFor();
  await page.locator('.sync-label').getByText('Synced', { exact: false }).waitFor();

  const other = await browser.newContext();
  const second = await other.newPage();
  await signIn(second);
  await second.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
  await second.locator('.photo-grid img').waitFor();
  const syncedPhoto = await second.locator('.photo-grid img').evaluate(async img =>
    Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())));
  if (Buffer.compare(Buffer.from(syncedPhoto), imageBytes) !== 0) throw new Error('Photo BLOB did not survive browser sync');
  console.log('Synced batch to second device');

  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log('Browser smoke passed');
} finally {
  await browser.close();
}
