import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Dropdown, Empty, Form, Input, Modal, Select, Tag } from 'antd';
import { CheckOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { addBatchPlan, createBatch, eventDetails, eventFormData, listEvents, listPhotos,
  startBatchFromRecipe, updateBatchPlan, type ActualEvent, type Batch, type Equipment, type InventoryItem,
  type LocalDb, type MeasurementKind, type PlanInput, type Recipe } from './db.ts';
import { kindLabel, planKinds } from './constants.ts';
import { formatTime } from './time.ts';
import { PlanForm } from './PlanForm.tsx';
import { EventForm } from './EventForm.tsx';
import type { PreferredUnits } from './api.ts';
import type { CatalogInventory } from '../shared/catalog.ts';
import { effectivePlanTime, planDetailsLabel, planDuration, planKindLabel, planTimingLabel } from './planTiming.ts';

interface TimelineGroup { key: string; at: number | null; label: string; events: ActualEvent[] }

export function BatchSection({ db, basePath, accountId, batches, recipes, equipment, inventory, catalogInventory, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; batches: Batch[]; recipes: Recipe[]; equipment: Equipment[]; inventory: InventoryItem[];
  catalogInventory: CatalogInventory[]; preferredUnits: PreferredUnits; selectedId: string | null;
  onSelect: (id: string | null) => void; onChanged: () => Promise<void>;
}) {
  const [events, setEvents] = useState<ActualEvent[]>([]);
  const [details, setDetails] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<{ id: string; url: string; batch_event_id: string | null; created_at: number }[]>([]);
  const [newBatch, setNewBatch] = useState(false);
  const [creatingKind, setCreatingKind] = useState<string | null>(null);
  const [editingPlan, setEditingPlan] = useState<ActualEvent | null>(null);
  const [recordingEvent, setRecordingEvent] = useState<ActualEvent | null>(null);
  const [editingData, setEditingData] = useState<{ measurementKind?: MeasurementKind; payload: Record<string, string | number | null> } | null>(null);
  const [error, setError] = useState('');
  const batch = batches.find(item => item.id === selectedId) || null;

  async function refreshDetail() {
    if (!selectedId) return;
    const [nextEvents, nextPhotos] = await Promise.all([listEvents(db, selectedId), listPhotos(db, selectedId)]);
    setEvents(nextEvents);
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

  const timeline = useMemo(() => {
    if (!batch) return [];
    const groups = new Map<string, TimelineGroup>();
    for (const item of events) {
      const at = item.actual_at ?? item.skipped_at ?? effectivePlanTime(item, events, events, batch.created_at);
      const key = at == null ? `anchor:${item.anchor_event_id}:${item.offset_seconds || 0}` : `time:${Math.floor(at / 60)}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, at, label: item.actual_at != null || item.skipped_at != null ? formatTime(at!) : planTimingLabel(item, events), events: [] };
        groups.set(key, group);
      }
      group.events.push(item);
    }
    return [...groups.values()].sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
  }, [batch, events]);

  async function changed() { await refreshDetail(); await onChanged(); }

  async function create(values: { name: string; description?: string; recipe_id?: string }) {
    try {
      const recipe = recipes.find(item => item.id === values.recipe_id);
      if (values.recipe_id && !recipe) throw new Error('Choose an available recipe');
      const id = recipe ? await startBatchFromRecipe(db, recipe, values.name.trim(), accountId, values.description || '')
        : await createBatch(db, values.name.trim(), values.description || '', accountId);
      onSelect(id); setNewBatch(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveAction(input: PlanInput, recordNow = false) {
    if (!batch) return;
    try {
      const id = editingPlan ? (await updateBatchPlan(db, batch.id, editingPlan.id, input), editingPlan.id)
        : await addBatchPlan(db, batch.id, input, accountId);
      setCreatingKind(null); setEditingPlan(null);
      await changed();
      if (recordNow) {
        const next = await listEvents(db, batch.id);
        setRecordingEvent(next.find(item => item.id === id) || null);
        setEditingData(null);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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
      {batches.length === 0 ? <Empty description="No batches yet" /> : <div className="record-list">{batches.map(item =>
        <a key={item.id} className="record-link" href={`${basePath}/batch/${item.id}`}
          onClick={event => { event.preventDefault(); onSelect(item.id); }}>
          <strong>{item.name}</strong><small>{item.description || formatTime(item.created_at)}</small>
        </a>)}</div>}
    </section> : !batch ? <Empty description="Batch not found" /> : <section className="record-detail">
      <div className="content-heading"><div><span className="eyebrow">Batch log</span><h2>{batch.name}</h2>
        <p className="muted">{batch.description || 'A living record of this brew.'}</p>
        <p className="muted">Started {formatTime(batch.created_at)}</p></div></div>
      <section className="batch-timeline"><div className="column-title"><h3>Timeline</h3><span>{events.length} actions</span></div>
        {timeline.length === 0 ? <Card><Empty description="No activity yet" /></Card> :
          <div className="card-stack">{timeline.map(group => <Card key={group.key} size="small" className="timeline-group">
            <div className="timeline-group-heading"><strong>{group.label}</strong>
              {group.at != null && <span className="muted">{formatTime(group.at)}</span>}</div>
            {group.events.map(event => {
              const images = photos.filter(photo => photo.batch_event_id === event.id);
              const happened = event.actual_at != null;
              const skipped = !happened && event.skipped_at != null;
              const detail = happened && ['addition', 'measurement', 'temperature_control', 'note', 'photo'].includes(event.event_type)
                ? details[event.id] : planDetailsLabel(event) || details[event.id];
              return <div key={event.id} className="timeline-entry plan-card">
                <div className="timeline-card"><div><div className="title-edit-row">
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Edit ${event.title || kindLabel(event.event_type)}`}
                    onClick={() => happened ? void recordOrEdit(event) : setEditingPlan(event)} />
                  <strong>{event.title || planKindLabel(event)}</strong></div>
                  <div className="plan-meta">{planKindLabel(event)} · {happened ? `${formatTime(event.actual_at!)}${event.ended_at ? ` – ${formatTime(event.ended_at)}` : ''}` : skipped ? `Skipped ${formatTime(event.skipped_at!)}` : planTimingLabel(event, events)}</div>
                  <Tag color={happened ? planDuration(event) && !event.ended_at ? 'cyan' : 'green' : skipped ? 'default' : 'blue'}>
                    {happened ? planDuration(event) && !event.ended_at ? 'In progress' : 'Done' : skipped ? 'Skipped' : 'Pending'}</Tag></div>
                  {!happened && <Button type="text" shape="circle" icon={<CheckOutlined />} aria-label={`Record ${event.title}`}
                    title="Record or skip" onClick={() => void recordOrEdit(event)} />}</div>
                {detail && <p className="event-detail">{detail}</p>}
                {images.length > 0 && <div className="photo-grid">{images.map(photo => <img key={photo.id} src={photo.url} alt="Batch activity" />)}</div>}
              </div>;
            })}
          </Card>)}</div>}
      </section>
      <div className="timeline-actions"><Dropdown trigger={['click']} placement="topLeft"
        menu={{ items: planKinds.map(item => ({ key: item.value, label: item.label })),
          onClick: ({ key }) => { setEditingPlan(null); setCreatingKind(key); } }}>
        <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="Add action" title="Add action" />
      </Dropdown></div>
    </section>}
    <Modal title="New batch" open={newBatch} onCancel={() => setNewBatch(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={create}>
        <Form.Item name="name" label="Batch name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="recipe_id" label="Recipe (optional)"><Select allowClear showSearch optionFilterProp="label"
          placeholder="Choose a recipe" options={recipes.map(recipe => ({ value: recipe.id, label: recipe.name }))} /></Form.Item>
        <Form.Item name="description" label="Description"><Input.TextArea rows={2} /></Form.Item>
        <Button type="primary" htmlType="submit">Create batch</Button>
      </Form>
    </Modal>
    <Modal title={editingPlan ? `Edit ${kindLabel(editingPlan.event_type).toLowerCase()}` : `Add ${kindLabel(creatingKind || '').toLowerCase()}`}
      open={!!(editingPlan || creatingKind)} onCancel={() => { setCreatingKind(null); setEditingPlan(null); }} footer={null} destroyOnHidden>
      {(editingPlan || creatingKind) && <PlanForm key={editingPlan?.id || creatingKind || 'new'}
        eventType={editingPlan?.event_type || creatingKind || 'addition'} anchors={events.filter(item => item.id !== editingPlan?.id)}
        initialPlan={editingPlan || undefined} inventory={inventory} catalog={catalogInventory}
        preferredUnits={preferredUnits} allowRecordNow submit={saveAction} />}
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
