import { useState } from 'react';
import { Alert, AutoComplete, Button, Form, Input, InputNumber, Select } from 'antd';
import { kindLabel, measurementKinds, planKinds } from './constants.ts';
import type { InventoryItem, PlanInput } from './db.ts';
import { quantityUnits, unitGroups, unitOptions } from '../shared/units.ts';
import { parsePlanDetails } from './planTiming.ts';
import { inventoryCategories, unitForCategory, type CatalogInventory } from '../shared/catalog.ts';

interface Anchor { id: string; title: string; event_type: string }
const timeUnits = [
  { value: 'seconds', label: 'Seconds', multiplier: 1 },
  { value: 'minutes', label: 'Minutes', multiplier: 60 },
  { value: 'hours', label: 'Hours', multiplier: 3600 },
  { value: 'days', label: 'Days', multiplier: 86400 }
] as const;
const titleLabels: Record<string, string> = {
  measurement: 'What will be measured?',
  temperature_control: 'Temperature action', pressure_control: 'Pressure action',
  transfer: 'Transfer', packaging: 'Packaging action', boil_finished: 'Milestone',
  photo: 'Photo reminder', note: 'Reminder'
};

interface Values {
  event_type: string; title: string; timing_key: string; offset_value: number;
  offset_unit: typeof timeUnits[number]['value']; details?: string;
  item_category?: string; quantity?: number; unit?: string;
  measurement_kind?: string; target_value?: number; target_unit?: string;
  mode?: string; container_name?: string; container_size?: number; container_count?: number;
}

