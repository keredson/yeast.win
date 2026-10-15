import { chromium } from 'playwright-core';

const baseUrl = process.env.BREWLOG_TEST_URL || 'http://127.0.0.1:5173';
const username = `cbor-${Date.now()}`;
const password = 'cbor-smoke-pass';
const batchName = `CBOR sync ${Date.now()}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  headless: true, args: ['--no-sandbox']
});

async function signIn(page, create) {
  await page.goto(baseUrl);
  if (create) await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  if (create) await page.getByLabel('Confirm password').fill(password);
  await page.locator('.login-card form button[type="submit"]').click();
  await page.getByRole('heading', { name: 'Batches' }).waitFor({ timeout: 30_000 });
}

try {
  const firstContext = await browser.newContext();
  const first = await firstContext.newPage();
  const syncResponses = [];
  first.on('response', response => {
    if (response.url().includes('/sync/')) syncResponses.push([response.status(), response.headers()['content-type']]);
  });
  const catalogResponse = first.waitForResponse(response => response.url().includes('/api/catalog/sync'));
  await signIn(first, true);
  const catalog = await catalogResponse;
  if (catalog.status() !== 200 || !catalog.headers()['content-type']?.startsWith('application/cbor-seq')) {
    throw new Error(`Catalog did not use CBOR sync: ${catalog.status()}`);
  }
  await first.getByRole('button', { name: 'New batch' }).click();
  const dialog = first.getByRole('dialog', { name: 'New batch' });
  await dialog.getByLabel('Batch name').fill(batchName);
  await dialog.getByRole('button', { name: 'Create batch' }).click();
  await first.getByRole('heading', { name: batchName }).waitFor();
  await first.goto(`${baseUrl}/settings`);
  await first.getByRole('button', { name: 'Sync Homebrew' }).click();
  await first.waitForFunction(() => {
    const id = JSON.parse(localStorage.getItem('brewlog:last-session')).workspaces[0].id;
    return Number(localStorage.getItem(`brewlog:last-sync:${id}`)) > 0;
  });
  if (!syncResponses.some(([status, type]) => status === 200 && type?.startsWith('application/cbor-seq'))) {
    throw new Error('No successful CBOR sync response');
  }
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  await signIn(second, false);
  await second.locator('.record-link').filter({ hasText: batchName }).waitFor({ timeout: 30_000 });
  console.log('CBOR brewery sync reached a second browser profile');
} finally {
  await browser.close();
}
