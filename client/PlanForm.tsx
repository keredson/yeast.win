import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, AutoComplete, Button, Checkbox, Form, Input, InputNumber, Select } from 'antd';
import { kindLabel, measurementKinds } from './constants.ts';
import type { InventoryItem, PlanInput } from './db.ts';
import { compoundMassUnit, convertUnit, quantityForStorage, quantityUnitsForCategory, splitOunces, unitGroups, unitOptions } from '../shared/units.ts';
import { parsePlanDetails, planDuration } from './planTiming.ts';
import { inventoryCategories, unitForCategory, type CatalogInventory } from '../shared/catalog.ts';
import { QuantityFields } from './QuantityFields.tsx';
import type { PreferredUnits } from './api.ts';
import { changeNumberUnit, changeQuantityUnit } from './unitFields.ts';

interface Anchor { id: string; title: string; event_type: string; details_json?: string | null }
export interface PlanPreset { phase?: 'mash' | 'boil' | 'chill'; measurementKind?: string; itemCategory?: string; title?: string; timingKey?: string }
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
  record_now?: boolean;
  title: string; timing_key: string; offset_value: number;
  offset_unit: typeof timeUnits[number]['value']; details?: string;
  item_category?: string; quantity?: number; unit?: string; pounds?: number; ounces?: number;
  measurement_kind?: string; target_value?: number; target_unit?: string;
  mode?: string; container_name?: string; container_size?: number; container_count?: number;
  duration_value?: number; duration_unit?: typeof timeUnits[number]['value'];
}

