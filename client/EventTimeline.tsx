import { useMemo, useState } from 'react';
import { Button, Card, Dropdown, Empty, Popconfirm, Tag } from 'antd';
import { CheckOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { ActualEvent, PlanInput } from './db.ts';
import { kindLabel, measurementKinds } from './constants.ts';
import { formatTime } from './time.ts';
import { effectivePlanTime, parsePlanDetails, planDetailsLabel, planDuration, planKindLabel, planTimingLabel } from './planTiming.ts';
import type { PlanPreset } from './PlanForm.tsx';

export type TimelineEvent = PlanInput & { id: string; actual_at?: number | null; skipped_at?: number | null; ended_at?: number | null };
export interface TimelinePhoto { id: string; url: string; batch_event_id: string | null }
interface Group { key: string; at: number | null; label: string; events: TimelineEvent[] }

export function actionForMenu(key: string, plans: TimelineEvent[]): { kind: string; preset: PlanPreset } {
  const [action, measurementKind] = key.split(':');
  const boil = plans.find(plan => parsePlanDetails(plan.details_json).phase === 'boil');
  const preset: PlanPreset = action === 'ingredient' ? { itemCategory: 'Grain', timingKey: boil ? `after:start:${boil.id}` : 'start' }
    : action === 'yeast' ? { itemCategory: 'Yeast', title: 'Yeast' }
      : action === 'measurement' ? { measurementKind, title: `Measure ${measurementKinds.find(item => item.value === measurementKind)?.label.toLowerCase() || measurementKind}` }
        : ['mash', 'boil', 'chill'].includes(action) ? { phase: action as PlanPreset['phase'], title: action[0].toUpperCase() + action.slice(1) } : {};
  return { kind: ['mash', 'boil', 'chill'].includes(action) ? 'temperature_control'
    : ['ingredient', 'yeast'].includes(action) ? 'addition' : action, preset };
}

const actionItems = [
  { key: 'mash', label: 'Mash' }, { key: 'boil', label: 'Boil' },
  { key: 'ingredient', label: 'Ingredient' }, { key: 'chill', label: 'Chill' },
  { key: 'yeast', label: 'Pitch yeast' },
  { key: 'measurement', label: 'Measurement', children: measurementKinds.map(kind => ({ key: `measurement:${kind.value}`, label: kind.label })) },
  { key: 'temperature_control', label: 'Temperature setting' }, { key: 'pressure_control', label: 'Pressure setting' },
  { key: 'transfer', label: 'Transfer' }, { key: 'packaging', label: 'Packaging' },
  { key: 'photo', label: 'Photo' }, { key: 'note', label: 'Notes' }
];

export function EventTimeline({ events, batchStartAt, details = {}, photos = [], onEdit, onAdd, onRecord, onDelete }: {
  events: TimelineEvent[]; batchStartAt?: number; details?: Record<string, string>; photos?: TimelinePhoto[];
  onEdit: (event: TimelineEvent) => void; onAdd: (kind: string, preset: PlanPreset) => void;
  onRecord?: (event: ActualEvent) => void; onDelete?: (event: TimelineEvent) => Promise<void>;
}) {
  const isBatch = batchStartAt != null;
  const [menuOpen, setMenuOpen] = useState(false);
  const groups = useMemo(() => {
    const startAt = batchStartAt ?? 0;
    const startKey = `time:${Math.floor(startAt / 60)}`;
    const grouped = new Map<string, Group>([[startKey, { key: startKey, at: startAt, label: 'Batch start', events: [] }]]);
    for (const item of events) {
      const at = item.actual_at ?? item.skipped_at ?? effectivePlanTime(item, events, events as ActualEvent[], startAt);
      const key = at == null ? `anchor:${item.anchor_event_id}:${item.offset_seconds || 0}` : `time:${Math.floor(at / 60)}`;
      let group = grouped.get(key);
      if (!group) {
        group = { key, at, label: isBatch && (item.actual_at != null || item.skipped_at != null)
          ? formatTime(at!) : planTimingLabel(item, events), events: [] };
        grouped.set(key, group);
      }
      group.events.push(item);
    }
    return [...grouped.values()].sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
  }, [events, batchStartAt, isBatch]);

  return <section className="batch-timeline"><div className="column-title"><h3>Timeline</h3><span>{events.length} actions</span></div>
    <div className="card-stack">{groups.map(group => <Card key={group.key} size="small" className="timeline-group">
      <div className="timeline-group-heading"><strong>{group.label}</strong>
        {isBatch && group.at != null && <span className="muted">{formatTime(group.at)}</span>}</div>
      {group.events.length === 0 && <div className="timeline-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No actions at the start yet" /></div>}
      {group.events.map(item => {
        const happened = item.actual_at != null;
        const skipped = !happened && item.skipped_at != null;
        const detail = happened && ['addition', 'measurement', 'temperature_control', 'note', 'photo'].includes(item.event_type)
          ? details[item.id] : planDetailsLabel(item) || details[item.id];
        const images = photos.filter(photo => photo.batch_event_id === item.id);
        return <div key={item.id} className="timeline-entry plan-card">
          <div className="timeline-card"><div><div className="title-edit-row">
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={`${isBatch ? 'Edit' : 'Edit planned event'} ${item.title || kindLabel(item.event_type)}`}
              onClick={() => onEdit(item)} />
            <strong>{item.title || planKindLabel(item)}</strong></div>
            <div className="plan-meta">{planKindLabel(item)} · {happened
              ? `${formatTime(item.actual_at!)}${item.ended_at ? ` – ${formatTime(item.ended_at)}` : ''}`
              : skipped ? `Skipped ${formatTime(item.skipped_at!)}` : planTimingLabel(item, events)}</div>
            {isBatch && <Tag color={happened ? planDuration(item) && !item.ended_at ? 'cyan' : 'green' : skipped ? 'default' : 'blue'}>
              {happened ? planDuration(item) && !item.ended_at ? 'In progress' : 'Done' : skipped ? 'Skipped' : 'Pending'}</Tag>}</div>
            {onRecord && !happened && <Button type="text" shape="circle" icon={<CheckOutlined />} aria-label={`Record ${item.title}`}
              title="Record or skip" onClick={() => onRecord(item as ActualEvent)} />}
            {onDelete && <Popconfirm title={`Delete ${item.title}?`}
              description="Actions timed from this one will become relative to batch start. Existing batches keep their copies."
              okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => void onDelete(item)}>
              <Button type="text" danger size="small" icon={<DeleteOutlined />} aria-label={`Delete planned event ${item.title}`} />
            </Popconfirm>}</div>
          {detail && <p className="event-detail">{detail}</p>}
          {images.length > 0 && <div className="photo-grid">{images.map(photo => <img key={photo.id} src={photo.url} alt="Batch activity" />)}</div>}
        </div>;
      })}
    </Card>)}</div>
    <div className="timeline-actions"><Dropdown trigger={['click']} placement="topLeft" open={menuOpen} onOpenChange={setMenuOpen}
      menu={{ items: actionItems, triggerSubMenuAction: 'click', onClick: ({ key }) => {
        const action = actionForMenu(key, events); setMenuOpen(false); onAdd(action.kind, action.preset);
      } }}>
      <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label={isBatch ? 'Add action' : 'Add recipe event'} title="Add action" />
    </Dropdown></div>
  </section>;
}
