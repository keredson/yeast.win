import { Fragment, useMemo, useState } from 'react';
import { Button, Card, Dropdown, Tag } from 'antd';
import { CheckOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { ActualEvent, Equipment, PlanInput } from './db.ts';
import { kindLabel, measurementKinds } from './constants.ts';
import { formatTime } from './time.ts';
import { formatOffset, orderTimelineGroup, planDetailsLabel, planDuration, planKindLabel, timelineGroupKey, timelineGroupStep, timelinePosition } from './planTiming.ts';
import type { PlanPreset } from './PlanForm.tsx';

export type TimelineEvent = PlanInput & { id: string; actual_at?: number | null; skipped_at?: number | null; ended_at?: number | null };
export interface TimelinePhoto { id: string; url: string; batch_event_id: string | null }
interface Group { key: string; at: number | null; step: number; events: TimelineEvent[] }

function shortTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, { timeStyle: 'short' });
}

export function actionForMenu(key: string, plans: TimelineEvent[]): { kind: string; preset: PlanPreset } {
  const [action, measurementKind] = key.split(':');
  const boil = plans.find(plan => plan.details?.phase === 'boil');
  const mash = plans.find(plan => plan.details?.phase === 'mash');
  const preset: PlanPreset = action === 'ingredient' ? { itemCategory: 'Grain', timingKey: boil ? `after:start:${boil.id}` : 'start' }
    : action === 'yeast' ? { itemCategory: 'Yeast', title: 'Yeast' }
      : action === 'drain_grain' ? { purpose: 'drain_grain', title: 'Drain grain',
        timingKey: mash ? `after:end:${mash.id}` : 'start' }
      : action === 'measurement' ? { measurementKind, title: `Measure ${measurementKinds.find(item => item.value === measurementKind)?.label.toLowerCase() || measurementKind}` }
        : ['mash', 'boil', 'chill'].includes(action) ? { phase: action as PlanPreset['phase'], title: action[0].toUpperCase() + action.slice(1) } : {};
  return { kind: ['mash', 'boil', 'chill'].includes(action) ? 'temperature_control'
    : ['ingredient', 'yeast'].includes(action) ? 'addition' : action === 'drain_grain' ? 'transfer' : action, preset };
}

const actionItems = [
  { key: 'ingredient', label: 'Ingredient' },
  { key: 'mash', label: 'Mash' }, { key: 'drain_grain', label: 'Drain grain' }, { key: 'boil', label: 'Boil' },
  { key: 'chill', label: 'Chill' },
  { key: 'yeast', label: 'Pitch yeast' },
  { key: 'measurement', label: 'Measurement', children: measurementKinds.map(kind => ({ key: `measurement:${kind.value}`, label: kind.label })) },
  { key: 'temperature_control', label: 'Temperature setting' }, { key: 'pressure_control', label: 'Pressure setting' },
  { key: 'transfer', label: 'Transfer' }, { key: 'packaging', label: 'Packaging' },
  { key: 'photo', label: 'Photo' }, { key: 'note', label: 'Notes' }
];

