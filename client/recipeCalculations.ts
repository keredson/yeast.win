import type { Equipment, EquipmentSpecifications, InventoryRecord, PlanInput } from './db.ts';
import type { CatalogInventory } from '../shared/catalog.ts';
import { convertUnit } from '../shared/units.ts';

type Event = PlanInput & { id: string };
export interface RecipeEstimate {
  targetLiters: number | null;
  originalGravity: number | null;
  finalGravity: number | null;
  abvPct: number | null;
  usedAppYeastAttenuation: boolean;
  measuredOriginalGravity: boolean;
  measuredFinalGravity: boolean;
  colorSrm: number | null;
  efficiencyLabel: string | null;
  mashEfficiencyPct: number | null;
  measuredMashEfficiency: boolean;
  missing: string[];
  sources: { targetLiters: string[]; originalGravity: string[]; finalGravity: string[];
    abvPct: string[]; colorSrm: string[]; mashEfficiency: string[] };
  unavailable: { targetLiters: string[]; originalGravity: string[]; finalGravity: string[];
    abvPct: string[]; colorSrm: string[]; mashEfficiency: string[] };
}

export const appMashEfficiencyPct = 75;
export const appYeastAttenuationPct = 75;
export interface BatchGravityReadings { original?: number | null; final?: number | null }

// Estimated as-is extract potential for grains without a recorded specification.
// Product and brewery values always take precedence over these broad defaults.
export const appGrainYields = { base: 78, kilned: 75, caramel: 70, roasted: 65, flaked: 70, other: 75 } as const;

// Approximate sucrose-solution density at 20 °C for volume-based sweeteners.
// °Brix is mass percent soluble solids; this is an estimate for mixed sugars such as honey.
function brixDensity(brix: number): number {
  return 1 + brix / (258.6 - brix / 258.2 * 227.1);
}

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

