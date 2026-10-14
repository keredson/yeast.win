import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Form, Input, InputNumber, Modal, Select } from 'antd';
import { PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { addBatchPlan, createBatch, eventDetails, eventFormData, listEvents, listPhotos, releaseEquipmentUse,
  startBatchFromRecipe, startBatchFromTemplate, startBatchFromPrevious, updateBatchPlan, batchWortLoss, updateBatchWortLoss,
  type ActualEvent, type Batch, type Equipment, type InventoryItem,
  type LocalDb, type MeasurementKind, type PlanInput, type Recipe, type RecipeType } from './db.ts';
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
  const [newBatchForm] = Form.useForm();
  const startFrom = Form.useWatch('start_from', newBatchForm) as string | undefined;
  const selectedRecipeId = Form.useWatch('recipe_id', newBatchForm) as string | undefined;
  const selectedPreviousId = Form.useWatch('source_batch_id', newBatchForm) as string | undefined;
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

  async function create(values: { name: string; description?: string; start_from: string; recipe_id?: string;
    source_batch_id?: string; unit_ids?: Record<string, string>; stock_ids?: Record<string, string>; wort_loss?: number }) {
    try {
      let id: string;
      if (values.start_from === 'recipe') {
        const recipe = recipes.find(item => item.id === values.recipe_id);
        if (!recipe) throw new Error('Choose an available recipe');
        id = await startBatchFromRecipe(db, recipe, values.name.trim(), accountId, values.description || '', values.unit_ids);
      } else if (values.start_from === 'previous') {
        if (!values.source_batch_id || !batches.some(item => item.id === values.source_batch_id))
          throw new Error('Choose an available previous batch');
        id = await startBatchFromPrevious(db, values.source_batch_id, values.name.trim(), accountId,
          values.description || '', values.unit_ids, values.stock_ids);
      } else if (values.start_from.startsWith('template:')) {
        id = await startBatchFromTemplate(db, values.start_from.slice(9) as RecipeType, values.name.trim(),
          values.description || '', accountId, preferredUnits.temperature);
      } else {
        id = await createBatch(db, values.name.trim(), values.description || '', accountId);
      }
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
        {batch.source_batch_id && <p className="muted">Started from {batch.source_batch_name
          ? <a href={`${basePath}/batch/${batch.source_batch_id}`}
            onClick={event => { event.preventDefault(); onSelect(batch.source_batch_id!); }}>{batch.source_batch_name}</a>
          : 'a previous batch'}</p>}
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
    <Modal title="New batch" open={newBatch} onCancel={() => setNewBatch(false)} afterClose={() => newBatchForm.resetFields()}
      footer={null} destroyOnHidden>
      <Form form={newBatchForm} layout="vertical" onFinish={create} initialValues={{ start_from: 'empty' }}>
        <Form.Item name="name" label="Batch name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="start_from" label="Start from"><Select options={[
          { value: 'empty', label: 'Empty batch' },
          { value: 'template:beer', label: 'Beer template' },
          { value: 'template:wine', label: 'Wine template' },
          { value: 'template:mead', label: 'Mead template' },
          { value: 'template:cider', label: 'Cider template' },
          { value: 'recipe', label: 'Recipe' },
          { value: 'previous', label: 'Previous batch' }
        ]} /></Form.Item>
        {startFrom === 'recipe' && <><Form.Item name="recipe_id" label="Recipe" rules={[{ required: true }]}>
          <Select showSearch optionFilterProp="label" placeholder="Choose a recipe"
            options={recipes.map(recipe => ({ value: recipe.id, label: recipe.name }))} /></Form.Item>
          <RecipeEquipmentFields db={db} recipeId={selectedRecipeId} equipment={equipment} models={equipmentModels} /></>}
        {startFrom === 'previous' && <><Form.Item name="source_batch_id" label="Previous batch" rules={[{ required: true }]}>
          <Select showSearch optionFilterProp="label" placeholder="Choose a batch"
            options={batches.map(previous => ({ value: previous.id, label: previous.name }))} /></Form.Item>
          <PreviousBatchFields db={db} batchId={selectedPreviousId} equipment={equipment} inventory={inventory} /></>}
        <Form.Item name="wort_loss" label={`Wort loss override (${preferredUnits.volume})`}>
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

function PreviousBatchFields({ db, batchId, equipment, inventory }: {
  db: LocalDb; batchId?: string; equipment: Equipment[]; inventory: InventoryItem[];
}) {
  const [events, setEvents] = useState<ActualEvent[]>([]);
  const [sourceUnits, setSourceUnits] = useState<{ id: string; model_id: string; name: string }[]>([]);
  useEffect(() => {
    if (!batchId) { setEvents([]); return; }
    let active = true;
    void Promise.all([listEvents(db, batchId),
      db.execO<{ id: string; model_id: string; name: string }>('SELECT id, model_id, name FROM equipment')])
      .then(([nextEvents, nextUnits]) => { if (active) { setEvents(nextEvents); setSourceUnits(nextUnits); } });
    return () => { active = false; };
  }, [db, batchId]);
  const equipmentIds = [...new Set(events.flatMap(event =>
    [event.details.equipment_id, event.details.mash_equipment_id, event.details.to_vessel_id]
      .filter((id): id is string => typeof id === 'string' && !!id)))];
  const ingredients = [...new Map(events.filter(event => event.event_type === 'addition'
    && (event.actual_at != null || event.skipped_at == null))
    .map(event => [event.details.inventory_item_id || event.details.supply_id, event.details] as const)
    .filter(([key]) => !!key)).values()];
  return <>
    {equipmentIds.map(sourceId => {
      const source = sourceUnits.find(unit => unit.id === sourceId);
      const choices = equipment.filter(unit => unit.model_id === source?.model_id && unit.removed_at == null);
      const defaultId = choices.some(unit => unit.id === sourceId) ? sourceId
        : choices.length === 1 ? choices[0].id : 'unlinked';
      return <Form.Item key={sourceId} name={['unit_ids', sourceId]} initialValue={defaultId}
        label={`${source?.name || 'Equipment'} for this batch`}>
        <Select options={[{ value: 'unlinked', label: 'Choose later' }, ...choices.map(unit => ({
          value: unit.id, label: unit.stock_id ? `${unit.name} · ${unit.stock_id}` : unit.name
        }))]} />
      </Form.Item>;
    })}
    {ingredients.map(details => {
      const key = details.inventory_item_id || details.supply_id!;
      const choices = details.supply_id ? inventory.filter(item => item.supply_id === details.supply_id)
        : inventory.filter(item => item.id === details.inventory_item_id);
      return <Form.Item key={key} name={['stock_ids', key]}
        initialValue={choices.length === 1 ? choices[0].id : 'unlinked'}
        label={`Stock for ${details.item_name || choices[0]?.name || 'ingredient'}`}>
        <Select options={[{ value: 'unlinked', label: 'Choose later' }, ...choices.map(item => ({
          value: item.id, label: item.lot_code ? `${item.name} · Lot ${item.lot_code}` : item.name
        }))]} />
      </Form.Item>;
    })}
  </>;
}
