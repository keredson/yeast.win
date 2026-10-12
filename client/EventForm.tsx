import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Select } from 'antd';
import { kindLabel, measurementKinds, planKinds } from './constants.ts';
import { fromDatetimeLocal, toDatetimeLocal } from './time.ts';
import { addPhoto, recordEvent, skipBatchEvent, updateEvent, updatePhotoEvent, type ActualEvent, type Equipment, type EventInput, type InventoryItem, type LocalDb, type MeasurementKind, type Plan } from './db.ts';
import type { PreferredUnits } from './api.ts';
import { compoundMassUnit, quantityForStorage, quantityUnitsForCategory, splitOunces, unitGroups, unitOptions } from '../shared/units.ts';
import { parsePlanDetails } from './planTiming.ts';
import { inventoryCategories } from '../shared/catalog.ts';
import { QuantityFields } from './QuantityFields.tsx';
import { changeNumberUnit, changeQuantityUnit } from './unitFields.ts';

function measurementUnits(kind: MeasurementKind): readonly string[] {
  if (kind === 'ph') return ['pH'];
  if (kind === 'gravity') return unitGroups.gravity;
  if (kind === 'carbonation') return unitGroups.carbonation;
  if (kind === 'dissolved_oxygen') return unitGroups.dissolved_oxygen;
  return unitGroups[kind];
}

function measurementUnit(kind: MeasurementKind, units: PreferredUnits): string {
  if (kind === 'temperature') return units.temperature;
  if (kind === 'volume') return units.volume;
  if (kind === 'pressure') return units.pressure;
  return measurementKinds.find(item => item.value === kind)?.unit || '';
}

function eventUnit(kind: string, units: PreferredUnits): string | undefined {
  if (kind === 'measurement') return units.temperature;
  if (kind === 'addition') return units.mass;
  if (kind === 'transfer') return units.volume;
  return undefined;
}

interface Values {
  event_type: string; measurement_kind?: MeasurementKind; actual_at: string; ended_at?: string;
  note?: string; value?: number; unit?: string; uncertainty?: number; equipment_id?: string;
  calibration_id?: string; source?: string; item_name?: string; inventory_item_id?: string;
  item_category?: string; quantity?: number; pounds?: number; ounces?: number;
  mode?: string; target_value?: number; target_unit?: string; power_watts?: number;
  from_vessel_id?: string; to_vessel_id?: string; container_name?: string; container_size?: number;
  container_unit?: string; container_count?: number;
}