export function PlanForm({ anchors, initialPlan, inventory, catalog, preferredMassUnit, submit }: {
  anchors: Anchor[];
  initialPlan?: PlanInput & { id: string };
  inventory: InventoryItem[]; catalog: CatalogInventory[]; preferredMassUnit: string;
  submit: (input: PlanInput) => Promise<void>;
}) {
  const [form] = Form.useForm<Values>();
  const initialDetails = parsePlanDetails(initialPlan?.details_json);
  const offset = initialPlan?.offset_seconds ?? 0;
  const offsetUnit = offset === 0 ? timeUnits[1] : [...timeUnits].reverse().find(item => Math.abs(offset) % item.multiplier === 0) || timeUnits[0];
  const initialItem = String(initialDetails.item_name || initialPlan?.title || '');
  const initialCategory = String(initialDetails.item_category || inventory.find(item => item.id === initialDetails.inventory_item_id)?.category
    || catalog.find(item => item.id === initialDetails.catalog_item_id || item.name === initialItem)?.category || '');
  const [kind, setKind] = useState(initialPlan?.event_type || 'addition');
  const [measurementKind, setMeasurementKind] = useState(String(initialDetails.measurement_kind || 'temperature'));
  const [itemCategory, setItemCategory] = useState(initialCategory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(values: Values) {
    try {
      setBusy(true); setError('');
      const unit = timeUnits.find(item => item.value === values.offset_unit);
      if (!unit || !Number.isFinite(values.offset_value) || values.offset_value < 0) throw new Error('Choose a valid time offset');
      const [direction, anchorId] = values.timing_key === 'start' ? ['start', null] : values.timing_key.split(':', 2);
      if (anchorId && !anchors.some(item => item.id === anchorId)) throw new Error('Choose an available timing event');
      const details: Record<string, string | number> = {};
      if (values.details) details.note = values.details;
      const keysByKind: Record<string, (keyof Values)[]> = {
        addition: ['item_category', 'quantity', 'unit'],
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
      if (kind === 'addition') {
        details.item_name = values.title.trim();
        const owned = inventory.find(item => item.category === values.item_category && item.name.toLowerCase() === values.title.trim().toLowerCase());
        const known = catalog.find(item => item.category === values.item_category && item.name.toLowerCase() === values.title.trim().toLowerCase());
        if (owned) details.inventory_item_id = owned.id;
        else if (known) details.catalog_item_id = known.id;
      }
      await submit({
        title: values.title.trim(), event_type: values.event_type,
        planned_at: null, anchor_event_id: anchorId,
        offset_seconds: Math.round(values.offset_value * unit.multiplier) * (direction === 'before' ? -1 : 1),
        details_json: Object.keys(details).length ? JSON.stringify(details) : null
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <Form form={form} layout="vertical" onFinish={save} initialValues={{
    event_type: kind, title: kind === 'addition' ? initialItem : initialPlan?.title,
    timing_key: initialPlan?.anchor_event_id ? `${offset < 0 ? 'before' : 'after'}:${initialPlan.anchor_event_id}` : 'start',
    offset_value: Math.abs(offset) / offsetUnit.multiplier, offset_unit: offsetUnit.value,
    measurement_kind: measurementKind, mode: initialDetails.mode || 'hold',
    unit: initialDetails.unit || 'g', target_unit: initialDetails.target_unit || '°C',
    details: initialDetails.note, item_category: initialCategory,
    quantity: initialDetails.quantity,
    target_value: initialDetails.target_value, container_name: initialDetails.container_name,
    container_size: initialDetails.container_size, container_count: initialDetails.container_count
  }}>
    {error && <Alert type="error" message={error} className="form-alert" />}
    <Form.Item name="event_type" label="Event type" rules={[{ required: true }]}><Select options={planKinds} onChange={value => {
      setKind(value);
      form.setFieldsValue({ title: undefined, item_category: value === 'addition' ? 'Grain' : undefined,
        quantity: undefined, unit: value === 'addition' ? preferredMassUnit : value === 'transfer' ? 'L' : undefined,
        target_value: undefined, target_unit: value === 'temperature_control' || value === 'measurement' ? '°C'
          : value === 'pressure_control' ? 'kPa' : undefined, container_name: undefined, container_size: undefined, container_count: undefined });
    }} /></Form.Item>
    {kind === 'addition' && <>
      <Form.Item name="item_category" label="Type" rules={[{ required: true }]}><Select options={inventoryCategories.map(value => ({ value, label: value }))}
        onChange={(value: string) => { setItemCategory(value); form.setFieldsValue({ title: undefined,
          unit: unitForCategory(value, preferredMassUnit) }); }} /></Form.Item>
      <Form.Item name="title" label="What will be added?" rules={[{ required: true, whitespace: true }]}>
        <AutoComplete placeholder="Search inventory or enter an item" maxLength={120} options={[
          ...inventory.filter(item => item.category === itemCategory).map(item => ({ value: item.name, label: `${item.name} · Your inventory` })),
          ...catalog.filter(item => item.category === itemCategory && !inventory.some(owned => owned.category === itemCategory && owned.name.toLowerCase() === item.name.toLowerCase()))
            .map(item => ({ value: item.name, label: `${item.name} · Shared catalog` }))
        ]} filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
          onSelect={(value: string) => {
            const owned = inventory.find(item => item.category === itemCategory && item.name === value);
            const known = catalog.find(item => item.category === itemCategory && item.name === value);
            form.setFieldValue('unit', owned?.default_unit || known?.unit || unitForCategory(itemCategory, preferredMassUnit));
          }} />
      </Form.Item>
      <div className="form-pair"><Form.Item name="quantity" label="Planned quantity"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit"><Select showSearch options={unitOptions(quantityUnits)} /></Form.Item></div>
    </>}
    {kind !== 'addition' && <Form.Item name="title" label={titleLabels[kind] || 'Action title'} rules={[{ required: true }]}>
      <Input placeholder={`Describe the ${kindLabel(kind).toLowerCase()}`} maxLength={120} />
    </Form.Item>}
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
      ...anchors.flatMap(anchor => [
        { value: `before:${anchor.id}`, label: `Before ${anchor.title} · ${kindLabel(anchor.event_type)}` },
        { value: `after:${anchor.id}`, label: `After ${anchor.title} · ${kindLabel(anchor.event_type)}` }
      ])
    ]} /></Form.Item>
    <div className="form-pair">
      <Form.Item name="offset_value" label="Time offset" rules={[{ required: true }]}><InputNumber className="full-width" min={0} step="any" /></Form.Item>
      <Form.Item name="offset_unit" label="Unit" rules={[{ required: true }]}><Select options={timeUnits.map(({ value, label }) => ({ value, label }))} /></Form.Item>
    </div>
    <Form.Item name="details" label="Instructions"><Input.TextArea rows={2} placeholder="Optional details" /></Form.Item>
    <Button type="primary" htmlType="submit" loading={busy}>{initialPlan ? 'Save planned event' : 'Add planned event'}</Button>
  </Form>;
}
