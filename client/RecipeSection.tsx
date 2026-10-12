import { useEffect, useState } from 'react';
import { Alert, Button, Card, Dropdown, Empty, Form, Input, Modal, Popconfirm, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { addRecipePlan, createRecipe, deleteRecipePlan, listRecipePlans, startBatchFromRecipe, updateRecipePlan,
  type InventoryItem, type LocalDb, type PlanInput, type Recipe } from './db.ts';
import { PlanForm } from './PlanForm.tsx';
import { kindLabel, planKinds } from './constants.ts';
import { planDetailsLabel, planTimingLabel } from './planTiming.ts';
import type { CatalogInventory } from '../shared/catalog.ts';

export function RecipeSection({ db, basePath, accountId, recipes, inventory, catalogInventory, preferredMassUnit, selectedId, onSelect, onChanged, onBatchStarted }: {
  db: LocalDb; basePath: string; accountId: string; recipes: Recipe[]; selectedId: string | null; onSelect: (id: string | null) => void;
  inventory: InventoryItem[]; catalogInventory: CatalogInventory[]; preferredMassUnit: string;
  onChanged: () => Promise<void>; onBatchStarted: (id: string) => void;
}) {
  const [plans, setPlans] = useState<(PlanInput & { id: string })[]>([]);
  const [newRecipe, setNewRecipe] = useState(false);
  const [creatingKind, setCreatingKind] = useState<string | null>(null);
  const [editingPlan, setEditingPlan] = useState<(PlanInput & { id: string }) | null>(null);
  const [newBatch, setNewBatch] = useState(false);
  const [error, setError] = useState('');
  const recipe = recipes.find(item => item.id === selectedId) || null;

  async function refreshPlans() {
    if (selectedId) setPlans(await listRecipePlans(db, selectedId));
  }
  useEffect(() => { void refreshPlans(); }, [db, selectedId]);

  async function addRecipe(values: { name: string; description?: string }) {
    try {
      const id = await createRecipe(db, values.name.trim(), values.description || '');
      onSelect(id); setNewRecipe(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function addPlan(input: PlanInput) {
    if (!recipe) return;
    if (editingPlan) await updateRecipePlan(db, recipe.id, editingPlan.id, input);
    else await addRecipePlan(db, recipe.id, input);
    setCreatingKind(null); setEditingPlan(null); await refreshPlans(); await onChanged();
  }

  function dependentPlans(id: string) {
    const ids = new Set([id]);
    let size = 0;
    while (ids.size !== size) {
      size = ids.size;
      for (const plan of plans) if (plan.anchor_event_id && ids.has(plan.anchor_event_id)) ids.add(plan.id);
    }
    return plans.filter(plan => plan.id !== id && ids.has(plan.id));
  }

  async function removePlan(id: string) {
    if (!recipe) return;
    try {
      await deleteRecipePlan(db, recipe.id, id);
      await refreshPlans(); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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
      {recipes.length === 0 ? <Empty description="No recipes yet" /> : <div className="record-list">{recipes.map(item =>
        <a key={item.id} className="record-link" href={`${basePath}/recipe/${item.id}`}
          onClick={event => { event.preventDefault(); onSelect(item.id); }}>
          <strong>{item.name}</strong><small>{item.description || 'No description'}</small>
        </a>)}</div>}
    </section> : !recipe ? <Empty description="Recipe not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">Recipe plan</span><h2>{recipe.name}</h2><p className="muted">{recipe.description}</p></div>
          <div className="heading-actions"><Button type="primary" onClick={() => setNewBatch(true)}>Start batch</Button></div>
        </div>
        {plans.length === 0 ? <Card><Empty description="Add the first planned event" /></Card> :
          <div className="card-stack">{plans.map(plan => <Card key={plan.id} size="small">
            <div className="timeline-card"><div><div className="title-edit-row"><Button type="text" size="small" icon={<EditOutlined />}
              aria-label={`Edit planned event ${plan.title}`} onClick={() => setEditingPlan(plan)} />
              <strong>{plan.title}</strong></div><div className="muted">{planTimingLabel(plan, plans)}</div></div>
              <div className="recipe-card-actions"><Tag>{kindLabel(plan.event_type)}</Tag>
                <Popconfirm title={`Delete ${plan.title}?`}
                  description={<div className="recipe-delete-description">{dependentPlans(plan.id).length
                    ? `Also deletes ${dependentPlans(plan.id).map(item => item.title).join(', ')}. Existing batches keep their copies.`
                    : 'Existing batches keep their copies.'}</div>}
                  okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => void removePlan(plan.id)}>
                  <Button type="text" danger size="small" icon={<DeleteOutlined />} aria-label={`Delete planned event ${plan.title}`} />
                </Popconfirm></div></div>
            {planDetailsLabel(plan) && <p className="event-detail">{planDetailsLabel(plan)}</p>}
          </Card>)}</div>}
        <div className="recipe-add-action"><Dropdown trigger={['click']} placement="topLeft"
          menu={{ items: planKinds.map(item => ({ key: item.value, label: item.label })),
            onClick: ({ key }) => { setEditingPlan(null); setCreatingKind(key); } }}>
          <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="Add recipe event" title="Add recipe event" />
        </Dropdown></div>
      </section>}
    <Modal title="New recipe" open={newRecipe} onCancel={() => setNewRecipe(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={addRecipe}>
        <Form.Item name="name" label="Recipe name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="description" label="Description"><Input.TextArea rows={2} /></Form.Item>
        <Button type="primary" htmlType="submit">Create recipe</Button>
      </Form>
    </Modal>
    <Modal title={editingPlan ? `Edit ${kindLabel(editingPlan.event_type).toLowerCase()}` : `Add ${kindLabel(creatingKind || '').toLowerCase()}`}
      open={!!(editingPlan || creatingKind)} onCancel={() => { setCreatingKind(null); setEditingPlan(null); }} footer={null} destroyOnHidden>
      {(editingPlan || creatingKind) && <PlanForm key={editingPlan?.id || creatingKind || 'new'} eventType={editingPlan?.event_type || creatingKind || 'addition'}
        anchors={plans.filter(item => item.id !== editingPlan?.id)} initialPlan={editingPlan || undefined}
        inventory={inventory} catalog={catalogInventory} preferredMassUnit={preferredMassUnit} submit={addPlan} />
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
