import type { ActualEvent, Plan, PlanDetails } from './db.ts';
import { formatQuantity } from '../shared/units.ts';
import { kindLabel } from './constants.ts';

export const timeUnits = [
  { value: 'seconds', label: 'Seconds', multiplier: 1 },
  { value: 'minutes', label: 'Minutes', multiplier: 60 },
  { value: 'hours', label: 'Hours', multiplier: 3600 },
  { value: 'days', label: 'Days', multiplier: 86400 }
] as const;

type TimedPlan = Pick<Plan, 'id' | 'title'> & Partial<Pick<Plan, 'event_type' | 'planned_at' | 'anchor_event_id' | 'offset_seconds' | 'details'>>;

export function supportsDuration(eventType: string, phase?: string): boolean {
  return eventType === 'pressure_control' || eventType === 'temperature_control' && phase !== 'chill';
}

export function planDuration(plan: Pick<TimedPlan, 'event_type' | 'details'>): number {
  const details = plan.details || {};
  if (!plan.event_type || !supportsDuration(plan.event_type, String(details.phase || ''))) return 0;
  const value = details.duration_seconds;
  return typeof value === 'number' && value > 0 ? value : 0;
}

export function anchorPoint(plan: Pick<TimedPlan, 'details'>): 'start' | 'end' {
  return plan.details?.anchor_point === 'end' ? 'end' : 'start';
}

export function planKindLabel(plan: { event_type: string; details?: PlanDetails }): string {
  const phase = plan.details?.phase;
  return plan.event_type === 'temperature_control' && typeof phase === 'string'
    ? phase[0].toUpperCase() + phase.slice(1) : kindLabel(plan.event_type);
}