export function EventForm({ db, batchId, accountId, equipment, inventory, preferredUnits, initialPlan, initialEvent, initialData, onSaved }: {
  db: LocalDb; batchId: string; accountId: string; equipment: Equipment[];
  inventory: InventoryItem[]; preferredUnits: PreferredUnits; initialPlan?: Plan | null;
  initialEvent?: ActualEvent | null; initialData?: { measurementKind?: MeasurementKind; payload: Record<string, string | number | null> } | null;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm<Values>();
  const planned = parsePlanDetails(initialPlan?.details_json);
  const plannedString = (key: string) => typeof planned[key] === 'string' ? planned[key] as string : undefined;
  const plannedNumber = (key: string) => typeof planned[key] === 'number' ? planned[key] as number : undefined;
  const completingPlan = !!initialPlan && !initialEvent;
  const initialMeasurement = measurementKinds.find(item => item.value === plannedString('measurement_kind'))?.value as MeasurementKind | undefined;
  const [kind, setKind] = useState(initialEvent?.event_type || initialPlan?.event_type || 'note');
  const [measurement, setMeasurement] = useState<MeasurementKind>(initialData?.measurementKind || initialMeasurement || 'temperature');
  const [instrumentId, setInstrumentId] = useState<string | undefined>(String(initialData?.payload.equipment_id || '') || undefined);
  const [calibrations, setCalibrations] = useState<{ id: string; effective_at: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const initialQuantity = typeof initialData?.payload.quantity === 'number' ? initialData.payload.quantity : plannedNumber('quantity');
  const storedUnit = String(initialData?.payload.unit || plannedString('unit') || (kind === 'measurement'
    ? measurementUnit(initialMeasurement || 'temperature', preferredUnits) : eventUnit(kind, preferredUnits)) || '');
  const initialUnit = kind === 'addition' && storedUnit === 'oz'
    && (plannedString('display_unit') === compoundMassUnit || preferredUnits.mass === compoundMassUnit)
    ? compoundMassUnit : storedUnit;
  const initialSplit = initialUnit === compoundMassUnit && initialQuantity != null ? splitOunces(initialQuantity) : null;
  const initialCategory = plannedString('item_category')
    || inventory.find(item => item.id === (initialData?.payload.inventory_item_id || plannedString('inventory_item_id')))?.category || 'Other';
  const selectedUnit = Form.useWatch('unit', form) as string | undefined;
  const selectedTargetUnit = Form.useWatch('target_unit', form) as string | undefined;
  const selectedContainerUnit = Form.useWatch('container_unit', form) as string | undefined;
  const selectedCategory = Form.useWatch('item_category', form) as string | undefined;

  function changeMainUnit(next: string) {
    const from = selectedUnit || initialUnit;
    if (kind === 'addition') changeQuantityUnit(form, from, next);
    else if (kind === 'measurement') changeNumberUnit(form, ['value', 'uncertainty'], from, next, ['uncertainty']);
    else changeNumberUnit(form, ['quantity'], from, next);
  }

  useEffect(() => {
    if (!instrumentId) return setCalibrations([]);
    void db.execO<{ id: string; effective_at: number }>(
      'SELECT id, effective_at FROM equipment_calibrations WHERE equipment_id = ? ORDER BY effective_at DESC', [instrumentId])
      .then(setCalibrations);
  }, [db, instrumentId]);

  async function submit(values: Values) {
    setBusy(true); setError('');
    try {
      if (kind === 'photo') {
        if (initialEvent) await updatePhotoEvent(db, initialEvent, fromDatetimeLocal(values.actual_at), values.note || '', photo);
        else {
          if (!photo) throw new Error('Choose a photo');
          await addPhoto(db, batchId, photo, accountId, fromDatetimeLocal(values.actual_at), initialPlan?.id || null, values.note || '');
        }
        await onSaved();
        return;
      }
      let payload: EventInput['payload'];
      const input: EventInput = {
        batchId, accountId, eventType: initialPlan?.event_type || values.event_type,
        actualAt: fromDatetimeLocal(values.actual_at),
        endedAt: values.ended_at ? fromDatetimeLocal(values.ended_at) : null,
        eventId: initialPlan?.id || null, note: values.note || '',
      };
      if (kind === 'measurement') {
        if (values.value == null) throw new Error('Enter the measured value');
        input.measurementKind = values.measurement_kind || measurement;
        payload = { value: values.value, unit: values.unit || '', uncertainty: values.uncertainty ?? null,
          equipment_id: values.equipment_id || null, calibration_id: values.calibration_id || null,
          source: values.source || 'manual' };
      } else if (kind === 'addition') {
        const itemName = values.item_name || plannedString('item_name') || initialPlan?.title;
        const itemId = values.inventory_item_id || plannedString('inventory_item_id');
        const amount = quantityForStorage(values.unit || '', values.quantity, values.pounds, values.ounces);
        if (!itemName || !amount) throw new Error('Enter an item and quantity');
        payload = { item_name: itemName, inventory_item_id: itemId || null,
          quantity: amount.quantity, unit: amount.unit };
      } else if (kind === 'temperature_control') {
        if (!values.equipment_id) throw new Error('Choose controlled equipment');
        if (values.target_value == null && values.power_watts == null) throw new Error('Enter a target or power');
        payload = { equipment_id: values.equipment_id, mode: values.mode || 'hold',
          target_value: values.target_value ?? null, target_unit: values.target_unit || null,
          power_watts: values.power_watts ?? null, ended_at: values.ended_at ? fromDatetimeLocal(values.ended_at) : null };
      } else if (kind === 'pressure_control') {
        if (!values.equipment_id || values.target_value == null || !values.target_unit) throw new Error('Choose equipment and a pressure target');
        payload = { equipment_id: values.equipment_id, target_value: values.target_value, target_unit: values.target_unit };
      } else if (kind === 'transfer') {
        payload = { from_vessel_id: values.from_vessel_id || null, to_vessel_id: values.to_vessel_id || null,
          quantity: values.quantity ?? null, unit: values.unit || null };
      } else if (kind === 'packaging') {
        if (!values.container_name || values.container_size == null || !values.container_unit || values.container_count == null) {
          throw new Error('Enter container, size, unit, and count');
        }
        payload = { container_name: values.container_name, container_size: values.container_size,
          container_unit: values.container_unit, container_count: values.container_count,
          inventory_item_id: values.inventory_item_id || null };
      }
      input.payload = payload;
      if (initialEvent) await updateEvent(db, initialEvent, input);
      else await recordEvent(db, input);
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function skipPlan() {
    if (!initialPlan) return;
    setBusy(true); setError('');
    try {
      const at = form.getFieldValue('actual_at');
      if (!at) throw new Error('Choose when this was skipped');
      await skipBatchEvent(db, initialPlan.id, fromDatetimeLocal(at), accountId);
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <Form form={form} layout="vertical" onFinish={submit} initialValues={{
    event_type: kind, actual_at: initialEvent?.actual_at != null ? toDatetimeLocal(initialEvent.actual_at) : toDatetimeLocal(),
    ended_at: initialEvent?.ended_at ? toDatetimeLocal(initialEvent.ended_at) : undefined,
    note: initialEvent?.note || undefined,
    measurement_kind: initialData?.measurementKind || plannedString('measurement_kind') || measurement,
    mode: initialData?.payload.mode || plannedString('mode') || 'hold', source: initialData?.payload.source || 'manual',
    item_name: plannedString('item_name'), item_category: initialCategory,
    inventory_item_id: plannedString('inventory_item_id'),
    container_name: plannedString('container_name'), container_size: plannedNumber('container_size'),
    container_count: plannedNumber('container_count'),
    target_value: kind === 'measurement' ? undefined : plannedNumber('target_value'),
    target_unit: plannedString('target_unit') || (kind === 'temperature_control' ? preferredUnits.temperature : kind === 'pressure_control' ? preferredUnits.pressure : undefined),
    container_unit: plannedString('unit') || preferredUnits.volume,
    ...initialData?.payload,
    unit: initialUnit, quantity: initialUnit === compoundMassUnit ? undefined : initialQuantity,
    pounds: initialSplit?.pounds, ounces: initialSplit?.ounces
  }}>
    {error && <Alert type="error" message={error} className="form-alert" />}
    {!initialPlan && <Form.Item name="event_type" label="Event type" rules={[{ required: true }]}>
      <Select disabled={!!initialEvent} options={initialEvent?.event_type === 'skipped' ? [{ value: 'skipped', label: 'Skipped plan' }] : planKinds} onChange={(value: string) => {
        setKind(value);
        form.setFieldsValue({ unit: eventUnit(value, preferredUnits),
          target_unit: value === 'temperature_control' ? preferredUnits.temperature : value === 'pressure_control' ? preferredUnits.pressure : undefined });
      }} />
    </Form.Item>}
    <div>
      <Form.Item name="actual_at" label={plannedNumber('duration_seconds') || initialEvent?.ended_at ? 'Started' : 'When'} rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
    </div>
    {(!!plannedNumber('duration_seconds') || !!initialEvent?.ended_at || kind === 'temperature_control') &&
      <Form.Item name="ended_at" label="Ended (optional)"><Input type="datetime-local" /></Form.Item>}
    {kind === 'measurement' && <>
      <Form.Item name="measurement_kind" label="Measurement" rules={[{ required: true }]}>
        <Select disabled={!!initialEvent} options={measurementKinds.map(item => ({ value: item.value, label: item.label }))}
          onChange={(value: MeasurementKind) => {
            setMeasurement(value);
            form.setFieldsValue({ unit: measurementUnit(value, preferredUnits), value: undefined, uncertainty: undefined });
          }} />
      </Form.Item>
      <div className="form-pair">
        <Form.Item name="value" label="Corrected value" rules={[{ required: true }]}><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit" rules={[{ required: true }]}><Select options={unitOptions(measurementUnits(measurement))}
          onChange={changeMainUnit} /></Form.Item>
      </div>
      <div className="form-pair">
        <Form.Item name="uncertainty" label="Uncertainty (±)"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="source" label="Method/source"><Input placeholder="e.g. refractometer" /></Form.Item>
      </div>
      <div className="form-pair">
        <Form.Item name="equipment_id" label="Instrument"><Select allowClear placeholder="Choose equipment"
          options={equipment.map(item => ({ value: item.id, label: item.name }))} onChange={setInstrumentId} /></Form.Item>
        <Form.Item name="calibration_id" label="Calibration"><Select allowClear placeholder="If calibrated"
          options={calibrations.map(item => ({ value: item.id, label: new Date(item.effective_at * 1000).toLocaleDateString() }))} /></Form.Item>
      </div>
    </>}
    {kind === 'addition' && <>
      <>
        <Form.Item name="item_category" label="Type"><Select options={inventoryCategories.map(value => ({ value, label: value }))}
          onChange={() => form.setFieldsValue({ inventory_item_id: undefined, item_name: undefined, unit: preferredUnits.mass,
            quantity: undefined, pounds: undefined, ounces: undefined })} /></Form.Item>
        <Form.Item name="inventory_item_id" label="Inventory item"><Select allowClear placeholder="Optional"
          options={inventory.filter(item => item.category === (selectedCategory || initialCategory)).map(item =>
            ({ value: item.id, label: `${item.name} · ${item.location_name || 'Unspecified'}` }))}
          onChange={id => { const item = inventory.find(row => row.id === id);
            if (item) { changeQuantityUnit(form, selectedUnit || initialUnit, item.display_unit);
              form.setFieldsValue({ item_name: item.name, item_category: item.category, unit: item.display_unit }); } }} /></Form.Item>
        <Form.Item name="item_name" label="What was added?" rules={[{ required: true }]}><Input placeholder="e.g. Fermaid O, yeast, oxygen" /></Form.Item>
      </>
      <Form.Item name="unit" label="Unit" rules={[{ required: true }]}>
        <Select showSearch options={unitOptions(quantityUnitsForCategory(selectedCategory || initialCategory))}
          onChange={changeMainUnit} /></Form.Item>
      <QuantityFields unit={selectedUnit || initialUnit} />
    </>}
    {(kind === 'temperature_control' || kind === 'pressure_control') && <>
      <Form.Item name="equipment_id" label="Controlled equipment" rules={[{ required: true }]}><Select
        options={equipment.map(item => ({ value: item.id, label: item.name }))} placeholder="Choose equipment" /></Form.Item>
      {kind === 'temperature_control' && <Form.Item name="mode" label="Mode"><Select options={[
        { value: 'heat', label: 'Heat' }, { value: 'chill', label: 'Chill' }, { value: 'hold', label: 'Hold' }
      ]} /></Form.Item>}
      <div className="form-pair"><Form.Item name="target_value" label="Target" rules={kind === 'pressure_control' ? [{ required: true }] : []}>
        <InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="target_unit" label="Unit" rules={kind === 'pressure_control' ? [{ required: true }] : []}>
          <Select options={unitOptions(kind === 'pressure_control' ? unitGroups.pressure : unitGroups.temperature)}
            onChange={unit => changeNumberUnit(form, ['target_value'], selectedTargetUnit, unit)} /></Form.Item></div>
      {kind === 'temperature_control' && <Form.Item name="power_watts" label="Power (W), if set"><InputNumber className="full-width" min={0} /></Form.Item>}
    </>}
    {kind === 'transfer' && <>
      <div className="form-pair"><Form.Item name="from_vessel_id" label="From vessel"><Select allowClear options={equipment.map(item => ({ value: item.id, label: item.name }))} /></Form.Item>
        <Form.Item name="to_vessel_id" label="To vessel"><Select allowClear options={equipment.map(item => ({ value: item.id, label: item.name }))} /></Form.Item></div>
      <div className="form-pair"><Form.Item name="quantity" label="Quantity"><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit"><Select options={unitOptions(unitGroups.volume)} onChange={changeMainUnit} /></Form.Item></div>
    </>}
    {kind === 'packaging' && <>
      <Form.Item name="inventory_item_id" label="Container inventory item"><Select allowClear options={inventory.map(item => ({ value: item.id, label: item.name }))} /></Form.Item>
      <Form.Item name="container_name" label="Container" rules={[{ required: true }]}><Input placeholder="Bottle, keg…" /></Form.Item>
      <div className="form-triple"><Form.Item name="container_size" label="Size" rules={[{ required: true }]}><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="container_unit" label="Unit" rules={[{ required: true }]}><Select options={unitOptions(unitGroups.volume)}
          onChange={unit => changeNumberUnit(form, ['container_size'], selectedContainerUnit, unit)} /></Form.Item>
        <Form.Item name="container_count" label="Count" rules={[{ required: true }]}><InputNumber className="full-width" min={1} precision={0} /></Form.Item></div>
    </>}
    {kind === 'photo' && <Form.Item label={initialEvent ? 'Replace photo (optional)' : 'Photo'} required={!initialEvent}>
      <Input type="file" accept="image/*" onChange={event => setPhoto(event.target.files?.[0] || null)} />
    </Form.Item>}
    <Form.Item name="note" label={kind === 'note' ? 'Notes' : 'Note'} rules={kind === 'note' ? [{ required: true, whitespace: true }] : []}>
      <Input.TextArea rows={kind === 'note' ? 4 : 2} placeholder={kind === 'note' ? 'What happened?' : 'Optional context'} /></Form.Item>
    <div className="event-form-actions"><Button type="primary" htmlType="submit" loading={busy}>Save event</Button>
      {initialPlan && !initialEvent && <Button onClick={() => void skipPlan()} disabled={busy}>Skip this event</Button>}</div>
  </Form>;
}
