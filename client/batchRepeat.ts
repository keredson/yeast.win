import { nanoid } from 'nanoid';
import type { ActualEvent, PlanDetails } from './db.ts';
import { anchorPoint, effectivePlanTime, supportsDuration } from './planTiming.ts';

const repeatableTypes = new Set(['addition', 'temperature_control', 'pressure_control',
  'measurement', 'transfer', 'packaging']);

export interface RepeatedAction {
  id: string;
  sourceId: string;
  event_type: string;
  title: string;
  anchor_event_id: string | null;
  offset_seconds: number;
  details: PlanDetails;
}

export function repeatBatchActions(events: ActualEvent[], sourceStartedAt: number): RepeatedAction[] {
  const included = events.filter(event => repeatableTypes.has(event.event_type)
    && (event.actual_at != null || event.skipped_at == null)
    && (event.event_type !== 'measurement' || !!event.details.measurement_kind));
  const ids = new Map(included.map(event => [event.id, nanoid()]));
  const sourceAt = (event: ActualEvent) => event.actual_at
    ?? effectivePlanTime(event, events, events, sourceStartedAt);
  return included.map(event => {
    const anchor = events.find(item => item.id === event.anchor_event_id);
    const hasAnchor = !!anchor && ids.has(anchor.id);
    const baseAt = hasAnchor && anchor ? sourceAt(anchor) : null;
    const anchorAt = baseAt == null ? null : baseAt + (anchorPoint(event) === 'end' && anchor
      ? anchor.ended_at != null && anchor.actual_at != null ? anchor.ended_at - anchor.actual_at
        : anchor.details.duration_seconds || 0 : 0);
    const eventAt = sourceAt(event);
    const offset = hasAnchor
      ? event.actual_at != null && anchorAt != null ? event.actual_at - anchorAt : event.offset_seconds || 0
      : eventAt != null ? eventAt - sourceStartedAt : event.offset_seconds || 0;
    const duration = supportsDuration(event.event_type, event.details.phase)
      && event.actual_at != null && event.ended_at != null
      ? Math.max(0, event.ended_at - event.actual_at) : event.details.duration_seconds;
    return {
      id: ids.get(event.id)!, sourceId: event.id, event_type: event.event_type, title: event.title || '',
      anchor_event_id: hasAnchor ? ids.get(anchor!.id)! : null,
      offset_seconds: offset,
      details: { ...event.details, duration_seconds: duration,
        anchor_point: hasAnchor ? event.details.anchor_point : undefined }
    };
  });
}
