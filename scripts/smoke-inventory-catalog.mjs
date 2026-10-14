import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  headless: true, args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));

try {
  await page.goto(process.env.BREWLOG_TEST_URL || 'http://127.0.0.1:5173');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Username').fill(`inventory-catalog-${Date.now()}`);
  await page.getByLabel('Password', { exact: true }).fill('smoke-test-1234');
  await page.getByLabel('Confirm password').fill('smoke-test-1234');
  await page.locator('.login-card form button[type="submit"]').click();
  await page.getByRole('button', { name: 'Account settings' }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Sync now"]');
    return button && !button.hasAttribute('disabled');
  }, undefined, { timeout: 30_000 });
  const catalogSync = page.waitForResponse(response => response.url().includes('/api/catalog/sync')
    && response.request().method() === 'GET', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Sync now' }).click();
  if (!(await catalogSync).ok()) throw new Error('Manual sync did not fetch catalog changes');
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Sync now"]');
    return button && !button.hasAttribute('disabled');
  }, undefined, { timeout: 60_000 });
  const forcedCatalogSync = page.waitForResponse(response => response.url().includes('/api/catalog/sync')
    && response.request().method() === 'GET', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Sync now' }).click();
  if (!(await forcedCatalogSync).ok()) throw new Error('Manual sync was blocked by the catalog refresh interval');
  await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Inventory' }).first().click();
  await page.getByRole('heading', { name: 'Inventory', exact: true }).waitFor();

  if (await page.getByRole('button', { name: 'Add from catalog' }).count()) {
    throw new Error('Inventory index still has a top-level catalog button');
  }
  await page.locator('.inventory-add-types').getByRole('link', { name: 'other', exact: true }).click();
  const other = page.getByRole('dialog', { name: 'Specify other product' });
  if (await other.getByRole('combobox', { name: 'Category' }).count()) {
    throw new Error('Categories should be defined by the app');
  }
  await other.locator('input#name').fill('Smoke spice');
  await other.getByRole('button', { name: 'Save product' }).click();
  await other.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Other', exact: true }).waitFor();
  await page.locator('.inventory-add-types').getByRole('link', { name: 'other fermentables' }).click();
  const fermentables = page.getByRole('dialog', { name: 'Add from catalog' });
  await fermentables.getByRole('button', { name: /Briess CBW® Golden Light DME/ }).waitFor({ timeout: 60_000 });
  await fermentables.getByRole('button', { name: /Fresh apple cider/ }).waitFor();
  await fermentables.locator('.ant-modal-close').click();

  await page.locator('.inventory-add-types').getByRole('link', { name: 'nutrient' }).click();
  const explorer = page.getByRole('dialog', { name: 'Add from catalog' });
  await explorer.getByRole('searchbox', { name: 'Search inventory products' }).fill('Fermaid');
  for (const name of ['Fermaid O', 'Fermaid K', 'Fermaid A', 'Fermaid Performens M']) {
    await explorer.getByRole('button', { name: new RegExp(name) }).waitFor({ timeout: 60_000 });
  }
  await explorer.getByRole('searchbox', { name: 'Search inventory products' }).fill('');
  await explorer.getByRole('combobox', { name: 'Filter inventory type' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="Grain"]').click();
  await explorer.getByRole('searchbox', { name: 'Search inventory products' }).fill('Crisp Malt Finest Maris Otter');
  await explorer.getByRole('button', { name: /Crisp Malt Finest Maris Otter/ }).waitFor({ timeout: 60_000 });
  await explorer.getByRole('searchbox', { name: 'Search inventory products' }).fill('Weyermann Munich Malt Type 1');
  const weyermann = explorer.getByRole('button', { name: /Weyermann Munich Malt Type 1/ });
  await weyermann.waitFor({ timeout: 60_000 });
  if (!await weyermann.locator('img').count()) throw new Error('Weyermann product has no catalog image');
  await weyermann.locator('img[src]').waitFor();
  await weyermann.locator('img[src]').evaluate(image => image.decode());
  await explorer.getByRole('searchbox', { name: 'Search inventory products' }).fill('Lighthouse');
  const lighthouse = explorer.getByRole('button', { name: /Briess Lighthouse™ Munich Malt/ });
  await lighthouse.waitFor({ timeout: 60_000 });
  await lighthouse.locator('img[src]').waitFor();
  await lighthouse.locator('img[src]').evaluate(image => image.decode());
  await explorer.getByRole('searchbox', { name: 'Search inventory products' }).fill('Briess Caramel Malt 60L');
  const product = explorer.getByRole('button', { name: /Briess Caramel Malt 60L/ });
  await product.waitFor({ timeout: 60_000 });
  if (!await product.locator('img').count()) throw new Error('Catalog result has no product image');
  await product.locator('img[src]').waitFor();
  await product.click();

  const form = page.getByRole('dialog', { name: 'New grain item' });
  if (await form.getByRole('combobox', { name: 'Item' }).count()) {
    throw new Error('Catalog choice still shows a redundant item picker');
  }
  await form.getByText('Briess Caramel Malt 60L', { exact: true }).waitFor();
  const briessImage = form.locator('.inventory-catalog-source img');
  await form.locator('.inventory-catalog-source img[src]').waitFor();
  await briessImage.evaluate(image => image.decode());
  const briessDimensions = await briessImage.evaluate(image => [image.naturalWidth, image.naturalHeight]);
  if (briessDimensions[0] !== briessDimensions[1]) throw new Error(`Briess image is not square: ${briessDimensions}`);
  const briessLink = form.getByRole('link', { name: 'Product information' });
  await briessLink.waitFor();
  if (!(await briessLink.getAttribute('href'))?.endsWith('/Briess-PISB-Caramel-Malt-60L.pdf')) {
    throw new Error('Briess product information does not link to its own PDF');
  }
  await form.getByRole('button', { name: 'Create item' }).click();
  await form.waitFor({ state: 'hidden' });
  await page.getByRole('link', { name: 'Briess Caramel Malt 60L' }).waitFor();
  await page.locator('.inventory-table').getByRole('row')
    .filter({ has: page.getByRole('link', { name: 'Briess Caramel Malt 60L' }) })
    .locator('img.inventory-table-thumbnail').waitFor();
  await page.locator('.inventory-add-types').getByRole('link', { name: 'grain' }).click();
  const grainExplorer = page.getByRole('dialog', { name: 'Add from catalog' });
  await grainExplorer.getByRole('button', { name: 'Specify grain not in catalog' }).click();
  const custom = page.getByRole('dialog', { name: 'Specify grain product' });
  await custom.locator('input#name').fill('House malt');
  await custom.getByRole('spinbutton', { name: 'Extract yield (%)' }).fill('79');
  await custom.getByRole('spinbutton', { name: 'Color (°L)' }).fill('3');
  await custom.getByRole('button', { name: 'Save product' }).click();
  await custom.waitFor({ state: 'hidden' });
  await page.getByRole('link', { name: 'House malt' }).click();
  await page.getByRole('button', { name: 'Supply properties' }).click();
  const savedSpec = page.getByRole('dialog', { name: 'House malt supply defaults' });
  if (await savedSpec.getByRole('spinbutton', { name: 'Extract yield (%)' }).inputValue() !== '79') {
    throw new Error('Custom product specification was not saved');
  }
  await savedSpec.locator('.ant-modal-close').click();
  await page.getByRole('button', { name: 'Edit product URL' }).click();
  const links = page.getByRole('dialog', { name: 'Edit product URL' });
  await links.getByRole('textbox', { name: 'Product URL' }).fill('https://example.com/house-malt');
  await links.getByRole('button', { name: 'Save URL' }).click();
  await links.waitFor({ state: 'hidden' });
  await page.getByRole('link', { name: 'https://example.com/house-malt' }).waitFor();
  await page.getByRole('button', { name: 'Edit image' }).click();
  const image = page.getByRole('dialog', { name: 'Edit product image' });
  await image.getByLabel('Product image').setInputFiles('tests/fixtures/old-briess-caramel-60.jpg');
  await image.getByRole('button', { name: 'Save image' }).click();
  await image.waitFor({ state: 'hidden' });
  await page.locator('.supply-product-image img').waitFor();
  await page.getByRole('button', { name: 'Link catalog product' }).click();
  const linkCatalog = page.getByRole('dialog', { name: 'Link catalog product' });
  await linkCatalog.getByRole('searchbox', { name: 'Search inventory products' }).fill('Crisp Malt Finest Maris Otter');
  await linkCatalog.getByRole('button', { name: /Crisp Malt Finest Maris Otter/ }).click();
  await page.getByText('Crisp Malt', { exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'Change catalog product' }).count()) {
    throw new Error('Linked product can be reassigned from its detail page');
  }
  await page.getByRole('button', { name: 'Edit product URL' }).click();
  await page.getByRole('dialog', { name: 'Edit product URL' }).getByRole('button', { name: 'Restore catalog URL' }).click();
  await page.getByRole('dialog', { name: 'Edit product URL' }).getByRole('button', { name: 'Save URL' }).click();
  await page.getByRole('link', { name: /crispmalt.com\/malts\/finest-maris-otter-ale-malt/ }).waitFor();
  await page.setViewportSize({ width: 320, height: 720 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
    throw new Error('Inventory product details overflow a narrow phone');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Equipment' }).first().click();
  await page.getByRole('button', { name: 'Add from catalog' }).click();
  const equipmentCatalog = page.getByRole('dialog', { name: 'Add from catalog' });
  await equipmentCatalog.getByRole('searchbox', { name: 'Search equipment models' }).fill('VEVOR Electric Brewing System');
  const vevor = equipmentCatalog.getByRole('button', { name: /VEVOR Electric Brewing System 9.2 Gal\/35 L/ }).first();
  await vevor.locator('img[src]').waitFor({ timeout: 60_000 });
  await vevor.locator('img[src]').evaluate(image => image.decode());
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log('Manual catalog sync, lazy catalog images, inventory catalog, and catalog linking passed');
} finally {
  await browser.close();
}
