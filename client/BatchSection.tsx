import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Modal, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { addBatchPlan, addPhoto, createBatch, eventDetails, listEvents, listPhotos, listPlans,
  recordEvent, type ActualEvent, type Batch, type Equipment, type InventoryItem, type LocalDb, type Plan } from './db.ts';
import { kindLabel } from './constants.ts';
import { formatTime } from './time.ts';
import { PlanForm } from './PlanForm.tsx';
import { EventForm } from './EventForm.tsx';
import type { PreferredUnits } from './api.ts';

function effectivePlanTime(plan: Plan, plans: Plan[], events: ActualEvent[]): number | null {
  if (plan.planned_at != null) return plan.planned_at;
  if (!plan.anchor_event_id) return null;
  const anchor = plans.find(item => item.id === plan.anchor_event_id);
  if (!anchor) return null;
  const actuals = events.filter(item => item.planned_event_id === anchor.id && item.event_type !== 'skipped');
  if (!actuals.length) return null;
  return Math.min(...actuals.map(item => item.actual_at)) + (plan.offset_seconds || 0);
}

export function BatchSection({ db, basePath, accountId, batches, equipment, inventory, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; batches: Batch[]; equipment: Equipment[]; inventory: InventoryItem[];
  preferredUnits: PreferredUnits; selectedId: string | null; onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [events, setEvents] = useState<ActualEvent[]>([]);
  const [details, setDetails] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<{ id: string; url: string }[]>([]);
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
      return nextPhotos.map(photo => ({ id: photo.id, url: URL.createObjectURL(new Blob([photo.image as BlobPart], { type: photo.mime_type })) }));
    });
  }
  useEffect(() => { void refreshDetail(); }, [db, selectedId, batches]);
  useEffect(() => () => { for (const photo of photos) URL.revokeObjectURL(photo.url); }, [photos]);

  const sortedPlans = useMemo(() => [...plans].sort((a, b) =>
    (effectivePlanTime(a, plans, events) ?? Number.MAX_SAFE_INTEGER) -
    (effectivePlanTime(b, plans, events) ?? Number.MAX_SAFE_INTEGER)), [plans, events]);

  async function changed() { await refreshDetail(); await onChanged(); }

  async function create(values: { name: string; description?: string }) {
    try {
      const id = await createBatch(db, values.name.trim(), values.description || '', accountId);
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

  async function uploadPhoto(file: File) {
    if (!batch) return;
    try { await addPhoto(db, batch.id, file, accountId); await changed(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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
        <Button type="link" className="back-link" onClick={() => onSelect(null)}>← All batches</Button>
        <div className="content-heading"><div><span className="eyebrow">Batch log</span><h2>{batch.name}</h2>
          <p className="muted">{batch.description || 'A living record of this brew.'}</p></div>
          <div className="heading-actions"><Button onClick={() => setNewPlan(true)}>Plan</Button>
            <Button type="primary" onClick={() => { setEventPlan(null); setNewEvent(true); }}>Log event</Button></div>
        </div>
        <div className="batch-columns">
          <section><div className="column-title"><h3>Planned</h3><span>{plans.length}</span></div>
            {sortedPlans.length === 0 ? <Card><Empty description="No planned events" /></Card> :
              <div className="card-stack">{sortedPlans.map(plan => {
                const linked = events.filter(item => item.planned_event_id === plan.id);
                const completed = linked.filter(item => item.event_type !== 'skipped');
                const skipped = linked.filter(item => item.event_type === 'skipped');
                const due = effectivePlanTime(plan, plans, events);
                return <Card key={plan.id} size="small" className="plan-card">
                  <div className="timeline-card"><div><strong>{plan.title}</strong><div className="muted">{formatTime(due)}</div></div>
                    <Tag color={completed.length && skipped.length || completed.length > 1 ? 'orange' : completed.length ? 'green' : skipped.length ? 'default' : due && due < Date.now() / 1000 ? 'red' : 'blue'}>
                      {completed.length && skipped.length || completed.length > 1 ? 'Conflicting' : completed.length ? 'Done' : skipped.length ? 'Skipped' : 'Planned'}</Tag></div>
                  <div className="plan-meta">{kindLabel(plan.event_type)}{plan.anchor_event_id ? ` · ${plan.offset_seconds || 0}s after ${plans.find(item => item.id === plan.anchor_event_id)?.title || 'anchor'}` : ''}</div>
                  {!linked.length && <div className="card-actions"><Button size="small" type="link" onClick={() => { setEventPlan(plan); setNewEvent(true); }}>Record actual</Button>
                    <Button size="small" type="link" onClick={() => void skip(plan)}>Skip</Button></div>}
                </Card>;
              })}</div>}
          </section>
          <section><div className="column-title"><h3>Activity</h3><span>{events.length}</span></div>
            {events.length === 0 ? <Card><Empty description="No events logged yet" /></Card> :
              <div className="card-stack">{events.map(event => <Card key={event.id} size="small" className="event-card">
                <div className="timeline-card"><div><strong>{kindLabel(event.event_type)}</strong>
                  <div className="muted">{formatTime(event.actual_at)}</div></div><Tag>{event.source_id || 'Manual'}</Tag></div>
                {details[event.id] && <p className="event-detail">{details[event.id]}</p>}
                {event.planned_event_id && <span className="plan-meta">For: {plans.find(item => item.id === event.planned_event_id)?.title || 'planned event'}</span>}
              </Card>)}</div>}
          </section>
        </div>
        <section className="photo-section"><div className="column-title"><h3>Photos</h3>
          <label className="file-button">Add photo<input type="file" accept="image/*" onChange={event => {
            const file = event.target.files?.[0]; if (file) void uploadPhoto(file); event.target.value = '';
          }} /></label></div>
          {photos.length ? <div className="photo-grid">{photos.map(photo => <img key={photo.id} src={photo.url} alt="Batch" />)}</div> :
            <p className="muted">No photos yet. Images up to 5 MB are saved with this brewery.</p>}
        </section>
      </section>}
    <Modal title="New batch" open={newBatch} onCancel={() => setNewBatch(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={create}>
        <Form.Item name="name" label="Batch name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="description" label="Description"><Input.TextArea rows={2} /></Form.Item>
        <Button type="primary" htmlType="submit">Create batch</Button>
      </Form>
    </Modal>
    <Modal title="Plan an event" open={newPlan} onCancel={() => setNewPlan(false)} footer={null} destroyOnHidden>
      <PlanForm anchors={plans} submit={plan} />
    </Modal>
    <Modal title={eventPlan ? `Record: ${eventPlan.title}` : 'Log an event'} open={newEvent}
      onCancel={() => { setNewEvent(false); setEventPlan(null); }} footer={null} destroyOnHidden width={600}>
      {batch && <EventForm db={db} batchId={batch.id} accountId={accountId} plans={plans} equipment={equipment} inventory={inventory}
        preferredUnits={preferredUnits} initialPlan={eventPlan} onSaved={async () => { setNewEvent(false); setEventPlan(null); await changed(); }} />}
    </Modal>
  </div>;
}
