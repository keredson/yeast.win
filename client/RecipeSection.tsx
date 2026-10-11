import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, List, Modal, Tag, Typography } from 'antd';
import { addRecipePlan, createRecipe, listRecipePlans, startBatchFromRecipe,
  type LocalDb, type PlanInput, type Recipe } from './db.ts';
import { PlanForm } from './PlanForm.tsx';
import { kindLabel } from './constants.ts';
import { formatTime } from './time.ts';

export function RecipeSection({ db, accountId, recipes, selectedId, onSelect, onChanged, onBatchStarted }: {
  db: LocalDb; accountId: string; recipes: Recipe[]; selectedId: string | null; onSelect: (id: string) => void;
  onChanged: () => Promise<void>; onBatchStarted: (id: string) => void;
}) {
  const [plans, setPlans] = useState<(PlanInput & { id: string })[]>([]);
  const [newRecipe, setNewRecipe] = useState(false);
  const [newPlan, setNewPlan] = useState(false);
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
    await addRecipePlan(db, recipe.id, input);
    setNewPlan(false); await refreshPlans(); await onChanged();
  }

  async function start(values: { name: string }) {
    if (!recipe) return;
    try {
      const id = await startBatchFromRecipe(db, recipe, values.name.trim(), accountId);
      setNewBatch(false); await onChanged(); onBatchStarted(id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="section-grid">
    <div className="section-sidebar">
      <div className="section-heading"><div><span className="eyebrow">Planning</span><h1>Recipes</h1></div><Button type="primary" onClick={() => setNewRecipe(true)}>New</Button></div>
      <p className="muted">Reusable event plans. Starting a batch copies the plan into its own history.</p>
      {recipes.length === 0 ? <Empty description="No recipes yet" /> : <List dataSource={recipes} renderItem={item =>
        <button className={item.id === selectedId ? 'list-choice selected' : 'list-choice'} onClick={() => onSelect(item.id)}>
          <strong>{item.name}</strong><small>{item.description || 'No description'}</small>
        </button>} />}
    </div>
    <div className="section-content">
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      {!recipe ? <Empty description="Select a recipe" /> : <>
        <div className="content-heading"><div><span className="eyebrow">Recipe plan</span><h2>{recipe.name}</h2><p className="muted">{recipe.description}</p></div>
          <div className="heading-actions"><Button onClick={() => setNewPlan(true)}>Add planned event</Button><Button type="primary" onClick={() => setNewBatch(true)}>Start batch</Button></div>
        </div>
        {plans.length === 0 ? <Card><Empty description="Add the first planned event" /></Card> :
          <div className="card-stack">{plans.map(plan => <Card key={plan.id} size="small">
            <div className="timeline-card"><div><strong>{plan.title}</strong><div className="muted">{plan.planned_at ? formatTime(plan.planned_at) :
              plan.anchor_event_id ? `${plan.offset_seconds || 0}s after ${plans.find(item => item.id === plan.anchor_event_id)?.title || 'anchor'}` : 'Unscheduled'}</div></div>
              <Tag>{kindLabel(plan.event_type)}</Tag></div>
          </Card>)}</div>}
      </>}
    </div>
    <Modal title="New recipe" open={newRecipe} onCancel={() => setNewRecipe(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={addRecipe}>
        <Form.Item name="name" label="Recipe name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="description" label="Description"><Input.TextArea rows={2} /></Form.Item>
        <Button type="primary" htmlType="submit">Create recipe</Button>
      </Form>
    </Modal>
    <Modal title="Planned recipe event" open={newPlan} onCancel={() => setNewPlan(false)} footer={null} destroyOnHidden>
      <PlanForm anchors={plans} submit={addPlan} includeFixed={false} />
    </Modal>
    <Modal title="Start a batch" open={newBatch} onCancel={() => setNewBatch(false)} footer={null} destroyOnHidden>
      <Typography.Paragraph>The recipe events will be copied into the new batch.</Typography.Paragraph>
      <Form layout="vertical" onFinish={start} initialValues={{ name: recipe ? `${recipe.name} batch` : '' }}>
        <Form.Item name="name" label="Batch name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Button type="primary" htmlType="submit">Create batch</Button>
      </Form>
    </Modal>
  </div>;
}
