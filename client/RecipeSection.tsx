import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select } from 'antd';
import { DeleteOutlined, DownloadOutlined, PlusOutlined, SettingOutlined, UploadOutlined } from '@ant-design/icons';
import { addRecipePlan, createRecipe, deleteRecipe, deleteRecipePlan, hasRecipeImport, listRecipePlans, startBatchFromRecipe, updateRecipe, updateRecipePlan,
  recipeImportSource, recipeTargetVolume, updateRecipeTargetVolume, recipeWortLoss, updateRecipeWortLoss,
  breweryWortLoss, updateBatchWortLoss, latestMeasuredMashEfficiency,
  type Equipment, type InventoryItem, type LocalDb, type PlanInput, type Recipe, type RecipeType } from './db.ts';
import { RecipeImportModal } from './RecipeImportModal.tsx';
import { PlanForm, repeatPreset, type PlanPreset } from './PlanForm.tsx';
import { kindLabel } from './constants.ts';
import { EventTimeline } from './EventTimeline.tsx';
import { RecipeTypeIcon } from './RecipeTypeIcon.tsx';
import type { CatalogInventory } from '../shared/catalog.ts';
import type { PreferredUnits } from './api.ts';
import { convertUnit, unitGroups, unitOptions } from '../shared/units.ts';
import { changeNumberUnit } from './unitFields.ts';
import { calculateRecipe, type RecipeEstimate } from './recipeCalculations.ts';
import { RecipeEquipmentFields } from './RecipeEquipmentFields.tsx';

const recipeTypeOptions = [
  { value: 'beer', label: 'Beer' }, { value: 'wine', label: 'Wine' },
  { value: 'mead', label: 'Mead' }, { value: 'cider', label: 'Cider' }
];

