import { useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Select } from 'antd';
import { kindLabel, measurementKinds, planKinds } from './constants.ts';
import type { PlanInput } from './db.ts';
import { quantityUnits, unitGroups, unitOptions } from '../shared/units.ts';

interface Anchor { id: string; title: string; event_type: string }
const timeUnits = [
  { value: 'seconds', label: 'Seconds', multiplier: 1 },
  { value: 'minutes', label: 'Minutes', multiplier: 60 },
  { value: 'hours', label: 'Hours', multiplier: 3600 },
  { value: 'days', label: 'Days', multiplier: 86400 }
] as const;
const titleLabels: Record<string, string> = {
  addition: 'What will be added?', measurement: 'What will be measured?',
  temperature_control: 'Temperature action', pressure_control: 'Pressure action',
  transfer: 'Transfer', packaging: 'Packaging action', boil_finished: 'Milestone',
  photo: 'Photo reminder', note: 'Reminder'
};

interface Values {
  event_type: string; title: string; timing_key: string; offset_value: number;
  offset_unit: typeof timeUnits[number]['value']; details?: string;
  item_name?: string; quantity?: number; unit?: string;
  measurement_kind?: string; target_value?: number; target_unit?: string;
  mode?: string; container_name?: string; container_size?: number; container_count?: number;
}