export function PlanForm({ anchors, eventType, initialPlan, inventory, catalog, preferredUnits, preset, allowRecordNow = false, extraAction, submit }: {
  anchors: Anchor[];
  eventType: string;
  initialPlan?: PlanInput & { id: string };
  inventory: InventoryItem[]; catalog: CatalogInventory[]; preferredUnits: PreferredUnits;
  preset?: PlanPreset;
  allowRecordNow?: boolean;
  extraAction?: ReactNode;
  submit: (input: PlanInput, recordNow?: boolean) => Promise<void>;
}) {
  const [form] = Form.useForm<Values>();
  const initialDetails = parsePlanDetails(initialPlan?.details_json);
  const kind = initialPlan?.event_type || eventType;
  const offset = initialPlan?.offset_seconds ?? 0;
  const offsetUnit = offset === 0 ? timeUnits[1] : [...timeUnits].reverse().find(item => Math.abs(offset) % item.multiplier === 0) || timeUnits[0];
  const initialItem = String(initialDetails.item_name || initialPlan?.title || preset?.title || '');
  const initialCategory = String(initialDetails.item_category || inventory.find(item => item.id === initialDetails.inventory_item_id)?.category
    || catalog.find(item => item.id === initialDetails.catalog_item_id || item.name === initialItem)?.category || preset?.itemCategory || '');
  const initialUnit = String(initialDetails.display_unit || initialDetails.unit ||
    (kind === 'transfer' || kind === 'packaging' ? preferredUnits.volume
      : initialCategory ? unitForCategory(initialCategory, preferredUnits.mass) : preferredUnits.mass));
  const initialSplit = initialUnit === compoundMassUnit && typeof initialDetails.quantity === 'number'
    ? splitOunces(initialDetails.quantity) : null;
  const lockedMeasurementKind = preset?.measurementKind || (initialPlan?.event_type === 'measurement' ? String(initialDetails.measurement_kind || '') : '');
  const [measurementKind, setMeasurementKind] = useState(String(initialDetails.measurement_kind || preset?.measurementKind || 'temperature'));
  const phase = String(initialDetails.phase || preset?.phase || '');
  const duration = initialPlan ? planDuration(initialPlan) : preset?.phase === 'boil' ? 3600 : preset?.phase === 'mash' ? 1800 : 0;
  const [itemCategory, setItemCategory] = useState(initialCategory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectedUnit = Form.useWatch('unit', form) as string | undefined;
  const selectedTargetUnit = Form.useWatch('target_unit', form) as string | undefined;
  const selectedOffsetUnit = Form.useWatch('offset_unit', form) as string | undefined;
  const selectedDurationUnit = Form.useWatch('duration_unit', form) as string | undefined;

  function changeTimeUnit(field: 'offset_value' | 'duration_value', from: string | undefined, to: string) {
    const oldUnit = timeUnits.find(item => item.value === from);
    const newUnit = timeUnits.find(item => item.value === to);
    const value = form.getFieldValue(field);
    if (oldUnit && newUnit && typeof value === 'number') form.setFieldValue(field,
      Number((value * oldUnit.multiplier / newUnit.multiplier).toFixed(6)));
  }

  function changeMainUnit(next: string) {
    if (kind === 'addition') changeQuantityUnit(form, selectedUnit || initialUnit, next);
    else changeNumberUnit(form, [kind === 'packaging' ? 'container_size' : 'quantity'], selectedUnit || initialUnit, next);
  }

  async function save(values: Values) {
    try {
      setBusy(true); setError('');
      const unit = timeUnits.find(item => item.value === values.offset_unit);
      if (!unit || !Number.isFinite(values.offset_value) || values.offset_value < 0) throw new Error('Choose a valid time offset');
      const [direction, point, anchorId] = values.timing_key === 'start' ? ['start', 'start', null] : values.timing_key.split(':', 3);
      if (anchorId && !anchors.some(item => item.id === anchorId)) throw new Error('Choose an available timing event');
      const details: Record<string, string | number> = {};
      if (values.details) details.note = values.details;
      if (phase) details.phase = phase;
      if (anchorId) details.anchor_point = point === 'end' ? 'end' : 'start';
      if (values.duration_value != null) {
        const durationUnit = timeUnits.find(item => item.value === values.duration_unit);
        if (!durationUnit || values.duration_value <= 0) throw new Error('Choose a positive duration');
        details.duration_seconds = Math.round(values.duration_value * durationUnit.multiplier);
      }
      const keysByKind: Record<string, (keyof Values)[]> = {
        addition: ['item_category'],
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
        const amount = quantityForStorage(values.unit || '', values.quantity, values.pounds, values.ounces);
        if (amount) {
          if (!values.unit) throw new Error('Choose a unit');
          details.quantity = amount.quantity;
          details.unit = amount.unit;
          if (values.unit === compoundMassUnit) details.display_unit = compoundMassUnit;
        }
        const owned = inventory.find(item => item.category === values.item_category && item.name.toLowerCase() === values.title.trim().toLowerCase());
        const known = catalog.find(item => item.category === values.item_category && item.name.toLowerCase() === values.title.trim().toLowerCase());
        if (owned) details.inventory_item_id = owned.id;
        else if (known) details.catalog_item_id = known.id;
      }
      await submit({
        title: values.title.trim(), event_type: kind,
        planned_at: null, anchor_event_id: anchorId,
        offset_seconds: Math.round(values.offset_value * unit.multiplier) * (direction === 'before' ? -1 : 1),
        details_json: Object.keys(details).length ? JSON.stringify(details) : null
      }, values.record_now);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <Form form={form} layout="vertical" onFinish={save} initialValues={{
    title: kind === 'addition' ? initialItem : initialPlan?.title || preset?.title,
    timing_key: initialPlan?.anchor_event_id ? `${offset < 0 ? 'before' : 'after'}:${initialDetails.anchor_point === 'end' ? 'end' : 'start'}:${initialPlan.anchor_event_id}` : preset?.timingKey || 'start',
    offset_value: Math.abs(offset) / offsetUnit.multiplier, offset_unit: offsetUnit.value,
    measurement_kind: measurementKind, mode: initialDetails.mode || (phase === 'boil' ? 'heat' : phase === 'chill' ? 'chill' : 'hold'),
    duration_value: duration ? duration % 3600 === 0 ? duration / 3600 : duration % 60 === 0 ? duration / 60 : duration : undefined,
    duration_unit: duration % 3600 === 0 ? 'hours' : duration % 60 === 0 ? 'minutes' : 'seconds',
    unit: initialUnit,
    target_unit: initialDetails.target_unit || (kind === 'temperature_control' ? preferredUnits.temperature
      : kind === 'pressure_control' ? preferredUnits.pressure
        : kind === 'measurement' ? measurementKind === 'temperature' ? preferredUnits.temperature
          : measurementKind === 'volume' ? preferredUnits.volume : measurementKind === 'pressure' ? preferredUnits.pressure
            : measurementKinds.find(item => item.value === measurementKind)?.unit : undefined),
    details: initialDetails.note, item_category: initialCategory,
    quantity: initialUnit === compoundMassUnit ? undefined : initialDetails.quantity,
    pounds: initialSplit?.pounds, ounces: initialSplit?.ounces,
    target_value: initialDetails.target_value ?? (phase === 'mash' ? convertUnit(67, '°C', preferredUnits.temperature)
      : phase === 'boil' ? convertUnit(100, '°C', preferredUnits.temperature) : undefined), container_name: initialDetails.container_name,
    container_size: initialDetails.container_size, container_count: initialDetails.container_count
  }}>
    {error && <Alert type="error" message={error} className="form-alert" />}
    {kind === 'addition' && <>
      <Form.Item name="item_category" label="Type" rules={[{ required: true }]}><Select options={inventoryCategories.map(value => ({ value, label: value }))}
        onChange={(value: string) => { setItemCategory(value); form.setFieldsValue({ title: undefined,
          unit: unitForCategory(value, preferredUnits.mass), quantity: undefined, pounds: undefined, ounces: undefined }); }} /></Form.Item>
      <Form.Item name="title" label="What will be added?" rules={[{ required: true, whitespace: true }]}>
        <AutoComplete placeholder="Search inventory or enter an item" maxLength={120} options={[
          ...inventory.filter((item, index) => item.category === itemCategory &&
            inventory.findIndex(other => other.category === item.category && other.name.toLowerCase() === item.name.toLowerCase()) === index)
            .map(item => ({ value: item.name, label: `${item.name} · Your inventory` })),
          ...catalog.filter(item => item.category === itemCategory && !inventory.some(owned => owned.category === itemCategory && owned.name.toLowerCase() === item.name.toLowerCase()))
            .map(item => ({ value: item.name, label: `${item.name} · Shared catalog` }))
        ]} filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
          onSelect={(value: string) => {
            const owned = inventory.find(item => item.category === itemCategory && item.name === value);
            const known = catalog.find(item => item.category === itemCategory && item.name === value);
            const knownUnit = known?.unit && unitGroups.mass.includes(known.unit as typeof unitGroups.mass[number])
              ? preferredUnits.mass : known?.unit;
            const nextUnit = owned?.display_unit || knownUnit || unitForCategory(itemCategory, preferredUnits.mass);
            changeQuantityUnit(form, selectedUnit || initialUnit, nextUnit);
            form.setFieldValue('unit', nextUnit);
          }} />
      </Form.Item>
      <Form.Item name="unit" label="Unit"><Select showSearch options={unitOptions(quantityUnitsForCategory(itemCategory))}
        onChange={changeMainUnit} /></Form.Item>
      <QuantityFields unit={selectedUnit || initialUnit} label="Quantity" optional />
    </>}
    {kind !== 'addition' && <Form.Item name="title" label={titleLabels[kind] || 'Action title'} rules={[{ required: true }]}>
      <Input placeholder={`Describe the ${kindLabel(kind).toLowerCase()}`} maxLength={120} />
    </Form.Item>}
    {kind === 'measurement' && <>
      {!lockedMeasurementKind && <Form.Item name="measurement_kind" label="Measurement"><Select options={measurementKinds.map(item => ({ value: item.value, label: item.label }))}
        onChange={value => { setMeasurementKind(value); form.setFieldsValue({ target_value: undefined,
          target_unit: value === 'temperature' ? preferredUnits.temperature : value === 'volume' ? preferredUnits.volume
            : value === 'pressure' ? preferredUnits.pressure : measurementKinds.find(item => item.value === value)?.unit }); }} /></Form.Item>
      }
      <div className="form-pair"><Form.Item name="target_value" label="Target (optional)"><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="target_unit" label="Unit"><Select options={unitOptions(
          measurementKind === 'ph' ? ['pH'] : measurementKind === 'gravity' ? unitGroups.gravity
            : measurementKind === 'carbonation' ? unitGroups.carbonation
              : measurementKind === 'dissolved_oxygen' ? unitGroups.dissolved_oxygen
                : unitGroups[measurementKind as 'temperature' | 'volume' | 'pressure'] || []
        )} onChange={unit => changeNumberUnit(form, ['target_value'], selectedTargetUnit, unit)} /></Form.Item></div>
    </>}
    {kind === 'temperature_control' && <>
      <Form.Item name="mode" label="Mode"><Select options={[
        { value: 'heat', label: 'Heat' }, { value: 'chill', label: 'Chill' }, { value: 'hold', label: 'Hold' }
      ]} /></Form.Item>
      <div className="form-pair"><Form.Item name="target_value" label="Target temperature"><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="target_unit" label="Unit"><Select options={unitOptions(unitGroups.temperature)}
          onChange={unit => changeNumberUnit(form, ['target_value'], selectedTargetUnit, unit)} /></Form.Item></div>
    </>}
    {kind === 'pressure_control' && <div className="form-pair"><Form.Item name="target_value" label="Target pressure"><InputNumber className="full-width" step="any" /></Form.Item>
      <Form.Item name="target_unit" label="Unit"><Select options={unitOptions(unitGroups.pressure)}
        onChange={unit => changeNumberUnit(form, ['target_value'], selectedTargetUnit, unit)} /></Form.Item></div>}
    {kind === 'transfer' && <div className="form-pair"><Form.Item name="quantity" label="Volume"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
      <Form.Item name="unit" label="Unit"><Select options={unitOptions(unitGroups.volume)} onChange={changeMainUnit} /></Form.Item></div>}
    {kind === 'packaging' && <>
      <Form.Item name="container_name" label="Container"><Input placeholder="Bottle, keg…" /></Form.Item>
      <div className="form-triple"><Form.Item name="container_size" label="Container size"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit"><Select options={unitOptions(unitGroups.volume)} onChange={changeMainUnit} /></Form.Item>
        <Form.Item name="container_count" label="Count"><InputNumber className="full-width" min={1} precision={0} /></Form.Item></div>
    </>}
    <div className="form-pair"><Form.Item name="duration_value" label="Duration (optional)"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
      <Form.Item name="duration_unit" label="Duration unit"><Select options={timeUnits.map(({ value, label }) => ({ value, label }))}
        onChange={unit => changeTimeUnit('duration_value', selectedDurationUnit, unit)} /></Form.Item></div>
    <Form.Item name="timing_key" label="Timing" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={[
      { value: 'start', label: 'Batch start' },
      ...anchors.flatMap(anchor => (planDuration(anchor) ? [
        { value: `before:start:${anchor.id}`, label: `Before start of ${anchor.title}` },
        { value: `after:start:${anchor.id}`, label: `At or after start of ${anchor.title}` },
        { value: `before:end:${anchor.id}`, label: `Before end of ${anchor.title}` },
        { value: `after:end:${anchor.id}`, label: `At or after end of ${anchor.title}` }
      ] : [
        { value: `before:start:${anchor.id}`, label: `Before ${anchor.title} · ${kindLabel(anchor.event_type)}` },
        { value: `after:start:${anchor.id}`, label: `At or after ${anchor.title} · ${kindLabel(anchor.event_type)}` }
      ]))
    ]} /></Form.Item>
    <div className="form-pair">
      <Form.Item name="offset_value" label="Time offset" rules={[{ required: true }]}><InputNumber className="full-width" min={0} step="any" /></Form.Item>
      <Form.Item name="offset_unit" label="Unit" rules={[{ required: true }]}><Select options={timeUnits.map(({ value, label }) => ({ value, label }))}
        onChange={unit => changeTimeUnit('offset_value', selectedOffsetUnit, unit)} /></Form.Item>
    </div>
    <Form.Item name="details" label="Instructions"><Input.TextArea rows={2} placeholder="Optional details" /></Form.Item>
    {allowRecordNow && !initialPlan && <Form.Item name="record_now" valuePropName="checked" initialValue={false}>
      <Checkbox>Record this now</Checkbox>
    </Form.Item>}
    <div className="plan-form-actions">
      <Button type="primary" htmlType="submit" loading={busy}>{initialPlan ? 'Save event' : `Add ${kindLabel(kind).toLowerCase()}`}</Button>
      {extraAction}
    </div>
  </Form>;
}