export function EventTimeline({ events, batchStartAt, equipment = [], details = {}, photos = [], onEdit, onAdd, onRecord, onReleaseEquipment }: {
  events: TimelineEvent[]; batchStartAt?: number; equipment?: Equipment[]; details?: Record<string, string>; photos?: TimelinePhoto[];
  onEdit: (event: TimelineEvent) => void; onAdd: (kind: string, preset: PlanPreset) => void;
  onRecord?: (event: ActualEvent) => void;
  onReleaseEquipment?: (eventId: string) => void;
}) {
  const isBatch = batchStartAt != null;
  const equipmentNames = new Map(equipment.map(item => [item.id, item.name]));
  const [menuOpen, setMenuOpen] = useState(false);
  const groups = useMemo(() => {
    const startAt = batchStartAt ?? 0;
    const startKey = timelineGroupKey(startAt, 0, 'start');
    const grouped = new Map<string, Group>([[startKey, { key: startKey, at: startAt, step: 0, events: [] }]]);
    const eventTimes = new Map<string, number | null>();
    for (const item of events) {
      const at = timelinePosition(item, events, startAt);
      eventTimes.set(item.id, at);
    }
    for (const item of events) {
      const at = eventTimes.get(item.id) ?? null;
      const step = timelineGroupStep(item, events, eventTimes);
      const key = timelineGroupKey(at, step, item.id);
      let group = grouped.get(key);
      if (!group) {
        group = { key, at, step, events: [] };
        grouped.set(key, group);
      }
      group.events.push(item);
    }
    for (const group of grouped.values()) group.events = orderTimelineGroup(group.events, eventTimes);
    return [...grouped.values()].sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER)
      || a.step - b.step || a.key.localeCompare(b.key));
  }, [events, batchStartAt]);

  return <section className={`batch-timeline${isBatch ? '' : ' recipe-timeline'}`}><div className="column-title"><h3>Timeline</h3>{isBatch && <span>{events.length} actions</span>}</div>
    <div className="card-stack timeline-track">{groups.map((group, index) => {
      const previous = groups[index - 1];
      const previousAt = previous?.at;
      const gapSeconds = group.at != null && previousAt != null ? group.at - previousAt : 0;
      const gapAlreadyShown = previous?.events.some(item => planDuration(item) === gapSeconds);
      return <Fragment key={group.key}>
      {gapSeconds > 0 && !gapAlreadyShown
        && <div className="timeline-gap">{formatOffset(gapSeconds)}</div>}
      {group.events.length > 0 && <Card size="small" className="timeline-group">
      {group.events.map(item => {
        const happened = item.actual_at != null;
        const skipped = !happened && item.skipped_at != null;
        const detail = item.event_type === 'equipment_use' ? equipmentNames.get(String(item.details.equipment_id || ''))
          : happened && ['addition', 'measurement', 'temperature_control', 'note', 'photo'].includes(item.event_type)
          ? details[item.id] : planDetailsLabel(item, equipmentNames) || details[item.id];
        const metadata = item.ended_at != null ? `${item.event_type === 'equipment_use' ? 'Released' : 'Ended'} ${formatTime(item.ended_at)}` : '';
        const images = photos.filter(photo => photo.batch_event_id === item.id);
        return <div key={item.id} className="timeline-entry plan-card">
          <div className="timeline-card"><div><div className={`title-edit-row${isBatch ? '' : ' recipe-title-detail'}`}>
            {isBatch && item.event_type !== 'equipment_use' && <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Edit ${item.title || kindLabel(item.event_type)}`}
              onClick={() => onEdit(item)} />}
            <strong>{item.title || planKindLabel(item)}</strong>
            {item.details.gravity_role && <Tag color={item.details.gravity_role === 'og' ? 'blue' : 'purple'}
              className="gravity-role-tag">{item.details.gravity_role.toUpperCase()}</Tag>}
            {!isBatch && detail && <span className="recipe-event-detail">{detail}</span>}</div>
            {metadata && <div className="plan-meta">{metadata}</div>}</div>
            <div className="timeline-status-actions">
              {isBatch && <Tag color={happened ? (item.event_type === 'equipment_use' || planDuration(item)) && !item.ended_at ? 'cyan' : 'green' : skipped ? 'default' : 'blue'}
                title={happened ? `Recorded ${formatTime(item.actual_at)}` : skipped ? `Skipped ${formatTime(item.skipped_at)}` : undefined}>
                {happened ? shortTime(item.actual_at!) : skipped ? 'Skipped' : 'Pending'}</Tag>}
              {item.event_type === 'equipment_use' && item.ended_at == null && onReleaseEquipment &&
                <Button type="text" size="small" onClick={() => onReleaseEquipment(item.id)}>Release</Button>}
              {onRecord && !happened && <Button type="text" shape="circle" icon={<CheckOutlined />} aria-label={`Record ${item.title}`}
                title="Record or skip" onClick={() => onRecord(item as ActualEvent)} />}
              {!isBatch && <Button type="text" shape="circle" size="small" icon={<EditOutlined />}
                aria-label={`Edit planned event ${item.title || kindLabel(item.event_type)}`}
                title="Edit event" onClick={() => onEdit(item)} />}
            </div></div>
          {isBatch && detail && <p className="event-detail">{detail}</p>}
          {images.length > 0 && <div className="photo-grid">{images.map(photo => <img key={photo.id} src={photo.url} alt="Batch activity" />)}</div>}
        </div>;
      })}
      </Card>}</Fragment>;
    })}</div>
    <div className={`timeline-actions${isBatch ? '' : ' timeline-actions-recipe'}`}><Dropdown trigger={['click']} placement="topLeft" open={menuOpen} onOpenChange={setMenuOpen}
      menu={{ items: actionItems, triggerSubMenuAction: 'click', onClick: ({ key }) => {
        const action = actionForMenu(key, events); setMenuOpen(false); onAdd(action.kind, action.preset);
      } }}>
      {isBatch ? <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="Add action" title="Add action" />
        : <Button type="text" icon={<PlusOutlined />} aria-label="Add recipe event">Add</Button>}
    </Dropdown></div>
  </section>;
}
