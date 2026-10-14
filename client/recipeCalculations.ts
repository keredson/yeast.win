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
  sources: { targetLiters: string[]; originalGravity: string[]; finalGravity: string[];
    abvPct: string[]; colorSrm: string[] };
  unavailable: { targetLiters: string[]; originalGravity: string[]; finalGravity: string[];
    abvPct: string[]; colorSrm: string[] };
}

export const appMashEfficiencyPct = 75;

// Estimated as-is extract potential for grains without a recorded specification.
// Product and brewery values always take precedence over these broad defaults.
export const appGrainYields = { base: 78, kilned: 75, caramel: 70, roasted: 65, flaked: 70, other: 75 } as const;

export function grainClassForName(name: string): keyof typeof appGrainYields {
  const text = name.toLowerCase();
  if (/roast|chocolate|black|carafa|dehusk/.test(text)) return 'roasted';
  if (/crystal|caramel|cara(?!fa)/.test(text)) return 'caramel';
  if (/flak|torrif|rolled/.test(text)) return 'flaked';
  if (/munich|vienna|biscuit|aromatic|melanoidin|amber|brown malt/.test(text)) return 'kilned';
  if (/pale|pils|wheat malt|maris otter|two.row|2.row/.test(text)) return 'base';
  return 'other';
}

