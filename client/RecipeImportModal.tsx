import { useState } from 'react';
import { Alert, Button, Checkbox, Input, Modal, Select, Switch, Table } from 'antd';
import { importRecipes, type IngredientImportChoice, type InventoryItem, type LocalDb } from './db.ts';
import { decodeImportBytes, parseRecipeImport, type ImportDocument, type ImportedIngredient } from './recipeImport.ts';
import { quantityUnitsForCategory, unitOptions, type PreferredUnits } from '../shared/units.ts';
import { unitForCategory } from '../shared/catalog.ts';

export function RecipeImportModal({ open, db, inventory, preferredUnits, onClose, onImported }: {
  open: boolean; db: LocalDb; inventory: InventoryItem[]; preferredUnits: PreferredUnits;
  onClose: () => void; onImported: (ids: string[]) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [document, setDocument] = useState<ImportDocument | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [linkInventory, setLinkInventory] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [units, setUnits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectedRecipes = document?.recipes.filter(recipe => selected.includes(recipe.sourceIndex)) || [];
  const ingredients = [...new Map(selectedRecipes.flatMap(recipe => recipe.ingredients.map(item => [item.key, item] as const))).values()];

  function defaultChoice(item: ImportedIngredient): string {
    return inventory.find(existing => existing.category === item.category && existing.name.toLowerCase() === item.name.toLowerCase())?.id || 'create';
  }

  async function chooseFile(next: File | undefined) {
    setError(''); setFile(null); setBytes(null); setDocument(null); setSelected([]); setChoices({}); setUnits({});
    if (!next) return;
    if (next.size > 10 * 1024 * 1024) { setError('Import file exceeds 10 MB'); return; }
    try {
      const data = new Uint8Array(await next.arrayBuffer());
      const format = next.name.toLowerCase().endsWith('.json') ? 'brewfather_json' : 'beerxml';
      const parsed = parseRecipeImport(decodeImportBytes(data, format), format);
      if (parsed.recipes.length > 200) throw new Error('Import up to 200 recipes per file');
      setFile(next); setBytes(data); setDocument(parsed);
      setSelected(parsed.recipes.length === 1 ? [parsed.recipes[0].sourceIndex] : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function save() {
    if (!file || !bytes || !document || !selectedRecipes.length || busy) return;
    setBusy(true); setError('');
    try {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
      const sha256 = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const mapping: Record<string, IngredientImportChoice> = {};
      for (const ingredient of ingredients) {
        const choice = linkInventory ? choices[ingredient.key] || defaultChoice(ingredient) : 'unlinked';
        if (choice === 'unlinked') mapping[ingredient.key] = { mode: 'unlinked' };
        else if (choice === 'create') mapping[ingredient.key] = { mode: 'create',
          unit: units[ingredient.key] || unitForCategory(ingredient.category, preferredUnits.mass) };
        else mapping[ingredient.key] = { mode: 'existing', inventoryItemId: choice };
      }
      const ids = await importRecipes(db, { filename: file.name, format: document.format, bytes, sha256 }, selectedRecipes, mapping);
      await onImported(ids);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <Modal title="Import recipes" open={open} onCancel={onClose} footer={null} width={720} destroyOnHidden>
    <p className="muted">Import BeerXML (.xml) or Brewfather recipe JSON (.json) files.</p>
    {error && <Alert type="error" message={error} className="form-alert" />}
    <Input type="file" accept=".xml,.json,text/xml,application/xml,application/json" onChange={event => void chooseFile(event.target.files?.[0])} />
    {document && <>
      {document.recipes.length > 1 && <div className="import-recipe-choices">
        <h3>Choose recipes to import</h3>
        <Checkbox.Group value={selected} onChange={values => setSelected(values.map(Number))}>
          <div className="import-recipe-list">{document.recipes.map(recipe =>
            <Checkbox key={recipe.sourceIndex} value={recipe.sourceIndex}>{recipe.name}</Checkbox>)}</div>
        </Checkbox.Group>
      </div>}
      {!!selectedRecipes.length && <>
        <div className="import-inventory-toggle"><Switch checked={linkInventory} onChange={setLinkInventory} />
          <span>Link ingredients to inventory or create items</span></div>
        {linkInventory && ingredients.length > 0 && <Table<ImportedIngredient> className="import-ingredient-table"
          dataSource={ingredients} rowKey="key" pagination={false} size="small" columns={[
            { title: 'Ingredient', render: (_, item) => <><strong>{item.name}</strong><div className="muted">{item.category}</div></> },
            { title: 'Inventory', render: (_, item) => {
              const value = choices[item.key] || defaultChoice(item);
              return <div className="import-inventory-choice"><Select value={value} onChange={next => setChoices(previous => ({ ...previous, [item.key]: next }))}
                options={[{ value: 'create', label: 'Create item' }, { value: 'unlinked', label: 'Leave unlinked' },
                  ...inventory.filter(existing => existing.category === item.category).map(existing => ({ value: existing.id,
                    label: existing.name + (existing.location_name ? ` · ${existing.location_name}` : '') }))]} />
                {value === 'create' && <Select value={units[item.key] || unitForCategory(item.category, preferredUnits.mass)}
                  onChange={unit => setUnits(previous => ({ ...previous, [item.key]: unit }))}
                  options={unitOptions(quantityUnitsForCategory(item.category))} aria-label={`Unit for ${item.name}`} />}</div>;
            } }
          ]} />}
        {selectedRecipes.flatMap(recipe => recipe.warnings).length > 0 &&
          <Alert type="warning" className="form-alert" message="Some action times need review after import"
            description={selectedRecipes.flatMap(recipe => recipe.warnings).join('; ')} />}
        <Button type="primary" loading={busy} onClick={() => void save()}>
          Import {selectedRecipes.length} {selectedRecipes.length === 1 ? 'recipe' : 'recipes'}
        </Button>
      </>}
    </>}
  </Modal>;
}
