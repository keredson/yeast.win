import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  headless: true, args: ['--no-sandbox']
});
const baseUrl = process.env.BREWLOG_TEST_URL || 'http://127.0.0.1:5173';
const username = process.env.BREWLOG_TEST_USERNAME || `smoke-${Date.now()}`;
const password = process.env.BREWLOG_TEST_PASSWORD || 'smoke123';
const errors = [];

async function signIn(page, createAccount = false) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl);
  if (createAccount) {
    await page.getByRole('button', { name: 'Create account' }).click();
    const shortPasswordStatus = await page.evaluate(async name => (await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'short12' })
    })).status, username);
    if (shortPasswordStatus !== 400) throw new Error(`Seven-character password was accepted: ${shortPasswordStatus}`);
    await page.setViewportSize({ width: 320, height: 720 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
      throw new Error('Signup page has horizontal overflow on a narrow phone');
    }
    await page.screenshot({ path: '/tmp/brewlog-signup-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  if (createAccount) await page.getByLabel('Confirm password').fill(password);
  await page.locator('.login-card form button[type="submit"]').click();
  await page.getByRole('heading', { name: 'Batches' }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'New', exact: true }).waitFor();
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await signIn(page, true);
  console.log('Registered account and opened local SQLite');

  if (await page.locator('.app-header').getByRole('button', { name: 'Sync now' }).count()) {
    throw new Error('Sync button is still in the header');
  }

  await page.getByRole('combobox', { name: 'Brewery' }).click();
  await page.getByText('＋ New brewery').click();
  await page.getByRole('dialog', { name: 'New brewery' }).waitFor();
  const secondBrewery = `Smoke brewery ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Brewery name' }).fill(secondBrewery);
  await page.getByRole('dialog', { name: 'New brewery' }).getByRole('button', { name: 'Create' }).click();
  await page.locator('.workspace-select').getByText(secondBrewery).waitFor();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Batch name').fill('Second brewery batch');
  await page.getByRole('button', { name: 'Create batch' }).click();
  await page.getByRole('heading', { name: 'Second brewery batch' }).waitFor();
  const secondBreweryBatchUrl = page.url();
  if (!new URL(secondBreweryBatchUrl).searchParams.get('brewery')) throw new Error('Batch link is missing its brewery');
  await page.reload();
  await page.getByRole('heading', { name: 'Second brewery batch' }).waitFor();
  await page.getByRole('combobox', { name: 'Brewery' }).click();
  await page.getByText('Homebrew', { exact: true }).last().click();
  await page.locator('.workspace-select').getByText('Homebrew').waitFor();
  await page.getByRole('button', { name: 'New', exact: true }).waitFor();
  console.log('Created and switched breweries from the header switcher');

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Batch name').fill(`Smoke batch ${Date.now()}`);
  const batchName = await page.getByLabel('Batch name').inputValue();
  await page.getByRole('button', { name: 'Create batch' }).click();
  await page.getByRole('heading', { name: batchName }).waitFor();
  if (!/^\/batch\/[A-Za-z0-9_-]{10,32}$/.test(new URL(page.url()).pathname)) throw new Error('Batch detail URL was not set');
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
      if (width <= 720) {
        await page.getByRole('button', { name: 'Open navigation' }).click();
        await page.locator('.ant-drawer').last().locator('.ant-menu-item').filter({ hasText: section }).click();
      } else {
        await page.locator('.app-nav .ant-menu-item').filter({ hasText: section }).click();
      }
      await page.getByRole('heading', { name: section, exact: true }).waitFor();
      if (section === 'Batches') await page.locator('.choice-list .list-choice').filter({ hasText: batchName }).click();
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

  if (!await page.locator('.app-nav').evaluate(element => element.classList.contains('ant-layout-sider'))) {
    throw new Error('Desktop navigation is not an Ant Design Sider');
  }
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('dialog', { name: 'New equipment' }).getByLabel('Name').fill('Smoke pH meter');
  await page.getByRole('dialog', { name: 'New equipment' }).getByRole('combobox', { name: 'Kind' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'pH meter' }).click();
  await page.getByRole('button', { name: 'Create equipment' }).click();
  await page.getByRole('heading', { name: 'Smoke pH meter' }).waitFor();
  if (!/^\/equipment\/[A-Za-z0-9_-]{10,32}$/.test(new URL(page.url()).pathname)) throw new Error('Equipment detail URL was not set');
  await page.getByRole('button', { name: 'Delete equipment' }).click();
  await page.getByRole('dialog', { name: 'Delete equipment?' }).getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL('**/equipment');
  await page.getByText('No equipment yet').waitFor();
  console.log('Created and deleted equipment with a defined kind');

  await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Recipes' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Smoke recipe');
  await page.getByRole('button', { name: 'Create recipe' }).click();
  await page.waitForURL(url => /^\/recipe\/[A-Za-z0-9_-]{10,32}$/.test(url.pathname));
  await page.goBack();
  await page.waitForURL('**/recipes');
  await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Inventory' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Item', { exact: true }).fill('Smoke grain');
  await page.getByRole('dialog', { name: 'New inventory item' }).getByRole('combobox', { name: 'Category' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Grain' }).click();
  await page.getByRole('button', { name: 'Create item' }).click();
  await page.waitForURL(url => /^\/inventory\/[A-Za-z0-9_-]{10,32}$/.test(url.pathname));
  console.log('Navigated recipe and inventory detail URLs');

  await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Batches' }).click();
  await page.locator('.choice-list .list-choice').filter({ hasText: batchName }).click();

  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9V+c0AAAAASUVORK5CYII=', 'base64');
  const beforePhotoSync = await page.evaluate(() => {
    const id = JSON.parse(localStorage.getItem('brewlog:last-session')).workspaces[0].id;
    return localStorage.getItem(`brewlog:last-sync:${id}`);
  });
  await page.locator('.photo-section input[type="file"]').setInputFiles({ name: 'brew.png', mimeType: 'image/png', buffer: imageBytes });
  await page.locator('.photo-grid img').waitFor();
  await page.waitForFunction(previous => {
    const id = JSON.parse(localStorage.getItem('brewlog:last-session')).workspaces[0].id;
    return Number(localStorage.getItem(`brewlog:last-sync:${id}`)) > Number(previous);
  }, beforePhotoSync);

  const other = await browser.newContext();
  const second = await other.newPage();
  await signIn(second);
  await second.goto(secondBreweryBatchUrl);
  await second.getByRole('heading', { name: 'Second brewery batch' }).waitFor({ timeout: 30_000 });
  await second.getByRole('combobox', { name: 'Brewery' }).click();
  await second.getByText('Homebrew', { exact: true }).last().click();
  await second.locator('.workspace-select').getByText('Homebrew').waitFor();
  await second.locator('.choice-list .list-choice').filter({ hasText: batchName }).click();
  await second.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
  await second.locator('.photo-grid img').waitFor();
  const syncedPhoto = await second.locator('.photo-grid img').evaluate(async img =>
    Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())));
  if (Buffer.compare(Buffer.from(syncedPhoto), imageBytes) !== 0) throw new Error('Photo BLOB did not survive browser sync');
  console.log('Synced batch to second device');

  const firstWorkspaceId = await page.evaluate(async () => (await (await fetch('/api/me')).json()).workspaces[0].id);
  const thirdContext = await browser.newContext();
  const third = await thirdContext.newPage();
  third.on('pageerror', error => errors.push(error.message));
  await third.goto(baseUrl);
  await third.getByRole('button', { name: 'Create account' }).click();
  await third.getByLabel('Username').fill(username.toUpperCase());
  await third.getByLabel('Password', { exact: true }).fill(password);
  await third.getByLabel('Confirm password').fill(password);
  await third.getByRole('button', { name: 'Create my account' }).click();
  await third.getByText('Username is already taken').waitFor();
  await third.getByLabel('Username').fill(`${username}b`);
  await third.getByRole('button', { name: 'Create my account' }).click();
  await third.getByRole('heading', { name: 'Batches' }).waitFor({ timeout: 30_000 });
  const forbiddenStatus = await third.evaluate(async id => (await fetch(`/api/workspaces/${id}/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverCursor: '0', localCursor: '0', changes: [] })
  })).status, firstWorkspaceId);
  if (forbiddenStatus !== 404) throw new Error(`Second account accessed first account's workspace: ${forbiddenStatus}`);
  console.log('Rejected duplicate username and isolated accounts');

  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.waitForURL('**/me');
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.setViewportSize({ width: 320, height: 720 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
    throw new Error('Settings page has horizontal overflow on a narrow phone');
  }
  await page.screenshot({ path: '/tmp/brewlog-account-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  if (await page.getByText('Current brewery', { exact: true }).count()) throw new Error('Current brewery is still shown on /me');
  const syncButton = page.getByRole('button', { name: 'Sync now' });
  await syncButton.hover();
  await page.getByRole('tooltip').getByText(/Last synced \d+ sec ago · Click to sync/).waitFor();
  if (await syncButton.evaluate(button => getComputedStyle(button).borderTopWidth) !== '0px') {
    throw new Error('Sync button should be borderless');
  }
  const syncBeforeClick = await page.evaluate(() => {
    const id = JSON.parse(localStorage.getItem('brewlog:last-session')).workspaces[0].id;
    return localStorage.getItem(`brewlog:last-sync:${id}`);
  });
  await syncButton.click();
  await page.waitForFunction(previous => {
    const id = JSON.parse(localStorage.getItem('brewlog:last-session')).workspaces[0].id;
    return Number(localStorage.getItem(`brewlog:last-sync:${id}`)) > Number(previous);
  }, syncBeforeClick);
  console.log('Settings sync icon updated the last sync time');
  const avatarData = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d'); context.fillStyle = '#407a61'; context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Avatar image').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(avatarData, 'base64') });
  await page.locator('.app-header .ant-avatar img').waitFor();
  const avatarResponse = await page.evaluate(async () => {
    const response = await fetch('/api/me/avatar');
    return { status: response.status, type: response.headers.get('content-type'), size: (await response.arrayBuffer()).byteLength };
  });
  if (avatarResponse.status !== 200 || avatarResponse.type !== 'image/jpeg' || !avatarResponse.size) {
    throw new Error(`Avatar was not stored in the account DB: ${JSON.stringify(avatarResponse)}`);
  }
  if (await third.evaluate(async () => (await fetch('/api/me/avatar')).status) !== 404) {
    throw new Error('Another account could read the avatar');
  }
  console.log('Uploaded account avatar');

  await page.getByRole('combobox', { name: 'Preferred temperature unit' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '°F' }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/me')).json()).preferred_units.temperature === '°F');
  await page.reload();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.locator('.app-header .ant-avatar img').waitFor();
  const secondUnits = await second.evaluate(async () => (await (await fetch('/api/me')).json()).preferred_units.temperature);
  if (secondUnits !== '°F') throw new Error('Preferred units did not persist across devices');
  await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Batches' }).click();
  await page.locator('.choice-list .list-choice').filter({ hasText: batchName }).click();
  await page.getByRole('button', { name: 'Log event' }).click();
  await page.getByRole('dialog', { name: 'Log an event' }).getByRole('combobox', { name: 'Event type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Measurement' }).click();
  if (await page.getByRole('dialog', { name: 'Log an event' }).getByLabel('Unit').inputValue() !== '°F') {
    throw new Error('Preferred temperature unit was not used in the event form');
  }
  await page.getByRole('dialog', { name: 'Log an event' }).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  console.log('Saved preferred units and used them in an event form');

  const autoSyncSwitch = page.getByRole('switch', { name: 'Automatic sync' });
  await autoSyncSwitch.click();
  if (await page.evaluate(() => localStorage.getItem('brewlog:auto-sync')) !== '0') {
    throw new Error('Automatic sync setting did not persist');
  }
  await page.reload();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  if (await autoSyncSwitch.getAttribute('aria-checked') !== 'false') throw new Error('Automatic sync setting was not restored');
  await autoSyncSwitch.click();
  await page.getByRole('button', { name: 'Change password' }).click();
  const passwordDialog = page.getByRole('dialog', { name: 'Change password' });
  await passwordDialog.getByLabel('Current password').fill('wrong-password');
  await passwordDialog.getByLabel('New password', { exact: true }).fill(`${password}-new`);
  await passwordDialog.getByLabel('Confirm new password').fill(`${password}-new`);
  await passwordDialog.getByRole('button', { name: 'Change password' }).click();
  await page.getByText('Current password is incorrect').waitFor();
  await passwordDialog.getByLabel('Current password').fill(password);
  await passwordDialog.getByRole('button', { name: 'Change password' }).click();
  await page.getByText('Password changed. Other sessions have been signed out.').waitFor();
  if (await second.evaluate(async () => (await fetch('/api/me')).status) !== 401) {
    throw new Error('Password change did not revoke other sessions');
  }
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.locator('.login-card form button[type="submit"]').waitFor();
  const oldPasswordStatus = await page.evaluate(async credentials => (await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials)
  })).status, { username, password });
  if (oldPasswordStatus !== 401) throw new Error('Old password still works');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(`${password}-new`);
  await page.locator('.login-card form button[type="submit"]').click();
  await page.getByRole('heading', { name: 'Batches' }).waitFor();
  console.log('Changed password, revoked other sessions, and signed back in');

  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log('Browser smoke passed');
} finally {
  await browser.close();
}
