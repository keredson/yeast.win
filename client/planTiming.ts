import type { ActualEvent, Plan } from './db.ts';
import { formatQuantity } from '../shared/units.ts';
import { kindLabel } from './constants.ts';

type TimedPlan = Pick<Plan, 'id' | 'title'> & Partial<Pick<Plan, 'event_type' | 'planned_at' | 'anchor_event_id' | 'offset_seconds' | 'details_json'>>;

export function supportsDuration(eventType: string): boolean {
  return eventType === 'temperature_control' || eventType === 'pressure_control';
}

export function planDuration(plan: TimedPlan): number {
  if (!plan.event_type || !supportsDuration(plan.event_type)) return 0;
  const value = parsePlanDetails(plan.details_json).duration_seconds;
  return typeof value === 'number' && value > 0 ? value : 0;
}

export function anchorPoint(plan: TimedPlan): 'start' | 'end' {
  return parsePlanDetails(plan.details_json).anchor_point === 'end' ? 'end' : 'start';
}

export function planKindLabel(plan: { event_type: string; details_json?: string | null }): string {
  const phase = parsePlanDetails(plan.details_json).phase;
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
    const point = anchor && planDuration(anchor) ? `${anchorPoint(plan)} of ` : '';
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

export function parsePlanDetails(detailsJson: string | null | undefined): Record<string, string | number> {
  try {
    const value = JSON.parse(detailsJson || '{}') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string | number> : {};
  } catch { return {}; }
}

export function planDetailsLabel(plan: Pick<Plan, 'event_type'> & { title?: string; details_json?: string | null },
  equipmentNames: ReadonlyMap<string, string> = new Map()): string {
  const details = parsePlanDetails(plan.details_json);
  const destinationName = () => equipmentNames.get(String(details.to_vessel_id))
    || String(details.to_vessel_name || 'Archived vessel');
  const amount = typeof details.quantity === 'number' ? formatQuantity(details.quantity, String(details.unit || ''), String(details.display_unit || '')) : '';
  const target = details.target_value != null ? `${details.target_value} ${details.target_unit || ''}`.trim() : '';
  const duration = supportsDuration(plan.event_type) && typeof details.duration_seconds === 'number' && details.duration_seconds > 0
    ? `For ${formatOffset(details.duration_seconds)}` : '';
  const parts = plan.event_type === 'addition' ? [amount, details.item_name === plan.title ? '' : details.item_name]
    : plan.event_type === 'measurement' ? [details.measurement_kind, target]
      : plan.event_type === 'temperature_control' ? [details.mode, target]
        : plan.event_type === 'pressure_control' ? [target]
          : plan.event_type === 'transfer' ? [details.to_vessel_id ? `To ${destinationName()}` : '', amount]
            : plan.event_type === 'packaging' ? [details.container_count,
              details.container_name, details.container_size != null ? `${details.container_size} ${details.container_unit || details.unit || ''}`.trim() : ''] : [];
  if (duration) parts.push(duration);
  if (details.note) parts.push(details.note);
  return parts.filter(Boolean).join(' · ');
}
