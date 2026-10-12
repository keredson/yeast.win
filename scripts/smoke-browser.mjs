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
  await page.getByRole('button', { name: 'New batch' }).waitFor();
}

async function navigateSection(page, section) {
  const mobile = await page.getByRole('button', { name: 'Open navigation' }).isVisible();
  if (mobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  const nav = mobile ? page.locator('.ant-drawer').last() : page.locator('.app-nav');
  await nav.locator('.ant-menu-item').filter({ hasText: section }).first().click();
  await page.getByRole('heading', { name: section, exact: true }).waitFor();
}

async function openBatch(page, name) {
  await page.locator('.record-link').filter({ hasText: name }).click();
  await page.getByRole('heading', { name }).waitFor();
}

async function choosePlanCategory(page, dialog, category) {
  await dialog.locator('.ant-form-item-label label').filter({ hasText: /^Type$/ }).waitFor();
  await dialog.getByLabel('Type', { exact: true }).click();
  await page.locator(`.ant-select-dropdown:visible .ant-select-item-option[title="${category}"]`).click();
}

async function choosePlanKind(page, buttonName, kind) {
  await page.getByRole('button', { name: buttonName }).click();
  await page.getByRole('menuitem', { name: kind, exact: true }).click();
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
  await page.getByRole('button', { name: 'New batch' }).click();
  await page.getByLabel('Batch name').fill('Second brewery batch');
  await page.getByRole('button', { name: 'Create batch' }).click();
  await page.getByRole('heading', { name: 'Second brewery batch' }).waitFor();
  const secondBreweryBatchUrl = page.url();
  if (!/^\/brewery\/[a-z0-9-]+\/batch\/[A-Za-z0-9_-]{10,32}$/.test(new URL(secondBreweryBatchUrl).pathname)
    || new URL(secondBreweryBatchUrl).search) throw new Error('Second brewery batch should use a clean brewery slug URL');
  await page.reload();
  await page.getByRole('heading', { name: 'Second brewery batch' }).waitFor();
  await navigateSection(page, 'Equipment');
  if (!/^\/brewery\/[a-z0-9-]+\/equipment$/.test(new URL(page.url()).pathname)) {
    throw new Error('Second brewery equipment should use a slug URL');
  }
  await page.getByRole('combobox', { name: 'Brewery' }).click();
  await page.getByText('Homebrew', { exact: true }).last().click();
  await page.locator('.workspace-select').getByText('Homebrew').waitFor();
  if (new URL(page.url()).pathname !== '/batches') throw new Error('Homebrew should use the root batch URL');
  await page.goBack();
  await page.getByRole('heading', { name: 'Equipment', exact: true }).waitFor();
  await page.locator('.workspace-select').getByText(secondBrewery).waitFor();
  await page.goForward();
  await page.getByRole('heading', { name: 'Batches', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New batch' }).waitFor();
  console.log('Created and switched breweries from the header switcher');

  await page.getByRole('button', { name: 'New batch' }).click();
  await page.getByLabel('Batch name').fill(`Smoke batch ${Date.now()}`);
  const batchName = await page.getByLabel('Batch name').inputValue();
  await page.getByRole('button', { name: 'Create batch' }).click();
  await page.getByRole('heading', { name: batchName }).waitFor();
  if (!/^\/batch\/[A-Za-z0-9_-]{10,32}$/.test(new URL(page.url()).pathname) || new URL(page.url()).search) {
    throw new Error('Default brewery batch should use a clean root URL');
  }
  await page.locator('.app-nav .ant-menu-item').filter({ hasText: batchName }).waitFor();
  await navigateSection(page, 'Batches');
  await page.locator('.app-nav .ant-menu-item').filter({ hasText: batchName }).click();
  await page.getByRole('heading', { name: batchName }).waitFor();
  console.log('Created batch:', batchName);

  await choosePlanKind(page, 'Plan an action', 'Addition');
  const firstPlan = page.getByRole('dialog', { name: 'Add addition' });
  if (await firstPlan.getByRole('combobox', { name: 'Event type' }).count()) throw new Error('Addition modal contains event type selector');
  await choosePlanCategory(page, firstPlan, 'Nutrient');
  await firstPlan.getByLabel('What will be added?').fill('Add nutrient');
  await firstPlan.getByRole('button', { name: 'Add addition' }).click();
  await firstPlan.waitFor({ state: 'hidden' });
  await page.getByText('Add nutrient', { exact: true }).waitFor();
  await choosePlanKind(page, 'Plan an action', 'Addition');
  await choosePlanCategory(page, page.getByRole('dialog', { name: 'Add addition' }), 'Yeast');
  await page.getByLabel('What will be added?').fill('Add yeast');
  await page.getByRole('dialog', { name: 'Add addition' }).getByRole('button', { name: 'Add addition' }).click();
  await page.getByRole('dialog', { name: 'Add addition' }).waitFor({ state: 'hidden' });
  await page.getByText('Add yeast', { exact: true }).waitFor();
  if (await page.locator('.timeline-group').count() !== 1 || await page.locator('.timeline-group .plan-card').count() !== 2) {
    throw new Error(`Actions at batch start were not grouped together: groups=${await page.locator('.timeline-group').count()}, plans=${await page.locator('.timeline-group .plan-card').count()}, errors=${JSON.stringify(await page.locator('.ant-form-item-explain-error').allTextContents())}`);
  }
  await choosePlanKind(page, 'Plan an action', 'Measurement');
  const measurementPlan = page.getByRole('dialog', { name: 'Add measurement' });
  await measurementPlan.getByLabel('What will be measured?').fill('Check gravity');
  if (!await measurementPlan.getByRole('combobox', { name: 'Measurement' }).count()) throw new Error('Measurement planning fields did not appear');
  await measurementPlan.getByRole('combobox', { name: 'Timing' }).click();
  if (await page.locator('.ant-select-dropdown:visible').getByText('After another event', { exact: true }).count()) {
    throw new Error('Timing still uses an intermediate anchor option');
  }
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'After Add nutrient' }).click();
  await measurementPlan.getByRole('spinbutton', { name: 'Time offset' }).fill('10');
  await measurementPlan.getByRole('button', { name: 'Add measurement' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Check gravity' }).getByText('10 minutes after Add nutrient').waitFor();
  await choosePlanKind(page, 'Plan an action', 'Notes');
  const beforePlan = page.getByRole('dialog', { name: 'Add notes' });
  await beforePlan.getByLabel('Reminder').fill('Prepare gravity sample');
  await beforePlan.getByRole('combobox', { name: 'Timing' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Before Check gravity' }).click();
  await beforePlan.getByRole('spinbutton', { name: 'Time offset' }).fill('5');
  await beforePlan.getByRole('button', { name: 'Add notes' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Prepare gravity sample' }).getByText('5 minutes before Check gravity').waitFor();
  await page.getByRole('button', { name: 'Edit planned event Add nutrient' }).click();
  const editBatchPlan = page.getByRole('dialog', { name: 'Edit addition' });
  await editBatchPlan.getByLabel('What will be added?').fill('Add nutrient dose');
  await editBatchPlan.getByRole('button', { name: 'Save event' }).click();
  await page.getByText('Add nutrient dose', { exact: true }).waitFor();
  await page.locator('.plan-card').filter({ hasText: 'Add nutrient dose' }).getByRole('button', { name: 'Record Add nutrient dose' }).click();
  const plannedAction = page.getByRole('dialog', { name: 'Record: Add nutrient dose' });
  await plannedAction.getByRole('button', { name: 'Skip this event' }).waitFor();
  for (const field of ['Event type', 'Related plan', 'Inventory item', 'What was added?']) {
    if (await plannedAction.getByLabel(field).count()) throw new Error(`${field} should be hidden when recording a planned event`);
  }
  await plannedAction.getByRole('spinbutton', { name: 'Quantity' }).fill('1');
  await plannedAction.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Add nutrient dose' }).locator('.event-card').getByText('1 g Add nutrient dose').waitFor();
  await page.locator('.plan-card').filter({ hasText: 'Add nutrient dose' }).getByRole('button', { name: 'Edit Addition event' }).click();
  const editActual = page.getByRole('dialog', { name: 'Edit event' });
  await editActual.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
  await editActual.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Add nutrient dose' }).locator('.event-card').getByText('2 g Add nutrient dose').waitFor();
  await page.locator('.plan-card').filter({ hasText: 'Add yeast' }).getByRole('button', { name: 'Record Add yeast' }).click();
  await page.getByRole('dialog', { name: 'Record: Add yeast' }).getByRole('button', { name: 'Skip this event' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Add yeast' }).locator('.ant-tag').getByText('Skipped', { exact: true }).waitFor();
  console.log('Added planned event');

  await page.getByRole('button', { name: 'Record activity' }).click();
  const eventNote = `Brew day ${Date.now()}`;
  await page.getByRole('button', { name: 'Save event' }).click();
  await page.getByRole('dialog', { name: 'Record activity' }).locator('.ant-form-item-explain-error').waitFor();
  await page.getByLabel('Notes').fill(eventNote);
  await page.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.event-card').getByText(eventNote).waitFor();
  await page.getByRole('dialog', { name: 'Record activity' }).waitFor({ state: 'hidden' });
  console.log('Logged actual event');

  await page.reload();
  await page.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
  await page.locator('.event-card').getByText(eventNote).waitFor();
  await page.locator('.plan-card').filter({ hasText: 'Add nutrient dose' }).locator('.event-card').getByText('2 g Add nutrient dose').waitFor();
  await page.locator('.plan-card').filter({ hasText: 'Add yeast' }).locator('.ant-tag').getByText('Skipped', { exact: true }).waitFor();
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
      await navigateSection(page, section);
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        index: !!document.querySelector('.record-index'), detail: !!document.querySelector('.record-detail')
      }));
      if (layout.overflow) {
        const offenders = await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
          .filter(element => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed')
          .slice(0, 12).map(element => `${element.tagName}.${element.className} ${Math.round(element.getBoundingClientRect().right)}`));
        throw new Error(`${name} ${section} has horizontal page overflow: ${offenders.join(', ')}`);
      }
      if (!layout.index || layout.detail) throw new Error(`${section} should be an index page`);
      if (section === 'Batches') {
        await openBatch(page, batchName);
        if (await page.locator('.batch-timeline').count() !== 1) throw new Error('Batch detail should have one timeline');
        if (await page.getByRole('button', { name: 'All batches' }).count()) throw new Error('Batch detail has a duplicate back button');
        if (width > 720 && !await page.locator('.app-nav .ant-menu-item').filter({ hasText: batchName }).isVisible()) {
          throw new Error('Recent batch link is hidden in the desktop navigation');
        }
        if (width > 720 && await page.locator('.app-nav').getByText('Recent', { exact: true }).count()) {
          throw new Error('Navigation still shows a Recent heading');
        }
        if (width > 720 && !await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Batches' }).first().count()) {
          throw new Error('Batches navigation link is missing');
        }
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
  await page.getByRole('button', { name: 'New equipment' }).click();
  const equipmentType = page.getByRole('dialog', { name: 'New equipment' }).getByRole('combobox', { name: 'Type' });
  await equipmentType.fill('pH meter');
  await equipmentType.press('Enter');
  if (await page.getByRole('dialog', { name: 'New equipment' }).getByLabel('Capacity (optional)').count()) {
    throw new Error('Measurement equipment was offered vessel capacity');
  }
  const phName = page.getByRole('dialog', { name: 'New equipment' }).getByRole('combobox', { name: 'Name' });
  await phName.fill('pH meter');
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'pH meter' }).last().click();
  await phName.fill('Smoke pH meter');
  await page.getByRole('dialog', { name: 'New equipment' }).getByRole('spinbutton', { name: 'Range minimum' }).fill('0');
  await page.getByRole('dialog', { name: 'New equipment' }).getByRole('spinbutton', { name: 'Range maximum' }).fill('14');
  await page.getByRole('button', { name: 'Create equipment' }).click();
  await page.getByRole('heading', { name: 'Smoke pH meter' }).waitFor();
  await page.getByText('Measurement range: 0–14 pH').waitFor();
  await page.getByRole('button', { name: 'Equipment settings' }).click();
  if (await page.getByRole('menuitem', { name: 'Set capacity' }).count()) throw new Error('pH meter still offers capacity settings');
  await page.getByRole('menuitem', { name: 'Set measurement range' }).click();
  await page.getByRole('dialog', { name: 'Set measurement range' }).getByRole('spinbutton', { name: 'Range maximum' }).fill('15');
  await page.getByRole('button', { name: 'Save range' }).click();
  await page.getByText('Measurement range: 0–15 pH').waitFor();
  if (!/^\/equipment\/[A-Za-z0-9_-]{10,32}$/.test(new URL(page.url()).pathname)) throw new Error('Equipment detail URL was not set');
  await page.getByRole('button', { name: 'Equipment settings' }).click();
  await page.getByRole('menuitem', { name: 'New calibration' }).click();
  await page.getByRole('spinbutton', { name: 'pH 4.00 buffer reading' }).fill('4.01');
  await page.getByRole('spinbutton', { name: 'pH 7.00 buffer reading' }).fill('7.02');
  await page.getByRole('button', { name: 'Save calibration' }).click();
  await page.getByText('Two-point pH').waitFor();
  await navigateSection(page, 'Equipment');
  await page.getByRole('button', { name: 'New equipment' }).click();
  await page.getByRole('dialog', { name: 'New equipment' }).getByRole('combobox', { name: 'Type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Refractometer' }).click();
  const refractometerName = page.getByRole('dialog', { name: 'New equipment' }).getByRole('combobox', { name: 'Name' });
  await refractometerName.fill('Refractometer');
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Refractometer' }).last().click();
  await refractometerName.fill('Smoke refractometer');
  await page.getByRole('dialog', { name: 'New equipment' }).getByRole('spinbutton', { name: 'Range minimum' }).fill('0');
  await page.getByRole('dialog', { name: 'New equipment' }).getByRole('spinbutton', { name: 'Range maximum' }).fill('32');
  await page.getByRole('button', { name: 'Create equipment' }).click();
  await page.getByRole('heading', { name: 'Smoke refractometer', exact: true }).waitFor();
  await page.getByText('Measurement range: 0–32 °Brix').waitFor();
  await navigateSection(page, 'Equipment');
  if (await page.locator('.group-table').count() !== 2) throw new Error('Equipment kinds should have separate tables');
  await page.setViewportSize({ width: 320, height: 720 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Grouped equipment tables overflow a narrow phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  await navigateSection(page, 'Batches');
  if (!await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Smoke pH meter' }).count()) {
    throw new Error('Recent equipment disappeared when navigating to batches');
  }
  await openBatch(page, batchName);
  await page.getByRole('button', { name: 'Record activity' }).click();
  const measurementDialog = page.getByRole('dialog', { name: 'Record activity' });
  await measurementDialog.getByRole('combobox', { name: 'Event type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Measurement' }).click();
  await measurementDialog.getByRole('combobox', { name: 'Measurement' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="pH"]').click();
  await measurementDialog.getByRole('spinbutton', { name: 'Corrected value' }).fill('5.2');
  await measurementDialog.getByRole('combobox', { name: 'Instrument' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Smoke pH meter' }).click();
  await measurementDialog.getByRole('button', { name: 'Save event' }).click();
  await page.getByText('ph 5.2 pH').waitFor();
  await navigateSection(page, 'Equipment');
  await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Smoke pH meter' }).click();
  await page.getByRole('heading', { name: 'Smoke pH meter' }).waitFor();
  await page.getByRole('button', { name: 'Equipment settings' }).click();
  await page.getByRole('menuitem', { name: 'Delete equipment' }).click();
  await page.getByRole('dialog', { name: 'Delete equipment?' }).getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL('**/equipment');
  await page.locator('.group-table a').filter({ hasText: 'Refractometer' }).click();
  await page.getByRole('button', { name: 'Equipment settings' }).click();
  await page.getByRole('menuitem', { name: 'Delete equipment' }).click();
  await page.getByRole('dialog', { name: 'Delete equipment?' }).getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL('**/equipment');
  await page.getByText('No equipment yet').waitFor();
  await navigateSection(page, 'Batches');
  await openBatch(page, batchName);
  await page.getByText('ph 5.2 pH').waitFor();
  console.log('Grouped equipment and hid used gear while preserving its measurement');

  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.getByRole('combobox', { name: 'Preferred mass unit' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="oz"]').click();
  await page.waitForFunction(async () => (await (await fetch('/api/me')).json()).preferred_units.mass === 'oz');
  await navigateSection(page, 'Recipes');
  await page.getByRole('button', { name: 'New recipe' }).click();
  await page.getByLabel('Recipe name').fill('Smoke recipe');
  await page.getByRole('dialog', { name: 'New recipe' }).getByRole('combobox', { name: 'Type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Beer' }).click();
  await page.getByRole('button', { name: 'Create recipe' }).click();
  await page.waitForURL(url => /^\/recipe\/[A-Za-z0-9_-]{10,32}$/.test(url.pathname));
  await page.getByRole('button', { name: 'Edit planned event Mash' }).waitFor();
  await page.getByRole('button', { name: 'Edit planned event Boil' }).waitFor();
  await page.getByRole('button', { name: 'Edit planned event Pitch yeast' }).waitFor();
  await page.getByRole('button', { name: 'Edit planned event Boil' }).click();
  const boilPlan = page.getByRole('dialog', { name: 'Edit Boil' });
  if (!await boilPlan.getByRole('spinbutton', { name: 'Duration (optional)' }).inputValue().then(value => Number(value) === 1)) {
    throw new Error('Seeded boil did not have a one-hour duration');
  }
  await boilPlan.locator('.ant-modal-close').click();
  await page.getByRole('button', { name: 'Add recipe event' }).click();
  await page.getByRole('menuitem', { name: 'Measurement' }).click();
  await page.getByRole('menuitem', { name: 'pH', exact: true }).click();
  const phPlan = page.getByRole('dialog', { name: 'Add ph measurement' });
  await phPlan.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
    throw new Error(`pH action did not open its modal: ${JSON.stringify(await page.locator('.ant-modal-title').allTextContents())}`);
  });
  if (await phPlan.getByRole('combobox', { name: 'Measurement' }).count()) throw new Error('pH modal has a redundant measurement type selector');
  await phPlan.locator('.ant-modal-close').click();
  if (await page.locator('.content-heading').getByRole('button', { name: 'Add planned event' }).count()) {
    throw new Error('Recipe still has a header add button');
  }
  await choosePlanKind(page, 'Add recipe event', 'Ingredient');
  const recipePlan = page.getByRole('dialog', { name: 'Add ingredient' });
  if (!await recipePlan.getByText('At or after start of Boil').count()) throw new Error('Ingredient did not default to boil start');
  await recipePlan.getByLabel('What will be added?').fill('2-row');
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '2-row pale malt' }).click();
  await recipePlan.getByRole('spinbutton', { name: 'Planned quantity' }).fill('5');
  if (!await recipePlan.getByRole('combobox', { name: 'Unit' }).locator('..').getByText('oz', { exact: true }).count()) {
    throw new Error('Shared grain suggestion replaced preferred ounces');
  }
  await recipePlan.getByRole('button', { name: 'Add addition' }).click();
  await recipePlan.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Edit planned event 2-row pale malt' }).waitFor();
  await page.getByText('5 oz', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit planned event 2-row pale malt' }).click();
  const editRecipePlan = page.getByRole('dialog', { name: 'Edit 2-row pale malt' });
  await editRecipePlan.getByLabel('What will be added?').fill('2-row pale malt extra');
  await editRecipePlan.getByRole('button', { name: 'Save event' }).click();
  await page.getByText('2-row pale malt extra').waitFor();
  await navigateSection(page, 'Batches');
  await page.getByRole('button', { name: 'New batch' }).click();
  await page.getByRole('dialog', { name: 'New batch' }).getByLabel('Batch name').fill('Batch from recipe');
  await page.getByRole('dialog', { name: 'New batch' }).getByRole('combobox', { name: 'Recipe (optional)' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Smoke recipe' }).click();
  await page.getByRole('button', { name: 'Create batch' }).click();
  await page.getByRole('heading', { name: 'Batch from recipe' }).waitFor();
  await page.locator('.plan-card').getByText('2-row pale malt extra').waitFor();
  await navigateSection(page, 'Recipes');
  await page.locator('.record-link').filter({ hasText: 'Smoke recipe' }).click();
  await choosePlanKind(page, 'Add recipe event', 'Notes');
  const recipeReminder = page.getByRole('dialog', { name: 'Add notes' });
  await recipeReminder.getByLabel('Reminder').fill('Check the mash');
  await recipeReminder.getByRole('combobox', { name: 'Timing' }).fill('2-row pale malt extra');
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '2-row pale malt extra' }).last().click();
  await recipeReminder.getByRole('button', { name: 'Add notes' }).click();
  await recipeReminder.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Delete planned event 2-row pale malt extra' }).click();
  await page.getByText('Also deletes Check the mash').waitFor();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Edit planned event Boil' }).waitFor();
  await navigateSection(page, 'Batches');
  await openBatch(page, 'Batch from recipe');
  await page.locator('.plan-card').getByText('2-row pale malt extra').waitFor();
  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.getByRole('combobox', { name: 'Preferred mass unit' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'lb + oz' }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/me')).json()).preferred_units.mass === 'lb + oz');
  await navigateSection(page, 'Inventory');
  await page.getByRole('button', { name: 'New inventory item' }).click();
  await page.getByRole('dialog', { name: 'New inventory item' }).getByRole('combobox', { name: 'Type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Grain' }).click();
  await page.getByRole('dialog', { name: 'New inventory item' }).getByRole('combobox', { name: 'Item' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Maris Otter malt' }).last().click();
  await page.getByRole('dialog', { name: 'New inventory item' }).getByRole('combobox', { name: 'Item' }).fill('Smoke grain');
  const newGrain = page.getByRole('dialog', { name: 'New inventory item' });
  if (!await newGrain.getByRole('combobox', { name: 'Unit' }).locator('..').getByText('lb + oz', { exact: true }).count()) {
    throw new Error('Preferred compound grain unit default was not set');
  }
  await newGrain.getByRole('combobox', { name: 'Unit' }).click();
  if (await page.locator('.ant-select-dropdown:visible').getByText('vial', { exact: true }).count()
    || await page.locator('.ant-select-dropdown:visible').getByText('bottle', { exact: true }).count()) {
    throw new Error('Grain offers packaging units');
  }
  await newGrain.getByRole('spinbutton', { name: 'Starting quantity on hand · pounds' }).fill('2');
  await newGrain.getByRole('spinbutton', { name: 'Ounces' }).fill('5');
  await page.getByRole('button', { name: 'Create item' }).click();
  await page.waitForURL(url => /^\/inventory\/[A-Za-z0-9_-]{10,32}$/.test(url.pathname));
  await page.getByText('2 lb 5 oz estimated on hand').waitFor();
  await page.reload();
  await page.getByText('2 lb 5 oz estimated on hand').waitFor();
  await navigateSection(page, 'Inventory');
  await page.getByRole('button', { name: 'New inventory item' }).click();
  await page.getByRole('dialog', { name: 'New inventory item' }).getByRole('combobox', { name: 'Type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Packaging' }).click();
  await page.getByRole('dialog', { name: 'New inventory item' }).getByRole('combobox', { name: 'Item' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '12 oz bottle' }).last().click();
  if (!await page.getByRole('dialog', { name: 'New inventory item' }).getByRole('combobox', { name: 'Unit' }).locator('..').getByText('each', { exact: true }).count()) throw new Error('Packaging unit default was not set');
  await page.getByRole('button', { name: 'Create item' }).click();
  await navigateSection(page, 'Inventory');
  if (await page.locator('.group-table').count() !== 2) throw new Error('Inventory categories should have separate tables');
  await page.setViewportSize({ width: 320, height: 720 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Grouped inventory tables overflow a narrow phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/**', route => route.abort());
  await page.goto(`${baseUrl}/inventory`);
  await page.getByRole('heading', { name: 'Inventory', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New inventory item' }).click();
  await page.getByRole('dialog', { name: 'New inventory item' }).getByRole('combobox', { name: 'Type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Grain' }).click();
  await page.getByRole('dialog', { name: 'New inventory item' }).getByRole('combobox', { name: 'Item' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Maris Otter malt' }).waitFor();
  await page.getByRole('dialog', { name: 'New inventory item' }).locator('.ant-modal-close').click();
  await page.getByRole('dialog', { name: 'New inventory item' }).waitFor({ state: 'hidden' });
  await page.unroute('**/api/**');
  console.log('Navigated recipe and inventory pages with grouped inventory tables');

  await navigateSection(page, 'Batches');
  await openBatch(page, batchName);

  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9V+c0AAAAASUVORK5CYII=', 'base64');
  const beforePhotoSync = await page.evaluate(() => {
    const id = JSON.parse(localStorage.getItem('brewlog:last-session')).workspaces[0].id;
    return localStorage.getItem(`brewlog:last-sync:${id}`);
  });
  await page.getByRole('button', { name: 'Record activity' }).click();
  const photoDialog = page.getByRole('dialog', { name: 'Record activity' });
  await photoDialog.getByRole('combobox', { name: 'Event type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Photo' }).click();
  await photoDialog.locator('input[type="file"]').setInputFiles({ name: 'brew.png', mimeType: 'image/png', buffer: imageBytes });
  await photoDialog.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.event-card .photo-grid img').waitFor();
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
  await openBatch(second, batchName);
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
  await page.mouse.move(0, 0);
  await page.locator('.ant-tooltip').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 320, height: 720 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
    const offenders = await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
      .filter(element => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed')
      .slice(0, 12).map(element => `${element.tagName}.${element.className} ${Math.round(element.getBoundingClientRect().right)}`));
    throw new Error(`Settings page has horizontal overflow on a narrow phone: ${offenders.join(', ')}`);
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
  await navigateSection(page, 'Batches');
  await openBatch(page, batchName);
  await page.getByRole('button', { name: 'Record activity' }).click();
  await page.getByRole('dialog', { name: 'Record activity' }).getByRole('combobox', { name: 'Event type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Measurement' }).click();
  if (!await page.getByRole('dialog', { name: 'Record activity' }).getByRole('combobox', { name: 'Unit' }).locator('..').getByText('°F', { exact: true }).count()) {
    throw new Error('Preferred temperature unit was not used in the event form');
  }
  await page.getByRole('dialog', { name: 'Record activity' }).getByRole('button', { name: 'Close' }).click();
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

  for (const type of ['Wine', 'Mead']) {
    await navigateSection(page, 'Recipes');
    await page.getByRole('button', { name: 'New recipe' }).click();
    const dialog = page.getByRole('dialog', { name: 'New recipe' });
    await dialog.getByLabel('Recipe name').fill(`${type} smoke recipe`);
    await dialog.getByRole('combobox', { name: 'Type' }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: type }).click();
    await dialog.getByRole('button', { name: 'Create recipe' }).click();
    await page.getByRole('button', { name: 'Edit planned event Pitch yeast' }).waitFor();
    if (await page.getByRole('button', { name: 'Edit planned event Boil' }).count()) throw new Error(`${type} recipe got a beer boil`);
  }

  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log('Browser smoke passed');
} finally {
  await browser.close();
}