export function RecipeSection({ db, basePath, accountId, recipes, equipment, equipmentModels, inventory, supplies, catalogInventory, preferredUnits, selectedId, onSelect, onChanged, onBatchStarted }: {
  db: LocalDb; basePath: string; accountId: string; recipes: Recipe[]; selectedId: string | null; onSelect: (id: string | null) => void;
  equipment: Equipment[]; equipmentModels: Equipment[]; inventory: InventoryItem[]; supplies: InventoryItem[]; catalogInventory: CatalogInventory[]; preferredUnits: PreferredUnits;
  onChanged: () => Promise<void>; onBatchStarted: (id: string) => void;
}) {
  const [settingsForm] = Form.useForm<{ name: string; description?: string; recipe_type: RecipeType;
    target_volume?: number; target_volume_unit: string; wort_loss?: number }>();
  const targetVolumeUnit = useRef<string>(preferredUnits.volume);
  const [plans, setPlans] = useState<(PlanInput & { id: string })[]>([]);
  const [estimate, setEstimate] = useState<RecipeEstimate | null>(null);
  const [importedRecipe, setImportedRecipe] = useState(false);
  const [newRecipe, setNewRecipe] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [breweryDefaultWortLoss, setBreweryDefaultWortLoss] = useState<number | null>(null);
  const [creatingKind, setCreatingKind] = useState<string | null>(null);
  const [preset, setPreset] = useState<PlanPreset>({});
  const [editingPlan, setEditingPlan] = useState<(PlanInput & { id: string }) | null>(null);
  const [planDeleteError, setPlanDeleteError] = useState('');
  const [newBatch, setNewBatch] = useState(false);
  const [deletingRecipe, setDeletingRecipe] = useState(false);
  const [error, setError] = useState('');
  const recipe = recipes.find(item => item.id === selectedId) || null;

  async function refreshPlans() {
    if (selectedId) setPlans(await listRecipePlans(db, selectedId));
  }
  useEffect(() => { void refreshPlans(); }, [db, selectedId]);
  useEffect(() => { if (!selectedId) { setImportedRecipe(false); return; }
    void hasRecipeImport(db, selectedId).then(setImportedRecipe);
  }, [db, selectedId]);
  useEffect(() => {
    if (!selectedId) { setEstimate(null); return; }
    let cancelled = false;
    setEstimate(null);
    void (async () => {
      const [recipeRows, eventRows, defaultWortLoss] = await Promise.all([
        db.execO<{ target_fermenter_volume_liters: number | null; brewhouse_efficiency_pct: number | null;
          wort_loss_liters: number | null }>(
          'SELECT target_fermenter_volume_liters, brewhouse_efficiency_pct, wort_loss_liters FROM recipe_inputs WHERE id = ?', [selectedId]),
        db.execO<{ id: string; yield_pct: number | null; color_lovibond: number | null; attenuation_pct: number | null }>(`SELECT i.id, i.yield_pct, i.color_lovibond, i.attenuation_pct FROM recipe_event_inputs i
          JOIN recipe_events e ON e.id = i.id WHERE e.recipe_id = ?`, [selectedId]),
        breweryWortLoss(db)
      ]);
      const recent: Record<string, number> = {};
      const equipmentIds = new Set(plans.filter(plan => plan.event_type === 'transfer')
        .filter(plan => plan.details.purpose === 'drain_grain')
        .map(plan => String(plan.details.mash_equipment_id
          || plans.find(item => item.id === plan.anchor_event_id)?.details.equipment_id || '')));
      for (const id of equipmentIds) {
        if (id) {
          const unit = equipment.find(item => item.model_id === id);
          const value = unit ? await latestMeasuredMashEfficiency(db, unit.id) : null;
          if (value != null) recent[id] = value;
        }
      }
      const recipeInputs = { ...(recipeRows[0] || {}),
        wort_loss_liters: recipeRows[0]?.wort_loss_liters ?? defaultWortLoss };
      const eventInputs = Object.fromEntries(eventRows.map(row => [row.id, row]));
      if (!cancelled) setEstimate(calculateRecipe(plans, supplies, equipmentModels, recipeInputs, eventInputs, recent,
        recipe?.recipe_type || 'beer'));
    })();
    return () => { cancelled = true; };
  }, [db, selectedId, plans, supplies, equipment, equipmentModels, settingsOpen, recipe?.recipe_type]);

  async function addRecipe(values: { name: string; description?: string; recipe_type: RecipeType }) {
    try {
      const id = await createRecipe(db, values.name.trim(), values.description || '', values.recipe_type, preferredUnits.temperature);
      onSelect(id); setNewRecipe(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function addPlan(input: PlanInput, _recordNow = false, addAnother = false) {
    if (!recipe) return;
    if (editingPlan) await updateRecipePlan(db, recipe.id, editingPlan.id, input);
    else await addRecipePlan(db, recipe.id, input);
    if (addAnother && editingPlan) { setPreset(repeatPreset(input)); setCreatingKind(editingPlan.event_type); setEditingPlan(null); }
    if (!addAnother) { setCreatingKind(null); setEditingPlan(null); }
    await refreshPlans(); await onChanged();
  }

  async function removePlan(id: string) {
    if (!recipe) return;
    try {
      await deleteRecipePlan(db, recipe.id, id);
      setEditingPlan(null);
      await refreshPlans(); await onChanged();
    } catch (cause) { setPlanDeleteError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function removeRecipe() {
    if (!recipe || deletingRecipe) return;
    setDeletingRecipe(true); setSettingsError('');
    try {
      await deleteRecipe(db, recipe.id);
      setSettingsOpen(false);
      onSelect(null);
      await onChanged();
    } catch (cause) { setSettingsError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDeletingRecipe(false); }
  }

  async function saveSettings(values: { name: string; description?: string; recipe_type: RecipeType;
    target_volume?: number; target_volume_unit: string; wort_loss?: number }) {
    if (!recipe) return;
    setSettingsBusy(true); setSettingsError('');
    try {
      await updateRecipe(db, recipe.id, values.name, values.description || '', values.recipe_type);
      await updateRecipeTargetVolume(db, recipe.id, values.target_volume == null ? null
        : convertUnit(values.target_volume, values.target_volume_unit, 'L'));
      await updateRecipeWortLoss(db, recipe.id, values.wort_loss == null ? null
        : convertUnit(values.wort_loss, preferredUnits.volume, 'L'));
      await onChanged();
      setSettingsOpen(false);
    } catch (cause) { setSettingsError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSettingsBusy(false); }
  }

  async function openSettings() {
    if (!recipe) return;
    setSettingsError('');
    const [liters, recipeLoss, defaultLoss] = await Promise.all([
      recipeTargetVolume(db, recipe.id), recipeWortLoss(db, recipe.id), breweryWortLoss(db)]);
    setBreweryDefaultWortLoss(defaultLoss);
    targetVolumeUnit.current = preferredUnits.volume;
    settingsForm.setFieldsValue({ name: recipe.name, description: recipe.description || '', recipe_type: recipe.recipe_type || 'beer',
      target_volume: liters == null ? undefined : convertUnit(liters, 'L', preferredUnits.volume) ?? undefined,
      target_volume_unit: preferredUnits.volume,
      wort_loss: recipeLoss == null ? undefined : convertUnit(recipeLoss, 'L', preferredUnits.volume) ?? undefined });
    setSettingsOpen(true);
  }

  async function downloadImport() {
    if (!recipe) return;
    try {
      const source = await recipeImportSource(db, recipe.id);
      if (!source) return;
      const url = URL.createObjectURL(new Blob([source.content as BlobPart],
        { type: source.format === 'beerxml' ? 'application/xml' : 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = source.filename; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) { setSettingsError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function start(values: { name: string; unit_ids?: Record<string, string>; wort_loss?: number }) {
    if (!recipe) return;
    try {
      const id = await startBatchFromRecipe(db, recipe, values.name.trim(), accountId, recipe.description || '', values.unit_ids);
      if (values.wort_loss != null) await updateBatchWortLoss(db, id,
        convertUnit(values.wort_loss, preferredUnits.volume, 'L'));
      setNewBatch(false); await onChanged(); onBatchStarted(id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="section-page">
    {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index">
      <div className="section-heading"><div><span className="eyebrow">Planning</span><h1>Recipes</h1></div></div>
      <p className="muted">Reusable event plans for your batches.</p>
      {recipes.length > 0 && <div className="record-list">{recipes.map(item =>
        <a key={item.id} className="record-link recipe-link" href={`${basePath}/recipe/${item.id}`}
          onClick={event => { event.preventDefault(); onSelect(item.id); }}>
          <RecipeTypeIcon type={item.recipe_type} />
          <span className="recipe-link-copy"><strong>{item.name}</strong><small>{item.description || 'No description'}</small></span>
        </a>)}</div>}
      <div className="recipe-index-actions">
        <Button icon={<PlusOutlined />} onClick={() => setNewRecipe(true)}>New recipe</Button>
        <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>Import recipes</Button>
      </div>
    </section> : !recipe ? <Empty description="Recipe not found" /> : <section className="record-detail">
        <div className="content-heading"><div className="recipe-detail-heading"><RecipeTypeIcon type={recipe.recipe_type} large />
          <div><h2>{recipe.name}</h2>
            <p className="muted">{recipe.description}</p></div></div>
          <div className="heading-actions"><Button type="primary" onClick={() => setNewBatch(true)}>Start batch</Button>
            <Button type="text" shape="circle" icon={<SettingOutlined />} aria-label="Recipe settings"
              title="Recipe settings" onClick={() => void openSettings()} /></div>
        </div>
        {estimate && <section className="recipe-estimates" aria-label="Recipe details">
          <h3>Details</h3>
          <div className="recipe-estimate-grid">
            <div><span>Into fermenter</span><strong>{estimate.targetLiters == null ? '—'
              : `${Number((convertUnit(estimate.targetLiters, 'L', preferredUnits.volume) || 0).toFixed(2))} ${preferredUnits.volume}`}</strong></div>
            <div><span>Expected OG</span><strong>{estimate.originalGravity?.toFixed(3) || '—'}</strong></div>
            <div><span>Expected FG</span><strong>{estimate.finalGravity?.toFixed(3) || '—'}</strong></div>
            <div><span>Expected ABV</span><strong>{estimate.abvPct == null ? '—' : `${estimate.abvPct.toFixed(1)}%`}</strong></div>
            {recipe.recipe_type === 'beer' && <div><span>Estimated color</span><strong>{estimate.colorSrm == null ? '—' : `${estimate.colorSrm.toFixed(1)} SRM`}</strong></div>}
          </div>
          {estimate.efficiencyLabel && <p className="muted">Using {estimate.efficiencyLabel}.</p>}
          {estimate.missing.length > 0 && <p className="muted recipe-estimate-missing">{estimate.missing.join(' ')}</p>}
        </section>}
        <EventTimeline events={plans} equipment={equipmentModels} onEdit={plan => { setPlanDeleteError(''); setEditingPlan(plan); }}
          onAdd={(kind, settings) => { setEditingPlan(null); setPreset(settings); setCreatingKind(kind); }} />
      </section>}
    <Modal title="New recipe" open={newRecipe} onCancel={() => setNewRecipe(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={addRecipe} initialValues={{ recipe_type: 'beer' }}>
        <Form.Item name="name" label="Recipe name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="recipe_type" label="Type" rules={[{ required: true }]}><Select options={recipeTypeOptions} /></Form.Item>
        <Form.Item name="description" label="Description"><Input.TextArea rows={2} /></Form.Item>
        <Button type="primary" htmlType="submit">Create recipe</Button>
      </Form>
    </Modal>
    <Modal title="Recipe settings" open={settingsOpen} onCancel={() => setSettingsOpen(false)} footer={null} destroyOnHidden>
      <Form form={settingsForm} layout="vertical" onFinish={saveSettings}>
        <Form.Item name="name" label="Recipe name" rules={[{ required: true, whitespace: true }, { max: 100 }]}>
          <Input maxLength={100} /></Form.Item>
        <Form.Item name="recipe_type" label="Type" rules={[{ required: true }]}>
          <Select options={recipeTypeOptions} /></Form.Item>
        <Form.Item name="description" label="Description"><Input.TextArea rows={3} /></Form.Item>
        <div className="form-pair"><Form.Item name="target_volume" label="Target volume into fermenter (optional)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="target_volume_unit" label="Unit"><Select options={unitOptions(unitGroups.volume)}
            onChange={unit => { changeNumberUnit(settingsForm, ['target_volume'], targetVolumeUnit.current, unit);
              targetVolumeUnit.current = unit; }} /></Form.Item></div>
        <Form.Item name="wort_loss" label={`Wort loss to fermenter (${preferredUnits.volume}, optional)`}>
          <InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <p className="muted">Leave blank to use the brewery default{breweryDefaultWortLoss == null ? ' (not set).' :
          ` (${Number((convertUnit(breweryDefaultWortLoss, 'L', preferredUnits.volume) || 0).toFixed(2))} ${preferredUnits.volume}).`}</p>
        {settingsError && <Alert type="error" message={settingsError} className="form-alert" />}
        <div className="recipe-settings-actions"><Button type="primary" htmlType="submit" loading={settingsBusy}>Save changes</Button>
          {importedRecipe && <Button type="text" htmlType="button" icon={<DownloadOutlined />}
            onClick={() => void downloadImport()}>Download original import</Button>}
          <Popconfirm title={`Delete ${recipe?.name || 'recipe'}?`}
            description="The recipe and its planned actions will be deleted. Batches already started from it keep their actions."
            okText="Delete recipe" okButtonProps={{ danger: true, loading: deletingRecipe }}
            onConfirm={() => void removeRecipe()}>
            <Button type="text" danger icon={<DeleteOutlined />} loading={deletingRecipe}>Delete recipe</Button>
          </Popconfirm></div>
      </Form>
    </Modal>
    <RecipeImportModal open={importOpen} db={db} inventory={inventory} preferredUnits={preferredUnits}
      onClose={() => setImportOpen(false)} onImported={async ids => { await onChanged(); if (ids.length === 1) onSelect(ids[0]); }} />
    <Modal title={editingPlan ? editingPlan.event_type === 'measurement'
      ? `Edit ${String(editingPlan.details.measurement_kind || 'measurement').replaceAll('_', ' ')} measurement`
      : editingPlan.event_type === 'addition' ? 'Edit ingredient' : `Edit ${editingPlan.title}`
      : `Add ${preset.phase || (preset.measurementKind ? `${preset.measurementKind.replaceAll('_', ' ')} measurement` : creatingKind === 'addition' ? 'ingredient' : kindLabel(creatingKind || '').toLowerCase())}`}
      open={!!(editingPlan || creatingKind)} onCancel={() => { setCreatingKind(null); setEditingPlan(null); setPlanDeleteError(''); }} footer={null} destroyOnHidden>
      {planDeleteError && <Alert type="error" message={planDeleteError} className="form-alert" />}
      {(editingPlan || creatingKind) && <PlanForm key={editingPlan?.id || creatingKind || 'new'} eventType={editingPlan?.event_type || creatingKind || 'addition'}
        anchors={plans.filter(item => item.id !== editingPlan?.id)} initialPlan={editingPlan || undefined}
        equipment={equipmentModels} inventory={supplies} catalog={catalogInventory} preferredUnits={preferredUnits} preset={editingPlan ? undefined : preset} recipeMode submit={addPlan}
        extraAction={editingPlan && <Popconfirm title={`Delete ${editingPlan.title}?`}
          description="Actions timed from this one will become relative to batch start. Existing batches keep their copies."
          okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => void removePlan(editingPlan.id)}>
          <Button type="text" htmlType="button" danger icon={<DeleteOutlined />}>Delete event</Button>
        </Popconfirm>} />
      }
    </Modal>
    <Modal title="Start a batch" open={newBatch} onCancel={() => setNewBatch(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={start} initialValues={{ name: recipe ? `${recipe.name} batch` : '' }}>
        <Form.Item name="name" label="Batch name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <RecipeEquipmentFields db={db} recipeId={recipe?.id} equipment={equipment} models={equipmentModels} />
        <Form.Item name="wort_loss" label={`Wort loss override (${preferredUnits.volume}, optional)`}>
          <InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Create batch</Button>
      </Form>
    </Modal>
  </div>;
}
