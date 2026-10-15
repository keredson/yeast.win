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
  await page.getByRole('heading', { name: 'Make something. See what happens.' }).waitFor();
  assert.equal(await page.title(), 'Yeast.Win!');
  const githubLinks = page.getByRole('link', { name: /Fork on GitHub|GitHub/ });
  assert.equal(await githubLinks.count(), 2);
  for (const githubLink of await githubLinks.all()) {
    assert.equal(await githubLink.getAttribute('href'), 'https://github.com/keredson/yeast.win');
    assert.equal(await githubLink.getAttribute('target'), '_blank');
  }
  if (!dev) {
    await page.evaluate(() => navigator.serviceWorker?.ready);
    assert.deepEqual(appAssets, [], 'signed-out splash fetched app assets');
    const worker = await page.evaluate(async () => (await fetch('/sw.js')).text());
    assert.doesNotMatch(worker, /url:"assets\/(main-|crsqlite-)/, 'service worker precaches the main app');
  }

  await page.goto(`${base}/batch/protected-example`);
  await page.getByRole('heading', { name: 'Sign in or create an account' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/login');
  assert.equal(new URL(page.url()).searchParams.get('next'), '/batch/protected-example');
  if (!dev) assert.deepEqual(appAssets, [], 'protected-route login fetched app assets');

  const username = `shell${Date.now()}`;
  await page.getByLabel('Username').fill(username);
  await page.getByText('New username. Choose a password to create your account.').waitFor();
  await page.getByLabel('Password', { exact: true }).fill('smoke12345');
  await page.getByLabel('Confirm password').fill('smoke12345');
  await page.getByRole('button', { name: 'Create account' }).click();
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
  const signInContext = await browser.newContext();
  const signInPage = await signInContext.newPage();
  await signInPage.goto(`${base}/login`);
  await signInPage.getByLabel('Username').fill(username.toUpperCase());
  await signInPage.getByText('Account found. Enter your password.').waitFor();
  assert.equal(await signInPage.getByLabel('Confirm password').isVisible(), false);
  await signInPage.getByLabel('Password', { exact: true }).fill('smoke12345');
  await signInPage.getByRole('button', { name: 'Sign in' }).click();
  await signInPage.getByRole('button', { name: 'Account settings' }).waitFor({ timeout: 30_000 });
  await signInContext.close();
  console.log(`Light public routes, protected redirect, and authenticated app load passed${dev ? ' in dev' : ' with offline reopen'}`);
} finally { await browser.close(); }
