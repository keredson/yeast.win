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
  await page.getByRole('menuitem', { name: kind, exact: kind !== 'Measurement' }).click();
  if (kind === 'Measurement') await page.getByRole('menuitem', { name: 'Temperature', exact: true }).click();
}

async function chooseEquipmentType(page, buttonName, group, kind) {
  await page.getByRole('button', { name: buttonName }).click();
  await page.getByRole('menuitem', { name: group }).click();
  await page.getByRole('menuitem', { name: kind, exact: true }).click();
}

async function localBreweryBlocks(page, id) {
  return page.evaluate(async breweryId => {
    const request = indexedDB.open('idb-batch-atomic');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        let count = 0;
        const tx = db.transaction('blocks', 'readonly');
        const cursor = tx.objectStore('blocks').openKeyCursor(IDBKeyRange.bound([`/brewlog-${breweryId}`], [`/brewlog-${breweryId}`, []]));
        cursor.onsuccess = () => { if (cursor.result) { count++; cursor.result.continue(); } };
        tx.oncomplete = () => resolve(count);
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, id);
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
  if (await page.getByText('＋ New brewery').count()) throw new Error('Brewery creation is still in the switcher');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('button', { name: 'New brewery' }).click();
  await page.getByRole('dialog', { name: 'New brewery' }).waitFor();
  const secondBrewery = `Smoke brewery ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Brewery name' }).fill(secondBrewery);
  await page.getByRole('dialog', { name: 'New brewery' }).getByRole('button', { name: 'Create brewery' }).click();
  await page.locator('.workspace-select').getByText(secondBrewery).waitFor();
  await page.getByRole('button', { name: `Edit ${secondBrewery}` }).click();
  const slug = `smoke-custom-${Date.now()}`;
  await page.getByRole('dialog', { name: 'Edit brewery' }).getByRole('textbox', { name: 'Brewery slug' }).fill(slug);
  await page.getByRole('dialog', { name: 'Edit brewery' }).getByRole('button', { name: 'Save brewery' }).click();
  await page.getByText(`/brewery/${slug}`, { exact: true }).waitFor();
  await navigateSection(page, 'Batches');
  await page.getByRole('button', { name: 'New batch' }).click();
  await page.getByLabel('Batch name').fill('Second brewery batch');
  await page.getByRole('button', { name: 'Create batch' }).click();
  await page.getByRole('heading', { name: 'Second brewery batch' }).waitFor();
  const secondBreweryBatchUrl = page.url();
  if (!new URL(secondBreweryBatchUrl).pathname.startsWith(`/brewery/${slug}/batch/`)
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
  console.log('Created a brewery in Settings and switched from the header');

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
  await page.getByRole('button', { name: 'Add action' }).waitFor();
  if (await page.locator('.timeline-group').count() || await page.getByText('Batch start', { exact: true }).count()) {
    throw new Error('An empty batch should not show a Batch start group');
  }

  await choosePlanKind(page, 'Add action', 'Ingredient');
  const firstAction = page.getByRole('dialog', { name: 'Add addition' });
  await choosePlanCategory(page, firstAction, 'Nutrient');
  await firstAction.getByLabel('What will be added?').fill('Add nutrient');
  await firstAction.getByRole('spinbutton', { name: 'Quantity' }).fill('1');
  await firstAction.getByRole('button', { name: 'Add addition' }).click();
  await firstAction.waitFor({ state: 'hidden' });
  await choosePlanKind(page, 'Add action', 'Ingredient');
  const yeastAction = page.getByRole('dialog', { name: 'Add addition' });
  await choosePlanCategory(page, yeastAction, 'Yeast');
  await yeastAction.getByLabel('What will be added?').fill('Add yeast');
  await yeastAction.getByRole('button', { name: 'Add addition' }).click();
  await yeastAction.waitFor({ state: 'hidden' });
  if (await page.locator('.timeline-group').count() !== 1 || await page.locator('.timeline-group .plan-card').count() !== 2) {
    throw new Error('Actions at batch start were not grouped together');
  }
  if (await page.locator('.timeline-group-heading').getByText('Batch start').count()) {
    throw new Error('Batch start heading should not appear above actions');
  }
  if (await page.locator('.timeline-group .plan-meta').count()) {
    throw new Error('Batch start actions repeat their group timing in each row');
  }
  await choosePlanKind(page, 'Add action', 'Measurement');
  const measurementAction = page.getByRole('dialog', { name: 'Add measurement' });
  await measurementAction.getByLabel('What will be measured?').fill('Check gravity');
  await measurementAction.getByRole('combobox', { name: 'Timing' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'After Add nutrient' }).click();
  await measurementAction.getByRole('spinbutton', { name: 'Time offset' }).fill('10');
  await measurementAction.getByRole('button', { name: 'Add measurement' }).click();
  await page.locator('.timeline-group').filter({ hasText: 'Check gravity' }).locator('xpath=preceding-sibling::*[1]')
    .getByText('10 minutes', { exact: true }).waitFor();
  if (!await page.locator('.plan-card').filter({ hasText: 'Add nutrient' }).first()
    .locator('.title-edit-row').getByRole('button', { name: 'Edit Add nutrient' }).count()) {
    throw new Error('Batch edit button moved away from the event title');
  }
  await page.getByRole('button', { name: 'Edit Add nutrient' }).click();
  const editAction = page.getByRole('dialog', { name: 'Edit addition' });
  await editAction.getByLabel('What will be added?').fill('Add nutrient dose');
  await editAction.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Add nutrient dose' }).getByRole('button', { name: 'Record Add nutrient dose' }).click();
  const recordAction = page.getByRole('dialog', { name: 'Record: Add nutrient dose' });
  await recordAction.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
  await recordAction.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Add nutrient dose' }).getByText('2 g Add nutrient dose').waitFor();
  await page.locator('.plan-card').filter({ hasText: 'Add nutrient dose' }).getByRole('button', { name: 'Edit Add nutrient dose' }).click();
  const editRecorded = page.getByRole('dialog', { name: 'Edit: Add nutrient dose' });
  await editRecorded.getByRole('spinbutton', { name: 'Quantity' }).fill('3');
  await editRecorded.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Add nutrient dose' }).getByText('3 g Add nutrient dose').waitFor();
  await page.locator('.plan-card').filter({ hasText: 'Add yeast' }).getByRole('button', { name: 'Record Add yeast' }).click();
  await page.getByRole('dialog', { name: 'Record: Add yeast' }).getByRole('button', { name: 'Skip this event' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Add yeast' }).getByText('Skipped', { exact: true }).waitFor();
  await page.locator('.plan-card').filter({ hasText: 'Add yeast' }).getByRole('button', { name: 'Record Add yeast' }).click();
  const doneAfterSkip = page.getByRole('dialog', { name: 'Record: Add yeast' });
  await doneAfterSkip.getByRole('spinbutton', { name: 'Quantity' }).fill('1');
  await doneAfterSkip.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Add yeast' }).getByText('Done', { exact: true }).waitFor();
  const eventNote = `Brew day ${Date.now()}`;
  await choosePlanKind(page, 'Add action', 'Notes');
  const noteAction = page.getByRole('dialog', { name: 'Add notes' });
  await noteAction.getByLabel('Reminder').fill('Brew day note');
  await noteAction.getByRole('checkbox', { name: 'Record this now' }).check();
  await noteAction.getByRole('button', { name: 'Add notes' }).click();
  const noteRecord = page.getByRole('dialog', { name: 'Record: Brew day note' });
  await noteRecord.getByLabel('Notes').fill(eventNote);
  await noteRecord.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.plan-card').getByText(eventNote).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
  await page.locator('.plan-card').getByText(eventNote).waitFor();
  await page.locator('.plan-card').filter({ hasText: 'Add nutrient dose' }).getByText('3 g Add nutrient dose').waitFor();
  await page.route('**/api/**', route => route.abort());
  await page.reload();
  await page.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
  await page.locator('.plan-card').getByText(eventNote).waitFor();
  await page.unroute('**/api/**');
  if (process.env.BREWLOG_TEST_PWA_OFFLINE === '1') {
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 30_000 });
    await context.setOffline(true);
    await page.reload();
    await page.getByRole('heading', { name: batchName }).waitFor({ timeout: 30_000 });
    await page.locator('.plan-card').getByText(eventNote).waitFor();
    await context.setOffline(false);
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
  await page.getByRole('button', { name: 'Add from catalog' }).click();
  const catalogDialog = page.getByRole('dialog', { name: 'Add from catalog' });
  await catalogDialog.getByRole('searchbox', { name: 'Search equipment models' }).fill('VEVOR');
  await catalogDialog.getByRole('button', { name: /VEVOR Electric Brewing System/ }).click();
  const catalogEquipmentDialog = page.getByRole('dialog', { name: 'Add all-in-one brewing system' });
  if (await catalogEquipmentDialog.getByRole('textbox', { name: 'Name' }).inputValue()
    !== 'VEVOR Electric Brewing System 9.2 Gal/35 L Brewing Pot') throw new Error('Catalog model name was not copied');
  if (await catalogEquipmentDialog.getByRole('spinbutton', { name: 'Capacity (optional)' }).inputValue() !== '35') {
    throw new Error('Catalog capacity was not copied');
  }
  await catalogEquipmentDialog.getByRole('button', { name: 'Create equipment' }).click();
  await page.getByText('Capacity: 35 L').waitFor();
  await page.locator('.equipment-delete').getByRole('button', { name: 'Delete' }).click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL('**/equipment');
  await chooseEquipmentType(page, 'Define equipment', 'Control', 'Electric kettle');
  const kettleDialog = page.getByRole('dialog', { name: 'Add electric kettle' });
  await kettleDialog.getByLabel('Capacity (optional)').waitFor();
  if (await kettleDialog.getByLabel('Range minimum').count()) throw new Error('Kettle was offered a measurement range');
  await kettleDialog.getByRole('textbox', { name: 'Name' }).fill('Smoke electric kettle');
  await kettleDialog.getByRole('spinbutton', { name: 'Capacity (optional)' }).fill('35');
  await kettleDialog.getByRole('spinbutton', { name: 'Rated power (W, optional)' }).fill('1800');
  await kettleDialog.getByRole('button', { name: 'Create equipment' }).click();
  await page.getByRole('heading', { name: 'Smoke electric kettle' }).waitFor();
  await page.getByText('Rated power: 1800 W').waitFor();
  await page.getByRole('button', { name: 'Edit capacity' }).click();
  await page.getByRole('dialog', { name: 'Edit capacity' }).getByRole('spinbutton', { name: 'Capacity' }).fill('36');
  await page.getByRole('button', { name: 'Save capacity' }).click();
  await page.getByText('Capacity: 36 L').waitFor();
  await page.getByRole('button', { name: 'Edit rated power' }).click();
  await page.getByRole('dialog', { name: 'Edit rated power' }).getByRole('spinbutton', { name: 'Rated power (W)' }).fill('2000');
  await page.getByRole('button', { name: 'Save rated power' }).click();
  await page.getByText('Rated power: 2000 W').waitFor();
  await page.getByRole('button', { name: 'Edit boil heat loss' }).click();
  const boilDialog = page.getByRole('dialog', { name: 'Calibrate boil-off' });
  await boilDialog.getByRole('spinbutton', { name: 'Start volume (L)' }).fill('30');
  await boilDialog.getByRole('spinbutton', { name: 'End volume (L)' }).fill('27');
  await boilDialog.getByRole('spinbutton', { name: 'Boil duration (minutes)' }).fill('60');
  await boilDialog.getByRole('button', { name: 'Save calibration' }).click();
  await page.getByText('Estimated boil-off at rated power: 3 L/h').waitFor();
  await page.getByRole('button', { name: 'Edit boil heat loss' }).click();
  const recalibrationDialog = page.getByRole('dialog', { name: 'Calibrate boil-off' });
  await recalibrationDialog.getByRole('spinbutton', { name: 'Start volume (L)' }).fill('30');
  await recalibrationDialog.getByRole('spinbutton', { name: 'End volume (L)' }).fill('28');
  await recalibrationDialog.getByRole('spinbutton', { name: 'Boil duration (minutes)' }).fill('60');
  await recalibrationDialog.getByRole('button', { name: 'Save calibration' }).click();
  await page.getByText('Estimated boil-off at rated power: 2 L/h').waitFor();
  await page.getByRole('button', { name: 'Edit temperature offset' }).click();
  const temperatureDialog = page.getByRole('dialog', { name: 'Calibrate temperature' });
  await temperatureDialog.getByRole('spinbutton', { name: 'Reference temperature (°C)' }).fill('65');
  await temperatureDialog.getByRole('spinbutton', { name: 'Equipment reading (°C)' }).fill('63');
  await temperatureDialog.getByRole('button', { name: 'Save temperature calibration' }).click();
  await page.getByText('Temperature offset: +2 °C').waitFor();
  await page.getByRole('button', { name: 'Edit equipment name and slug' }).click();
  const identityDialog = page.getByRole('dialog', { name: 'Edit equipment name and slug' });
  await identityDialog.getByRole('textbox', { name: 'Name' }).fill('Smoke kettle renamed');
  await identityDialog.getByRole('textbox', { name: 'Slug' }).fill('my-smoke-kettle');
  await identityDialog.getByRole('button', { name: 'Save name and slug' }).click();
  await page.getByRole('heading', { name: 'Smoke kettle renamed' }).waitFor();
  await page.waitForURL('**/equipment/my-smoke-kettle');
  await page.locator('.equipment-delete').getByRole('button', { name: 'Delete' }).click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL('**/equipment');
  await chooseEquipmentType(page, 'Define equipment', 'Passive vessels', 'Mash tun');
  const mashTunDialog = page.getByRole('dialog', { name: 'Add mash tun' });
  await mashTunDialog.getByLabel('Capacity (optional)').waitFor();
  await mashTunDialog.locator('.ant-modal-close').click();
  await chooseEquipmentType(page, 'Define equipment', 'Control', 'Fermentation temperature control');
  const fermentationControlDialog = page.getByRole('dialog', { name: 'Add fermentation temperature control' });
  if (await fermentationControlDialog.getByLabel('Capacity (optional)').count()) {
    throw new Error('Fermentation temperature control was offered vessel capacity');
  }
  await fermentationControlDialog.locator('.ant-modal-close').click();
  await chooseEquipmentType(page, 'Define equipment', 'Measurement', 'pH meter');
  const phDialog = page.getByRole('dialog', { name: 'Add pH meter' });
  if (await phDialog.getByLabel('Capacity (optional)').count()) {
    throw new Error('Measurement equipment was offered vessel capacity');
  }
  const phName = phDialog.getByRole('textbox', { name: 'Name' });
  await phName.fill('Smoke pH meter');
  await phDialog.getByRole('spinbutton', { name: 'Range minimum' }).fill('0');
  await phDialog.getByRole('spinbutton', { name: 'Range maximum' }).fill('14');
  await page.getByRole('button', { name: 'Create equipment' }).click();
  await page.getByRole('heading', { name: 'Smoke pH meter' }).waitFor();
  await page.getByText('Measurement range: 0–14 pH').waitFor();
  await page.getByRole('button', { name: 'Edit measurement range' }).click();
  await page.getByRole('dialog', { name: 'Edit measurement range' }).getByRole('spinbutton', { name: 'Range maximum' }).fill('15');
  await page.getByRole('button', { name: 'Save range' }).click();
  await page.getByText('Measurement range: 0–15 pH').waitFor();
  if (new URL(page.url()).pathname !== '/equipment/smoke-ph-meter') throw new Error('Equipment detail URL should use its name');
  await page.getByRole('button', { name: 'Edit pH 4.00 buffer reading' }).click();
  const phCalibrationDialog = page.getByRole('dialog', { name: 'Calibrate pH meter' });
  await phCalibrationDialog.getByRole('spinbutton', { name: 'pH 4.00 buffer reading' }).fill('4.01');
  await phCalibrationDialog.getByRole('spinbutton', { name: 'pH 7.00 buffer reading' }).fill('7.02');
  await phCalibrationDialog.getByRole('button', { name: 'Save calibration' }).click();
  await page.getByText('pH 4.00 buffer reading: 4.01').waitFor();
  await navigateSection(page, 'Equipment');
  if (!String(await page.getByRole('link', { name: 'Smoke pH meter' }).getAttribute('href')).endsWith('/equipment/smoke-ph-meter')) {
    throw new Error('Equipment list link should use its name slug');
  }
  const addEquipmentActions = page.locator('.equipment-add-actions');
  await addEquipmentActions.getByRole('button', { name: 'Add from catalog' }).waitFor();
  await addEquipmentActions.getByRole('button', { name: 'Define equipment' }).waitFor();
  const buttonBelowIntro = await addEquipmentActions.evaluate(actions => {
    const intro = actions.previousElementSibling;
    return intro?.textContent?.includes('Measurements, control settings, and transfers') || false;
  });
  if (!buttonBelowIntro) throw new Error('Equipment actions moved away from the intro when equipment exists');
  await chooseEquipmentType(page, 'Define equipment', 'Measurement', 'Refractometer');
  const refractometerDialog = page.getByRole('dialog', { name: 'Add refractometer' });
  const refractometerName = refractometerDialog.getByRole('textbox', { name: 'Name' });
  await refractometerName.fill('Smoke refractometer');
  await refractometerDialog.getByRole('spinbutton', { name: 'Range minimum' }).fill('0');
  await refractometerDialog.getByRole('spinbutton', { name: 'Range maximum' }).fill('32');
  await page.getByRole('button', { name: 'Create equipment' }).click();
  await page.getByRole('heading', { name: 'Smoke refractometer', exact: true }).waitFor();
  await page.getByText('Measurement range: 0–32 °Brix').waitFor();
  await navigateSection(page, 'Equipment');
  if (await page.locator('.group-table').count() !== 2) throw new Error('Equipment kinds should have separate tables');
  await page.setViewportSize({ width: 320, height: 720 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Grouped equipment tables overflow a narrow phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  await navigateSection(page, 'Batches');
  if (await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Smoke pH meter' }).count()) {
    throw new Error('Equipment still has child links in the navigation');
  }
  await openBatch(page, batchName);
  await choosePlanKind(page, 'Add action', 'Measurement');
  const measurementPlan = page.getByRole('dialog', { name: 'Add measurement' });
  await measurementPlan.getByLabel('What will be measured?').fill('Check pH');
  await measurementPlan.getByRole('checkbox', { name: 'Record this now' }).check();
  await measurementPlan.getByRole('button', { name: 'Add measurement' }).click();
  const measurementDialog = page.getByRole('dialog', { name: 'Record: Check pH' });
  await measurementDialog.getByRole('combobox', { name: 'Measurement' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="pH"]').click();
  await measurementDialog.getByRole('spinbutton', { name: 'Corrected value' }).fill('5.2');
  await measurementDialog.getByRole('combobox', { name: 'Instrument' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Smoke pH meter' }).click();
  await measurementDialog.getByRole('button', { name: 'Save event' }).click();
  await page.getByText('ph 5.2 pH').waitFor();
  await navigateSection(page, 'Equipment');
  await page.locator('.group-table').getByRole('link', { name: 'Smoke pH meter' }).click();
  await page.getByRole('heading', { name: 'Smoke pH meter' }).waitFor();
  await page.locator('.equipment-delete').getByRole('button', { name: 'Delete' }).click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL('**/equipment');
  await page.locator('.group-table a').filter({ hasText: 'Refractometer' }).click();
  await page.locator('.equipment-delete').getByRole('button', { name: 'Delete' }).click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: 'Delete' }).click();
  await page.waitForURL('**/equipment');
  await page.getByRole('button', { name: 'Define equipment' }).waitFor();
  await navigateSection(page, 'Batches');
  await openBatch(page, batchName);
  await page.getByText('ph 5.2 pH').waitFor();
  console.log('Grouped equipment and hid used gear while preserving its measurement');

  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.getByRole('combobox', { name: 'Preferred mass unit' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="oz"]').click();
  await page.waitForFunction(async () => (await (await fetch('/api/me')).json()).preferred_units.mass === 'oz');
  await page.getByRole('combobox', { name: 'Preferred temperature unit' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="°F"]').click();
  await page.waitForFunction(async () => (await (await fetch('/api/me')).json()).preferred_units.temperature === '°F');
  await navigateSection(page, 'Equipment');
  for (const [group, kind, name] of [['Passive vessels', 'Kettle', 'Smoke kettle'],
    ['Passive vessels', 'Fermenter', 'Smoke fermenter'], ['Control', 'Wort chiller', 'Smoke chiller']]) {
    await chooseEquipmentType(page, 'Define equipment', group, kind);
    const vesselDialog = page.getByRole('dialog', { name: `Add ${kind.toLowerCase()}` });
    await vesselDialog.getByRole('textbox', { name: 'Name' }).fill(name);
    await vesselDialog.getByRole('button', { name: 'Create equipment' }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await navigateSection(page, 'Equipment');
  }
  await navigateSection(page, 'Recipes');
  await page.getByRole('button', { name: 'New recipe' }).click();
  await page.getByLabel('Recipe name').fill('Smoke recipe');
  await page.getByRole('dialog', { name: 'New recipe' }).getByRole('combobox', { name: 'Type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Beer' }).click();
  await page.getByRole('button', { name: 'Create recipe' }).click();
  await page.waitForURL(url => /^\/recipe\/[A-Za-z0-9_-]{10,32}$/.test(url.pathname));
  await page.locator('.recipe-detail-heading .recipe-type-icon[data-recipe-type="beer"]').waitFor();
  if (await page.locator('.batch-timeline .column-title').getByText(/\d+ actions/).count()) {
    throw new Error('Recipe timeline still displays an action count');
  }
  await page.getByRole('button', { name: 'Edit planned event Mash' }).waitFor();
  await page.getByRole('button', { name: 'Edit planned event Add fermentable' }).waitFor();
  if (await page.getByRole('button', { name: 'Edit planned event Add fermentable' }).count() !== 1) {
    throw new Error('Beer template should have one fermentable placeholder');
  }
  const mashGroup = page.locator('.timeline-group').filter({ has: page.getByRole('button', { name: 'Edit planned event Mash' }) });
  const mashTitles = await mashGroup.locator('.title-edit-row strong').allTextContents();
  if (mashTitles.indexOf('Add fermentable') < 0 || mashTitles.indexOf('Add fermentable') > mashTitles.indexOf('Mash')) {
    throw new Error('Fermentable placeholder should appear at the start of Mash');
  }
  await page.getByRole('button', { name: 'Edit planned event Add fermentable' }).click();
  const fermentablePlan = page.getByRole('dialog', { name: 'Edit Add fermentable' });
  await fermentablePlan.waitFor();
  if (await fermentablePlan.getByLabel('What will be added?').inputValue()
    || !await fermentablePlan.getByRole('combobox', { name: 'Type' }).locator('..').getByText('Grain').count()
    || !await fermentablePlan.getByRole('combobox', { name: 'Timing' }).locator('..').getByText('At or after start of Mash').count()) {
    throw new Error('Fermentable placeholder should have no selected item and start with Mash');
  }
  await fermentablePlan.locator('.ant-modal-close').click();
  if (await page.locator('.plan-card').filter({ has: page.getByRole('button', { name: 'Edit planned event Mash' }) })
    .locator('.plan-meta').count()) throw new Error('Recipe start action repeats its group timing');
  await page.getByRole('button', { name: 'Edit planned event Boil' }).waitFor();
  const seededBoilGroup = page.locator('.timeline-group').filter({ has: page.getByRole('button', { name: 'Edit planned event Boil' }) });
  const boilRowHeight = await seededBoilGroup.locator('.timeline-entry').first().evaluate(element => element.getBoundingClientRect().height);
  if (boilRowHeight > 45) throw new Error(`Single-line recipe row has excess bottom space: ${boilRowHeight}px`);
  if (await seededBoilGroup.locator('xpath=preceding-sibling::*[1]').evaluate(element => element.classList.contains('timeline-gap'))) {
    throw new Error('Mash duration was repeated as a timeline gap');
  }
  if (await seededBoilGroup.locator('.timeline-group-heading').count()) throw new Error('Recipe group still has an anchor heading');
  await page.getByRole('button', { name: 'Edit planned event Chill' }).waitFor();
  const seededChillGroup = page.locator('.timeline-group').filter({ has: page.getByRole('button', { name: 'Edit planned event Chill' }) });
  if (await seededChillGroup.locator('xpath=preceding-sibling::*[1]').evaluate(element => element.classList.contains('timeline-gap'))) {
    throw new Error('Boil duration was repeated as a timeline gap');
  }
  const recipeAdd = page.getByRole('button', { name: 'Add recipe event' });
  if (await recipeAdd.textContent() !== 'Add'
    || !await recipeAdd.evaluate(element => element.classList.contains('ant-btn-text'))
    || !await recipeAdd.locator('svg').count()
    || await recipeAdd.evaluate(element => getComputedStyle(element.parentElement).justifyContent) !== 'flex-start') {
    throw new Error('Recipe add button should be a left-aligned, borderless icon and text');
  }
  await page.getByRole('button', { name: 'Edit planned event Chill' }).click();
  const chillPlan = page.getByRole('dialog', { name: 'Edit Chill' });
  if (await chillPlan.getByRole('spinbutton', { name: 'Duration (optional)' }).count()) {
    throw new Error('Chill plan still asks for a duration');
  }
  if (await chillPlan.getByRole('spinbutton', { name: 'Target temperature' }).inputValue() !== '68') {
    throw new Error('Chill plan should default to a 68°F target');
  }
  await chillPlan.locator('.ant-modal-close').click();
  await page.getByRole('button', { name: 'Edit planned event Transfer to fermenter' }).waitFor();
  await page.getByRole('button', { name: 'Edit planned event Transfer to fermenter' }).click();
  const transferPlan = page.getByRole('dialog', { name: 'Edit Transfer to fermenter' });
  await transferPlan.waitFor();
  if (await transferPlan.getByRole('combobox', { name: /From vessel/ }).count()
    || await transferPlan.getByRole('spinbutton', { name: 'Duration (optional)' }).count()) {
    throw new Error('Transfer plan still asks for a source vessel or duration');
  }
  if (!await transferPlan.getByRole('combobox', { name: 'Timing' }).locator('..').getByText('After Chill').count()) {
    throw new Error('Transfer timing should display its Chill anchor');
  }
  await transferPlan.getByRole('combobox', { name: 'To vessel (optional)' }).click();
  if (await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Smoke chiller' }).count()) {
    throw new Error('Transfer plan offered a chiller as a vessel');
  }
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Smoke fermenter' }).click();
  await transferPlan.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.plan-card').filter({ hasText: 'Transfer to fermenter' }).getByText('To Smoke fermenter').waitFor();
  await page.getByRole('button', { name: 'Edit planned event Measure original specific gravity' }).click();
  const gravityPlan = page.getByRole('dialog', { name: 'Edit gravity measurement' });
  await gravityPlan.waitFor();
  if (!await gravityPlan.getByRole('combobox', { name: 'Scale' }).locator('..').getByText('Specific gravity (unitless)').count()
    || !await gravityPlan.getByRole('combobox', { name: 'Timing' }).locator('..').getByText('At or after Transfer to fermenter').count()) {
    throw new Error('Beer template should measure unitless original specific gravity after transfer');
  }
  const gravityOffset = gravityPlan.getByRole('spinbutton', { name: 'Time offset' });
  if (await gravityOffset.inputValue() || await gravityPlan.getByRole('combobox', { name: 'Unit' }).inputValue()) {
    throw new Error('Gravity measurement should start without a time offset or time unit');
  }
  await gravityOffset.fill('5');
  await gravityPlan.getByRole('button', { name: 'Save event' }).click();
  await gravityPlan.locator('.ant-form-item-explain-error').waitFor();
  await gravityOffset.fill('');
  await gravityPlan.getByRole('button', { name: 'Save event' }).click();
  await gravityPlan.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Edit planned event Pitch yeast' }).waitFor();
  const templateGroups = await page.locator('.recipe-timeline .timeline-group').evaluateAll(groups => groups.map(group =>
    [...group.querySelectorAll('.title-edit-row strong')].map(title => title.textContent?.trim())));
  const chillGroupIndex = templateGroups.findIndex(titles => titles.includes('Chill'));
  const transferGroupIndex = templateGroups.findIndex(titles => titles.includes('Transfer to fermenter'));
  const gravityGroupIndex = templateGroups.findIndex(titles => titles.includes('Measure original specific gravity'));
  const pitchGroupIndex = templateGroups.findIndex(titles => titles.includes('Pitch yeast'));
  if (chillGroupIndex < 0 || transferGroupIndex <= chillGroupIndex || gravityGroupIndex <= transferGroupIndex
    || pitchGroupIndex <= chillGroupIndex) {
    throw new Error('Consecutive beer template actions should occupy separate timeline groups');
  }
  await page.getByRole('button', { name: 'Edit planned event Pitch yeast' }).click();
  const pitchPlan = page.getByRole('dialog', { name: 'Edit Pitch yeast' });
  await pitchPlan.waitFor();
  if (!await pitchPlan.getByRole('combobox', { name: 'Timing' }).locator('..').getByText('After Chill').count()) {
    throw new Error('Beer template should pitch yeast at the end of Chill');
  }
  if (await pitchPlan.getByLabel('What will be added?').inputValue()
    || await pitchPlan.locator('.ant-form-item').filter({ has: pitchPlan.getByLabel('What will be added?') }).locator('.ant-form-item-required').count()) {
    throw new Error('Pitch yeast should not require a generic yeast ingredient');
  }
  await pitchPlan.getByRole('button', { name: 'Save event' }).click();
  await pitchPlan.waitFor({ state: 'hidden' });
  if (await page.locator('.plan-card').filter({ hasText: 'Pitch yeast' }).first().getByText('Yeast', { exact: true }).count()) {
    throw new Error('Pitch yeast displayed a redundant generic yeast item');
  }
  await page.locator('.timeline-group').filter({ has: page.getByRole('button', { name: 'Edit planned event Package batch' }) })
    .locator('xpath=preceding-sibling::*[1]').getByText('21 days', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit planned event Package batch' }).click();
  const beerPackaging = page.getByRole('dialog', { name: 'Edit Package batch' });
  if (await beerPackaging.getByRole('textbox', { name: 'Container' }).inputValue()) {
    throw new Error('New recipe chose a packaging container in advance');
  }
  if (await beerPackaging.getByRole('spinbutton', { name: 'Duration (optional)' }).count()) {
    throw new Error('Packaging plan still has a duration');
  }
  if (Number(await beerPackaging.getByRole('spinbutton', { name: 'Time offset' }).inputValue()) !== 21
    || !await beerPackaging.getByRole('combobox', { name: 'Timing' }).locator('..').getByText('At or after Pitch yeast').count()) {
    throw new Error('Beer packaging was not planned 21 days after pitching yeast');
  }
  await beerPackaging.locator('.ant-modal-close').click();
  if (await page.locator('.plan-card').filter({ hasText: 'Pitch yeast' }).first()
    .locator('.title-edit-row').getByRole('button', { name: 'Edit planned event Pitch yeast' }).count()) {
    throw new Error('Recipe edit button is still beside the event title');
  }
  await page.getByRole('button', { name: 'Edit planned event Boil' }).click();
  const boilPlan = page.getByRole('dialog', { name: 'Edit Boil' });
  if (!await boilPlan.getByRole('spinbutton', { name: 'Duration (optional)' }).inputValue().then(value => Number(value) === 1)) {
    throw new Error('Seeded boil did not have a one-hour duration');
  }
  if (Number(await boilPlan.getByRole('spinbutton', { name: 'Target temperature' }).inputValue()) !== 212) {
    throw new Error('Seeded boil did not use preferred Fahrenheit');
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
  await recipePlan.getByRole('spinbutton', { name: 'Quantity' }).fill('5');
  if (!await recipePlan.getByRole('combobox', { name: 'Unit' }).locator('..').getByText('oz', { exact: true }).count()) {
    throw new Error('Shared grain suggestion replaced preferred ounces');
  }
  await recipePlan.getByRole('button', { name: 'Add addition' }).click();
  await recipePlan.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Edit planned event 2-row pale malt' }).waitFor();
  const ingredientCard = page.locator('.plan-card').filter({ has: page.getByRole('button', { name: 'Edit planned event 2-row pale malt' }) });
  if (!await ingredientCard.locator('.title-edit-row').getByText('5 oz', { exact: true }).count()
    || await ingredientCard.locator('p.event-detail').count()) {
    throw new Error('Recipe ingredient quantity should share the title line');
  }
  const boilGroup = page.locator('.timeline-group').filter({ has: page.getByRole('button', { name: 'Edit planned event Boil' }) });
  const boilGroupTitles = await boilGroup.locator('.title-edit-row strong').allTextContents();
  if (boilGroupTitles.indexOf('2-row pale malt') > boilGroupTitles.indexOf('Boil')
    || !boilGroupTitles.includes('2-row pale malt')) {
    throw new Error('An ingredient at boil start should appear before the boil action');
  }
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
  await page.getByRole('button', { name: 'Record Transfer to fermenter' }).click();
  const recordTransfer = page.getByRole('dialog', { name: 'Record: Transfer to fermenter' });
  if (await recordTransfer.getByRole('combobox', { name: 'From vessel' }).count()
    || await recordTransfer.getByLabel('Ended (optional)').count()) {
    throw new Error('Transfer recording still asks for a source vessel or end time');
  }
  await recordTransfer.getByRole('combobox', { name: 'To vessel' }).locator('..').getByText('Smoke fermenter').waitFor();
  await recordTransfer.getByRole('button', { name: 'Save event' }).click();
  await recordTransfer.waitFor({ state: 'hidden' });
  await page.locator('.plan-card').filter({ hasText: 'Transfer to fermenter' }).getByText('To Smoke fermenter').waitFor();
  await page.getByRole('button', { name: 'Record Package batch' }).click();
  const recordPackaging = page.getByRole('dialog', { name: 'Record: Package batch' });
  await recordPackaging.getByRole('button', { name: 'Save event' }).click();
  await recordPackaging.locator('.ant-form-item-explain-error').filter({ hasText: 'Container' }).waitFor();
  await recordPackaging.getByRole('textbox', { name: 'Container' }).fill('Bottle');
  await recordPackaging.getByRole('combobox', { name: 'Unit' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="US fl oz"]').click();
  await recordPackaging.getByRole('spinbutton', { name: 'Size' }).fill('12');
  await recordPackaging.getByRole('spinbutton', { name: 'Count' }).fill('48');
  await recordPackaging.getByRole('button', { name: 'Save event' }).click();
  await recordPackaging.waitFor({ state: 'hidden' });
  await page.locator('.plan-card').filter({ hasText: 'Package batch' }).getByText('Done').waitFor();
  await navigateSection(page, 'Recipes');
  await page.locator('.record-link').filter({ hasText: 'Smoke recipe' }).click();
  await choosePlanKind(page, 'Add recipe event', 'Notes');
  const recipeReminder = page.getByRole('dialog', { name: 'Add notes' });
  await recipeReminder.getByLabel('Reminder').fill('Check the mash');
  await recipeReminder.getByRole('combobox', { name: 'Timing' }).fill('2-row pale malt extra');
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '2-row pale malt extra' }).last().click();
  await recipeReminder.getByRole('button', { name: 'Add notes' }).click();
  await recipeReminder.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Edit planned event 2-row pale malt extra' }).click();
  const deleteRecipeEvent = page.getByRole('dialog', { name: 'Edit 2-row pale malt extra' });
  const recipeEventActions = deleteRecipeEvent.locator('.plan-form-actions');
  await recipeEventActions.getByRole('button', { name: 'Save event' }).waitFor();
  await recipeEventActions.getByRole('button', { name: 'Delete event' }).click();
  await page.getByText('Actions timed from this one will become relative to batch start.').waitFor();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await deleteRecipeEvent.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Edit planned event Boil' }).waitFor();
  await page.getByRole('button', { name: 'Edit planned event Check the mash' }).waitFor();
  await page.getByRole('button', { name: 'Edit planned event Check the mash' }).click();
  const unanchoredReminder = page.getByRole('dialog', { name: 'Edit Check the mash' });
  await unanchoredReminder.getByRole('combobox', { name: 'Timing' }).locator('..').getByText('Batch start').waitFor();
  await unanchoredReminder.locator('.ant-modal-close').click();
  await page.getByRole('button', { name: 'Recipe settings' }).click();
  const recipeSettings = page.getByRole('dialog', { name: 'Recipe settings' });
  await recipeSettings.getByRole('textbox', { name: 'Recipe name' }).fill('Smoke recipe revised');
  await recipeSettings.getByRole('textbox', { name: 'Description' }).fill('Edited recipe description');
  await recipeSettings.getByRole('combobox', { name: 'Type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Wine' }).click();
  await recipeSettings.getByRole('button', { name: 'Save changes' }).click();
  await recipeSettings.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Smoke recipe revised' }).waitFor();
  await page.getByText('Edited recipe description').waitFor();
  if (await page.getByText('Recipe plan · wine').count()) throw new Error('Recipe header still repeats its type');
  await page.locator('.recipe-detail-heading .recipe-type-icon[data-recipe-type="wine"]').waitFor();
  await page.getByRole('button', { name: 'Recipe settings' }).click();
  await recipeSettings.getByRole('button', { name: 'Delete recipe' }).click();
  await page.getByText('Batches already started from it keep their actions.').waitFor();
  await page.getByRole('button', { name: 'Delete recipe', exact: true }).last().click();
  await page.waitForURL(url => url.pathname === '/recipes');
  await page.locator('.record-link').filter({ hasText: 'Smoke recipe revised' }).waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('heading', { name: 'Recipes', exact: true }).waitFor();
  if (await page.locator('.record-link').filter({ hasText: 'Smoke recipe revised' }).count()) throw new Error('Deleted recipe returned after reload');
  await navigateSection(page, 'Batches');
  await openBatch(page, 'Batch from recipe');
  await page.locator('.plan-card').getByText('2-row pale malt extra').waitFor();
  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.getByRole('combobox', { name: 'Preferred mass unit' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'lb + oz' }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/me')).json()).preferred_units.mass === 'lb + oz');
  await navigateSection(page, 'Inventory');
  await page.getByRole('link', { name: 'grain', exact: true }).click();
  await page.getByRole('dialog', { name: 'New grain item' }).getByRole('combobox', { name: 'Item' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Maris Otter malt' }).last().click();
  await page.getByRole('dialog', { name: 'New grain item' }).getByRole('combobox', { name: 'Item' }).fill('Smoke grain');
  const newGrain = page.getByRole('dialog', { name: 'New grain item' });
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
  await newGrain.getByRole('combobox', { name: 'Unit' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="oz"]').click();
  await newGrain.getByRole('spinbutton', { name: 'Starting quantity on hand', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.ant-modal input[id="starting_quantity"]')?.value === '37');
  const convertedGrainQuantity = await newGrain.getByRole('spinbutton', { name: 'Starting quantity on hand' }).inputValue();
  if (Number(convertedGrainQuantity) !== 37) {
    throw new Error(`Changing from pounds and ounces did not convert the amount: ${convertedGrainQuantity}; ${JSON.stringify(await newGrain.locator('input').evaluateAll(inputs => inputs.map(input => ({ name: input.getAttribute('id'), value: input.value }))))}`);
  }
  await newGrain.getByRole('combobox', { name: 'Unit' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="lb + oz"]').click();
  await page.getByRole('button', { name: 'Create item' }).click();
  await newGrain.waitFor({ state: 'hidden' });
  await page.waitForURL(url => url.pathname === '/inventory');
  await page.getByRole('button', { name: 'Add grain' }).waitFor();
  const grainRow = page.locator('.group-table').getByRole('row').filter({ has: page.getByRole('link', { name: 'Smoke grain' }) });
  await page.getByRole('columnheader', { name: 'Qty' }).waitFor();
  await grainRow.getByText('2 lb 5 oz').waitFor();
  if (!String(await grainRow.getByRole('link', { name: 'Smoke grain' }).getAttribute('href')).endsWith('/inventory/smoke-grain')) {
    throw new Error('Inventory link still uses an item ID');
  }
  await page.getByRole('button', { name: 'Add grain' }).click();
  const moreGrain = page.getByRole('dialog', { name: 'New grain item' });
  await moreGrain.getByRole('combobox', { name: 'Item' }).fill('Smoke grain');
  if (await page.getByText('Unspecified', { exact: true }).count()) throw new Error('Unset stock location appeared as a named location');
  await moreGrain.getByText('This item is already at this location').waitFor();
  await moreGrain.getByRole('spinbutton', { name: 'Starting quantity on hand · pounds' }).fill('1');
  await moreGrain.getByRole('button', { name: 'Add stock' }).click();
  await moreGrain.waitFor({ state: 'hidden' });
  if (await page.locator('.group-table').getByRole('link', { name: 'Smoke grain' }).count() !== 1) {
    throw new Error('Adding an existing inventory item created a duplicate row');
  }
  await page.getByRole('button', { name: 'Actions for Smoke grain' }).click();
  await page.getByRole('menuitem', { name: 'Bought' }).click();
  const bought = page.getByRole('dialog', { name: 'Bought Smoke grain' });
  await bought.getByRole('spinbutton', { name: 'Quantity · pounds' }).fill('1');
  await bought.getByRole('button', { name: 'Save' }).click();
  await bought.waitFor({ state: 'hidden' });
  await grainRow.getByText('4 lb 5 oz').waitFor();
  await page.locator('.group-table').getByRole('link', { name: 'Smoke grain' }).click();
  await page.waitForURL(url => url.pathname === '/inventory/smoke-grain');
  await page.getByText('4 lb 5 oz estimated on hand').waitFor();
  await page.getByRole('heading', { name: 'Stock history' }).waitFor();
  await page.locator('.inventory-history').getByRole('columnheader', { name: 'Activity' }).waitFor();
  await page.setViewportSize({ width: 320, height: 720 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Inventory history overflows a narrow phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Discard' }).click();
  const discard = page.getByRole('dialog', { name: 'Discard Smoke grain' });
  await discard.getByRole('spinbutton', { name: 'Ounces' }).fill('5');
  await discard.getByRole('button', { name: 'Save' }).click();
  await page.getByText('4 lb estimated on hand').waitFor();
  await page.getByRole('button', { name: 'Discard' }).click();
  const discardAll = page.getByRole('dialog', { name: 'Discard Smoke grain' });
  await discardAll.getByRole('checkbox', { name: 'All available stock' }).check();
  await discardAll.getByRole('button', { name: 'Save' }).click();
  await page.getByText('0 lb estimated on hand').waitFor();
  if (await page.getByText('Discarded', { exact: true }).count() !== 2) throw new Error('Discard movements are missing');
  await page.reload();
  await page.getByText('0 lb estimated on hand').waitFor();
  await navigateSection(page, 'Inventory');
  await page.getByRole('link', { name: 'packaging', exact: true }).click();
  await page.getByRole('dialog', { name: 'New packaging item' }).getByRole('combobox', { name: 'Item' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '12 oz bottle' }).last().click();
  if (!await page.getByRole('dialog', { name: 'New packaging item' }).getByRole('combobox', { name: 'Unit' }).locator('..').getByText('each', { exact: true }).count()) throw new Error('Packaging unit default was not set');
  await page.getByRole('button', { name: 'Create item' }).click();
  await page.getByRole('dialog', { name: 'New packaging item' }).waitFor({ state: 'hidden' });
  await page.waitForURL(url => url.pathname === '/inventory');
  await page.waitForFunction(() => document.querySelectorAll('.group-table').length === 2);
  await page.setViewportSize({ width: 320, height: 720 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Grouped inventory tables overflow a narrow phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  await navigateSection(page, 'Locations');
  await page.getByRole('heading', { name: 'Locations' }).waitFor();
  if (await page.locator('.location-index .ant-empty').count() || await page.getByText('No locations yet').count()) {
    throw new Error('Locations should not show an empty-state illustration or placeholder message');
  }
  await page.getByRole('button', { name: 'Add location' }).click();
  const locationsDialog = page.getByRole('dialog', { name: 'New location' });
  if (await locationsDialog.getByRole('combobox', { name: 'Inside (optional)' }).count()
    || await locationsDialog.getByText('A parent is optional.').count()) {
    throw new Error('Empty location list should not show the parent selector or optional-parent note');
  }
  await locationsDialog.getByRole('textbox', { name: 'Name' }).fill('Back room');
  await locationsDialog.getByRole('textbox', { name: 'Address (optional)' }).fill('123 Brew Street');
  await locationsDialog.getByRole('button', { name: 'Add location' }).click();
  await locationsDialog.waitFor({ state: 'hidden' });
  await page.locator('.location-card').filter({ hasText: 'Back room' }).getByText('123 Brew Street').waitFor();
  await page.getByRole('link', { name: /Back room.*0 here/ }).waitFor();
  await page.getByRole('link', { name: /Back room.*0 here/ }).click();
  await page.waitForURL(/\/location\/back-room$/);
  await page.locator('.location-detail-address').getByText('123 Brew Street').waitFor();
  await page.getByRole('button', { name: 'New sublocation' }).click();
  const childDialog = page.getByRole('dialog', { name: 'New location' });
  await childDialog.getByRole('textbox', { name: 'Name' }).fill('Shelf A');
  await childDialog.getByRole('button', { name: 'Add location' }).click();
  await childDialog.waitFor({ state: 'hidden' });
  await page.getByRole('link', { name: /Shelf A.*0 here/ }).waitFor();
  await navigateSection(page, 'Locations');
  if (!await page.locator('.location-card .location-card').filter({ hasText: 'Shelf A' }).count()) {
    throw new Error('Child location is not shown as a card inside its parent');
  }
  await page.setViewportSize({ width: 320, height: 720 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('Location hierarchy overflows a narrow phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  await navigateSection(page, 'Inventory');
  await grainRow.getByRole('button', { name: 'Actions for Smoke grain' }).click();
  await page.getByRole('menuitem', { name: 'Bought' }).click();
  const refill = page.getByRole('dialog', { name: 'Bought Smoke grain' });
  await refill.getByRole('spinbutton', { name: 'Quantity · pounds' }).fill('2');
  await refill.getByRole('button', { name: 'Save' }).click();
  await refill.waitFor({ state: 'hidden' });
  await grainRow.getByRole('button', { name: 'Actions for Smoke grain' }).click();
  await page.getByRole('menuitem', { name: 'Move' }).click();
  const moveDialog = page.getByRole('dialog', { name: 'Move stock' });
  if (await moveDialog.getByRole('button', { name: 'Create or manage locations' }).count()) {
    throw new Error('Move stock still has a separate location management link');
  }
  await moveDialog.getByRole('combobox', { name: 'To location (optional)' }).click();
  await page.locator('.ant-select-tree:visible').getByText('New location…').click();
  const moveLocationDialog = page.getByRole('dialog', { name: 'New location' });
  await moveLocationDialog.getByRole('textbox', { name: 'Name' }).fill('Spare shelf');
  await moveLocationDialog.getByRole('button', { name: 'Add location' }).click();
  await moveLocationDialog.waitFor({ state: 'hidden' });
  if (!await moveDialog.getByRole('combobox', { name: 'To location (optional)' }).locator('..').getByText('Spare shelf').count()) {
    throw new Error('New location was not selected for the stock move');
  }
  await moveDialog.getByRole('combobox', { name: 'To location' }).click();
  await page.locator('.ant-select-tree:visible').getByText('Shelf A', { exact: true }).click();
  await moveDialog.getByRole('checkbox', { name: 'Move all available stock' }).check();
  await moveDialog.getByRole('button', { name: 'Move stock' }).click();
  await moveDialog.waitFor({ state: 'hidden' });
  await page.getByRole('cell', { name: 'Back room / Shelf A' }).waitFor();
  if (await page.locator('.group-table').getByRole('link', { name: 'Smoke grain' }).count() !== 2) {
    throw new Error('Moving stock did not create a distinct location row');
  }
  const shelfRow = page.locator('.group-table').getByRole('row').filter({ has: page.getByRole('cell', { name: 'Back room / Shelf A' }) });
  await shelfRow.getByText('2 lb').waitFor();
  await shelfRow.getByRole('link', { name: 'Smoke grain' }).click();
  await page.getByText('Moved in', { exact: true }).waitFor();
  await navigateSection(page, 'Inventory');
  await page.getByRole('button', { name: 'Add grain' }).click();
  const shelvedGrain = page.getByRole('dialog', { name: 'New grain item' });
  await shelvedGrain.waitFor();
  await shelvedGrain.locator('input#name').fill('Smoke grain');
  if (await shelvedGrain.getByRole('button', { name: 'Create or manage locations' }).count()) {
    throw new Error('New inventory item still has a separate location management link');
  }
  await shelvedGrain.locator('input#location_id').click();
  await page.locator('.ant-select-tree:visible').getByText('New location…').click();
  const itemLocationDialog = page.getByRole('dialog', { name: 'New location' });
  await itemLocationDialog.getByRole('textbox', { name: 'Name' }).fill('Stock cabinet');
  await itemLocationDialog.getByRole('button', { name: 'Add location' }).click();
  await itemLocationDialog.waitFor({ state: 'hidden' });
  if (!await shelvedGrain.getByRole('combobox', { name: 'Location (optional)' }).locator('..').getByText('Stock cabinet').count()) {
    throw new Error('New location was not selected for the inventory item');
  }
  await shelvedGrain.locator('input#location_id').click();
  await page.locator('.ant-select-tree:visible').getByText('Shelf A', { exact: true }).click();
  await shelvedGrain.getByText('This item is already at this location').waitFor();
  await shelvedGrain.getByRole('spinbutton', { name: 'Starting quantity on hand · pounds' }).fill('1');
  await shelvedGrain.getByRole('button', { name: 'Add stock' }).click();
  await shelvedGrain.waitFor({ state: 'hidden' });
  await shelfRow.getByText('3 lb').waitFor();
  if (await page.locator('.group-table').getByRole('link', { name: 'Smoke grain' }).count() !== 2) {
    throw new Error('Buying more at a location created another stock row');
  }
  await navigateSection(page, 'Locations');
  await page.locator('.location-card-heading').filter({ hasText: 'Shelf A' }).click();
  await page.getByRole('heading', { name: 'Shelf A' }).waitFor();
  await page.getByRole('heading', { name: 'Stock here' }).waitFor();
  await page.getByRole('link', { name: /Smoke grain.*3 lb/ }).waitFor();
  await page.getByRole('button', { name: 'Location settings' }).click();
  const locationSettings = page.getByRole('dialog', { name: 'Location settings' });
  await locationSettings.getByRole('textbox', { name: 'Name' }).fill('Shelf B');
  await locationSettings.getByRole('textbox', { name: 'URL slug' }).fill('shelf-b');
  await locationSettings.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/\/location\/shelf-b$/);
  await page.getByRole('heading', { name: 'Shelf B' }).waitFor();
  await page.route('**/api/**', route => route.abort());
  await page.goto(`${baseUrl}/inventory`);
  await page.getByRole('heading', { name: 'Inventory', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add grain' }).click();
  await page.getByRole('dialog', { name: 'New grain item' }).getByRole('combobox', { name: 'Item' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Maris Otter malt' }).waitFor();
  await page.getByRole('dialog', { name: 'New grain item' }).locator('.ant-modal-close').click();
  await page.getByRole('dialog', { name: 'New grain item' }).waitFor({ state: 'hidden' });
  await page.unroute('**/api/**');
  console.log('Navigated recipe and inventory pages with grouped inventory tables');

  await navigateSection(page, 'Batches');
  await openBatch(page, batchName);

  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9V+c0AAAAASUVORK5CYII=', 'base64');
  const beforePhotoSync = await page.evaluate(() => {
    const id = JSON.parse(localStorage.getItem('brewlog:last-session')).workspaces[0].id;
    return localStorage.getItem(`brewlog:last-sync:${id}`);
  });
  await choosePlanKind(page, 'Add action', 'Photo');
  const photoPlan = page.getByRole('dialog', { name: 'Add photo' });
  await photoPlan.getByLabel('Description (optional)').fill('Brew photo');
  await photoPlan.getByRole('checkbox', { name: 'Record this now' }).check();
  await photoPlan.getByRole('button', { name: 'Add photo' }).click();
  const photoDialog = page.getByRole('dialog', { name: 'Record: Brew photo' });
  await photoDialog.locator('input[type="file"]').setInputFiles({ name: 'brew.png', mimeType: 'image/png', buffer: imageBytes });
  await photoDialog.getByRole('button', { name: 'Save event' }).click();
  await page.locator('.plan-card .photo-grid img').waitFor();
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
  const forbiddenDelete = await third.evaluate(async id => (await fetch(`/api/workspaces/${id}`, { method: 'DELETE' })).status, firstWorkspaceId);
  if (forbiddenDelete !== 404) throw new Error(`Second account deleted first account's brewery: ${forbiddenDelete}`);
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
  await choosePlanKind(page, 'Add action', 'Measurement');
  const preferredMeasurement = page.getByRole('dialog', { name: 'Add measurement' });
  await preferredMeasurement.getByLabel('What will be measured?').fill('Check temperature');
  await preferredMeasurement.getByRole('checkbox', { name: 'Record this now' }).check();
  await preferredMeasurement.getByRole('button', { name: 'Add measurement' }).click();
  const preferredUnitText = await page.getByRole('dialog', { name: 'Record: Check temperature' }).getByRole('combobox', { name: 'Unit' }).locator('..').innerText();
  if (!preferredUnitText.includes('°F')) {
    throw new Error(`Preferred temperature unit was not used in the event form: ${preferredUnitText}`);
  }
  await page.getByRole('dialog', { name: 'Record: Check temperature' }).getByRole('button', { name: 'Close' }).click();
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

  for (const type of ['Wine', 'Mead', 'Cider']) {
    await navigateSection(page, 'Recipes');
    await page.getByRole('button', { name: 'New recipe' }).click();
    const dialog = page.getByRole('dialog', { name: 'New recipe' });
    await dialog.getByLabel('Recipe name').fill(`${type} smoke recipe`);
    await dialog.getByRole('combobox', { name: 'Type' }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: type }).click();
    await dialog.getByRole('button', { name: 'Create recipe' }).click();
    await page.getByRole('button', { name: 'Edit planned event Measure original specific gravity' }).click();
    const gravityPlan = page.getByRole('dialog', { name: 'Edit gravity measurement' });
    await gravityPlan.waitFor();
    if (!await gravityPlan.getByRole('combobox', { name: 'Scale' }).locator('..').getByText('Specific gravity (unitless)').count()) {
      throw new Error(`${type} template should include a unitless original specific gravity measurement`);
    }
    await gravityPlan.locator('.ant-modal-close').click();
    await page.getByRole('button', { name: 'Edit planned event Pitch yeast' }).waitFor();
    await page.getByRole('button', { name: 'Edit planned event Package batch' }).click();
    const packaging = page.getByRole('dialog', { name: 'Edit Package batch' });
    const days = type === 'Cider' ? 28 : 60;
    if (Number(await packaging.getByRole('spinbutton', { name: 'Time offset' }).inputValue()) !== days
      || !await packaging.getByRole('combobox', { name: 'Timing' }).locator('..').getByText('At or after Pitch yeast').count()) {
      throw new Error(`${type} packaging was not planned ${days} days after pitching yeast`);
    }
    await packaging.locator('.ant-modal-close').click();
    await page.locator(`.recipe-detail-heading .recipe-type-icon[data-recipe-type="${type.toLowerCase()}"]`).waitFor();
    await page.locator('.app-nav .nav-recent-item').filter({ hasText: `${type} smoke recipe` })
      .locator(`.recipe-type-icon[data-recipe-type="${type.toLowerCase()}"]`).waitFor();
    if (await page.getByRole('button', { name: 'Edit planned event Boil' }).count()) throw new Error(`${type} recipe got a beer boil`);
    await navigateSection(page, 'Recipes');
    await page.locator('.record-link').filter({ hasText: `${type} smoke recipe` })
      .locator(`.recipe-type-icon[data-recipe-type="${type.toLowerCase()}"]`).waitFor();
  }

  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('button', { name: 'Delete Homebrew' }).click();
  await page.getByRole('dialog', { name: 'Delete Homebrew?' }).getByRole('button', { name: 'Delete brewery' }).click();
  await page.getByRole('button', { name: 'Delete Homebrew' }).waitFor({ state: 'hidden' });
  const remainingBlocks = await localBreweryBlocks(page, firstWorkspaceId);
  if (remainingBlocks) throw new Error(`Deleted Homebrew database remains in browser storage (${remainingBlocks} blocks): ${JSON.stringify(await page.locator('.page-alert').allTextContents())}`);
  const afterDefaultDelete = await page.evaluate(async () => (await (await fetch('/api/me')).json()).workspaces);
  if (afterDefaultDelete.length !== 1 || afterDefaultDelete[0].name !== secondBrewery) {
    throw new Error('Deleting the default brewery did not retain the other brewery');
  }
  await navigateSection(page, 'Batches');
  await openBatch(page, 'Second brewery batch');
  if (!new URL(page.url()).pathname.startsWith(`/brewery/${slug}/batch/`)) {
    throw new Error('Deleting the root brewery changed another brewery’s slug URL');
  }
  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('button', { name: `Edit ${secondBrewery}` }).click();
  await page.getByRole('dialog', { name: 'Edit brewery' }).getByRole('textbox', { name: 'Brewery name' }).fill('Renamed brewery');
  await page.getByRole('dialog', { name: 'Edit brewery' }).getByRole('textbox', { name: 'Brewery slug' }).fill('');
  await page.getByRole('dialog', { name: 'Edit brewery' }).getByRole('button', { name: 'Save brewery' }).click();
  await page.getByRole('button', { name: 'Edit Renamed brewery' }).waitFor();
  await page.getByText('Root URLs · /batches').waitFor();
  await navigateSection(page, 'Batches');
  await openBatch(page, 'Second brewery batch');
  if (!/^\/batch\/[A-Za-z0-9_-]{10,32}$/.test(new URL(page.url()).pathname)) {
    throw new Error('Clearing the remaining brewery slug did not claim root URLs');
  }
  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('button', { name: 'Delete Renamed brewery' }).click();
  await page.getByRole('dialog', { name: 'Delete Renamed brewery?' }).getByRole('button', { name: 'Delete brewery' }).click();
  await page.getByText('No breweries yet. Add one to start brewing.').waitFor();
  await page.getByRole('button', { name: 'New brewery' }).click();
  const replacement = page.getByRole('dialog', { name: 'New brewery' });
  await replacement.getByRole('textbox', { name: 'Brewery name' }).fill('Replacement');
  await replacement.getByRole('button', { name: 'Create brewery' }).click();
  await page.getByRole('button', { name: 'Edit Replacement' }).waitFor();
  await navigateSection(page, 'Batches');
  if (new URL(page.url()).pathname !== '/batches') throw new Error('New sole brewery did not use root URLs');
  console.log('Managed slugs and deleted both the default and final brewery');

  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log('Browser smoke passed');
} finally {
  await browser.close();
}