export function formatOffset(seconds: number): string {
  if (seconds === 0) return 'At batch start';
  const magnitude = Math.abs(seconds);
  const [unit, size] = magnitude % 86400 === 0 ? ['day', 86400] : magnitude % 3600 === 0 ? ['hour', 3600]
    : magnitude % 60 === 0 ? ['minute', 60] : ['second', 1];
  const amount = magnitude / Number(size);
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

export function planTimingLabel(plan: TimedPlan, plans: TimedPlan[]): string {
  if (plan.anchor_event_id) {
    const anchor = plans.find(item => item.id === plan.anchor_event_id);
    const offset = plan.offset_seconds || 0;
    if (!offset && anchor && anchorPoint(plan) === 'end') return `After ${anchor.title}`;
    const point = anchor && (planDuration(anchor) || anchorPoint(plan) === 'end') ? `${anchorPoint(plan)} of ` : '';
    return `${offset ? `${formatOffset(offset)} ${offset < 0 ? 'before' : 'after'}` : 'At'} ${point}${anchor?.title || 'another event'}`;
  }
  if (plan.planned_at != null) return 'Scheduled from an older plan';
  return plan.offset_seconds ? `${formatOffset(plan.offset_seconds)} ${plan.offset_seconds < 0 ? 'before' : 'after'} batch start` : 'At batch start';
}

export function effectivePlanTime(plan: TimedPlan, plans: TimedPlan[], events: ActualEvent[], startAt: number,
  visited = new Set<string>()): number | null {
  if (visited.has(plan.id)) return null;
  visited.add(plan.id);
  if (plan.anchor_event_id) {
    const anchor = plans.find(item => item.id === plan.anchor_event_id);
    if (!anchor) return null;
    const actual = events.find(item => item.id === anchor.id);
    const start = actual?.actual_at ?? effectivePlanTime(anchor, plans, events, startAt, visited);
    const base = anchorPoint(plan) === 'end' ? actual?.ended_at ?? (start == null ? null : start + planDuration(anchor)) : start;
    return base == null ? null : base + (plan.offset_seconds || 0);
  }
  if (plan.planned_at != null) return plan.planned_at;
  return startAt + (plan.offset_seconds || 0);
}

export function timelinePosition<T extends TimedPlan & { actual_at?: number | null; skipped_at?: number | null }>(
  plan: T, plans: T[], startAt: number): number | null {
  // Recorded actions with no timing rule were added directly to the log.
  if (plan.planned_at == null && plan.anchor_event_id == null && plan.offset_seconds == null)
    return plan.actual_at ?? plan.skipped_at ?? startAt;
  // Recording a planned action changes its status, not its place in the plan.
  return effectivePlanTime(plan, plans, [], startAt);
}

export function timelineGroupStep(plan: TimedPlan, plans: TimedPlan[], eventTimes: ReadonlyMap<string, number | null>,
  visiting = new Set<string>()): number {
  const at = eventTimes.get(plan.id);
  if (at == null || !plan.anchor_event_id || visiting.has(plan.id)) return 0;
  const anchor = plans.find(item => item.id === plan.anchor_event_id);
  if (!anchor || eventTimes.get(anchor.id) !== at) return 0;
  visiting.add(plan.id);
  const previousStep = timelineGroupStep(anchor, plans, eventTimes, visiting);
  visiting.delete(plan.id);
  return previousStep + (anchorPoint(plan) === 'start' && planDuration(anchor) > 0 ? 0 : 1);
}

export function timelineGroupKey(at: number | null, step: number, id: string): string {
  return at == null ? `unresolved:${id}` : `time:${at}:${step}`;
}

export function orderTimelineGroup<T extends { id: string; event_type: string; anchor_event_id?: string | null; details?: PlanDetails }>(
  events: readonly T[], eventTimes: ReadonlyMap<string, number | null>): T[] {
  const at = (event: T) => eventTimes.get(event.id) ?? Number.MAX_SAFE_INTEGER;
  const byTime = [...events].sort((a, b) => at(a) - at(b));
  const ordered: T[] = [];
  for (let start = 0; start < byTime.length;) {
    let end = start + 1;
    while (end < byTime.length && at(byTime[end]) === at(byTime[start])) end++;
    const pending = byTime.slice(start, end);
    while (pending.length) {
      const pendingById = new Map(pending.map(event => [event.id, event]));
      const ready = pending.filter(event => {
        const anchor = event.anchor_event_id ? pendingById.get(event.anchor_event_id) : undefined;
        return !anchor || anchorPoint(event) === 'start' && planDuration(anchor) > 0;
      });
      const next = ready.find(event => event.event_type === 'addition'
        && event.details?.item_category !== 'Yeast') || ready[0] || pending[0];
      ordered.push(next);
      pending.splice(pending.indexOf(next), 1);
    }
    start = end;
  }
  return ordered;
}

export function planDetailsLabel(plan: Pick<Plan, 'event_type'> & { title?: string; details?: PlanDetails },
  equipmentNames: ReadonlyMap<string, string> = new Map()): string {
  const details = plan.details || {};
  const destinationName = () => equipmentNames.get(String(details.to_vessel_id))
    || String(details.to_vessel_name || 'Archived vessel');
  const amount = typeof details.quantity === 'number' ? formatQuantity(details.quantity, String(details.unit || ''), String(details.display_unit || '')) : '';
  const target = details.target_value != null
    ? `${details.target_value}${details.measurement_kind === 'gravity' && details.target_unit === 'SG' ? '' : ` ${details.target_unit || ''}`}`.trim() : '';
  const duration = supportsDuration(plan.event_type, String(details.phase || '')) && typeof details.duration_seconds === 'number' && details.duration_seconds > 0
    ? `For ${formatOffset(details.duration_seconds)}` : '';
  const genericPitch = plan.title === 'Pitch yeast' && details.item_category === 'Yeast'
    && details.item_name === 'Yeast' && !details.inventory_item_id && !details.catalog_item_id;
  const parts = plan.event_type === 'addition' ? [amount, genericPitch || details.item_name === plan.title ? '' : details.item_name]
    : plan.event_type === 'measurement' ? [details.measurement_kind, target]
      : plan.event_type === 'temperature_control' ? [details.mode, target]
        : plan.event_type === 'pressure_control' ? [target]
          : plan.event_type === 'transfer' ? [details.to_vessel_id ? `To ${destinationName()}` : '', amount]
            : plan.event_type === 'packaging' ? [details.container_count,
              details.container_name, details.container_size != null ? `${details.container_size} ${details.container_unit || ''}`.trim() : ''] : [];
  if (duration) parts.push(duration);
  if (details.note) parts.push(details.note);
  return parts.filter(Boolean).join(' · ');
}
