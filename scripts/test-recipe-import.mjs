import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';

const xml = `<?xml version="1.0" encoding="utf-8"?>
<RECIPES>
  <RECIPE><NAME>Import Pale Ale</NAME><VERSION>1</VERSION><TYPE>All Grain</TYPE>
    <BATCH_SIZE>20</BATCH_SIZE><BOIL_SIZE>24</BOIL_SIZE><BOIL_TIME>60</BOIL_TIME><EFFICIENCY>72</EFFICIENCY>
    <MASH><NAME>Single infusion</NAME><MASH_STEPS><MASH_STEP><NAME>Mash</NAME><STEP_TEMP>66</STEP_TEMP><STEP_TIME>45</STEP_TIME></MASH_STEP></MASH_STEPS></MASH>
    <FERMENTABLES><FERMENTABLE><NAME>2-row pale malt</NAME><TYPE>Grain</TYPE><AMOUNT>4.5</AMOUNT><YIELD>80</YIELD></FERMENTABLE></FERMENTABLES>
    <HOPS><HOP><NAME>Cascade</NAME><USE>Boil</USE><TIME>15</TIME><AMOUNT>0.030</AMOUNT><ALPHA>6</ALPHA></HOP></HOPS>
    <YEASTS><YEAST><NAME>US-05</NAME><AMOUNT>0.1</AMOUNT></YEAST></YEASTS>
  </RECIPE>
  <RECIPE><NAME>Import Porter</NAME><VERSION>1</VERSION><TYPE>All Grain</TYPE><BATCH_SIZE>20</BATCH_SIZE><BOIL_SIZE>24</BOIL_SIZE><BOIL_TIME>30</BOIL_TIME></RECIPE>
</RECIPES>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.BREWLOG_TEST_URL || 'http://127.0.0.1:5173');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Username').fill(`import-${Date.now()}`);
  await page.getByLabel('Password', { exact: true }).fill('importpass123');
  await page.getByLabel('Confirm password').fill('importpass123');
  await page.locator('.login-card form button[type="submit"]').click();
  await page.getByRole('heading', { name: 'Batches' }).waitFor();
  await page.locator('.app-nav .ant-menu-item').filter({ hasText: 'Recipes' }).first().click();
  await page.getByRole('button', { name: 'Import recipes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import recipes' });
  await dialog.getByText('Import BeerXML (.xml) or Brewfather recipe JSON (.json) files.').waitFor();
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'two-recipes.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await dialog.getByRole('checkbox', { name: 'Import Pale Ale' }).check();
  await dialog.getByRole('switch').check();
  const cascade = dialog.locator('.import-ingredient-table .ant-table-row').filter({ hasText: 'Cascade' });
  await cascade.locator('.ant-select').first().click();
  await page.locator('.ant-select-dropdown:visible').getByText('Leave unlinked').click();
  await dialog.getByRole('button', { name: 'Import 1 recipe' }).click();
  await page.getByRole('heading', { name: 'Import Pale Ale' }).waitFor();
  if (await page.getByRole('heading', { name: 'Import Porter' }).count()) throw new Error('Unselected recipe was imported');
  await page.getByText('Cascade', { exact: true }).first().waitFor();
  const imported = await page.evaluate(async () => {
    const { openLocalDb, startBatchFromRecipe, syncNow } = await import('/client/db.ts');
    const session = await fetch('/api/me').then(response => response.json());
    const db = await openLocalDb(session.workspaces[0].id);
    const recipes = await db.execO("SELECT id FROM recipes WHERE name = 'Import Pale Ale'");
    const inputs = await db.execO('SELECT inputs_json FROM recipe_inputs WHERE id = ?', [recipes[0].id]);
    const hops = await db.execO("SELECT id, anchor_event_id, offset_seconds, details_json FROM recipe_events WHERE recipe_id = ? AND title = 'Cascade'", [recipes[0].id]);
    const hopInputs = await db.execO('SELECT inputs_json FROM recipe_event_inputs WHERE id = ?', [hops[0].id]);
    const items = await db.execO("SELECT name FROM inventory_items WHERE name = '2-row pale malt' OR name = 'Cascade'");
    const counts = await db.execO('SELECT id FROM inventory_counts');
    const sources = await db.execO('SELECT id FROM recipe_import_sources');
    const links = await db.execO('SELECT id FROM recipe_import_links');
    const recipe = (await db.execO('SELECT id, name, description FROM recipes WHERE id = ?', [recipes[0].id]))[0];
    const batchId = await startBatchFromRecipe(db, recipe, 'Imported recipe batch', session.account.id);
    const batchInputs = await db.execO('SELECT inputs_json FROM batch_recipe_inputs WHERE id = ?', [batchId]);
    const batchHopInputs = await db.execO(`SELECT i.inputs_json FROM batch_event_inputs i
      JOIN batch_events e ON e.id = i.id WHERE e.batch_id = ? AND e.title = 'Cascade'`, [batchId]);
    await syncNow(db, session.workspaces[0].id);
    return { inputs: JSON.parse(inputs[0].inputs_json), hop: hops[0], hopInputs: JSON.parse(hopInputs[0].inputs_json),
      items: items.map(item => item.name), counts: counts.length, sources: sources.length, links: links.length,
      batchInputs: JSON.parse(batchInputs[0].inputs_json), batchHopInputs: JSON.parse(batchHopInputs[0].inputs_json) };
  });
  if (imported.inputs.efficiency !== '72' || imported.inputs.est_og || imported.hop.offset_seconds !== -900
    || imported.hopInputs.alpha !== '6' || imported.items.join(',') !== '2-row pale malt'
    || imported.counts !== 0 || imported.sources !== 1 || imported.links !== 1
    || imported.batchInputs.efficiency !== '72' || imported.batchHopInputs.alpha !== '6') {
    throw new Error(`Incorrect imported data: ${JSON.stringify(imported)}`);
  }
  await page.getByRole('button', { name: 'Recipe settings' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original import' }).click();
  const download = await downloadPromise;
  if (download.suggestedFilename() !== 'two-recipes.xml') throw new Error('Wrong source filename');
  const saved = await readFile(await download.path());
  if (!saved.equals(Buffer.from(xml))) throw new Error('Original import bytes changed');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('BeerXML import, recipe selection, inventory choices, and source download passed');
} finally { await browser.close(); }
