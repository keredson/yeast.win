import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.BREWLOG_TEST_URL || 'http://127.0.0.1:3127';
const dev = process.env.BREWLOG_TEST_DEV === '1';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  headless: true, args: ['--no-sandbox']
});

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const appAssets = [];
  page.on('request', request => {
    if (/\/assets\/(main-|crsqlite-)/.test(request.url())) appAssets.push(request.url());
  });
  await page.goto(base);
  await page.getByRole('heading', { name: 'Make it again. Make it better.' }).waitFor();
  assert.equal(await page.title(), 'Yeast.Win!');
  if (!dev) {
    await page.evaluate(() => navigator.serviceWorker?.ready);
    assert.deepEqual(appAssets, [], 'signed-out splash fetched app assets');
    const worker = await page.evaluate(async () => (await fetch('/sw.js')).text());
    assert.doesNotMatch(worker, /url:"assets\/(main-|crsqlite-)/, 'service worker precaches the main app');
  }

  await page.goto(`${base}/batch/protected-example`);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/login');
  assert.equal(new URL(page.url()).searchParams.get('next'), '/batch/protected-example');
  if (!dev) assert.deepEqual(appAssets, [], 'protected-route login fetched app assets');

  await page.getByRole('link', { name: 'Create account' }).click();
  const username = `shell${Date.now()}`;
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill('smoke12345');
  await page.getByLabel('Confirm password').fill('smoke12345');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await page.getByRole('button', { name: 'Account settings' }).waitFor({ timeout: 30_000 });
  assert.equal(new URL(page.url()).pathname, '/batch/protected-example', 'sign-in did not return to the requested route');
  if (!dev) {
    assert.ok(appAssets.some(url => url.includes('/main-')), 'main app was not downloaded after sign-in');
    assert.ok(appAssets.some(url => url.includes('/crsqlite-')), 'SQLite WASM was not downloaded after sign-in');
  }

  if (!dev) {
    await context.setOffline(true);
    await page.reload();
    await page.getByRole('button', { name: 'Account settings' }).waitFor({ timeout: 30_000 });
  }
  console.log(`Light public routes, protected redirect, and authenticated app load passed${dev ? ' in dev' : ' with offline reopen'}`);
} finally { await browser.close(); }
