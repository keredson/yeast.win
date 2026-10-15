import { chromium } from 'playwright-core';

const baseUrl = process.env.BREWLOG_TEST_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  headless: true, args: ['--no-sandbox']
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));

async function choose(dialog, label, value) {
  await dialog.getByRole('combobox', { name: label }).click();
  await page.locator(`.ant-select-dropdown:visible .ant-select-item-option[title="${value}"]`).click();
}

async function newBatch(name, source, sourceName) {
  await page.goto(`${baseUrl}/batches`);
  await page.getByRole('heading', { name: 'Batches' }).waitFor();
  await page.getByRole('button', { name: 'New batch' }).click();
  const dialog = page.getByRole('dialog', { name: 'New batch' });
  await dialog.getByLabel('Batch name').fill(name);
  await choose(dialog, 'Start from', source);
  if (sourceName) await choose(dialog, source === 'Recipe' ? 'Recipe' : 'Previous batch', sourceName);
  await dialog.getByRole('button', { name: 'Create batch' }).click();
  await page.getByRole('heading', { name }).waitFor();
  return page.url();
}

try {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Username').fill(`batch-start-${Date.now()}`);
  await page.getByLabel('Password', { exact: true }).fill('batch-start-pass');
  await page.getByLabel('Confirm password').fill('batch-start-pass');
  await page.locator('.login-card form button[type="submit"]').click();
  await page.getByRole('heading', { name: 'Batches' }).waitFor();

  await newBatch('Empty trial', 'Empty batch');
  if (await page.getByText('Mash', { exact: true }).count()) throw new Error('Empty batch has a template action');

  const templateUrl = await newBatch('Beer template trial', 'Beer template');
  await page.getByText('Mash', { exact: true }).first().waitFor();
  await page.getByText('Drain grain', { exact: true }).first().waitFor();
  await page.getByText('Package batch', { exact: true }).first().waitFor();

  for (const type of ['Wine', 'Mead', 'Cider']) {
    await newBatch(`${type} template trial`, `${type} template`);
    await page.getByText('Pitch yeast', { exact: true }).first().waitFor();
    await page.getByText('Package batch', { exact: true }).first().waitFor();
  }

  await newBatch('Repeat trial', 'Previous batch', 'Beer template trial');
  await page.getByText('Started from').waitFor();
  await page.getByText('Package batch', { exact: true }).first().waitFor();
  const sourceLink = page.locator(`a[href="${new URL(templateUrl).pathname}"]`);
  if (!await sourceLink.count()) throw new Error('Previous batch link missing');

  await page.goto(`${baseUrl}/recipes`);
  await page.getByRole('button', { name: 'New recipe' }).click();
  const recipeDialog = page.getByRole('dialog', { name: 'New recipe' });
  await recipeDialog.getByLabel('Recipe name').fill('Recipe trial');
  await recipeDialog.getByRole('button', { name: 'Create recipe' }).click();
  await page.getByRole('heading', { name: 'Recipe trial' }).waitFor();
  await newBatch('Recipe trial batch', 'Recipe', 'Recipe trial');
  await page.getByText('Package batch', { exact: true }).first().waitFor();
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log('Empty, all four templates, previous batch, and recipe starting choices passed');
} finally {
  await browser.close();
}
