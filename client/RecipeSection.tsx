import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Form, Input, Modal, Popconfirm, Select } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { addRecipePlan, createRecipe, deleteRecipe, deleteRecipePlan, listRecipePlans, startBatchFromRecipe, updateRecipePlan,
  type InventoryItem, type LocalDb, type PlanInput, type Recipe, type RecipeType } from './db.ts';
import { PlanForm, type PlanPreset } from './PlanForm.tsx';
import { kindLabel } from './constants.ts';
import { parsePlanDetails } from './planTiming.ts';
import { EventTimeline } from './EventTimeline.tsx';
import type { CatalogInventory } from '../shared/catalog.ts';
import type { PreferredUnits } from './api.ts';

export function RecipeSection({ db, basePath, accountId, recipes, inventory, catalogInventory, preferredUnits, selectedId, onSelect, onChanged, onBatchStarted }: {
  db: LocalDb; basePath: string; accountId: string; recipes: Recipe[]; selectedId: string | null; onSelect: (id: string | null) => void;
  inventory: InventoryItem[]; catalogInventory: CatalogInventory[]; preferredUnits: PreferredUnits;
  onChanged: () => Promise<void>; onBatchStarted: (id: string) => void;
}) {
  const [plans, setPlans] = useState<(PlanInput & { id: string })[]>([]);
  const [newRecipe, setNewRecipe] = useState(false);
  const [creatingKind, setCreatingKind] = useState<string | null>(null);
  const [preset, setPreset] = useState<PlanPreset>({});
  const [editingPlan, setEditingPlan] = useState<(PlanInput & { id: string }) | null>(null);
  const [newBatch, setNewBatch] = useState(false);
  const [deletingRecipe, setDeletingRecipe] = useState(false);
  const [error, setError] = useState('');
  const recipe = recipes.find(item => item.id === selectedId) || null;

  async function refreshPlans() {
    if (selectedId) setPlans(await listRecipePlans(db, selectedId));
  }
  useEffect(() => { void refreshPlans(); }, [db, selectedId]);

  async function addRecipe(values: { name: string; description?: string; recipe_type: RecipeType }) {
    try {
      const id = await createRecipe(db, values.name.trim(), values.description || '', values.recipe_type, preferredUnits.temperature);
      onSelect(id); setNewRecipe(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function addPlan(input: PlanInput) {
    if (!recipe) return;
    if (editingPlan) await updateRecipePlan(db, recipe.id, editingPlan.id, input);
    else await addRecipePlan(db, recipe.id, input);
    setCreatingKind(null); setEditingPlan(null); await refreshPlans(); await onChanged();
  }

  async function removePlan(id: string) {
    if (!recipe) return;
    try {
      await deleteRecipePlan(db, recipe.id, id);
      await refreshPlans(); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function removeRecipe() {
    if (!recipe || deletingRecipe) return;
    setDeletingRecipe(true); setError('');
    try {
      await deleteRecipe(db, recipe.id);
      onSelect(null);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDeletingRecipe(false); }
  }

  async function start(values: { name: string }) {
    if (!recipe) return;
    try {
      const id = await startBatchFromRecipe(db, recipe, values.name.trim(), accountId);
      setNewBatch(false); await onChanged(); onBatchStarted(id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="section-page">
    {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index">
      <div className="section-heading"><div><span className="eyebrow">Planning</span><h1>Recipes</h1></div><Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="New recipe" title="New recipe" onClick={() => setNewRecipe(true)} /></div>
      <p className="muted">Reusable event plans for your batches.</p>
      {recipes.length > 0 && <div className="record-list">{recipes.map(item =>
        <a key={item.id} className="record-link" href={`${basePath}/recipe/${item.id}`}
          onClick={event => { event.preventDefault(); onSelect(item.id); }}>
          <strong>{item.name}</strong><small>{item.description || 'No description'}</small>
        </a>)}</div>}
    </section> : !recipe ? <Empty description="Recipe not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">Recipe plan · {recipe.recipe_type || 'Unspecified'}</span><h2>{recipe.name}</h2><p className="muted">{recipe.description}</p></div>
          <div className="heading-actions"><Button type="primary" onClick={() => setNewBatch(true)}>Start batch</Button>
            <Popconfirm title={`Delete ${recipe.name}?`}
              description="The recipe and its planned actions will be deleted. Batches already started from it keep their actions."
              okText="Delete recipe" okButtonProps={{ danger: true, loading: deletingRecipe }}
              onConfirm={() => void removeRecipe()}>
              <Button type="text" danger shape="circle" icon={<DeleteOutlined />} aria-label={`Delete recipe ${recipe.name}`}
                title="Delete recipe" disabled={deletingRecipe} />
            </Popconfirm></div>
        </div>
        <EventTimeline events={plans} onEdit={plan => setEditingPlan(plan)} onDelete={plan => removePlan(plan.id)}
          onAdd={(kind, settings) => { setEditingPlan(null); setPreset(settings); setCreatingKind(kind); }} />
      </section>}
    <Modal title="New recipe" open={newRecipe} onCancel={() => setNewRecipe(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={addRecipe} initialValues={{ recipe_type: 'beer' }}>
        <Form.Item name="name" label="Recipe name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="recipe_type" label="Type" rules={[{ required: true }]}><Select options={[
          { value: 'beer', label: 'Beer' }, { value: 'wine', label: 'Wine' }, { value: 'mead', label: 'Mead' }
        ]} /></Form.Item>
        <Form.Item name="description" label="Description"><Input.TextArea rows={2} /></Form.Item>
        <Button type="primary" htmlType="submit">Create recipe</Button>
      </Form>
    </Modal>
    <Modal title={editingPlan ? editingPlan.event_type === 'measurement'
      ? `Edit ${String(parsePlanDetails(editingPlan.details_json).measurement_kind || 'measurement').replaceAll('_', ' ')} measurement`
      : `Edit ${editingPlan.title}` : `Add ${preset.phase || (preset.measurementKind ? `${preset.measurementKind.replaceAll('_', ' ')} measurement` : creatingKind === 'addition' ? 'ingredient' : kindLabel(creatingKind || '').toLowerCase())}`}
      open={!!(editingPlan || creatingKind)} onCancel={() => { setCreatingKind(null); setEditingPlan(null); }} footer={null} destroyOnHidden>
      {(editingPlan || creatingKind) && <PlanForm key={editingPlan?.id || creatingKind || 'new'} eventType={editingPlan?.event_type || creatingKind || 'addition'}
        anchors={plans.filter(item => item.id !== editingPlan?.id)} initialPlan={editingPlan || undefined}
        inventory={inventory} catalog={catalogInventory} preferredUnits={preferredUnits} preset={editingPlan ? undefined : preset} submit={addPlan} />
      }
    </Modal>
    <Modal title="Start a batch" open={newBatch} onCancel={() => setNewBatch(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={start} initialValues={{ name: recipe ? `${recipe.name} batch` : '' }}>
        <Form.Item name="name" label="Batch name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Button type="primary" htmlType="submit">Create batch</Button>
      </Form>
    </Modal>
  </div>;
}
