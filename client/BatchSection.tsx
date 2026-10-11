import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Modal, Select, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { addBatchPlan, createBatch, eventDetails, listEvents, listPhotos, listPlans,
  recordEvent, startBatchFromRecipe, type ActualEvent, type Batch, type Equipment, type InventoryItem, type LocalDb, type Plan, type Recipe } from './db.ts';
import { kindLabel } from './constants.ts';
import { formatTime } from './time.ts';
import { PlanForm } from './PlanForm.tsx';
import { EventForm } from './EventForm.tsx';
import type { PreferredUnits } from './api.ts';
import { effectivePlanTime, planDetailsLabel, planTimingLabel } from './planTiming.ts';

interface TimelineGroup {
  key: string; at: number | null; label: string;
  plans: Plan[]; events: ActualEvent[]; legacyPhotos: { id: string; url: string; created_at: number }[];
}

export function BatchSection({ db, basePath, accountId, batches, recipes, equipment, inventory, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; batches: Batch[]; recipes: Recipe[]; equipment: Equipment[]; inventory: InventoryItem[];
  preferredUnits: PreferredUnits; selectedId: string | null; onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [events, setEvents] = useState<ActualEvent[]>([]);
  const [details, setDetails] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<{ id: string; url: string; batch_event_id: string | null; created_at: number }[]>([]);
  const [newBatch, setNewBatch] = useState(false);
  const [newPlan, setNewPlan] = useState(false);
  const [newEvent, setNewEvent] = useState(false);
  const [eventPlan, setEventPlan] = useState<Plan | null>(null);
  const [error, setError] = useState('');
  const batch = batches.find(item => item.id === selectedId) || null;

  async function refreshDetail() {
    if (!selectedId) return;
    const [nextPlans, nextEvents, nextPhotos] = await Promise.all([
      listPlans(db, selectedId), listEvents(db, selectedId), listPhotos(db, selectedId)
    ]);
    setPlans(nextPlans); setEvents(nextEvents);
    const nextDetails: Record<string, string> = {};
    for (const event of nextEvents) nextDetails[event.id] = await eventDetails(db, event);
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
    const groupFor = (key: string, at: number | null, label: string) => {
      let group = groups.get(key);
      if (!group) {
        group = { key, at, label, plans: [], events: [], legacyPhotos: [] };
        groups.set(key, group);
      }
      return group;
    };
    for (const plan of plans) {
      const at = effectivePlanTime(plan, plans, events, batch.created_at);
      const key = at == null ? `anchor:${plan.anchor_event_id}:${plan.offset_seconds || 0}` : `time:${Math.floor(at / 60)}`;
      groupFor(key, at, planTimingLabel(plan, plans)).plans.push(plan);
    }
    for (const event of events) {
      if (event.planned_event_id && plans.some(plan => plan.id === event.planned_event_id)) continue;
      groupFor(`time:${Math.floor(event.actual_at / 60)}`, event.actual_at, formatTime(event.actual_at)).events.push(event);
    }
    for (const photo of photos) {
      if (photo.batch_event_id && events.some(event => event.id === photo.batch_event_id)) continue;
      groupFor(`time:${Math.floor(photo.created_at / 60)}`, photo.created_at, formatTime(photo.created_at)).legacyPhotos.push(photo);
    }
    return [...groups.values()].sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
  }, [batch, plans, events, photos]);

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

  async function plan(input: Parameters<typeof addBatchPlan>[2]) {
    if (!batch) return;
    await addBatchPlan(db, batch.id, input, accountId);
    setNewPlan(false); await changed();
  }

  async function skip(plan: Plan) {
    if (!batch) return;
    try {
      await recordEvent(db, { batchId: batch.id, accountId, eventType: 'skipped',
        actualAt: Math.floor(Date.now() / 1000), plannedEventId: plan.id });
      await changed();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function renderEvent(event: ActualEvent) {
    const images = photos.filter(photo => photo.batch_event_id === event.id);
    return <div key={event.id} className="timeline-entry event-card">
      <div className="timeline-card"><div><strong>{event.event_type === 'skipped' ? 'Skipped' : kindLabel(event.event_type)}</strong>
        <div className="muted">{formatTime(event.actual_at)}</div></div><Tag>{event.source_id || 'Manual'}</Tag></div>
      {details[event.id] && <p className="event-detail">{details[event.id]}</p>}
      {images.length > 0 && <div className="photo-grid">{images.map(photo => <img key={photo.id} src={photo.url} alt="Batch activity" />)}</div>}
    </div>;
  }

  return <div className="section-page">
    {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index">
      <div className="section-heading"><div><span className="eyebrow">Your brewing record</span><h1>Batches</h1></div>
        <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="New batch" title="New batch" onClick={() => setNewBatch(true)} /></div>
      <p className="muted">Plans, actions and readings, all around the batch.</p>
      {batches.length === 0 ? <Empty description="No batches yet" /> : <div className="record-list">{batches.map(item =>
        <a key={item.id} className="record-link" href={`${basePath}/batch/${item.id}`}
          onClick={event => { event.preventDefault(); onSelect(item.id); }}>
          <strong>{item.name}</strong><small>{item.description || formatTime(item.created_at)}</small>
        </a>)}</div>}
    </section> : !batch ? <Empty description="Batch not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">Batch log</span><h2>{batch.name}</h2>
          <p className="muted">{batch.description || 'A living record of this brew.'}</p>
          <p className="muted">Started {formatTime(batch.created_at)}</p></div>
        </div>
        <section className="batch-timeline"><div className="column-title"><h3>Timeline</h3><span>{plans.length} planned · {events.length + photos.filter(photo => !photo.batch_event_id).length} recorded</span></div>
          {timeline.length === 0 ? <Card><Empty description="No activity yet" /></Card> :
            <div className="card-stack">{timeline.map(group => <Card key={group.key} size="small" className="timeline-group">
              <div className="timeline-group-heading"><strong>{group.label}</strong>
                {group.at != null && <span className="muted">{formatTime(group.at)}</span>}</div>
              {group.plans.map(plan => {
                const linked = events.filter(item => item.planned_event_id === plan.id);
                const completed = linked.filter(item => item.event_type !== 'skipped');
                const skipped = linked.filter(item => item.event_type === 'skipped');
                const conflicting = !!(completed.length && skipped.length || completed.length > 1);
                return <div key={plan.id} className="timeline-entry plan-card">
                  <div className="timeline-card"><div><strong>{plan.title}</strong>
                    <div className="plan-meta">{kindLabel(plan.event_type)} · {planTimingLabel(plan, plans)}</div></div>
                    <Tag color={conflicting ? 'orange' : completed.length ? 'green' : skipped.length ? 'default' : 'blue'}>
                      {conflicting ? 'Conflicting' : completed.length ? 'Done' : skipped.length ? 'Skipped' : 'Planned'}</Tag></div>
                  {planDetailsLabel(plan) && <p className="event-detail">{planDetailsLabel(plan)}</p>}
                  {linked.map(renderEvent)}
                  {!linked.length && <div className="card-actions"><Button size="small" type="link" onClick={() => { setEventPlan(plan); setNewEvent(true); }}>Record</Button>
                    <Button size="small" type="link" onClick={() => void skip(plan)}>Skip</Button></div>}
                </div>;
              })}
              {group.events.map(renderEvent)}
              {group.legacyPhotos.map(photo => <div key={photo.id} className="timeline-entry event-card">
                <div className="timeline-card"><div><strong>Photo</strong><div className="muted">{formatTime(photo.created_at)}</div></div><Tag>Manual</Tag></div>
                <div className="photo-grid"><img src={photo.url} alt="Batch activity" /></div>
              </div>)}
            </Card>)}</div>}
        </section>
        <div className="timeline-actions"><Button onClick={() => setNewPlan(true)}>Plan an action</Button>
          <Button type="primary" onClick={() => { setEventPlan(null); setNewEvent(true); }}>Record activity</Button></div>
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
    <Modal title="Plan an event" open={newPlan} onCancel={() => setNewPlan(false)} footer={null} destroyOnHidden>
      <PlanForm anchors={plans} submit={plan} />
    </Modal>
    <Modal title={eventPlan ? `Record: ${eventPlan.title}` : 'Record activity'} open={newEvent}
      onCancel={() => { setNewEvent(false); setEventPlan(null); }} footer={null} destroyOnHidden width={600}>
      {batch && <EventForm db={db} batchId={batch.id} accountId={accountId} plans={plans} equipment={equipment} inventory={inventory}
        preferredUnits={preferredUnits} initialPlan={eventPlan} onSaved={async () => { setNewEvent(false); setEventPlan(null); await changed(); }} />}
    </Modal>
  </div>;
}
