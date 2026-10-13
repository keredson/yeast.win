import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Form, Input, InputNumber, Modal, Select } from 'antd';
import { PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { addBatchPlan, createBatch, eventDetails, eventFormData, listEvents, listPhotos, releaseEquipmentUse,
  startBatchFromRecipe, updateBatchPlan, batchWortLoss, updateBatchWortLoss,
  type ActualEvent, type Batch, type Equipment, type InventoryItem,
  type LocalDb, type MeasurementKind, type PlanInput, type Recipe } from './db.ts';
import { kindLabel } from './constants.ts';
import { formatTime } from './time.ts';
import { PlanForm, repeatPreset, type PlanPreset } from './PlanForm.tsx';
import { EventForm } from './EventForm.tsx';
import { EventTimeline } from './EventTimeline.tsx';
import { RecipeEquipmentFields } from './RecipeEquipmentFields.tsx';
import type { PreferredUnits } from './api.ts';
import type { CatalogInventory } from '../shared/catalog.ts';
import { convertUnit } from '../shared/units.ts';

export function BatchSection({ db, basePath, accountId, batches, recipes, equipment, equipmentModels, inventory, catalogInventory, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; batches: Batch[]; recipes: Recipe[]; equipment: Equipment[]; equipmentModels: Equipment[]; inventory: InventoryItem[];
  catalogInventory: CatalogInventory[]; preferredUnits: PreferredUnits; selectedId: string | null;
  onSelect: (id: string | null) => void; onChanged: () => Promise<void>;
}) {
  const [events, setEvents] = useState<ActualEvent[]>([]);
  const [details, setDetails] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<{ id: string; url: string; batch_event_id: string | null; created_at: number }[]>([]);
  const [newBatch, setNewBatch] = useState(false);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | undefined>();
  const [creatingKind, setCreatingKind] = useState<string | null>(null);
  const [preset, setPreset] = useState<PlanPreset>({});
  const [editingPlan, setEditingPlan] = useState<ActualEvent | null>(null);
  const [recordingEvent, setRecordingEvent] = useState<ActualEvent | null>(null);
  const [editingData, setEditingData] = useState<{ measurementKind?: MeasurementKind; payload: Record<string, string | number | null> } | null>(null);
  const [error, setError] = useState('');
  const [wortLoss, setWortLoss] = useState<number | null>(null);
  const [editWortLoss, setEditWortLoss] = useState(false);
  const batch = batches.find(item => item.id === selectedId) || null;

  async function refreshDetail() {
    if (!selectedId) return;
    const [nextEvents, nextPhotos, nextWortLoss] = await Promise.all([
      listEvents(db, selectedId), listPhotos(db, selectedId), batchWortLoss(db, selectedId)]);
    setEvents(nextEvents);
    setWortLoss(nextWortLoss);
    const nextDetails: Record<string, string> = {};
    for (const event of nextEvents.filter(item => item.actual_at != null)) {
      nextDetails[event.id] = await eventDetails(db, event, preferredUnits.mass);
    }
    setDetails(nextDetails);
    setPhotos(previous => {
      for (const photo of previous) URL.revokeObjectURL(photo.url);
      return nextPhotos.map(photo => ({ id: photo.id, batch_event_id: photo.batch_event_id, created_at: photo.created_at,
        url: URL.createObjectURL(new Blob([photo.image as BlobPart], { type: photo.mime_type })) }));
    });
  }
  useEffect(() => { void refreshDetail(); }, [db, selectedId, batches]);
  useEffect(() => () => { for (const photo of photos) URL.revokeObjectURL(photo.url); }, [photos]);

  async function changed() { await refreshDetail(); await onChanged(); }

  async function create(values: { name: string; description?: string; recipe_id?: string;
    unit_ids?: Record<string, string>; wort_loss?: number }) {
    try {
      const recipe = recipes.find(item => item.id === values.recipe_id);
      if (values.recipe_id && !recipe) throw new Error('Choose an available recipe');
      const id = recipe ? await startBatchFromRecipe(db, recipe, values.name.trim(), accountId, values.description || '', values.unit_ids)
        : await createBatch(db, values.name.trim(), values.description || '', accountId);
      if (values.wort_loss != null) await updateBatchWortLoss(db, id,
        convertUnit(values.wort_loss, preferredUnits.volume, 'L'));
      onSelect(id); setNewBatch(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveWortLoss(values: { wort_loss: number }) {
    if (!batch) return;
    try {
      await updateBatchWortLoss(db, batch.id, convertUnit(values.wort_loss, preferredUnits.volume, 'L'));
      setEditWortLoss(false);
      await changed();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveAction(input: PlanInput, recordNow = false, addAnother = false) {
    if (!batch) return;
    const id = editingPlan ? (await updateBatchPlan(db, batch.id, editingPlan.id, input), editingPlan.id)
      : await addBatchPlan(db, batch.id, input, accountId);
    if (addAnother && editingPlan) { setPreset(repeatPreset(input)); setCreatingKind(editingPlan.event_type); setEditingPlan(null); }
    if (!addAnother) { setCreatingKind(null); setEditingPlan(null); }
    await changed();
    if (recordNow) {
      const next = await listEvents(db, batch.id);
      setRecordingEvent(next.find(item => item.id === id) || null);
      setEditingData(null);
    }
  }

  async function recordOrEdit(event: ActualEvent) {
    try {
      setEditingData(event.actual_at != null ? await eventFormData(db, event) : null);
      setRecordingEvent(event);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="section-page">
    {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index">
      <div className="section-heading"><div><span className="eyebrow">Your brewing record</span><h1>Batches</h1></div>
        <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="New batch" title="New batch" onClick={() => setNewBatch(true)} /></div>
      <p className="muted">Actions and readings, all around the batch.</p>
      {batches.length > 0 && <div className="record-list">{batches.map(item =>
        <a key={item.id} className="record-link" href={`${basePath}/batch/${item.id}`}
          onClick={event => { event.preventDefault(); onSelect(item.id); }}>
          <strong>{item.name}</strong><small>{item.description || formatTime(item.created_at)}</small>
        </a>)}</div>}
    </section> : !batch ? <Empty description="Batch not found" /> : <section className="record-detail">
      <div className="content-heading"><div><span className="eyebrow">Batch log</span><h2>{batch.name}</h2>
        <p className="muted">{batch.description || 'A living record of this brew.'}</p>
        <p className="muted">Started {formatTime(batch.created_at)}</p>
        <div className="equipment-parameter"><span>Expected wort loss to fermenter: {wortLoss == null ? 'Not set'
          : `${Number((convertUnit(wortLoss, 'L', preferredUnits.volume) || 0).toFixed(2))} ${preferredUnits.volume}`}</span>
          <Button type="text" size="small" icon={<SettingOutlined />} aria-label="Edit batch wort loss"
            onClick={() => setEditWortLoss(true)} /></div></div></div>
      <EventTimeline events={events} batchStartAt={batch.created_at} equipment={equipment} details={details} photos={photos}
        onEdit={event => event.actual_at != null ? void recordOrEdit(event as ActualEvent) : setEditingPlan(event as ActualEvent)}
        onRecord={event => void recordOrEdit(event)}
        onReleaseEquipment={id => { void releaseEquipmentUse(db, id).then(changed).catch(cause =>
          setError(cause instanceof Error ? cause.message : String(cause))); }}
        onAdd={(kind, settings) => { setEditingPlan(null); setPreset(settings); setCreatingKind(kind); }} />
    </section>}
    <Modal title="New batch" open={newBatch} onCancel={() => setNewBatch(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={create}>
        <Form.Item name="name" label="Batch name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="recipe_id" label="Recipe (optional)"><Select allowClear showSearch optionFilterProp="label"
          placeholder="Choose a recipe" options={recipes.map(recipe => ({ value: recipe.id, label: recipe.name }))}
          onChange={setSelectedRecipeId} /></Form.Item>
        <RecipeEquipmentFields db={db} recipeId={selectedRecipeId} equipment={equipment} models={equipmentModels} />
        <Form.Item name="wort_loss" label={`Wort loss override (${preferredUnits.volume}, optional)`}>
          <InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="description" label="Description"><Input.TextArea rows={2} /></Form.Item>
        <Button type="primary" htmlType="submit">Create batch</Button>
      </Form>
    </Modal>
    <Modal title="Batch wort loss" open={editWortLoss} onCancel={() => setEditWortLoss(false)} footer={null} destroyOnHidden>
      <Form key={`${batch?.id}:${editWortLoss}`} layout="vertical" onFinish={saveWortLoss}
        initialValues={{ wort_loss: wortLoss == null ? undefined : convertUnit(wortLoss, 'L', preferredUnits.volume) }}>
        <p className="muted">Adjust the expected loss for this batch without changing its recipe or brewery default.</p>
        <Form.Item name="wort_loss" label={`Wort loss to fermenter (${preferredUnits.volume})`} rules={[{ required: true }]}>
          <InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Save batch value</Button>
      </Form>
    </Modal>
    <Modal title={editingPlan ? editingPlan.event_type === 'addition' ? 'Edit ingredient'
      : `Edit ${kindLabel(editingPlan.event_type).toLowerCase()}` : creatingKind === 'addition' ? 'Add ingredient'
        : `Add ${kindLabel(creatingKind || '').toLowerCase()}`}
      open={!!(editingPlan || creatingKind)} onCancel={() => { setCreatingKind(null); setEditingPlan(null); }} footer={null} destroyOnHidden>
      {(editingPlan || creatingKind) && <PlanForm key={editingPlan?.id || creatingKind || 'new'}
        eventType={editingPlan?.event_type || creatingKind || 'addition'} anchors={events.filter(item => item.id !== editingPlan?.id)}
        initialPlan={editingPlan || undefined} equipment={equipment} inventory={inventory} catalog={catalogInventory}
        preferredUnits={preferredUnits} preset={editingPlan ? undefined : preset} allowRecordNow submit={saveAction} />}
    </Modal>
    <Modal title={recordingEvent?.actual_at != null ? `Edit: ${recordingEvent.title}` : `Record: ${recordingEvent?.title || ''}`}
      open={!!recordingEvent} onCancel={() => { setRecordingEvent(null); setEditingData(null); }} footer={null} destroyOnHidden width={600}>
      {batch && recordingEvent && <EventForm key={recordingEvent.id} db={db} batchId={batch.id} accountId={accountId}
        equipment={equipment} inventory={inventory} preferredUnits={preferredUnits} initialPlan={recordingEvent}
        initialEvent={recordingEvent.actual_at != null ? recordingEvent : null} initialData={editingData}
        onSaved={async () => { setRecordingEvent(null); setEditingData(null); await changed(); }} />}
    </Modal>
  </div>;
}