function positive(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// Only equipment linked to post-boil actions contributes to this estimate.
// A missing loss is treated as zero, not as an unrecorded equipment default.
export function estimatedPostBoilLoss(events: Event[], equipment: Equipment[]): number {
  const ids = new Set(events.filter(event => event.event_type === 'temperature_control'
    && ['boil', 'chill'].includes(String(event.details.phase || '')))
    .map(event => String(event.details.equipment_id || '')).filter(Boolean));
  for (const event of events) {
    if (event.event_type !== 'transfer' || event.details.purpose !== 'to_fermenter') continue;
    for (const id of event.details.transfer_equipment_ids || []) ids.add(id);
  }
  return [...ids].reduce((total, id) => total + Math.max(0,
    equipment.find(item => item.id === id)?.post_boil_loss_liters ?? 0), 0);
}

export function calculateRecipe(events: Event[], inventory: InventoryItem[], equipment: Equipment[],
  recipeInputs: Record<string, unknown>, eventInputs: Record<string, Record<string, unknown>>,
  recentMashEfficiency: Record<string, number | { value: number; batchName: string }> = {}, recipeType = 'beer',
  breweryMashEfficiencyPct: number | null = null, context: 'recipe' | 'batch' = 'recipe'): RecipeEstimate {
  const batch = context === 'batch';
  const missing: string[] = [];
  const gravityMissing: string[] = [];
  const colorMissing: string[] = [];
  const targetLiters = positive(recipeInputs.target_fermenter_volume_liters);
  const assumedSize = recipeInputs.batch_size_source === 'assumed_brewery' ? 'brewery default'
    : recipeInputs.batch_size_source === 'assumed_app' ? '5 US gal app default' : null;
  const targetSources = targetLiters ? [`Batch size: ${Number(targetLiters.toFixed(3))} L (${batch
    ? 'batch inputs' : assumedSize ? `assumed from ${assumedSize} because the recipe had no size` : 'recipe settings'}).`] : [];
  const targetHelp = batch ? 'Batch size is not set for this batch.' : 'Set Batch size in recipe settings.';
  if (!targetLiters) { missing.push(targetHelp); gravityMissing.push(targetHelp); colorMissing.push(targetHelp); }
  if (recipeType !== 'beer') return { targetLiters, originalGravity: null, finalGravity: null, abvPct: null, colorSrm: null,
    efficiencyLabel: null, missing: [...missing, `Gravity and alcohol estimates for this ${context} type need fermentable sugar inputs.`],
    sources: { targetLiters: targetSources, originalGravity: [], finalGravity: [], abvPct: [], colorSrm: [] },
    unavailable: { targetLiters: targetLiters ? [] : [targetHelp],
      originalGravity: [`Gravity estimates for this ${context} type need fermentable sugar inputs.`],
      finalGravity: [`Gravity estimates for this ${context} type need fermentable sugar inputs.`],
      abvPct: [`Alcohol estimates for this ${context} type need fermentable sugar inputs.`], colorSrm: [] } };

  const drain = events.find(event => event.event_type === 'transfer' && event.details.purpose === 'drain_grain');
  const drainDetails = drain?.details || {};
  const mash = events.find(event => event.id === drain?.anchor_event_id);
  const mashEquipmentId = String(drainDetails.mash_equipment_id || mash?.details.equipment_id || '');
  const mashEquipment = equipment.find(item => item.id === mashEquipmentId);
  const mashSpecs: EquipmentSpecifications = mashEquipment || {};
  const validEfficiency = (value: unknown) => { const parsed = positive(value); return parsed != null && parsed <= 100 ? parsed : null; };
  const importedBrewhouseEfficiency = validEfficiency(recipeInputs.brewhouse_efficiency_pct);
  const snapshotEfficiency = batch ? validEfficiency(eventInputs[drain?.id || '']?.mash_efficiency_pct) : null;
  const modelEfficiency = snapshotEfficiency ?? validEfficiency(mashSpecs.mash_efficiency_pct);
  const recentReading = recentMashEfficiency[mashEquipmentId];
  const recentEfficiency = validEfficiency(typeof recentReading === 'number' ? recentReading : recentReading?.value);
  const breweryEfficiency = validEfficiency(breweryMashEfficiencyPct);
  const mashEfficiency = modelEfficiency ?? recentEfficiency
    ?? (importedBrewhouseEfficiency == null ? breweryEfficiency ?? appMashEfficiencyPct : null);
  const gravitySources = [...targetSources];
  const colorSources = [...targetSources];
  let efficiencyLabel: string | null = null;
  let efficiency: number | null = null;
  let extractVolume: number | null = targetLiters;
  if (mashEfficiency != null) {
    const batchWortLoss = batch && recipeInputs.wort_loss_liters != null
      ? Math.max(0, Number(recipeInputs.wort_loss_liters)) : null;
    const wortLoss = batchWortLoss != null && Number.isFinite(batchWortLoss)
      ? batchWortLoss : estimatedPostBoilLoss(events, equipment);
    efficiency = mashEfficiency;
    extractVolume = targetLiters == null ? null : targetLiters + wortLoss;
    const source = snapshotEfficiency != null ? 'batch event input'
      : modelEfficiency != null ? `${batch ? 'equipment unit' : 'equipment model'} ${mashEquipment?.name || mashEquipmentId}`
      : recentEfficiency != null ? `batch ${typeof recentReading === 'object' ? recentReading.batchName : 'measurement'} using ${mashEquipment?.name || mashEquipmentId}`
        : breweryEfficiency != null ? 'brewery default' : 'app default';
    efficiencyLabel = `${mashEfficiency}% mash efficiency (${source}); ${wortLoss} L post-boil loss`;
    gravitySources.push(`Mash efficiency: ${mashEfficiency}% (${source}).`);
    const usedEquipment = new Set(events.filter(event => event.event_type === 'temperature_control'
      && ['boil', 'chill'].includes(String(event.details.phase || '')))
      .map(event => String(event.details.equipment_id || '')).filter(Boolean));
    for (const event of events.filter(event => event.event_type === 'transfer' && event.details.purpose === 'to_fermenter')) {
      for (const id of event.details.transfer_equipment_ids || []) usedEquipment.add(id);
    }
    const lossSources = [...usedEquipment].map(id => equipment.find(item => item.id === id))
      .filter((item): item is Equipment => !!item && (item.post_boil_loss_liters ?? 0) > 0)
      .map(item => `${item.name}: ${item.post_boil_loss_liters} L`);
    gravitySources.push(batchWortLoss != null && Number.isFinite(batchWortLoss)
      ? `Post-boil wort retained: ${wortLoss} L (batch input).`
      : `Post-boil wort retained: ${wortLoss} L${lossSources.length ? ` (${lossSources.join(', ')})` : ' (no linked equipment loss set)'}.`);
  }
  if (efficiency == null && importedBrewhouseEfficiency != null) {
    efficiency = importedBrewhouseEfficiency;
    efficiencyLabel = `${efficiency}% ${batch ? 'batch' : 'imported'} brewhouse efficiency`;
    gravitySources.push(`Brewhouse efficiency: ${efficiency}% (${batch ? 'batch input' : 'imported recipe'}).`);
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
    const item = inventory.find(row => row.id === details.inventory_item_id)
      || (details.supply_id ? inventory.find(row => row.id === details.supply_id
        || row.supply_id === details.supply_id) : undefined);
    const source = eventInputs[event.id] || {};
    const name = String(details.item_name || item?.name || event.title);
    const itemYield = positive(item?.yield_pct);
    const snapshotYield = positive(source.yield_pct);
    const recordedYield = batch ? snapshotYield ?? itemYield : itemYield ?? snapshotYield;
    const grainClass = String((batch ? source.grain_class || item?.grain_class : item?.grain_class || source.grain_class)
      || grainClassForName(name));
    const yieldPct = recordedYield ?? (details.item_category === 'Grain'
      ? appGrainYields[grainClass as keyof typeof appGrainYields] ?? appGrainYields.base : null);
    const pounds = convertUnit(Number(details.quantity), String(details.unit), 'lb');
    const rawColor = batch ? source.color_lovibond ?? item?.color_lovibond
      : item?.color_lovibond ?? source.color_lovibond;
    const color = rawColor == null || rawColor === '' ? null : Number(rawColor);
    if (pounds == null || pounds <= 0 || color == null || !Number.isFinite(color) || color < 0) colorReady = false;
    else maltColorUnits += pounds * color;
    const amount = `${details.quantity ?? 'unset'} ${details.unit || ''}`.trim();
    if (details.item_category === 'Grain') {
      const yieldSource = batch && snapshotYield != null ? 'batch event input'
        : itemYield != null ? 'brewery or catalog ingredient'
          : snapshotYield != null ? 'imported recipe'
          : `app estimate for ${grainClass} malt`;
      gravitySources.push(`${name}: ${amount} (${batch ? 'batch action' : 'recipe action'}); extract yield ${yieldPct ?? 'unset'}% (${yieldSource}).`);
      colorSources.push(`${name}: ${amount} (${batch ? 'batch action' : 'recipe action'}); color ${color ?? 'unset'} °L (${batch && source.color_lovibond != null ? 'batch event input' : item?.color_lovibond != null ? 'brewery or catalog ingredient' : source.color_lovibond != null ? 'imported recipe' : 'unset'}).`);
    }
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
    const item = inventory.find(row => row.id === details.inventory_item_id)
      || (details.supply_id ? inventory.find(row => row.id === details.supply_id
        || row.supply_id === details.supply_id) : undefined);
    const snapshot = positive(eventInputs[event.id]?.attenuation_pct);
    return batch ? snapshot ?? positive(item?.attenuation_pct) : positive(item?.attenuation_pct) ?? snapshot;
  });
  const attenuation = attenuations.length === 1 && attenuations[0] != null && attenuations[0] <= 100 ? attenuations[0] : null;
  const yeast = yeasts[0];
  const yeastItem = inventory.find(row => row.id === yeast?.details.inventory_item_id)
    || (yeast?.details.supply_id ? inventory.find(row => row.id === yeast.details.supply_id
      || row.supply_id === yeast.details.supply_id) : undefined);
  const finalSources = [originalGravity == null ? 'Expected OG is unavailable.' : `Expected OG: ${originalGravity.toFixed(3)} (calculated above).`];
  if (attenuation != null) finalSources.push(`Yeast attenuation: ${attenuation}% (${batch && yeast && positive(eventInputs[yeast.id]?.attenuation_pct) != null
    ? 'batch event input' : yeastItem ? `brewery ingredient ${yeastItem.name}` : `imported recipe ${yeast?.details.item_name || yeast?.title || 'yeast'}`}).`);
  const attenuationHelp = 'Select one yeast with an attenuation value.';
  if (!attenuation) missing.push(attenuationHelp);
  const finalGravity = originalGravity != null && attenuation != null
    ? 1 + (originalGravity - 1) * (1 - attenuation / 100) : null;
  const abvPct = finalGravity != null && originalGravity != null ? (originalGravity - finalGravity) * 131.25 : null;
  const abvSources = originalGravity != null && finalGravity != null
    ? [`Expected OG: ${originalGravity.toFixed(3)}.`, `Expected FG: ${finalGravity.toFixed(3)}.`,
      'ABV = (OG − FG) × 131.25.'] : [];
  if (colorSrm != null) colorSources.push('Color uses grain amounts, color values, batch size, and the Morey approximation.');

  return { targetLiters, originalGravity, finalGravity, abvPct, colorSrm,
    efficiencyLabel, missing: [...new Set(missing)],
    sources: { targetLiters: targetSources, originalGravity: gravitySources, finalGravity: finalSources,
      abvPct: abvSources, colorSrm: colorSources },
    unavailable: { targetLiters: targetLiters ? [] : [targetHelp], originalGravity: gravityMissing,
      finalGravity: [...gravityMissing, ...(!attenuation ? [attenuationHelp] : [])],
      abvPct: [...gravityMissing, ...(!attenuation ? [attenuationHelp] : [])], colorSrm: colorMissing } };
}
