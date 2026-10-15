import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.BREWLOG_TEST_URL || 'http://127.0.0.1:3127';
const dev = process.env.BREWLOG_TEST_DEV === '1';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  headless: true, args: ['--no-sandbox']
});

try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
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
  await page.getByRole('radio', { name: /Imperial/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Account menu' }).waitFor({ timeout: 30_000 });
  assert.deepEqual(await page.evaluate(async () => (await (await fetch('/api/me')).json()).preferred_units),
    { temperature: '°F', volume: 'US gal', mass: 'lb + oz', pressure: 'psi' });
  assert.equal(new URL(page.url()).pathname, '/batch/protected-example', 'sign-in did not return to the requested route');
  await page.goto(`${base}/me`);
  await page.waitForURL('**/settings');
  assert.equal(await page.locator('.app-header').count(), 0, 'the old header is still present');
  assert.equal(await page.locator('.app-nav').getByRole('combobox', { name: 'Brewery' }).isVisible(), true);
  assert.equal(await page.locator('.app-nav .nav-footer').getByRole('button', { name: 'Account menu' }).isVisible(), true);
  assert.equal(await page.locator('.account-page .ant-card').first().getByText('Profile').count(), 1);
  assert.equal(await page.locator('.account-page .ant-card').nth(1).getByText('Preferred units').count(), 1);
  assert.equal(await page.locator('.account-page .ant-card').last().getByText('Security').count(), 1);
  assert.equal(await page.getByText('Recipe calculations').count(), 0);
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  if (!dev) {
    assert.ok(appAssets.some(url => url.includes('/main-')), 'main app was not downloaded after sign-in');
    assert.ok(appAssets.some(url => url.includes('/crsqlite-')), 'SQLite WASM was not downloaded after sign-in');
  }

  if (!dev) {
    await context.setOffline(true);
    await page.reload();
    await page.getByRole('button', { name: 'Account menu' }).waitFor({ timeout: 30_000 });
  }
  const signInContext = await browser.newContext();
  const signInPage = await signInContext.newPage();
  await signInPage.goto(`${base}/login`);
  await signInPage.getByLabel('Username').fill(username.toUpperCase());
  await signInPage.getByText('Account found. Enter your password.').waitFor();
  assert.equal(await signInPage.getByLabel('Confirm password').isVisible(), false);
  assert.equal(await signInPage.getByRole('radio', { name: /Imperial/ }).isVisible(), false);
  await signInPage.getByLabel('Password', { exact: true }).fill('smoke12345');
  await signInPage.getByRole('button', { name: 'Sign in' }).click();
  await signInPage.getByRole('button', { name: 'Account menu' }).waitFor({ timeout: 30_000 });
  await signInContext.close();
  await page.locator('.app-nav').getByRole('menuitem', { name: 'Home' }).click();
  await page.locator('.app-nav').getByRole('menuitem', { name: 'Settings' }).click();
  await page.waitForURL('**/settings');
  assert.equal(await page.getByRole('switch', { name: 'Automatic sync' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Download catalog images' }).count(), 0);
  assert.equal(await page.getByText('Changes stay on this device until they sync automatically.').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Delete Homebrew' }).count(), 0);
  await page.getByRole('button', { name: 'Edit Homebrew' }).click();
  const breweryEditor = page.getByRole('dialog', { name: 'Edit brewery' });
  await breweryEditor.getByRole('button', { name: 'Delete brewery' }).click();
  await page.getByRole('dialog', { name: 'Delete Homebrew?' }).getByRole('button', { name: 'Cancel' }).click();
  await breweryEditor.getByRole('button', { name: 'Close' }).click();
  if (dev) {
    await page.getByRole('button', { name: 'New brewery' }).click();
    const newBrewery = page.getByRole('dialog', { name: 'New brewery' });
    await newBrewery.getByRole('textbox', { name: 'Brewery name' }).fill('Smoke second brewery');
    await newBrewery.getByRole('spinbutton', { name: 'Default batch size (US gal)' }).fill('7.5');
    await newBrewery.getByRole('spinbutton', { name: 'Default mash efficiency (%)' }).fill('72.5');
    await newBrewery.getByRole('button', { name: 'Create brewery' }).click();
    await page.getByRole('button', { name: 'Edit Smoke second brewery' }).click();
    await page.waitForFunction(() => Number(document.querySelector('input[id="batch_size"]')?.value) === 7.5);
    assert.equal(Number(await breweryEditor.getByRole('spinbutton', { name: 'Default mash efficiency (%)' }).inputValue()), 72.5);
    await breweryEditor.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Edit Homebrew' }).click();
    await breweryEditor.getByRole('spinbutton', { name: 'Default batch size (US gal)' }).fill('6.25');
    await breweryEditor.getByRole('spinbutton', { name: 'Default mash efficiency (%)' }).fill('68');
    await breweryEditor.getByRole('button', { name: 'Save brewery' }).click();
    await page.getByRole('button', { name: 'Edit Homebrew' }).click();
    await page.waitForFunction(() => document.querySelector('input[id="batch_size"]')?.value === '6.25');
    assert.equal(Number(await breweryEditor.getByRole('spinbutton', { name: 'Default mash efficiency (%)' }).inputValue()), 68);
    await breweryEditor.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Sync Homebrew' }).click();
    const homebrewId = await page.evaluate(() => JSON.parse(localStorage.getItem('brewlog:last-session')).workspaces[0].id);
    await page.waitForFunction(id => Number(localStorage.getItem(`brewlog:last-sync:${id}`)) > 0, homebrewId);
    assert.equal(await page.locator('.app-nav .workspace-select').getByText('Smoke second brewery').isVisible(), true,
      'syncing Homebrew changed the selected brewery');
  }
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const mobileNavigation = page.getByRole('dialog', { name: 'Yeast.Win!' });
  assert.equal(await mobileNavigation.getByRole('combobox', { name: 'Brewery' }).isVisible(), true);
  assert.equal(await mobileNavigation.getByRole('button', { name: 'Account menu' }).isVisible(), true);
  await mobileNavigation.getByRole('button', { name: 'Close' }).click();
  await page.goto(`${base}/batches`);
  await page.getByRole('navigation', { name: 'Breadcrumb' }).waitFor();
  assert.equal(await page.evaluate(() => {
    const row = document.querySelector('.page-navigation');
    const menu = document.querySelector('.mobile-menu-button').getBoundingClientRect();
    const breadcrumb = document.querySelector('.app-breadcrumb');
    const crumbs = breadcrumb.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    return rowBounds.left === 0 && rowBounds.right === innerWidth
      && crumbs.left >= menu.right && Math.abs(crumbs.top - menu.top) < 20
      && getComputedStyle(row).backgroundColor === 'rgb(25, 59, 57)'
      && getComputedStyle(document.querySelector('.mobile-menu-button')).color === 'rgb(255, 255, 255)'
      && getComputedStyle(breadcrumb.querySelector('a')).color === 'rgb(255, 255, 255)';
  }), true, 'mobile navigation does not place light breadcrumbs beside the menu on dark green');
  await page.goto(`${base}/settings`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
    'brewery actions overflow the Settings page on a narrow phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  const raptSettingsButton = page.getByRole('button', { name: 'RAPT Pill settings' });
  await raptSettingsButton.click();
  const raptSettings = page.getByRole('dialog', { name: 'RAPT Pill' });
  const webhookUrl = raptSettings.getByRole('textbox', { name: 'RAPT webhook URL' });
  await webhookUrl.waitFor();
  await page.waitForFunction(() => !!document.querySelector('input[aria-label="RAPT webhook URL"]')?.value);
  const firstWebhookUrl = await webhookUrl.inputValue();
  assert.match(firstWebhookUrl, /\/api\/webhooks\/rapt\/[A-Za-z0-9_-]{43}$/);
  assert.equal(await raptSettings.getByRole('link', { name: /Open RAPT webhooks/ }).getAttribute('href'),
    'https://app.rapt.io/integration/webhooks/list');
  await raptSettings.getByRole('button', { name: 'Copy RAPT webhook URL' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), firstWebhookUrl);
  await raptSettings.getByRole('button', { name: 'Copy payload' }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /"device_id": "@device_id"/);
  await raptSettings.getByRole('button', { name: 'Close' }).click();
  await raptSettingsButton.click();
  assert.equal(await webhookUrl.inputValue(), firstWebhookUrl, 'reopening RAPT settings rotated the webhook URL');
  await raptSettings.getByRole('button', { name: 'Delete integration' }).click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await webhookUrl.inputValue(), firstWebhookUrl, 'canceling integration deletion changed the URL');
  await raptSettings.getByRole('button', { name: 'Delete integration' }).click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: 'Delete integration' }).click();
  await raptSettings.waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(async () => (await (await fetch('/api/me/rapt')).json()).webhook_path)), null);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.getByRole('link', { name: 'Sign in' }).waitFor();
  console.log(`Light public routes, protected redirect, and authenticated app load passed${dev ? ' in dev' : ' with offline reopen'}`);
} finally { await browser.close(); }
