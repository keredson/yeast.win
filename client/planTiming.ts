import type { ActualEvent, Plan } from './db.ts';

type TimedPlan = Pick<Plan, 'id' | 'title'> & Partial<Pick<Plan, 'planned_at' | 'anchor_event_id' | 'offset_seconds'>>;

export function formatOffset(seconds: number): string {
  if (seconds === 0) return 'At batch start';
  const [unit, size] = seconds % 86400 === 0 ? ['day', 86400] : seconds % 3600 === 0 ? ['hour', 3600]
    : seconds % 60 === 0 ? ['minute', 60] : ['second', 1];
  const amount = seconds / Number(size);
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

export function planTimingLabel(plan: TimedPlan, plans: TimedPlan[]): string {
  if (plan.anchor_event_id) {
    const anchor = plans.find(item => item.id === plan.anchor_event_id);
    const offset = plan.offset_seconds || 0;
    return `${offset ? `${formatOffset(offset)} after` : 'With'} ${anchor?.title || 'another event'}`;
  }
  if (plan.planned_at != null) return 'Scheduled from an older plan';
  return plan.offset_seconds ? `${formatOffset(plan.offset_seconds)} after batch start` : 'At batch start';
}

export function effectivePlanTime(plan: TimedPlan, plans: TimedPlan[], events: ActualEvent[], startAt: number,
  visited = new Set<string>()): number | null {
  if (visited.has(plan.id)) return null;
  visited.add(plan.id);
  if (plan.anchor_event_id) {
    const anchor = plans.find(item => item.id === plan.anchor_event_id);
    if (!anchor) return null;
    const actuals = events.filter(item => item.planned_event_id === anchor.id && item.event_type !== 'skipped');
    const base = actuals.length ? Math.min(...actuals.map(item => item.actual_at))
      : effectivePlanTime(anchor, plans, events, startAt, visited);
    return base == null ? null : base + (plan.offset_seconds || 0);
  }
  if (plan.planned_at != null) return plan.planned_at;
  return startAt + (plan.offset_seconds || 0);
}
