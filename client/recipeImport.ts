import type { RecipeType } from './db.ts';

export interface ImportedIngredient { key: string; name: string; category: string }
export interface ImportedAction {
  key: string; eventType: string; title: string; anchorKey: string | null; offsetSeconds: number;
  details: Record<string, string | number>; inputs: Record<string, unknown>; ingredientKey?: string;
}
export interface ImportedRecipe {
  sourceIndex: number; externalId?: string; name: string; description: string; type: RecipeType;
  inputs: Record<string, unknown>; actions: ImportedAction[]; ingredients: ImportedIngredient[]; warnings: string[];
}
export interface ImportDocument { format: 'beerxml' | 'brewfather_json'; recipes: ImportedRecipe[] }

function ingredientKey(category: string, name: string): string {
  return `${category}:${name.trim().toLocaleLowerCase()}`;
}

function number(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter(row => Object.keys(row).length > 0) : [];
}
function picked(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => row[key] != null).map(key => [key, row[key]]));
}

function builder(sourceIndex: number, name: string, description: string, type: RecipeType,
  inputs: Record<string, unknown>, externalId?: string) {
  const actions: ImportedAction[] = [];
  const ingredients = new Map<string, ImportedIngredient>();
  const warnings: string[] = [];
  function action(eventType: string, title: string, anchorKey: string | null, offsetSeconds: number,
    details: Record<string, string | number> = {}, sourceInputs: Record<string, unknown> = {}, ingredient?: { name: string; category: string }) {
    const key = `action-${actions.length}`;
    let ingredientRef: string | undefined;
    if (ingredient) {
      ingredientRef = ingredientKey(ingredient.category, ingredient.name);
      ingredients.set(ingredientRef, { key: ingredientRef, ...ingredient });
      details.item_category = ingredient.category;
      details.item_name = ingredient.name;
    }
    actions.push({ key, eventType, title, anchorKey, offsetSeconds, details, inputs: sourceInputs, ingredientKey: ingredientRef });
    return key;
  }
  return { actions, warnings, action, finish: (): ImportedRecipe => ({ sourceIndex, externalId, name, description, type,
    inputs, actions, ingredients: [...ingredients.values()], warnings }) };
}

function child(element: Element, name: string): Element | undefined {
  return [...element.children].find(item => item.localName.toUpperCase() === name);
}
function children(element: Element, parent: string, name: string): Element[] {
  const container = child(element, parent);
  return container ? [...container.children].filter(item => item.localName.toUpperCase() === name) : [];
}
function tag(element: Element, name: string): string { return child(element, name)?.textContent?.trim() || ''; }
function tagNumber(element: Element, name: string): number | undefined { return number(tag(element, name)); }
function xmlInputs(element: Element, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map(name => [name.toLowerCase(), tag(element, name)])
    .filter(([, value]) => value !== ''));
}

