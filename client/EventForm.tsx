import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Select } from 'antd';
import { kindLabel, measurementKinds, planKinds } from './constants.ts';
import { fromDatetimeLocal, toDatetimeLocal } from './time.ts';
import { recordEvent, type Equipment, type EventInput, type InventoryItem, type LocalDb, type MeasurementKind, type Plan } from './db.ts';
import type { PreferredUnits } from './api.ts';
import { quantityUnits, unitGroups, unitOptions } from '../shared/units.ts';

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
  event_type: string; measurement_kind?: MeasurementKind; actual_at: string; planned_event_id?: string;
  note?: string; value?: number; unit?: string; uncertainty?: number; equipment_id?: string;
  calibration_id?: string; source?: string; item_name?: string; inventory_item_id?: string;
  quantity?: number; mode?: string; target_value?: number; target_unit?: string; power_watts?: number;
  from_vessel_id?: string; to_vessel_id?: string; container_name?: string; container_size?: number;
  container_unit?: string; container_count?: number;
}

export function EventForm({ db, batchId, accountId, plans, equipment, inventory, preferredUnits, initialPlan, onSaved }: {
  db: LocalDb; batchId: string; accountId: string; plans: Plan[]; equipment: Equipment[];
  inventory: InventoryItem[]; preferredUnits: PreferredUnits; initialPlan?: Plan | null; onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm<Values>();
  const [kind, setKind] = useState(initialPlan?.event_type || 'note');
  const [measurement, setMeasurement] = useState<MeasurementKind>('temperature');
  const [instrumentId, setInstrumentId] = useState<string | undefined>();
  const [calibrations, setCalibrations] = useState<{ id: string; effective_at: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!instrumentId) return setCalibrations([]);
    void db.execO<{ id: string; effective_at: number }>(
      'SELECT id, effective_at FROM equipment_calibrations WHERE equipment_id = ? ORDER BY effective_at DESC', [instrumentId])
      .then(setCalibrations);
  }, [db, instrumentId]);

  async function submit(values: Values) {
    setBusy(true); setError('');
    try {
      let payload: EventInput['payload'];
      const input: EventInput = {
        batchId, accountId, eventType: values.event_type, actualAt: fromDatetimeLocal(values.actual_at),
        plannedEventId: values.planned_event_id || null, note: values.note || '',
      };
      if (kind === 'measurement') {
        if (values.value == null) throw new Error('Enter the measured value');
        input.measurementKind = values.measurement_kind || measurement;
        payload = { value: values.value, unit: values.unit || '', uncertainty: values.uncertainty ?? null,
          equipment_id: values.equipment_id || null, calibration_id: values.calibration_id || null,
          source: values.source || 'manual' };
      } else if (kind === 'addition') {
        if (!values.item_name || values.quantity == null || !values.unit) throw new Error('Enter an item, quantity, and unit');
        payload = { item_name: values.item_name, inventory_item_id: values.inventory_item_id || null,
          quantity: values.quantity, unit: values.unit };
      } else if (kind === 'temperature_control') {
        if (!values.equipment_id) throw new Error('Choose controlled equipment');
        if (values.target_value == null && values.power_watts == null) throw new Error('Enter a target or power');
        payload = { equipment_id: values.equipment_id, mode: values.mode || 'hold',
          target_value: values.target_value ?? null, target_unit: values.target_unit || null,
          power_watts: values.power_watts ?? null, ended_at: null };
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
      await recordEvent(db, input);
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <Form form={form} layout="vertical" onFinish={submit} initialValues={{
    event_type: kind, actual_at: toDatetimeLocal(), planned_event_id: initialPlan?.id,
    measurement_kind: measurement, mode: 'hold', source: 'manual',
    unit: eventUnit(kind, preferredUnits),
    target_unit: kind === 'temperature_control' ? preferredUnits.temperature : kind === 'pressure_control' ? preferredUnits.pressure : undefined,
    container_unit: preferredUnits.volume
  }}>
    {error && <Alert type="error" message={error} className="form-alert" />}
    <Form.Item name="event_type" label="Event type" rules={[{ required: true }]}>
      <Select options={[...planKinds, { value: 'skipped', label: 'Skipped plan' }]} onChange={(value: string) => {
        setKind(value);
        form.setFieldsValue({ unit: eventUnit(value, preferredUnits),
          target_unit: value === 'temperature_control' ? preferredUnits.temperature : value === 'pressure_control' ? preferredUnits.pressure : undefined });
      }} />
    </Form.Item>
    <div className="form-pair">
      <Form.Item name="actual_at" label="When" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
      <Form.Item name="planned_event_id" label="Related plan"><Select allowClear placeholder="Unplanned"
        options={plans.map(plan => ({ label: `${plan.title} · ${kindLabel(plan.event_type)}`, value: plan.id }))} /></Form.Item>
    </div>
    {kind === 'measurement' && <>
      <Form.Item name="measurement_kind" label="Measurement" rules={[{ required: true }]}>
        <Select options={measurementKinds.map(item => ({ value: item.value, label: item.label }))}
          onChange={(value: MeasurementKind) => {
            setMeasurement(value);
            form.setFieldValue('unit', measurementUnit(value, preferredUnits));
          }} />
      </Form.Item>
      <div className="form-pair">
        <Form.Item name="value" label="Corrected value" rules={[{ required: true }]}><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit" rules={[{ required: true }]}><Select options={unitOptions(measurementUnits(measurement))} /></Form.Item>
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
      <Form.Item name="inventory_item_id" label="Inventory item"><Select allowClear placeholder="Optional"
        options={inventory.map(item => ({ value: item.id, label: item.name }))} /></Form.Item>
      <Form.Item name="item_name" label="What was added?" rules={[{ required: true }]}><Input placeholder="e.g. Fermaid O, yeast, oxygen" /></Form.Item>
      <div className="form-pair"><Form.Item name="quantity" label="Quantity" rules={[{ required: true }]}><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit" rules={[{ required: true }]}><Select showSearch options={unitOptions(quantityUnits)} /></Form.Item></div>
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
          <Select options={unitOptions(kind === 'pressure_control' ? unitGroups.pressure : unitGroups.temperature)} /></Form.Item></div>
      {kind === 'temperature_control' && <Form.Item name="power_watts" label="Power (W), if set"><InputNumber className="full-width" min={0} /></Form.Item>}
    </>}
    {kind === 'transfer' && <>
      <div className="form-pair"><Form.Item name="from_vessel_id" label="From vessel"><Select allowClear options={equipment.map(item => ({ value: item.id, label: item.name }))} /></Form.Item>
        <Form.Item name="to_vessel_id" label="To vessel"><Select allowClear options={equipment.map(item => ({ value: item.id, label: item.name }))} /></Form.Item></div>
      <div className="form-pair"><Form.Item name="quantity" label="Quantity"><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit"><Select options={unitOptions(unitGroups.volume)} /></Form.Item></div>
    </>}
    {kind === 'packaging' && <>
      <Form.Item name="inventory_item_id" label="Container inventory item"><Select allowClear options={inventory.map(item => ({ value: item.id, label: item.name }))} /></Form.Item>
      <Form.Item name="container_name" label="Container" rules={[{ required: true }]}><Input placeholder="Bottle, keg…" /></Form.Item>
      <div className="form-triple"><Form.Item name="container_size" label="Size" rules={[{ required: true }]}><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="container_unit" label="Unit" rules={[{ required: true }]}><Select options={unitOptions(unitGroups.volume)} /></Form.Item>
        <Form.Item name="container_count" label="Count" rules={[{ required: true }]}><InputNumber className="full-width" min={1} precision={0} /></Form.Item></div>
    </>}
    <Form.Item name="note" label={kind === 'note' ? 'Notes' : 'Note'} rules={kind === 'note' ? [{ required: true, whitespace: true }] : []}>
      <Input.TextArea rows={kind === 'note' ? 4 : 2} placeholder={kind === 'note' ? 'What happened?' : 'Optional context'} /></Form.Item>
    <Button type="primary" htmlType="submit" loading={busy}>Save event</Button>
  </Form>;
}
