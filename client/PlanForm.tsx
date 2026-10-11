import { useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Select } from 'antd';
import { kindLabel, planKinds } from './constants.ts';
import { fromDatetimeLocal, toDatetimeLocal } from './time.ts';
import type { PlanInput } from './db.ts';

interface Anchor { id: string; title: string; event_type: string }

export function PlanForm({ anchors, submit, includeFixed = true }: {
  anchors: Anchor[];
  submit: (input: PlanInput) => Promise<void>;
  includeFixed?: boolean;
}) {
  const [timing, setTiming] = useState<'unscheduled' | 'fixed' | 'anchored'>('unscheduled');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(values: {
    title: string; event_type: string; planned_at?: string; anchor_event_id?: string;
    offset_minutes?: number; details?: string;
  }) {
    try {
      setBusy(true); setError('');
      await submit({
        title: values.title.trim(), event_type: values.event_type,
        planned_at: timing === 'fixed' && values.planned_at ? fromDatetimeLocal(values.planned_at) : null,
        anchor_event_id: timing === 'anchored' ? values.anchor_event_id : null,
        offset_seconds: timing === 'anchored' ? Math.round((values.offset_minutes || 0) * 60) : null,
        details_json: values.details ? JSON.stringify({ note: values.details }) : null
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <Form layout="vertical" onFinish={save} initialValues={{ event_type: 'addition', offset_minutes: 0, planned_at: toDatetimeLocal() }}>
    {error && <Alert type="error" message={error} className="form-alert" />}
    <Form.Item name="title" label="What needs to happen?" rules={[{ required: true }]}><Input placeholder="e.g. Add second nutrient dose" maxLength={120} /></Form.Item>
    <Form.Item name="event_type" label="Action" rules={[{ required: true }]}><Select options={planKinds} /></Form.Item>
    <Form.Item label="Timing"><Select value={timing} onChange={setTiming} options={[
      { value: 'unscheduled', label: 'No date yet' },
      ...(includeFixed ? [{ value: 'fixed', label: 'Fixed date and time' }] : []),
      { value: 'anchored', label: 'Relative to another event' }
    ]} /></Form.Item>
    {timing === 'fixed' && <Form.Item name="planned_at" label="Planned time" rules={[{ required: true }]}>
      <Input type="datetime-local" /></Form.Item>}
    {timing === 'anchored' && <div className="form-pair">
      <Form.Item name="anchor_event_id" label="After event" rules={[{ required: true }]}>
        <Select placeholder="Choose an anchor" options={anchors.map(anchor => ({
          value: anchor.id, label: `${anchor.title} · ${kindLabel(anchor.event_type)}`
        }))} /></Form.Item>
      <Form.Item name="offset_minutes" label="Offset (minutes)"><InputNumber className="full-width" step={5} /></Form.Item>
    </div>}
    <Form.Item name="details" label="Instructions"><Input.TextArea rows={2} placeholder="Optional details" /></Form.Item>
    <Button type="primary" htmlType="submit" loading={busy}>Add planned event</Button>
  </Form>;
}
