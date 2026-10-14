import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, AutoComplete, Button, Checkbox, Form, Input, InputNumber, Select } from 'antd';
import { kindLabel, measurementKinds } from './constants.ts';
import type { Equipment, InventoryItem, PlanDetails, PlanInput } from './db.ts';
import { vesselKinds } from '../shared/equipment.ts';
import { compoundMassUnit, convertUnit, gravityScales, quantityForStorage, quantityUnitsForCategory, splitOunces, unitGroups, unitOptions } from '../shared/units.ts';
import { planDuration, supportsDuration } from './planTiming.ts';
import { unitForCategory, type CatalogInventory, type CatalogSupplyCategory } from '../shared/catalog.ts';
import { QuantityFields } from './QuantityFields.tsx';
import type { PreferredUnits } from './api.ts';
import { changeNumberUnit, changeQuantityUnit } from './unitFields.ts';

interface Anchor { id: string; title: string; event_type: string; details?: PlanDetails }
export interface PlanPreset { phase?: 'mash' | 'boil' | 'chill'; measurementKind?: string; itemCategory?: string; title?: string;
  timingKey?: string; offsetSeconds?: number; purpose?: 'drain_grain' }
export function repeatPreset(input: PlanInput): PlanPreset {
  const anchorPoint = input.details?.anchor_point === 'end' ? 'end' : 'start';
  return {
    itemCategory: String(input.details?.item_category || ''),
    measurementKind: String(input.details?.measurement_kind || ''),
    timingKey: input.anchor_event_id ? `${(input.offset_seconds || 0) < 0 ? 'before' : 'after'}:${anchorPoint}:${input.anchor_event_id}` : 'start',
    offsetSeconds: input.offset_seconds || 0
  };
}
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
  photo: 'Description', note: 'Reminder'
};

interface Values {
  record_now?: boolean;
  title: string; timing_key: string; offset_value?: number;
  offset_unit?: typeof timeUnits[number]['value']; details?: string;
  item_category?: string; quantity?: number; unit?: string; pounds?: number; ounces?: number;
  measurement_kind?: string; target_value?: number; target_unit?: string;
  mode?: string; container_name?: string; container_size?: number; container_count?: number;
  to_vessel_id?: string; transfer_equipment_ids?: string[];
  mash_equipment_id?: string;
  equipment_id?: string;
  duration_value?: number; duration_unit?: typeof timeUnits[number]['value'];
}