function parseBeerXmlRecipe(element: Element, sourceIndex: number): ImportedRecipe {
  const name = tag(element, 'NAME');
  if (!name) throw new Error(`Recipe ${sourceIndex + 1} has no name`);
  const style = child(element, 'STYLE');
  const equipment = child(element, 'EQUIPMENT');
  const mash = child(element, 'MASH');
  const inputs = {
    format: 'beerxml',
    ...xmlInputs(element, ['TYPE', 'BATCH_SIZE', 'BOIL_SIZE', 'BOIL_TIME', 'EFFICIENCY', 'BREWER',
      'PRIMARY_AGE', 'PRIMARY_TEMP', 'SECONDARY_AGE', 'SECONDARY_TEMP', 'TERTIARY_AGE', 'TERTIARY_TEMP']),
    ...(style ? { style: xmlInputs(style, ['NAME', 'CATEGORY', 'CATEGORY_NUMBER', 'STYLE_LETTER', 'STYLE_GUIDE']) } : {}),
    ...(equipment ? { equipment: xmlInputs(equipment, ['NAME', 'MASH_TUN_VOLUME', 'TUN_VOLUME', 'TRUB_CHILLER_LOSS', 'EVAP_RATE', 'LAUTER_DEADSPACE', 'TOP_UP_KETTLE', 'HOP_UTILIZATION']) } : {}),
    ...(mash ? { mash: xmlInputs(mash, ['NAME', 'GRAIN_TEMP', 'SPARGE_TEMP', 'PH']) } : {}),
    water: children(element, 'WATERS', 'WATER').map(water =>
      xmlInputs(water, ['NAME', 'AMOUNT', 'CALCIUM', 'BICARBONATE', 'SULFATE', 'CHLORIDE', 'SODIUM', 'MAGNESIUM', 'PH']))
  };
  const build = builder(sourceIndex, name, tag(element, 'NOTES'), 'beer', inputs);
  let firstMash: string | null = null;
  let lastMash: string | null = null;
  for (const step of mash ? children(mash, 'MASH_STEPS', 'MASH_STEP') : []) {
    const duration = tagNumber(step, 'STEP_TIME');
    const temperature = tagNumber(step, 'STEP_TEMP');
    const details: Record<string, string | number> = { phase: 'mash', mode: 'hold' };
    if (temperature != null) { details.target_value = temperature; details.target_unit = '°C'; }
    if (duration != null && duration > 0) details.duration_seconds = Math.round(duration * 60);
    if (lastMash) details.anchor_point = 'end';
    const id = build.action('temperature_control', tag(step, 'NAME') || 'Mash', lastMash, 0, details,
      xmlInputs(step, ['TYPE', 'STEP_TEMP', 'STEP_TIME', 'RAMP_TIME', 'INFUSE_AMOUNT', 'INFUSE_TEMP']));
    firstMash ||= id;
    lastMash = id;
  }
  const drain = lastMash ? build.action('transfer', 'Drain grain', lastMash, 0,
    { purpose: 'drain_grain', anchor_point: 'end' }) : null;
  if (drain) {
    build.action('measurement', 'Measure pre-boil gravity', drain, 0, { measurement_kind: 'gravity', target_unit: 'SG' });
  }
  const boilMinutes = tagNumber(element, 'BOIL_TIME');
  let boil: string | null = null;
  if (boilMinutes != null && boilMinutes > 0) {
    boil = build.action('temperature_control', 'Boil', drain || lastMash, 0,
      { phase: 'boil', mode: 'heat', duration_seconds: Math.round(boilMinutes * 60),
        ...(!drain && lastMash ? { anchor_point: 'end' } : {}) }, { boil_time_minutes: boilMinutes });
  }
  for (const item of children(element, 'FERMENTABLES', 'FERMENTABLE')) {
    const itemName = tag(item, 'NAME');
    if (!itemName) continue;
    const type = tag(item, 'TYPE');
    const category = type === 'Grain' ? 'Grain' : 'Adjunct';
    const afterBoil = tag(item, 'ADD_AFTER_BOIL').toUpperCase() === 'TRUE';
    const anchor = afterBoil ? boil : type === 'Grain' ? firstMash || boil : boil || firstMash;
    const amount = tagNumber(item, 'AMOUNT');
    build.action('addition', itemName, anchor, 0,
      { ...(afterBoil && anchor ? { anchor_point: 'end' } : {}), ...(amount != null ? { quantity: amount, unit: 'kg' } : {}) },
      xmlInputs(item, ['TYPE', 'YIELD', 'COLOR', 'ADD_AFTER_BOIL', 'ORIGIN', 'SUPPLIER', 'MOISTURE', 'DIASTATIC_POWER', 'PROTEIN']),
      { name: itemName, category });
  }
  let yeastAnchor: string | null = boil || lastMash;
  for (const item of children(element, 'YEASTS', 'YEAST')) {
    const itemName = tag(item, 'NAME');
    if (!itemName) continue;
    const amount = tagNumber(item, 'AMOUNT');
    const isWeight = tag(item, 'AMOUNT_IS_WEIGHT').toUpperCase() === 'TRUE';
    const id = build.action('addition', `Pitch ${itemName}`, yeastAnchor, 0,
      { ...(yeastAnchor === boil && boil ? { anchor_point: 'end' } : {}),
        ...(amount != null ? { quantity: amount, unit: isWeight ? 'kg' : 'L' } : {}) },
      xmlInputs(item, ['TYPE', 'FORM', 'LABORATORY', 'PRODUCT_ID', 'ATTENUATION', 'AMOUNT_IS_WEIGHT']),
      { name: itemName, category: 'Yeast' });
    yeastAnchor = id;
  }
  for (const item of children(element, 'HOPS', 'HOP')) {
    const itemName = tag(item, 'NAME');
    if (!itemName) continue;
    const use = tag(item, 'USE');
    const minutes = tagNumber(item, 'TIME') || 0;
    const amount = tagNumber(item, 'AMOUNT');
    const isBoil = use === 'Boil' || use === 'First Wort';
    const isLate = use === 'Aroma' || use === 'Whirlpool';
    const anchor = isBoil || isLate ? boil : use === 'Mash' ? firstMash : yeastAnchor;
    const details: Record<string, string | number> = {
      ...(anchor === boil && boil ? { anchor_point: 'end' } : {}),
      ...(amount != null ? { quantity: amount * 1000, unit: 'g' } : {}),
      ...((use === 'Dry Hop' || use === 'Aroma') ? { note: `${use}: ${minutes} minutes in source` } : {})
    };
    if (use === 'Dry Hop') build.warnings.push(`${itemName}: dry-hop duration does not specify when to add it; timing needs review`);
    build.action('addition', itemName, anchor, isBoil ? -Math.round(minutes * 60) : 0, details,
      xmlInputs(item, ['USE', 'TIME', 'ALPHA', 'FORM', 'TYPE', 'BETA', 'HSI']), { name: itemName, category: 'Hops' });
  }
  for (const item of children(element, 'MISCS', 'MISC')) {
    const itemName = tag(item, 'NAME');
    if (!itemName) continue;
    const use = tag(item, 'USE');
    const minutes = tagNumber(item, 'TIME') || 0;
    const amount = tagNumber(item, 'AMOUNT');
    const weight = tag(item, 'AMOUNT_IS_WEIGHT').toUpperCase() !== 'FALSE';
    const category = tag(item, 'TYPE') === 'Water Agent' ? 'Chemical' : 'Adjunct';
    const anchor = use === 'Boil' ? boil : use === 'Mash' ? firstMash : yeastAnchor;
    build.action('addition', itemName, anchor, use === 'Boil' ? -Math.round(minutes * 60) : 0,
      { ...(use === 'Boil' && anchor ? { anchor_point: 'end' } : {}),
        ...(amount != null ? { quantity: weight ? amount * 1000 : amount, unit: weight ? 'g' : 'L' } : {}) },
      xmlInputs(item, ['TYPE', 'USE', 'TIME', 'AMOUNT_IS_WEIGHT', 'USE_FOR']), { name: itemName, category });
  }
  let fermentationAnchor = yeastAnchor;
  let priorFermentationStep = false;
  for (const stage of ['PRIMARY', 'SECONDARY', 'TERTIARY']) {
    const temperature = tagNumber(element, `${stage}_TEMP`);
    const days = tagNumber(element, `${stage}_AGE`);
    if (temperature == null && days == null) continue;
    const details: Record<string, string | number> = { mode: 'hold' };
    if (temperature != null) { details.target_value = temperature; details.target_unit = '°C'; }
    if (days != null && days > 0) details.duration_seconds = Math.round(days * 86400);
    if (priorFermentationStep || fermentationAnchor === boil && !!boil) details.anchor_point = 'end';
    fermentationAnchor = build.action('temperature_control', `${stage[0]}${stage.slice(1).toLowerCase()} fermentation`,
      fermentationAnchor, 0, details, { stage: stage.toLowerCase(), temperature_c: temperature, duration_days: days });
    priorFermentationStep = true;
  }
  return build.finish();
}

