import { useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Select } from 'antd';
import { kindLabel, planKinds } from './constants.ts';
import type { PlanInput } from './db.ts';

interface Anchor { id: string; title: string; event_type: string }
const timeUnits = [
  { value: 'seconds', label: 'Seconds', multiplier: 1 },
  { value: 'minutes', label: 'Minutes', multiplier: 60 },
  { value: 'hours', label: 'Hours', multiplier: 3600 },
  { value: 'days', label: 'Days', multiplier: 86400 }
] as const;

export function PlanForm({ anchors, submit }: {
  anchors: Anchor[];
  submit: (input: PlanInput) => Promise<void>;
}) {
  const [timing, setTiming] = useState<'start' | 'anchored'>('start');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(values: {
    title: string; event_type: string; anchor_event_id?: string;
    offset_value: number; offset_unit: typeof timeUnits[number]['value']; details?: string;
  }) {
    try {
      setBusy(true); setError('');
      const unit = timeUnits.find(item => item.value === values.offset_unit);
      if (!unit || !Number.isFinite(values.offset_value) || values.offset_value < 0) throw new Error('Choose a valid time offset');
      if (timing === 'anchored' && !values.anchor_event_id) throw new Error('Choose an anchor event');
      await submit({
        title: values.title.trim(), event_type: values.event_type,
        planned_at: null,
        anchor_event_id: timing === 'anchored' ? values.anchor_event_id : null,
        offset_seconds: Math.round(values.offset_value * unit.multiplier),
        details_json: values.details ? JSON.stringify({ note: values.details }) : null
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <Form layout="vertical" onFinish={save} initialValues={{ event_type: 'addition', offset_value: 0, offset_unit: 'minutes' }}>
    {error && <Alert type="error" message={error} className="form-alert" />}
    <Form.Item name="title" label="What needs to happen?" rules={[{ required: true }]}><Input placeholder="e.g. Add second nutrient dose" maxLength={120} /></Form.Item>
    <Form.Item name="event_type" label="Action" rules={[{ required: true }]}><Select options={planKinds} /></Form.Item>
    <Form.Item label="Timing"><Select value={timing} onChange={setTiming} options={[
      { value: 'start', label: 'From batch start' },
      { value: 'anchored', label: 'After another event' }
    ]} /></Form.Item>
    {timing === 'anchored' && <Form.Item name="anchor_event_id" label="After event" rules={[{ required: true }]}>
      <Select placeholder="Choose an anchor" options={anchors.map(anchor => ({
        value: anchor.id, label: `${anchor.title} · ${kindLabel(anchor.event_type)}`
      }))} /></Form.Item>}
    <div className="form-pair">
      <Form.Item name="offset_value" label="Time offset" rules={[{ required: true }]}><InputNumber className="full-width" min={0} step="any" /></Form.Item>
      <Form.Item name="offset_unit" label="Unit" rules={[{ required: true }]}><Select options={timeUnits.map(({ value, label }) => ({ value, label }))} /></Form.Item>
    </div>
    <Form.Item name="details" label="Instructions"><Input.TextArea rows={2} placeholder="Optional details" /></Form.Item>
    <Button type="primary" htmlType="submit" loading={busy}>Add planned event</Button>
  </Form>;
}