export function PlanForm({ anchors, eventType, initialPlan, equipment, inventory, catalog, catalogCategories, preferredUnits, preset, recipeMode = false, allowRecordNow = false, extraAction, submit }: {
  anchors: Anchor[];
  eventType: string;
  initialPlan?: PlanInput & { id: string };
  equipment: Equipment[]; inventory: InventoryItem[]; catalog: CatalogInventory[]; catalogCategories: CatalogSupplyCategory[]; preferredUnits: PreferredUnits;
  preset?: PlanPreset;
  recipeMode?: boolean;
  allowRecordNow?: boolean;
  extraAction?: ReactNode;
  submit: (input: PlanInput, recordNow?: boolean, addAnother?: boolean) => Promise<void>;
}) {
  const [form] = Form.useForm<Values>();
  const addAnotherRef = useRef(false);
  const initialDetails = initialPlan?.details || {};
  const kind = initialPlan?.event_type || eventType;
  const offset = initialPlan?.offset_seconds ?? preset?.offsetSeconds ?? 0;
  const offsetUnit = offset === 0 ? timeUnits[1] : [...timeUnits].reverse().find(item => Math.abs(offset) % item.multiplier === 0) || timeUnits[0];
  const genericPitch = kind === 'addition' && initialPlan?.title === 'Pitch yeast'
    && initialDetails.item_category === 'Yeast' && !initialDetails.inventory_item_id && !initialDetails.supply_id && !initialDetails.catalog_item_id
    && (!initialDetails.item_name || initialDetails.item_name === 'Yeast');
  const unspecifiedAddition = kind === 'addition' && !!initialPlan && !!initialDetails.item_category
    && !initialDetails.item_name && !initialDetails.inventory_item_id && !initialDetails.supply_id && !initialDetails.catalog_item_id;
  const initialItem = genericPitch || unspecifiedAddition ? '' : String(initialDetails.item_name || initialPlan?.title || preset?.title || '');
  const initialCategory = String(initialDetails.item_category || inventory.find(item => item.id === (recipeMode
    ? initialDetails.supply_id : initialDetails.inventory_item_id))?.category
    || catalog.find(item => item.id === initialDetails.catalog_item_id || item.name === initialItem)?.category || preset?.itemCategory || '');
  const categoryNames = [...new Set([...catalogCategories.map(row => row.name),
    ...inventory.map(row => row.category), ...(initialCategory ? [initialCategory] : [])])];
  const initialUnit = String(initialDetails.display_unit || initialDetails.container_unit || initialDetails.unit ||
    (kind === 'transfer' || kind === 'packaging' ? preferredUnits.volume
      : initialCategory ? unitForCategory(initialCategory, preferredUnits.mass) : preferredUnits.mass));
  const initialSplit = initialUnit === compoundMassUnit && typeof initialDetails.quantity === 'number'
    ? splitOunces(initialDetails.quantity) : null;
  const lockedMeasurementKind = preset?.measurementKind || (initialPlan?.event_type === 'measurement' ? String(initialDetails.measurement_kind || '') : '');
  const [measurementKind, setMeasurementKind] = useState(String(initialDetails.measurement_kind || preset?.measurementKind || 'temperature'));
  const gravityMeasurement = kind === 'measurement' && measurementKind === 'gravity';
  const phase = String(initialDetails.phase || preset?.phase || '');
  const timedControl = supportsDuration(kind, phase);
  const duration = initialPlan ? planDuration(initialPlan) : preset?.phase === 'boil' ? 3600 : preset?.phase === 'mash' ? 1800 : 0;
  const [itemCategory, setItemCategory] = useState(initialCategory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recordNow = Form.useWatch('record_now', form) as boolean | undefined;
  const selectedUnit = Form.useWatch('unit', form) as string | undefined;
  const selectedTargetUnit = Form.useWatch('target_unit', form) as string | undefined;
  const selectedOffsetUnit = Form.useWatch('offset_unit', form) as string | undefined;
  const selectedOffsetValue = Form.useWatch('offset_value', form) as number | undefined;
  const selectedDurationUnit = Form.useWatch('duration_unit', form) as string | undefined;
  const vesselOptions = equipment.filter(item => vesselKinds.has(item.kind)).map(item => ({ value: item.id, label: item.name }));
  const destinationId = initialDetails.to_vessel_id;
  if (typeof destinationId === 'string' && !vesselOptions.some(item => item.value === destinationId)) {
    vesselOptions.push({ value: destinationId, label: String(initialDetails.to_vessel_name || 'Archived vessel') });
  }

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
      const addAnother = addAnotherRef.current;
      const itemName = values.title?.trim() || '';
      const title = itemName || (kind === 'photo' ? 'Photo' : kind === 'addition' ? initialPlan?.title
        || (values.item_category === 'Yeast' ? 'Pitch yeast' : `Add ${String(values.item_category || 'ingredient').toLowerCase()}`) : '');
      const hasOffset = values.offset_value != null;
      const unit = timeUnits.find(item => item.value === values.offset_unit);
      if ((!gravityMeasurement && (!hasOffset || !unit)) || hasOffset && (!unit || !Number.isFinite(values.offset_value) || values.offset_value! < 0)) {
        throw new Error('Choose a valid time offset and unit');
      }
      const [direction, point, anchorId] = values.timing_key === 'start' ? ['start', 'start', null] : values.timing_key.split(':', 3);
      if (anchorId && !anchors.some(item => item.id === anchorId)) throw new Error('Choose an available timing event');
      const details: PlanDetails = {};
      if (values.details) details.note = values.details;
      if (phase) details.phase = phase;
      if (kind === 'transfer' && (preset?.purpose || initialDetails.purpose)) details.purpose = preset?.purpose || initialDetails.purpose;
      if (anchorId) details.anchor_point = point === 'end' ? 'end' : 'start';
      if (timedControl && values.duration_value != null) {
        const durationUnit = timeUnits.find(item => item.value === values.duration_unit);
        if (!durationUnit || values.duration_value <= 0) throw new Error('Choose a positive duration');
        details.duration_seconds = Math.round(values.duration_value * durationUnit.multiplier);
      }
      const keysByKind: Record<string, (keyof Values)[]> = {
        addition: ['item_category'],
        measurement: ['measurement_kind', 'target_value', 'target_unit'],
        temperature_control: ['mode', 'target_value', 'target_unit', 'equipment_id'],
        pressure_control: ['target_value', 'target_unit', 'equipment_id'],
        transfer: ['to_vessel_id', 'mash_equipment_id', 'quantity', 'unit'],
        packaging: ['container_name', 'container_size', 'container_count']
      };
      for (const key of keysByKind[kind] || []) {
        const value = values[key];
        if (typeof value === 'string' && value || typeof value === 'number') {
          (details as Record<string, string | number>)[key] = value;
        }
      }
      if (kind === 'packaging' && values.unit) details.container_unit = values.unit;
      if (kind === 'transfer') {
        const vessel = equipment.find(item => item.id === values.to_vessel_id);
        details.transfer_equipment_ids = values.transfer_equipment_ids || [];
        if (details.purpose !== 'drain_grain' && (vessel?.kind.includes('fermenter') ||
          /transfer to fermenter/i.test(title))) details.purpose = 'to_fermenter';
        if (vessel) details.to_vessel_name = vessel.name;
        else if (values.to_vessel_id === initialDetails.to_vessel_id && initialDetails.to_vessel_name) {
          details.to_vessel_name = initialDetails.to_vessel_name;
        }
      }
      if (kind === 'addition') {
        if (itemName) details.item_name = itemName;
        const amount = quantityForStorage(values.unit || '', values.quantity, values.pounds, values.ounces);
        if (amount) {
          if (!values.unit) throw new Error('Choose a unit');
          details.quantity = amount.quantity;
          details.unit = amount.unit;
          if (values.unit === compoundMassUnit) details.display_unit = compoundMassUnit;
        }
        const owned = inventory.find(item => item.category === values.item_category && item.name.toLowerCase() === itemName.toLowerCase());
        const known = catalog.find(item => item.category === values.item_category && item.name.toLowerCase() === itemName.toLowerCase());
        if (owned) {
          if (recipeMode) details.supply_id = owned.id;
          else { details.inventory_item_id = owned.id; details.supply_id = owned.supply_id || undefined; }
        }
        else if (known) details.catalog_item_id = known.id;
      }
      await submit({
        title, event_type: kind,
        planned_at: null, anchor_event_id: anchorId,
        offset_seconds: hasOffset ? Math.round(values.offset_value! * unit!.multiplier) * (direction === 'before' ? -1 : 1) : 0,
        details
      }, addAnother ? false : values.record_now, addAnother);
      if (addAnother) form.setFieldsValue({ title: undefined, quantity: undefined, pounds: undefined,
        ounces: undefined, target_value: undefined, details: undefined });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { addAnotherRef.current = false; setBusy(false); }
  }

  return <Form form={form} layout="vertical" onFinish={save} onFinishFailed={() => { addAnotherRef.current = false; }} initialValues={{
    title: kind === 'addition' ? initialItem : initialPlan?.title || preset?.title,
    timing_key: initialPlan?.anchor_event_id ? `${offset < 0 ? 'before' : 'after'}:${initialDetails.anchor_point === 'end' ? 'end' : 'start'}:${initialPlan.anchor_event_id}` : preset?.timingKey || 'start',
    offset_value: gravityMeasurement && offset === 0 ? undefined : Math.abs(offset) / offsetUnit.multiplier,
    offset_unit: gravityMeasurement && offset === 0 ? undefined : offsetUnit.value,
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
      : phase === 'boil' ? convertUnit(100, '°C', preferredUnits.temperature)
        : phase === 'chill' ? convertUnit(20, '°C', preferredUnits.temperature) : undefined), container_name: initialDetails.container_name,
    container_size: initialDetails.container_size, container_count: initialDetails.container_count,
    to_vessel_id: initialDetails.to_vessel_id, mash_equipment_id: initialDetails.mash_equipment_id,
    transfer_equipment_ids: initialDetails.transfer_equipment_ids || [],
    equipment_id: initialDetails.equipment_id
  }}>
    {error && <Alert type="error" message={error} className="form-alert" />}
    {kind === 'addition' && <>
      <Form.Item name="item_category" label="Type" rules={[{ required: true }]}><Select options={categoryNames.map(value => ({ value, label: value }))}
        onChange={(value: string) => { setItemCategory(value); form.setFieldsValue({ title: undefined,
          unit: unitForCategory(value, preferredUnits.mass), quantity: undefined, pounds: undefined, ounces: undefined }); }} /></Form.Item>
      <Form.Item name="title" label="What will be added?">
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
              ? unitForCategory(itemCategory, preferredUnits.mass) : known?.unit;
            const nextUnit = owned?.display_unit || knownUnit || unitForCategory(itemCategory, preferredUnits.mass);
            changeQuantityUnit(form, selectedUnit || initialUnit, nextUnit);
            form.setFieldValue('unit', nextUnit);
          }} />
      </Form.Item>
      <Form.Item name="unit" label="Unit"><Select showSearch options={unitOptions(quantityUnitsForCategory(itemCategory))}
        onChange={changeMainUnit} /></Form.Item>
      <QuantityFields unit={selectedUnit || initialUnit} label="Quantity" optional />
    </>}
    {kind !== 'addition' && <Form.Item name="title" label={titleLabels[kind] || 'Action title'}
      rules={kind === 'photo' ? [] : [{ required: true }]}>
      <Input placeholder={kind === 'photo' ? 'What should you photograph?' : `Describe the ${kindLabel(kind).toLowerCase()}`} maxLength={120} />
    </Form.Item>}
    {kind === 'measurement' && <>
      {!lockedMeasurementKind && <Form.Item name="measurement_kind" label="Measurement"><Select options={measurementKinds.map(item => ({ value: item.value, label: item.label }))}
        onChange={value => { setMeasurementKind(value); form.setFieldsValue({ target_value: undefined,
          target_unit: value === 'temperature' ? preferredUnits.temperature : value === 'volume' ? preferredUnits.volume
            : value === 'pressure' ? preferredUnits.pressure : measurementKinds.find(item => item.value === value)?.unit }); }} /></Form.Item>
      }
      <div className="form-pair"><Form.Item name="target_value" label="Target"><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="target_unit" label={measurementKind === 'gravity' ? 'Scale' : 'Unit'}><Select options={unitOptions(
          measurementKind === 'ph' ? ['pH'] : measurementKind === 'gravity' ? gravityScales
            : measurementKind === 'carbonation' ? unitGroups.carbonation
              : measurementKind === 'dissolved_oxygen' ? unitGroups.dissolved_oxygen
                : unitGroups[measurementKind as 'temperature' | 'volume' | 'pressure'] || []
        )} onChange={unit => changeNumberUnit(form, ['target_value'], selectedTargetUnit, unit)} /></Form.Item></div>
    </>}
    {kind === 'temperature_control' && <>
      <Form.Item name="equipment_id" label="Equipment"><Select allowClear showSearch optionFilterProp="label"
        options={equipment.filter(item => phase !== 'mash' || ['all_in_one', 'mash_tun', 'kettle', 'electric_kettle'].includes(item.kind))
          .map(item => ({ value: item.id, label: item.name }))} /></Form.Item>
      <Form.Item name="mode" label="Mode"><Select options={[
        { value: 'heat', label: 'Heat' }, { value: 'chill', label: 'Chill' }, { value: 'hold', label: 'Hold' }
      ]} /></Form.Item>
      <div className="form-pair"><Form.Item name="target_value" label="Target temperature" rules={phase === 'chill' ? [{ required: true }] : []}><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="target_unit" label="Unit" rules={phase === 'chill' ? [{ required: true }] : []}><Select options={unitOptions(unitGroups.temperature)}
          onChange={unit => changeNumberUnit(form, ['target_value'], selectedTargetUnit, unit)} /></Form.Item></div>
    </>}
    {kind === 'pressure_control' && <><Form.Item name="equipment_id" label="Equipment"><Select allowClear showSearch optionFilterProp="label"
      options={equipment.map(item => ({ value: item.id, label: item.name }))} /></Form.Item>
      <div className="form-pair"><Form.Item name="target_value" label="Target pressure"><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="target_unit" label="Unit"><Select options={unitOptions(unitGroups.pressure)}
          onChange={unit => changeNumberUnit(form, ['target_value'], selectedTargetUnit, unit)} /></Form.Item></div></>}
    {kind === 'transfer' && <>
      {(preset?.purpose === 'drain_grain' || initialDetails.purpose === 'drain_grain') &&
        <Form.Item name="mash_equipment_id" label="Mash equipment"><Select allowClear showSearch optionFilterProp="label"
          options={equipment.filter(item => ['all_in_one', 'mash_tun', 'kettle', 'electric_kettle'].includes(item.kind))
            .map(item => ({ value: item.id, label: item.name }))}
          onChange={id => { const item = equipment.find(row => row.id === id);
            if (item?.kind === 'all_in_one' && !form.getFieldValue('to_vessel_id')) form.setFieldValue('to_vessel_id', id); }} /></Form.Item>}
      <Form.Item name="to_vessel_id" label={preset?.purpose === 'drain_grain' || initialDetails.purpose === 'drain_grain'
        ? 'Collecting vessel' : 'To vessel'}><Select allowClear showSearch optionFilterProp="label" options={vesselOptions} /></Form.Item>
      {preset?.purpose !== 'drain_grain' && initialDetails.purpose !== 'drain_grain' &&
        <Form.Item name="transfer_equipment_ids" label="Transfer equipment"><Select mode="multiple" showSearch optionFilterProp="label"
          options={equipment.filter(item => !['fermenter', 'temp_control_fermenter', 'pressure_fermenter', 'temp_pressure_fermenter'].includes(item.kind))
            .map(item => ({ value: item.id, label: item.name }))} /></Form.Item>}
      <div className="form-pair"><Form.Item name="quantity" label="Volume"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit"><Select options={unitOptions(unitGroups.volume)} onChange={changeMainUnit} /></Form.Item></div>
    </>}
    {kind === 'packaging' && <>
      <Form.Item name="container_name" label="Container"><Input placeholder="Bottle, keg…" /></Form.Item>
      <div className="form-triple"><Form.Item name="container_size" label="Container size"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit"><Select options={unitOptions(unitGroups.volume)} onChange={changeMainUnit} /></Form.Item>
        <Form.Item name="container_count" label="Count"><InputNumber className="full-width" min={1} precision={0} /></Form.Item></div>
    </>}
    {timedControl && <div className="form-pair"><Form.Item name="duration_value" label="Duration"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
      <Form.Item name="duration_unit" label="Duration unit"><Select options={timeUnits.map(({ value, label }) => ({ value, label }))}
        onChange={unit => changeTimeUnit('duration_value', selectedDurationUnit, unit)} /></Form.Item></div>}
    <Form.Item name="timing_key" label="Timing" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={[
      { value: 'start', label: 'Batch start' },
      ...anchors.flatMap(anchor => (planDuration(anchor) ? [
        { value: `before:start:${anchor.id}`, label: `Before start of ${anchor.title}` },
        { value: `after:start:${anchor.id}`, label: `At or after start of ${anchor.title}` },
        { value: `before:end:${anchor.id}`, label: `Before end of ${anchor.title}` },
        { value: `after:end:${anchor.id}`, label: `At or after end of ${anchor.title}` }
      ] : anchor.details?.phase === 'chill' ? [
        { value: `before:start:${anchor.id}`, label: `Before ${anchor.title} · ${kindLabel(anchor.event_type)}` },
        { value: `after:start:${anchor.id}`, label: `At or after ${anchor.title}` },
        { value: `after:end:${anchor.id}`, label: `After ${anchor.title}` }
      ] : [
        { value: `before:start:${anchor.id}`, label: `Before ${anchor.title} · ${kindLabel(anchor.event_type)}` },
        { value: `after:start:${anchor.id}`, label: `At or after ${anchor.title} · ${kindLabel(anchor.event_type)}` }
      ]))
    ]} /></Form.Item>
    <div className="form-pair">
      <Form.Item name="offset_value" label="Time offset" rules={gravityMeasurement ? [] : [{ required: true }]}><InputNumber className="full-width" min={0} step="any" /></Form.Item>
      <Form.Item name="offset_unit" label="Unit" rules={[{ required: !gravityMeasurement || selectedOffsetValue != null }]}><Select options={timeUnits.map(({ value, label }) => ({ value, label }))}
        onChange={unit => changeTimeUnit('offset_value', selectedOffsetUnit, unit)} /></Form.Item>
    </div>
    <Form.Item name="details" label="Instructions"><Input.TextArea rows={2} placeholder="Optional details" /></Form.Item>
    {allowRecordNow && !initialPlan && <Form.Item name="record_now" valuePropName="checked" initialValue={false}>
      <Checkbox>Record this now</Checkbox>
    </Form.Item>}
    <div className="plan-form-actions">
      <div className="plan-form-save-actions">
        <Button type="primary" htmlType="submit" loading={busy} onClick={() => { addAnotherRef.current = false; }}>
          {initialPlan ? 'Save event' : kind === 'addition' ? 'Add ingredient' : `Add ${kindLabel(kind).toLowerCase()}`}
        </Button>
        {['addition', 'measurement'].includes(kind) && !recordNow &&
          <Button htmlType="submit" loading={busy} onClick={() => { addAnotherRef.current = true; }}>Save and add another</Button>}
      </div>
      {extraAction}
    </div>
  </Form>;
}