function parseBrewfatherRecipe(value: Record<string, unknown>, sourceIndex: number): ImportedRecipe {
  const name = text(value.name);
  if (!name) throw new Error(`Recipe ${sourceIndex + 1} has no name`);
  const typeText = text(value.recipeType || value.beverageType).toLowerCase();
  const type: RecipeType = ['beer', 'wine', 'mead', 'cider'].includes(typeText) ? typeText as RecipeType : 'beer';
  const inputs = picked(value, ['type', 'batchSize', 'boilSize', 'boilTime', 'efficiency', 'mashEfficiency', 'author']);
  for (const key of ['style', 'equipment']) {
    const source = record(value[key]);
    if (Object.keys(source).length) inputs[key] = picked(source, key === 'style' ? ['name', 'category', 'categoryNumber', 'styleLetter']
      : ['name', 'trubChillerLoss', 'evapRate', 'lauterDeadspace', 'topUpKettle', 'hopUtilization']);
  }
  const water = record(value.water);
  if (Object.keys(water).length) inputs.water = picked(water, ['name', 'amount', 'calcium', 'bicarbonate', 'sulfate', 'chloride', 'sodium', 'magnesium', 'ph']);
  for (const key of ['waters', 'waterAdditions', 'salts', 'acids']) {
    const entries = records(value[key]);
    if (entries.length) inputs[key] = entries.map(item => picked(item,
      ['name', 'amount', 'unit', 'use', 'calcium', 'bicarbonate', 'sulfate', 'chloride', 'sodium', 'magnesium', 'ph']));
  }
  const build = builder(sourceIndex, name, text(value.notes), type, inputs, text(value._id || value.id) || undefined);
  const mash = record(value.mash);
  let firstMash: string | null = null;
  let lastMash: string | null = null;
  for (const step of records(mash.steps || value.mashSteps)) {
    const duration = number(step.stepTime ?? step.time);
    const temperature = number(step.stepTemp ?? step.temperature);
    const details: Record<string, string | number> = { phase: 'mash', mode: 'hold' };
    if (temperature != null) { details.target_value = temperature; details.target_unit = '°C'; }
    if (duration != null && duration > 0) details.duration_seconds = Math.round(duration * 60);
    if (lastMash) details.anchor_point = 'end';
    const id = build.action('temperature_control', text(step.name) || 'Mash', lastMash, 0, details,
      picked(step, ['type', 'stepTemp', 'stepTime', 'rampTime', 'infuseAmount']));
    firstMash ||= id;
    lastMash = id;
  }
  const drain = lastMash ? build.action('transfer', 'Drain grain', lastMash, 0,
    { purpose: 'drain_grain', anchor_point: 'end' }) : null;
  if (drain) {
    build.action('measurement', 'Measure pre-boil gravity', drain, 0, { measurement_kind: 'gravity', target_unit: 'SG' });
  }
  const boilMinutes = number(value.boilTime);
  const boil = boilMinutes != null && boilMinutes > 0
    ? build.action('temperature_control', 'Boil', drain || lastMash, 0,
      { phase: 'boil', mode: 'heat', duration_seconds: Math.round(boilMinutes * 60),
        ...(!drain && lastMash ? { anchor_point: 'end' } : {}) }, { boil_time_minutes: boilMinutes }) : null;
  for (const item of records(value.fermentables)) {
    const itemName = text(item.name);
    if (!itemName) continue;
    const category = text(item.type).toLowerCase() === 'grain' ? 'Grain' : 'Adjunct';
    const use = text(item.use).toLowerCase();
    const anchor = use.includes('boil') ? boil : category === 'Grain' ? firstMash || boil : boil || firstMash;
    const amount = number(item.amount);
    build.action('addition', itemName, anchor, 0,
      { ...(amount != null ? { quantity: amount, unit: 'kg' } : {}) },
      picked(item, ['type', 'use', 'time', 'yield', 'color', 'potential', 'supplier', 'origin', 'moisture', 'protein']),
      { name: itemName, category });
  }
  let yeastAnchor: string | null = boil || lastMash;
  for (const item of records(value.yeasts || value.yeast)) {
    const itemName = text(item.name);
    if (!itemName) continue;
    const unit = text(item.unit);
    const amount = number(item.amount);
    const id = build.action('addition', `Pitch ${itemName}`, yeastAnchor, 0,
      { ...(yeastAnchor === boil && boil ? { anchor_point: 'end' } : {}),
        ...(amount != null && ['g', 'kg', 'mL', 'L', 'packet', 'vial'].includes(unit) ? { quantity: amount, unit } : {}) },
      picked(item, ['type', 'form', 'laboratory', 'productId', 'attenuation', 'amount', 'unit']),
      { name: itemName, category: 'Yeast' });
    yeastAnchor = id;
  }
  for (const item of records(value.hops)) {
    const itemName = text(item.name);
    if (!itemName) continue;
    const use = text(item.use);
    const minutes = number(item.time) || 0;
    const amount = number(item.amount);
    const isBoil = /boil|first wort/i.test(use);
    const isLate = /aroma|whirlpool|hop stand/i.test(use);
    const anchor = isBoil || isLate ? boil : /mash/i.test(use) ? firstMash : yeastAnchor;
    if (/dry hop/i.test(use)) build.warnings.push(`${itemName}: dry-hop timing needs review`);
    build.action('addition', itemName, anchor, isBoil ? -Math.round(minutes * 60) : 0,
      { ...(anchor === boil && boil ? { anchor_point: 'end' } : {}),
        ...(amount != null ? { quantity: amount, unit: 'g' } : {}) },
      picked(item, ['use', 'time', 'alpha', 'form', 'type', 'beta', 'hsi', 'temperature']),
      { name: itemName, category: 'Hops' });
  }
  for (const item of records(value.miscs)) {
    const itemName = text(item.name);
    if (!itemName) continue;
    const use = text(item.use);
    const amount = number(item.amount);
    const unit = text(item.unit);
    const anchor = /boil/i.test(use) ? boil : /mash/i.test(use) ? firstMash : yeastAnchor;
    build.action('addition', itemName, anchor, /boil/i.test(use) ? -Math.round((number(item.time) || 0) * 60) : 0,
      { ...(anchor === boil && boil ? { anchor_point: 'end' } : {}),
        ...(amount != null && unit ? { quantity: amount, unit } : {}) },
      picked(item, ['type', 'use', 'time', 'amount', 'unit', 'useFor']),
      { name: itemName, category: text(item.type) === 'Water Agent' ? 'Chemical' : 'Adjunct' });
  }
  const fermentation = record(value.fermentation);
  let fermentationAnchor = yeastAnchor;
  let priorFermentationStep = false;
  for (const step of records(fermentation.steps || value.fermentationSteps)) {
    const temperature = number(step.stepTemp ?? step.temperature ?? step.temp);
    const days = number(step.stepTime ?? step.time ?? step.duration);
    const details: Record<string, string | number> = { mode: 'hold' };
    if (temperature != null) { details.target_value = temperature; details.target_unit = '°C'; }
    if (days != null && days > 0) details.duration_seconds = Math.round(days * 86400);
    if (priorFermentationStep || fermentationAnchor === boil && !!boil) details.anchor_point = 'end';
    fermentationAnchor = build.action('temperature_control', text(step.name) || 'Fermentation temperature',
      fermentationAnchor, 0, details, picked(step, ['name', 'stepTemp', 'temperature', 'temp', 'stepTime', 'time', 'duration']));
    priorFermentationStep = true;
  }
  return build.finish();
}

