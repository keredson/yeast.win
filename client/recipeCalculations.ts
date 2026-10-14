import type { Equipment, EquipmentSpecifications, InventoryItem, PlanInput } from './db.ts';
import { convertUnit } from '../shared/units.ts';

type Event = PlanInput & { id: string };
export interface RecipeEstimate {
  targetLiters: number | null;
  originalGravity: number | null;
  finalGravity: number | null;
  abvPct: number | null;
  colorSrm: number | null;
  efficiencyLabel: string | null;
  missing: string[];
  unavailable: { targetLiters: string[]; originalGravity: string[]; finalGravity: string[];
    abvPct: string[]; colorSrm: string[] };
}

function positive(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegative(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// Estimates deliberately use only explicit inputs. Mash efficiency requires
// an expected wort loss to translate kettle extract into fermenter gravity.
export function calculateRecipe(events: Event[], inventory: InventoryItem[], equipment: Equipment[],
  recipeInputs: Record<string, unknown>, eventInputs: Record<string, Record<string, unknown>>,
  recentMashEfficiency: Record<string, number> = {}, recipeType = 'beer'): RecipeEstimate {
  const missing: string[] = [];
  const gravityMissing: string[] = [];
  const colorMissing: string[] = [];
  const targetLiters = positive(recipeInputs.target_fermenter_volume_liters);
  const targetHelp = 'Set Batch size in recipe settings.';
  if (!targetLiters) { missing.push(targetHelp); gravityMissing.push(targetHelp); colorMissing.push(targetHelp); }
  if (recipeType !== 'beer') return { targetLiters, originalGravity: null, finalGravity: null, abvPct: null, colorSrm: null,
    efficiencyLabel: null, missing: [...missing, 'Gravity and alcohol estimates for this recipe type need fermentable sugar inputs.'],
    unavailable: { targetLiters: targetLiters ? [] : [targetHelp],
      originalGravity: ['Gravity estimates for this recipe type need fermentable sugar inputs.'],
      finalGravity: ['Gravity estimates for this recipe type need fermentable sugar inputs.'],
      abvPct: ['Alcohol estimates for this recipe type need fermentable sugar inputs.'], colorSrm: [] } };

  const drain = events.find(event => event.event_type === 'transfer' && event.details.purpose === 'drain_grain');
  const drainDetails = drain?.details || {};
  const mash = events.find(event => event.id === drain?.anchor_event_id);
  const mashEquipmentId = String(drainDetails.mash_equipment_id || mash?.details.equipment_id || '');
  const mashEquipment = equipment.find(item => item.id === mashEquipmentId);
  const mashSpecs: EquipmentSpecifications = mashEquipment || {};
  const importedBrewhouseEfficiency = positive(recipeInputs.brewhouse_efficiency_pct);
  const mashEfficiency = positive(mashSpecs.mash_efficiency_pct) ?? positive(recentMashEfficiency[mashEquipmentId]);
  let efficiencyLabel: string | null = null;
  let efficiency: number | null = null;
  let extractVolume: number | null = targetLiters;
  if (mashEfficiency != null) {
    const wortLoss = nonNegative(recipeInputs.wort_loss_liters);
    if (wortLoss != null) {
      efficiency = mashEfficiency;
      extractVolume = targetLiters == null ? null : targetLiters + wortLoss;
      efficiencyLabel = `${mashEfficiency}% mash efficiency${mashSpecs.mash_efficiency_pct == null ? ' (recent batch)' : ''}; ${wortLoss} L wort loss`;
    } else if (importedBrewhouseEfficiency == null) {
      const message = 'Set expected wort loss in brewery or recipe settings to use mash efficiency.';
      missing.push(message); gravityMissing.push(message);
    }
  }
  if (efficiency == null && importedBrewhouseEfficiency != null && importedBrewhouseEfficiency <= 100) {
    efficiency = importedBrewhouseEfficiency;
    efficiencyLabel = `${efficiency}% imported brewhouse efficiency`;
  } else if (efficiency == null && mashEfficiency == null) {
    const message = 'Set mash efficiency on the mash equipment, or import a brewhouse efficiency.';
    missing.push(message); gravityMissing.push(message);
  }

  let potentialPointGallons = 0;
  let maltColorUnits = 0;
  let colorReady = true;
  let grainCount = 0;
  for (const event of events) {
    if (event.event_type !== 'addition') continue;
    const details = event.details;
    if (details.item_category !== 'Grain' && details.item_category !== 'Adjunct') continue;
    if (details.item_category === 'Adjunct') {
      const message = 'Gravity estimates do not yet include adjunct extract.';
      missing.push(message); gravityMissing.push(message);
    }
    if (details.item_category === 'Grain') grainCount++;
    const item = inventory.find(row => row.id === (details.supply_id || details.inventory_item_id));
    const source = eventInputs[event.id] || {};
    const yieldPct = positive(item ? item.yield_pct : source.yield_pct);
    const pounds = convertUnit(Number(details.quantity), String(details.unit), 'lb');
    const rawColor = item ? item.color_lovibond : source.color_lovibond;
    const color = rawColor == null || rawColor === '' ? null : Number(rawColor);
    if (pounds == null || pounds <= 0 || color == null || !Number.isFinite(color) || color < 0) colorReady = false;
    else maltColorUnits += pounds * color;
    if (details.item_category === 'Adjunct') continue;
    if (yieldPct == null || yieldPct > 100 || pounds == null || pounds <= 0) {
      const message = `Set an amount and extract yield for ${details.item_name || event.title}.`;
      missing.push(message); gravityMissing.push(message);
      continue;
    }
    potentialPointGallons += pounds * 46 * yieldPct / 100;
  }
  if (!grainCount) { const message = 'Add grain with an amount and extract yield.';
    missing.push(message); gravityMissing.push(message); }
  const canEstimateGravity = !!targetLiters && !!efficiency && grainCount > 0
    && !gravityMissing.some(message => message.includes('adjunct') || message.startsWith('Set an amount'));
  const gallons = extractVolume == null ? null : convertUnit(extractVolume, 'L', 'US gal');
  const targetGallons = targetLiters == null ? null : convertUnit(targetLiters, 'L', 'US gal');
  // Morey's beer color approximation from malt color units (MCU).
  // https://beersmith.com/BeerSmithHelp.pdf
  const colorSrm = colorReady && targetGallons && targetGallons > 0 && maltColorUnits > 0
    ? 1.4922 * (maltColorUnits / targetGallons) ** 0.6859 : null;
  if (grainCount && !colorReady) { const message = 'Set an amount and color value for each fermentable.';
    missing.push(message); colorMissing.push(message); }
  if (!grainCount) colorMissing.push('Add grain with an amount and color value.');
  if (grainCount && colorReady && maltColorUnits <= 0) colorMissing.push('Set a color value above zero for a fermentable.');
  const originalGravity = canEstimateGravity && gallons && gallons > 0
    ? 1 + potentialPointGallons * efficiency! / 100 / gallons / 1000 : null;

  const yeasts = events.filter(event => event.event_type === 'addition' && event.details.item_category === 'Yeast');
  const attenuations = yeasts.map(event => {
    const details = event.details;
    const item = inventory.find(row => row.id === (details.supply_id || details.inventory_item_id));
    return positive(item ? item.attenuation_pct : eventInputs[event.id]?.attenuation_pct);
  });
  const attenuation = attenuations.length === 1 && attenuations[0] != null && attenuations[0] <= 100 ? attenuations[0] : null;
  const attenuationHelp = 'Select one yeast with an attenuation value.';
  if (!attenuation) missing.push(attenuationHelp);
  const finalGravity = originalGravity != null && attenuation != null
    ? 1 + (originalGravity - 1) * (1 - attenuation / 100) : null;
  const abvPct = finalGravity != null && originalGravity != null ? (originalGravity - finalGravity) * 131.25 : null;

  return { targetLiters, originalGravity, finalGravity, abvPct, colorSrm,
    efficiencyLabel, missing: [...new Set(missing)],
    unavailable: { targetLiters: targetLiters ? [] : [targetHelp], originalGravity: gravityMissing,
      finalGravity: [...gravityMissing, ...(!attenuation ? [attenuationHelp] : [])],
      abvPct: [...gravityMissing, ...(!attenuation ? [attenuationHelp] : [])], colorSrm: colorMissing } };
}