export function calculateRecipe(events: Event[], inventory: InventoryRecord[], equipment: Equipment[],
  recipeInputs: Record<string, unknown>, eventInputs: Record<string, Record<string, unknown>>,
  recentMashEfficiency: Record<string, number | { value: number; batchName: string }> = {}, recipeType = 'beer',
  breweryMashEfficiencyPct: number | null = null, context: 'recipe' | 'batch' = 'recipe',
  catalog: CatalogInventory[] = [], readings: BatchGravityReadings = {}, measuredMashEfficiencyPct: number | null = null): RecipeEstimate {
  const batch = context === 'batch';
  const missing: string[] = [];
  const gravityMissing: string[] = [];
  const colorMissing: string[] = [];
  const targetLiters = positive(recipeInputs.target_fermenter_volume_liters);
  const assumedSize = recipeInputs.batch_size_source === 'assumed_brewery' ? 'brewery default'
    : recipeInputs.batch_size_source === 'assumed_app' ? '5 US gal app default' : null;
  const targetSources = targetLiters ? [`Batch size: ${Number(targetLiters.toFixed(3))} L (${batch
    ? assumedSize ? `assumed from ${assumedSize} because the batch has no size` : 'batch inputs'
    : assumedSize ? `assumed from ${assumedSize} because the recipe had no size` : 'recipe settings'}).`] : [];
  const targetHelp = batch ? 'Batch size is not set for this batch.' : 'Set Batch size in recipe settings.';
  if (!targetLiters) { missing.push(targetHelp); gravityMissing.push(targetHelp); colorMissing.push(targetHelp); }
  const ingredient = (event: Event) => {
    const details = event.details;
    const item = inventory.find(row => row.id === details.stock_bucket_id)
      || (details.supply_id ? inventory.find(row => row.id === details.supply_id
        || row.supply_id === details.supply_id) : undefined);
    const catalogItem = catalog.find(row => row.id === (details.catalog_item_id || item?.catalog_supply_id));
    return { item, catalogItem, category: catalogItem?.category || item?.category || details.item_category };
  };

  const drain = events.find(event => event.event_type === 'transfer' && event.details.purpose === 'drain_grain');
  const drainDetails = drain?.details || {};
  const mash = events.find(event => event.id === drain?.anchor_event_id);
  const mashEquipmentId = String(drainDetails.mash_equipment_id || mash?.details.equipment_id || '');
  const mashEquipment = equipment.find(item => item.id === mashEquipmentId);
  const mashSpecs: EquipmentSpecifications = mashEquipment || {};
  const hasGrain = recipeType === 'beer' && events.some(event => event.event_type === 'addition'
    && ingredient(event).category === 'Grain');
  const validEfficiency = (value: unknown) => { const parsed = positive(value); return parsed != null && parsed <= 100 ? parsed : null; };
  const importedBrewhouseEfficiency = validEfficiency(recipeInputs.brewhouse_efficiency_pct);
  const snapshotEfficiency = batch ? validEfficiency(eventInputs[drain?.id || '']?.mash_efficiency_pct) : null;
  const modelEfficiency = snapshotEfficiency ?? validEfficiency(mashSpecs.mash_efficiency_pct);
  const recentReading = recentMashEfficiency[mashEquipmentId];
  const recentEfficiency = validEfficiency(typeof recentReading === 'number' ? recentReading : recentReading?.value);
  const breweryEfficiency = validEfficiency(breweryMashEfficiencyPct);
  const measuredEfficiency = batch && measuredMashEfficiencyPct != null
    && Number.isFinite(measuredMashEfficiencyPct) && measuredMashEfficiencyPct >= 0 && measuredMashEfficiencyPct <= 105
    ? measuredMashEfficiencyPct : null;
  const mashEfficiency = hasGrain ? measuredEfficiency ?? modelEfficiency ?? recentEfficiency
    ?? (importedBrewhouseEfficiency == null ? breweryEfficiency ?? appMashEfficiencyPct : null) : null;
  const gravitySources = [...targetSources];
  const colorSources = [...targetSources];
  let efficiencyLabel: string | null = null;
  let mashEfficiencySource: string | null = null;
  let efficiency: number | null = null;
  let extractVolume: number | null = targetLiters;
  if (mashEfficiency != null) {
    const batchWortLoss = batch && recipeInputs.wort_loss_liters != null
      ? Math.max(0, Number(recipeInputs.wort_loss_liters)) : null;
    const wortLoss = batchWortLoss != null && Number.isFinite(batchWortLoss)
      ? batchWortLoss : estimatedPostBoilLoss(events, equipment);
    efficiency = mashEfficiency;
    extractVolume = targetLiters == null ? null : targetLiters + wortLoss;
    const source = measuredEfficiency != null ? 'this batch’s grain additions, collected wort volume, and pre-boil gravity'
      : snapshotEfficiency != null ? 'batch event input'
      : modelEfficiency != null ? `${batch ? 'equipment unit' : 'equipment model'} ${mashEquipment?.name || mashEquipmentId}`
      : recentEfficiency != null ? `batch ${typeof recentReading === 'object' ? recentReading.batchName : 'measurement'} using ${mashEquipment?.name || mashEquipmentId}`
        : breweryEfficiency != null ? 'brewery default' : 'app default';
    mashEfficiencySource = source;
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
  if (hasGrain && efficiency == null && importedBrewhouseEfficiency != null) {
    efficiency = importedBrewhouseEfficiency;
    efficiencyLabel = `${efficiency}% ${batch ? 'batch' : 'imported'} brewhouse efficiency`;
    gravitySources.push(`Brewhouse efficiency: ${efficiency}% (${batch ? 'batch input' : 'imported recipe'}).`);
  } else if (hasGrain && efficiency == null && mashEfficiency == null) {
    const message = 'Set mash efficiency on the mash equipment, or import a brewhouse efficiency.';
    missing.push(message); gravityMissing.push(message);
  }

  let potentialPointGallons = 0;
  let maltColorUnits = 0;
  let colorReady = true;
  let grainCount = 0;
  let sugarCount = 0;
  let sugarPointGallons = 0;
  for (const event of events) {
    if (event.event_type !== 'addition') continue;
    const details = event.details;
    const { item, catalogItem, category } = ingredient(event);
    if (category === 'Other fermentables') {
      const name = String(details.item_name || event.title);
      if (recipeType === 'beer') {
        colorMissing.push(`Estimated beer color does not yet include ${name}.`);
        colorReady = false;
      }
      const brix = positive(item?.typical_brix ?? catalogItem?.typical_brix);
      const amount = positive(details.quantity);
      const unit = String(details.unit || '');
      const pounds = amount == null ? null : convertUnit(amount, unit, 'lb');
      const liters = amount == null ? null : convertUnit(amount, unit, 'L');
      if (brix == null || brix > 100 || (pounds == null && liters == null)) {
        gravityMissing.push(`Set an amount and typical °Brix for ${name} to estimate OG.`);
        continue;
      }
      const sugarPounds = (pounds ?? (liters! * brixDensity(brix) / 0.45359237)) * brix / 100;
      sugarPointGallons += sugarPounds * 46;
      sugarCount++;
      gravitySources.push(`${name}: ${amount} ${unit}; ${brix} °Brix (${item?.typical_brix != null
        ? 'brewery ingredient' : 'catalog ingredient'}); sugar contributes without mash efficiency.`);
      continue;
    }
    if (recipeType !== 'beer' || category !== 'Grain' && category !== 'Adjunct') continue;
    if (category === 'Adjunct') {
      const message = 'Gravity estimates do not yet include adjunct extract.';
      missing.push(message); gravityMissing.push(message);
    }
    if (category === 'Grain') grainCount++;
    const source = eventInputs[event.id] || {};
    const name = String(details.item_name || item?.name || catalogItem?.name || event.title);
    const itemYield = positive(item?.yield_pct ?? catalogItem?.yield_pct);
    const snapshotYield = positive(source.yield_pct);
    const recordedYield = batch ? snapshotYield ?? itemYield : itemYield ?? snapshotYield;
    const grainClass = String((batch ? source.grain_class || item?.grain_class || catalogItem?.grain_class
      : item?.grain_class || catalogItem?.grain_class || source.grain_class)
      || grainClassForName(name));
    const yieldPct = recordedYield ?? (category === 'Grain'
      ? appGrainYields[grainClass as keyof typeof appGrainYields] ?? appGrainYields.base : null);
    const pounds = convertUnit(Number(details.quantity), String(details.unit), 'lb');
    const rawColor = batch ? source.color_lovibond ?? item?.color_lovibond ?? catalogItem?.color_lovibond
      : item?.color_lovibond ?? catalogItem?.color_lovibond ?? source.color_lovibond;
    const color = rawColor == null || rawColor === '' ? null : Number(rawColor);
    if (pounds == null || pounds <= 0 || color == null || !Number.isFinite(color) || color < 0) colorReady = false;
    else maltColorUnits += pounds * color;
    const amount = `${details.quantity ?? 'unset'} ${details.unit || ''}`.trim();
    if (category === 'Grain') {
      const yieldSource = batch && snapshotYield != null ? 'batch event input'
        : itemYield != null ? 'brewery or catalog ingredient'
          : snapshotYield != null ? 'imported recipe'
          : `app estimate for ${grainClass} malt`;
      gravitySources.push(`${name}: ${amount} (${batch ? 'batch action' : 'recipe action'}); extract yield ${yieldPct ?? 'unset'}% (${yieldSource}).`);
      colorSources.push(`${name}: ${amount} (${batch ? 'batch action' : 'recipe action'}); color ${color ?? 'unset'} °L (${batch && source.color_lovibond != null ? 'batch event input' : item?.color_lovibond != null || catalogItem?.color_lovibond != null ? 'brewery or catalog ingredient' : source.color_lovibond != null ? 'imported recipe' : 'unset'}).`);
    }
    if (category === 'Adjunct') continue;
    if (yieldPct == null || yieldPct > 100 || pounds == null || pounds <= 0) {
      const message = `Set an amount and extract yield for ${details.item_name || event.title}.`;
      missing.push(message); gravityMissing.push(message);
      continue;
    }
    potentialPointGallons += pounds * 46 * yieldPct / 100;
  }
  if (!grainCount && !sugarCount) { const message = recipeType === 'beer'
    ? 'Add grain or another fermentable with an amount and extract yield or °Brix.'
    : 'Add a fermentable with an amount and typical °Brix.';
    missing.push(message); gravityMissing.push(message); }
  const canEstimateGravity = !!targetLiters && (grainCount === 0 || efficiency != null) && (grainCount > 0 || sugarCount > 0)
    && !gravityMissing.some(message => message.includes('adjunct') || message.startsWith('Set an amount')
      || message.startsWith('Expected OG does not yet include'));
  const gallons = extractVolume == null ? null : convertUnit(extractVolume, 'L', 'US gal');
  const targetGallons = targetLiters == null ? null : convertUnit(targetLiters, 'L', 'US gal');
  // Morey's beer color approximation from malt color units (MCU).
  // https://beersmith.com/BeerSmithHelp.pdf
  const colorSrm = recipeType === 'beer' && colorReady && targetGallons && targetGallons > 0 && maltColorUnits > 0
    ? 1.4922 * (maltColorUnits / targetGallons) ** 0.6859 : null;
  if (recipeType === 'beer' && grainCount && !colorReady) { const message = 'Set an amount and color value for each fermentable.';
    missing.push(message); colorMissing.push(message); }
  if (recipeType === 'beer' && !grainCount) colorMissing.push('Add grain with an amount and color value.');
  if (recipeType === 'beer' && grainCount && colorReady && maltColorUnits <= 0) colorMissing.push('Set a color value above zero for a fermentable.');
  const estimatedOriginalGravity = canEstimateGravity && gallons && gallons > 0
    ? 1 + (potentialPointGallons * (efficiency ?? 0) / 100 + sugarPointGallons) / gallons / 1000 : null;
  const measuredGravity = (value: unknown) => { const parsed = Number(value); return value != null
    && Number.isFinite(parsed) && parsed > 0.9 && parsed < 2 ? parsed : null; };
  const recordedOriginalGravity = batch ? measuredGravity(readings.original) : null;
  const recordedFinalGravity = batch ? measuredGravity(readings.final) : null;
  const originalGravity = recordedOriginalGravity ?? estimatedOriginalGravity;
  const measuredOriginalGravity = recordedOriginalGravity != null;
  const measuredFinalGravity = recordedFinalGravity != null;
  if (recordedOriginalGravity != null) gravitySources.unshift(`Measured OG: ${recordedOriginalGravity.toFixed(3)} (batch gravity reading).`);

  const yeasts = events.filter(event => event.event_type === 'addition' && ingredient(event).category === 'Yeast');
  const yeast = yeasts[0];
  const { item: yeastItem, catalogItem: catalogYeast } = yeast ? ingredient(yeast)
    : { item: undefined, catalogItem: undefined };
  const validAttenuation = (value: unknown) => { const parsed = positive(value); return parsed != null && parsed <= 100 ? parsed : null; };
  const snapshotAttenuation = validAttenuation(eventInputs[yeast?.id || '']?.attenuation_pct);
  const itemAttenuation = validAttenuation(yeastItem?.attenuation_pct ?? catalogYeast?.attenuation_pct);
  const recordedAttenuation = batch ? snapshotAttenuation ?? itemAttenuation : itemAttenuation ?? snapshotAttenuation;
  const usedAppYeastAttenuation = !measuredFinalGravity && yeasts.length === 1 && recordedAttenuation == null;
  const attenuation = yeasts.length === 1 ? recordedAttenuation ?? appYeastAttenuationPct : null;
  const finalSources = recordedFinalGravity != null ? [`Measured FG: ${recordedFinalGravity.toFixed(3)} (batch gravity reading).`]
    : [originalGravity == null ? 'OG is unavailable.' : `${measuredOriginalGravity ? 'Measured' : 'Expected'} OG: ${originalGravity.toFixed(3)}.`];
  if (!measuredFinalGravity && attenuation != null) finalSources.push(`Yeast apparent attenuation: ${attenuation}% (${recordedAttenuation == null
    ? 'app estimate; selected yeast has no attenuation value'
    : batch && snapshotAttenuation != null ? 'batch event input'
      : itemAttenuation != null && (yeastItem || catalogYeast) ? `brewery or catalog ingredient ${(yeastItem || catalogYeast)!.name}`
        : `imported recipe ${yeast?.details.item_name || yeast?.title || 'yeast'}`}).`);
  const attenuationHelp = measuredFinalGravity ? null : yeasts.length === 0 ? 'Add a yeast addition to estimate final gravity.'
    : yeasts.length > 1 ? 'Final gravity with multiple yeast additions needs a blend calculation.' : null;
  if (attenuationHelp) missing.push(attenuationHelp);
  const finalGravity = recordedFinalGravity ?? (originalGravity != null && attenuation != null
    ? 1 + (originalGravity - 1) * (1 - attenuation / 100) : null);
  const abvPct = finalGravity != null && originalGravity != null ? (originalGravity - finalGravity) * 131.25 : null;
  const abvSources = originalGravity != null && finalGravity != null
    ? [`${measuredOriginalGravity ? 'Measured' : 'Expected'} OG: ${originalGravity.toFixed(3)}.`,
      `${measuredFinalGravity ? 'Measured' : 'Expected'} FG: ${finalGravity.toFixed(3)}.`,
      ...finalSources.slice(1), 'ABV = (OG − FG) × 131.25.'] : [];
  if (colorSrm != null) colorSources.push('Color uses grain amounts, color values, batch size, and the Morey approximation.');

  return { targetLiters, originalGravity, finalGravity, abvPct, usedAppYeastAttenuation,
    measuredOriginalGravity, measuredFinalGravity, colorSrm,
    efficiencyLabel, mashEfficiencyPct: mashEfficiency, measuredMashEfficiency: measuredEfficiency != null,
    missing: [...new Set(missing)],
    sources: { targetLiters: targetSources, originalGravity: gravitySources, finalGravity: finalSources,
      abvPct: abvSources, colorSrm: colorSources, mashEfficiency: mashEfficiency == null ? []
        : [`${measuredEfficiency == null ? 'Assumed' : 'Measured'} mash efficiency: ${mashEfficiency}% (${mashEfficiencySource}).`] },
    unavailable: { targetLiters: targetLiters ? [] : [targetHelp], originalGravity: originalGravity == null ? gravityMissing : [],
      finalGravity: finalGravity == null ? [...(originalGravity == null ? gravityMissing : []),
        ...(attenuationHelp ? [attenuationHelp] : [])] : [],
      abvPct: abvPct == null ? [...(originalGravity == null ? gravityMissing : []),
        ...(finalGravity == null && attenuationHelp ? [attenuationHelp] : [])] : [], colorSrm: colorMissing,
      mashEfficiency: mashEfficiency == null ? ['Set a mash efficiency assumption or record grain additions, collected wort volume, and pre-boil gravity.'] : [] } };
}