export function parseRecipeImport(source: string, format: 'beerxml' | 'brewfather_json'): ImportDocument {
  if (format === 'beerxml') {
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('XML document declarations are not supported');
    const document = new DOMParser().parseFromString(source, 'application/xml');
    if (document.querySelector('parsererror')) throw new Error('Invalid BeerXML file');
    const root = document.documentElement;
    const elements = root.localName.toUpperCase() === 'RECIPE' ? [root]
      : root.localName.toUpperCase() === 'RECIPES' ? [...root.children].filter(item => item.localName.toUpperCase() === 'RECIPE') : [];
    if (!elements.length) throw new Error('No BeerXML recipes found');
    return { format, recipes: elements.map(parseBeerXmlRecipe) };
  }
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('Invalid JSON file'); }
  const root = record(value);
  const entries = Array.isArray(value) ? value : Array.isArray(root.recipes) ? root.recipes
    : root.recipe ? [root.recipe] : Object.keys(root).length ? [root] : [];
  const recipes = records(entries).map(parseBrewfatherRecipe);
  if (!recipes.length) throw new Error('No Brewfather recipes found');
  return { format, recipes };
}

export function decodeImportBytes(bytes: Uint8Array, format: 'beerxml' | 'brewfather_json'): string {
  const preview = new TextDecoder('ascii').decode(bytes.slice(0, 256));
  const declared = format === 'beerxml' ? /<\?xml[^>]*encoding=["']([^"']+)/i.exec(preview)?.[1] : undefined;
  const encoding = declared && /^(utf-8|iso-8859-1|windows-1252)$/i.test(declared) ? declared : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}
