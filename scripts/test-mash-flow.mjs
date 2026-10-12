import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto(process.env.BREWLOG_TEST_URL || 'http://127.0.0.1:5173');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Username').fill(`mash-${Date.now()}`);
  await page.getByLabel('Password', { exact: true }).fill('mashflowpass123');
  await page.getByLabel('Confirm password').fill('mashflowpass123');
  await page.locator('.login-card form button[type="submit"]').click();
  await page.getByRole('heading', { name: 'Batches' }).waitFor();
  const result = await page.evaluate(async () => {
    const api = await import('/client/db.ts');
    const session = await fetch('/api/me').then(response => response.json());
    const db = await api.openLocalDb(session.workspaces[0].id);
    const equipmentId = await api.createEquipment(db, 'Mash system', 'all_in_one');
    const equipment = { id: equipmentId, name: 'Mash system', kind: 'all_in_one', specification_json: null };
    await api.updateBrewingLosses(db, equipment, { mash_efficiency_pct: 75,
      grain_absorption_l_per_kg: 0.8, mash_deadspace_liters: 0.5, kettle_retention_liters: 1 });
    const itemId = await api.createInventoryItem(db, 'Test malt', 'Grain', 'kg');
    const item = { id: itemId, name: 'Test malt', category: 'Grain', default_unit: 'kg', display_unit: 'kg', location_id: null };
    await api.updateIngredientProperties(db, item, { yield_pct: 80, color_lovibond: 2 });
    const recipeId = await api.createRecipe(db, 'Mash test beer', '', 'beer');
    await api.updateRecipeTargetVolume(db, recipeId, 19);
    const plans = await api.listRecipePlans(db, recipeId);
    const mash = plans.find(plan => plan.title === 'Mash');
    const drain = plans.find(plan => plan.title === 'Drain grain');
    const grain = plans.find(plan => plan.title === 'Add fermentable');
    if (!mash || !drain || !grain) throw new Error('Beer template lacks mash, grain drain, or fermentable');
    await api.updateRecipePlan(db, recipeId, mash.id, { ...mash,
      details_json: JSON.stringify({ ...JSON.parse(mash.details_json), equipment_id: equipmentId }) });
    await api.updateRecipePlan(db, recipeId, drain.id, { ...drain,
      details_json: JSON.stringify({ ...JSON.parse(drain.details_json), mash_equipment_id: equipmentId,
        to_vessel_id: equipmentId }) });
    await api.updateRecipePlan(db, recipeId, grain.id, { ...grain, title: 'Test malt',
      details_json: JSON.stringify({ ...JSON.parse(grain.details_json), item_name: 'Test malt',
        inventory_item_id: itemId, quantity: 4.5, unit: 'kg' }) });
    const recipe = { id: recipeId, name: 'Mash test beer', description: null, recipe_type: 'beer' };
    const batchId = await api.startBatchFromRecipe(db, recipe, 'First mash', session.account.id);
    const inputs = await db.execO('SELECT inputs_json FROM batch_recipe_inputs WHERE id = ?', [batchId]);
    const drainBatch = (await db.execO('SELECT id FROM batch_events WHERE batch_id = ? AND title = ?', [batchId, 'Drain grain']))[0];
    const drainInputs = await db.execO('SELECT inputs_json FROM batch_event_inputs WHERE id = ?', [drainBatch.id]);
    const grainBatch = (await db.execO('SELECT id FROM batch_events WHERE batch_id = ? AND title = ?', [batchId, 'Test malt']))[0];
    const grainInputs = await db.execO('SELECT inputs_json FROM batch_event_inputs WHERE id = ?', [grainBatch.id]);
    const gravityBatch = (await db.execO('SELECT id FROM batch_events WHERE batch_id = ? AND title = ?', [batchId, 'Measure pre-boil gravity']))[0];
    const at = Math.floor(Date.now() / 1000);
    for (const id of [grainBatch.id, drainBatch.id, gravityBatch.id])
      await db.exec('UPDATE batch_events SET actual_at = ? WHERE id = ?', [at, id]);
    await db.exec('INSERT INTO transfers(event_id, to_vessel_id, quantity, unit) VALUES (?, ?, ?, ?)',
      [drainBatch.id, equipmentId, 20, 'L']);
    await db.exec('INSERT INTO additions(event_id, inventory_item_id, item_name, quantity, unit) VALUES (?, ?, ?, ?, ?)',
      [grainBatch.id, itemId, 'Test malt', 4.5, 'kg']);
    await db.exec('INSERT INTO gravity_measurements(event_id, value, unit) VALUES (?, ?, ?)', [gravityBatch.id, 1.05, 'SG']);
    const measured = await api.latestMeasuredMashEfficiency(db, equipmentId);
    await api.updateIngredientProperties(db, item, { yield_pct: 75, color_lovibond: 3 });
    const current = (await db.execO('SELECT * FROM equipment WHERE id = ?', [equipmentId]))[0];
    await api.updateBrewingLosses(db, current, { mash_efficiency_pct: null });
    const nextBatchId = await api.startBatchFromRecipe(db, recipe, 'Second mash', session.account.id);
    const nextDrain = (await db.execO('SELECT id FROM batch_events WHERE batch_id = ? AND title = ?', [nextBatchId, 'Drain grain']))[0];
    const nextInputs = await db.execO('SELECT inputs_json FROM batch_event_inputs WHERE id = ?', [nextDrain.id]);
    const nextGrain = (await db.execO('SELECT id FROM batch_events WHERE batch_id = ? AND title = ?', [nextBatchId, 'Test malt']))[0];
    const nextGrainInputs = await db.execO('SELECT inputs_json FROM batch_event_inputs WHERE id = ?', [nextGrain.id]);
    await api.syncNow(db, session.workspaces[0].id);
    return { recipeId, target: await api.recipeTargetVolume(db, recipeId),
      recipeInputs: JSON.parse(inputs[0].inputs_json), drainInputs: JSON.parse(drainInputs[0].inputs_json),
      grainInputs: JSON.parse(grainInputs[0].inputs_json), measured,
      nextInputs: JSON.parse(nextInputs[0].inputs_json), nextGrainInputs: JSON.parse(nextGrainInputs[0].inputs_json) };
  });
  if (result.target !== 19 || result.recipeInputs.target_fermenter_volume_liters !== 19
    || result.drainInputs.equipment_assumptions.mash_efficiency_pct !== 75
    || result.drainInputs.equipment_assumptions.grain_absorption_l_per_kg !== 0.8
    || result.grainInputs.ingredient_properties.yield_pct !== 80
    || Math.abs(result.measured - 72.02) > 1
    || result.nextInputs.equipment_assumptions.mash_efficiency_pct !== result.measured
    || result.nextGrainInputs.ingredient_properties.yield_pct !== 75) {
    throw new Error(`Incorrect mash data: ${JSON.stringify(result)}`);
  }
  await page.goto(`${process.env.BREWLOG_TEST_URL || 'http://127.0.0.1:5173'}/recipe/${result.recipeId}`);
  await page.getByText('Drain grain').first().waitFor();
  await page.getByText('Measure pre-boil gravity').first().waitFor();
  const details = page.getByRole('region', { name: 'Recipe details' });
  await details.getByRole('heading', { name: 'Details' }).waitFor();
  const og = await details.locator('.recipe-estimate-grid > div').filter({ hasText: 'Expected OG' }).locator('strong').textContent();
  const color = await details.locator('.recipe-estimate-grid > div').filter({ hasText: 'Estimated color' }).locator('strong').textContent();
  if (!og || Number(og) <= 1.04 || !color?.includes('SRM')) throw new Error('Recipe estimates did not render');
  await page.getByRole('button', { name: 'Recipe settings' }).click();
  const target = page.getByRole('spinbutton', { name: 'Target volume into fermenter (optional)' });
  if (Number(await target.inputValue()) !== 19) throw new Error('Recipe target volume is missing from settings');
  await page.getByRole('dialog', { name: 'Recipe settings' }).getByRole('combobox', { name: 'Unit' }).click();
  await page.locator('.ant-select-dropdown:visible').getByText('US gal').click();
  if (Math.abs(Number(await target.inputValue()) - 5.019) > 0.01) throw new Error('Target volume did not convert with its unit');
  await page.getByRole('dialog', { name: 'Recipe settings' }).locator('.ant-modal-close').click();
  await page.getByRole('button', { name: 'Edit planned event Drain grain' }).click();
  await page.getByText('Mash equipment').waitFor();
  await page.getByText('Collecting vessel (optional)').waitFor();
  console.log('Mash transfer, equipment losses, ingredient properties, snapshots, and recent efficiency passed');
} finally { await browser.close(); }
