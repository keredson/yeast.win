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
  await page.getByLabel('Note').fill('Brew day started');
  await page.getByRole('button', { name: 'Save event' }).click();
  await page.getByText('Brew day started').waitFor();
  console.log('Logged actual event');

  await page.reload();
  await page.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
  await page.getByText('Brew day started').waitFor();
  console.log('Reloaded persisted local data');

  for (const [name, width, height] of [['mobile', 390, 844], ['tablet', 820, 1024], ['desktop', 1280, 900]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      sidebarColumns: getComputedStyle(document.querySelector('.section-grid')).gridTemplateColumns.split(' ').length,
      batchColumns: getComputedStyle(document.querySelector('.batch-columns')).gridTemplateColumns.split(' ').length,
      choiceDirection: getComputedStyle(document.querySelector('.choice-list')).flexDirection
    }));
    if (layout.overflow) throw new Error(`${name} has horizontal page overflow`);
    if (name === 'mobile' && layout.choiceDirection !== 'row') throw new Error('Mobile batch picker is not horizontal');
    if (name === 'desktop' && (layout.sidebarColumns !== 2 || layout.batchColumns !== 2)) {
      throw new Error('Desktop layout should have side-by-side lists and timeline columns');
    }
    if (name === 'tablet' && layout.sidebarColumns !== 2) throw new Error('Tablet should retain a sidebar');
    await page.screenshot({ path: `/tmp/brewlog-${name}.png`, fullPage: true });
    console.log(`${name} viewport: ${width}×${height}`);
  }

  const other = await browser.newContext();
  const second = await other.newPage();
  await signIn(second);
  await second.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
  console.log('Synced batch to second device');

  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log('Browser smoke passed');
} finally {
  await browser.close();
}