export function PlanForm({ anchors, submit }: {
  anchors: Anchor[];
  submit: (input: PlanInput) => Promise<void>;
}) {
  const [form] = Form.useForm<Values>();
  const [kind, setKind] = useState('addition');
  const [measurementKind, setMeasurementKind] = useState('temperature');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(values: Values) {
    try {
      setBusy(true); setError('');
      const unit = timeUnits.find(item => item.value === values.offset_unit);
      if (!unit || !Number.isFinite(values.offset_value) || values.offset_value < 0) throw new Error('Choose a valid time offset');
      const anchorId = values.timing_key === 'start' ? null : values.timing_key;
      if (anchorId && !anchors.some(item => item.id === anchorId)) throw new Error('Choose an available timing event');
      const details: Record<string, string | number> = {};
      if (values.details) details.note = values.details;
      const keysByKind: Record<string, (keyof Values)[]> = {
        addition: ['item_name', 'quantity', 'unit'],
        measurement: ['measurement_kind', 'target_value', 'target_unit'],
        temperature_control: ['mode', 'target_value', 'target_unit'],
        pressure_control: ['target_value', 'target_unit'],
        transfer: ['quantity', 'unit'],
        packaging: ['container_name', 'container_size', 'container_count', 'unit']
      };
      for (const key of keysByKind[kind] || []) {
        const value = values[key];
        if (typeof value === 'string' && value || typeof value === 'number') details[key] = value;
      }
      await submit({
        title: values.title.trim(), event_type: values.event_type,
        planned_at: null, anchor_event_id: anchorId,
        offset_seconds: Math.round(values.offset_value * unit.multiplier),
        details_json: Object.keys(details).length ? JSON.stringify(details) : null
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <Form form={form} layout="vertical" onFinish={save} initialValues={{
    event_type: 'addition', timing_key: 'start', offset_value: 0, offset_unit: 'minutes',
    measurement_kind: 'temperature', mode: 'hold', unit: 'g', target_unit: '°C'
  }}>
    {error && <Alert type="error" message={error} className="form-alert" />}
    <Form.Item name="event_type" label="Event type" rules={[{ required: true }]}><Select options={planKinds} onChange={value => {
      setKind(value);
      form.setFieldsValue({ item_name: undefined, quantity: undefined, unit: value === 'addition' ? 'g' : value === 'transfer' ? 'L' : undefined,
        target_value: undefined, target_unit: value === 'temperature_control' || value === 'measurement' ? '°C'
          : value === 'pressure_control' ? 'kPa' : undefined, container_name: undefined, container_size: undefined, container_count: undefined });
    }} /></Form.Item>
    <Form.Item name="title" label={titleLabels[kind] || 'Action title'} rules={[{ required: true }]}>
      <Input placeholder={kind === 'addition' ? 'e.g. Add second nutrient dose' : `Describe the ${kindLabel(kind).toLowerCase()}`} maxLength={120} />
    </Form.Item>
    {kind === 'addition' && <>
      <Form.Item name="item_name" label="Ingredient or item"><Input placeholder="e.g. Fermaid O" /></Form.Item>
      <div className="form-pair"><Form.Item name="quantity" label="Planned quantity"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit"><Select showSearch options={unitOptions(quantityUnits)} /></Form.Item></div>
    </>}
    {kind === 'measurement' && <>
      <Form.Item name="measurement_kind" label="Measurement"><Select options={measurementKinds.map(item => ({ value: item.value, label: item.label }))}
        onChange={value => { setMeasurementKind(value); form.setFieldValue('target_unit', measurementKinds.find(item => item.value === value)?.unit); }} /></Form.Item>
      <div className="form-pair"><Form.Item name="target_value" label="Planned target (optional)"><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="target_unit" label="Unit"><Select options={unitOptions(
          measurementKind === 'ph' ? ['pH'] : measurementKind === 'gravity' ? unitGroups.gravity
            : measurementKind === 'carbonation' ? unitGroups.carbonation
              : measurementKind === 'dissolved_oxygen' ? unitGroups.dissolved_oxygen
                : unitGroups[measurementKind as 'temperature' | 'volume' | 'pressure'] || []
        )} /></Form.Item></div>
    </>}
    {kind === 'temperature_control' && <>
      <Form.Item name="mode" label="Mode"><Select options={[
        { value: 'heat', label: 'Heat' }, { value: 'chill', label: 'Chill' }, { value: 'hold', label: 'Hold' }
      ]} /></Form.Item>
      <div className="form-pair"><Form.Item name="target_value" label="Target temperature"><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="target_unit" label="Unit"><Select options={unitOptions(unitGroups.temperature)} /></Form.Item></div>
    </>}
    {kind === 'pressure_control' && <div className="form-pair"><Form.Item name="target_value" label="Target pressure"><InputNumber className="full-width" step="any" /></Form.Item>
      <Form.Item name="target_unit" label="Unit"><Select options={unitOptions(unitGroups.pressure)} /></Form.Item></div>}
    {kind === 'transfer' && <div className="form-pair"><Form.Item name="quantity" label="Planned volume"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
      <Form.Item name="unit" label="Unit"><Select options={unitOptions(unitGroups.volume)} /></Form.Item></div>}
    {kind === 'packaging' && <>
      <Form.Item name="container_name" label="Container"><Input placeholder="Bottle, keg…" /></Form.Item>
      <div className="form-triple"><Form.Item name="container_size" label="Container size"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit"><Select options={unitOptions(unitGroups.volume)} /></Form.Item>
        <Form.Item name="container_count" label="Count"><InputNumber className="full-width" min={1} precision={0} /></Form.Item></div>
    </>}
    <Form.Item name="timing_key" label="Timing" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={[
      { value: 'start', label: 'Batch start' },
      ...anchors.map(anchor => ({ value: anchor.id, label: `${anchor.title} · ${kindLabel(anchor.event_type)}` }))
    ]} /></Form.Item>
    <div className="form-pair">
      <Form.Item name="offset_value" label="Time offset" rules={[{ required: true }]}><InputNumber className="full-width" min={0} step="any" /></Form.Item>
      <Form.Item name="offset_unit" label="Unit" rules={[{ required: true }]}><Select options={timeUnits.map(({ value, label }) => ({ value, label }))} /></Form.Item>
    </div>
    <Form.Item name="details" label="Instructions"><Input.TextArea rows={2} placeholder="Optional details" /></Form.Item>
    <Button type="primary" htmlType="submit" loading={busy}>Add planned event</Button>
  </Form>;
}
