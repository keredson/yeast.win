import { useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Select } from 'antd';
import { kindLabel, measurementKinds, planKinds } from './constants.ts';
import { fromDatetimeLocal, toDatetimeLocal } from './time.ts';
import { addPhoto, recordEvent, skipBatchEvent, updateEvent, updatePhotoEvent, type ActualEvent, type Equipment, type EventInput, type InventoryRecord, type LocalDb, type MeasurementKind, type Plan, type PlanDetails } from './db.ts';
import type { PreferredUnits } from './api.ts';
import { compoundMassUnit, gravityScales, quantityForStorage, quantityUnitsForCategory, splitOunces, unitGroups, unitOptions } from '../shared/units.ts';
import { supportsDuration, timeUnits } from './planTiming.ts';
import { inventoryCategories, unitForCategory } from '../shared/catalog.ts';
import { findCatalogSupply } from './catalog.ts';
import { ProductPicker } from './ProductPicker.tsx';
import { QuantityFields } from './QuantityFields.tsx';
import { changeNumberUnit, changeQuantityUnit } from './unitFields.ts';
import { vesselKinds } from '../shared/equipment.ts';

function measurementUnits(kind: MeasurementKind): readonly string[] {
  if (kind === 'ph') return ['pH'];
  if (kind === 'gravity') return gravityScales;
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
  event_type: string; measurement_kind?: MeasurementKind; actual_at: string;
  gravity_role?: 'og' | 'fg' | '';
  duration_value?: number; duration_unit?: typeof timeUnits[number]['value'];
  note?: string; value?: number; unit?: string; uncertainty?: number; equipment_id?: string;
  source?: string; item_name?: string; stock_bucket_id?: string; catalog_item_id?: string;
  item_category?: string; quantity?: number; pounds?: number; ounces?: number;
  mode?: string; target_value?: number; target_unit?: string; power_watts?: number;
  to_vessel_id?: string; container_name?: string; container_size?: number;
  container_unit?: string; container_count?: number;
}

export function EventForm({ db, batchId, accountId, equipment, inventory, catalogRevision, preferredUnits, initialPlan, initialEvent, initialData, onSaved }: {
  db: LocalDb; batchId: string; accountId: string; equipment: Equipment[];
  inventory: InventoryRecord[]; catalogRevision: number; preferredUnits: PreferredUnits; initialPlan?: Plan | null;
  initialEvent?: ActualEvent | null; initialData?: { measurementKind?: MeasurementKind; payload: Record<string, string | number | null> } | null;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm<Values>();
  const planned = initialPlan?.details || {};
  const plannedString = (key: keyof PlanDetails) => typeof planned[key] === 'string' ? planned[key] as string : undefined;
  const plannedNumber = (key: keyof PlanDetails) => typeof planned[key] === 'number' ? planned[key] as number : undefined;
  const completingPlan = !!initialPlan && !initialEvent;
  const initialMeasurement = measurementKinds.find(item => item.value === plannedString('measurement_kind'))?.value as MeasurementKind | undefined;
  const [kind, setKind] = useState(initialEvent?.event_type || initialPlan?.event_type || 'note');
  const chillToTarget = kind === 'temperature_control' && plannedString('phase') === 'chill';
  const timedControl = supportsDuration(kind, plannedString('phase'));
  const recordedDuration = initialEvent?.actual_at != null && initialEvent.ended_at != null
    ? initialEvent.ended_at - initialEvent.actual_at : null;
  const initialDuration = recordedDuration != null && recordedDuration > 0
    ? recordedDuration : plannedNumber('duration_seconds');
  const initialDurationUnit = initialDuration && initialDuration > 0
    ? [...timeUnits].reverse().find(unit => initialDuration % unit.multiplier === 0) || timeUnits[0]
    : timeUnits[1];
  const [measurement, setMeasurement] = useState<MeasurementKind>(initialData?.measurementKind || initialMeasurement || 'temperature');
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
    || inventory.find(item => item.id === (initialData?.payload.stock_bucket_id || plannedString('stock_bucket_id')))?.category || 'Other';
  const selectedCategory = Form.useWatch('item_category', form) as string | undefined;
  const selectedUnit = Form.useWatch('unit', form) as string | undefined;
  const selectedTargetUnit = Form.useWatch('target_unit', form) as string | undefined;
  const selectedContainerUnit = Form.useWatch('container_unit', form) as string | undefined;
  const selectedDurationUnit = Form.useWatch('duration_unit', form) as string | undefined;
  const selectedInventoryId = Form.useWatch('stock_bucket_id', form) as string | undefined;
  const selectedCatalogId = Form.useWatch('catalog_item_id', form) as string | undefined;
  const selectedStock = inventory.find(item => item.id === selectedInventoryId);
  const genericPitch = initialPlan?.title === 'Pitch yeast' && kind === 'addition';
  const quantityOptional = kind === 'addition' && (selectedCategory || initialCategory) === 'Yeast' && !selectedInventoryId;
  const vesselOptions = equipment.filter(item => vesselKinds.has(item.kind)).map(item => ({ value: item.id, label: item.name }));
  const destinationId = initialData?.payload.to_vessel_id || plannedString('to_vessel_id');
  if (typeof destinationId === 'string' && !vesselOptions.some(item => item.value === destinationId)) {
    vesselOptions.push({ value: destinationId, label: plannedString('to_vessel_name') || 'Archived vessel' });
  }

  function changeMainUnit(next: string) {
    const from = selectedUnit || initialUnit;
    if (kind === 'addition') changeQuantityUnit(form, from, next);
    else if (kind === 'measurement') changeNumberUnit(form, ['value', 'uncertainty'], from, next, ['uncertainty']);
    else changeNumberUnit(form, ['quantity'], from, next);
  }

  function changeDurationUnit(next: typeof timeUnits[number]['value']) {
    const previous = timeUnits.find(unit => unit.value === (selectedDurationUnit || initialDurationUnit.value));
    const nextUnit = timeUnits.find(unit => unit.value === next);
    const value = form.getFieldValue('duration_value') as number | undefined;
    if (previous && nextUnit && value != null) form.setFieldValue('duration_value', value * previous.multiplier / nextUnit.multiplier);
  }

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
      const startedAt = fromDatetimeLocal(values.actual_at);
      const durationUnit = timeUnits.find(unit => unit.value === values.duration_unit);
      const durationSeconds = timedControl && values.duration_value != null
        ? Math.round(values.duration_value * (durationUnit?.multiplier || 0)) : null;
      if (timedControl && values.duration_value != null && (!durationUnit || durationSeconds == null || durationSeconds <= 0))
        throw new Error('Choose a positive length');
      const endedAt = durationSeconds == null ? null : startedAt + durationSeconds;
      const input: EventInput = {
        batchId, accountId, eventType: initialPlan?.event_type || values.event_type,
        actualAt: startedAt,
        endedAt,
        eventId: initialPlan?.id || null, note: values.note || '',
      };
      if (kind === 'measurement') {
        if (values.value == null) throw new Error('Enter the measured value');
        input.measurementKind = values.measurement_kind || measurement;
        input.gravityRole = input.measurementKind === 'gravity' ? values.gravity_role || null : null;
        payload = { value: values.value, unit: values.unit || '', uncertainty: values.uncertainty ?? null,
          equipment_id: values.equipment_id || null,
          source: values.source || 'manual' };
      } else if (kind === 'addition') {
        const itemName = values.item_name?.trim() || (genericPitch ? initialPlan?.title : undefined);
        const itemId = values.stock_bucket_id;
        const stock = inventory.find(item => item.id === itemId);
        const category = values.item_category || initialCategory;
        const unchanged = itemName === (plannedString('item_name') || initialPlan?.title)
          && category === initialCategory;
        const keepPlannedSupply = unchanged && (!values.catalog_item_id
          || values.catalog_item_id === plannedString('catalog_item_id'));
        const catalogId = stock ? null : values.catalog_item_id || (unchanged ? plannedString('catalog_item_id') : null)
          || (itemName ? (await findCatalogSupply(category, itemName))?.id : null);
        const amount = quantityForStorage(values.unit || '', values.quantity, values.pounds, values.ounces);
        if (!itemName) throw new Error('Enter an item');
        if (!amount && !quantityOptional) throw new Error('Enter a quantity');
        payload = { item_name: itemName, item_category: category,
          stock_bucket_id: itemId || null,
          catalog_item_id: catalogId || null,
          supply_id: stock ? stock.supply_id || null : (keepPlannedSupply ? plannedString('supply_id') : null) || null,
          quantity: amount?.quantity ?? null, unit: amount?.unit || null };
      } else if (kind === 'temperature_control') {
        if (chillToTarget && values.target_value == null) throw new Error('Enter a target temperature');
        if (values.target_value == null && values.power_watts == null) throw new Error('Enter a target or power');
        payload = { equipment_id: values.equipment_id || null, mode: values.mode || 'hold',
          target_value: values.target_value ?? null, target_unit: values.target_unit || null,
          power_watts: values.power_watts ?? null, ended_at: endedAt };
      } else if (kind === 'pressure_control') {
        if (!values.equipment_id || values.target_value == null || !values.target_unit) throw new Error('Choose equipment and a pressure target');
        payload = { equipment_id: values.equipment_id, target_value: values.target_value, target_unit: values.target_unit };
      } else if (kind === 'transfer') {
        payload = { to_vessel_id: values.to_vessel_id || null, quantity: values.quantity ?? null, unit: values.unit || null };
      } else if (kind === 'packaging') {
        if (!values.container_name || values.container_size == null || !values.container_unit || values.container_count == null) {
          throw new Error('Enter container, size, unit, and count');
        }
        const stock = inventory.find(item => item.id === values.stock_bucket_id);
        const unchanged = values.container_name === plannedString('container_name');
        const catalogId = stock ? null : values.catalog_item_id || (unchanged ? plannedString('catalog_item_id') : null)
          || (await findCatalogSupply('Packaging', values.container_name))?.id || null;
        payload = { container_name: values.container_name, container_size: values.container_size,
          container_unit: values.container_unit, container_count: values.container_count,
          stock_bucket_id: values.stock_bucket_id || null, catalog_item_id: catalogId,
          supply_id: stock ? stock.supply_id || null : unchanged && (!values.catalog_item_id
            || values.catalog_item_id === plannedString('catalog_item_id')) ? plannedString('supply_id') || null : null };
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
    duration_value: initialDuration && initialDuration > 0 ? initialDuration / initialDurationUnit.multiplier : undefined,
    duration_unit: initialDurationUnit.value,
    note: initialEvent?.note || undefined,
    measurement_kind: initialData?.measurementKind || plannedString('measurement_kind') || measurement,
    gravity_role: plannedString('gravity_role') || '',
    mode: initialData?.payload.mode || plannedString('mode') || 'hold', source: initialData?.payload.source || 'manual',
    item_name: plannedString('item_name') || (genericPitch ? undefined : initialPlan?.title), item_category: initialCategory,
    stock_bucket_id: plannedString('stock_bucket_id'),
    catalog_item_id: plannedString('catalog_item_id'),
    equipment_id: plannedString('equipment_id'),
    to_vessel_id: plannedString('to_vessel_id'),
    container_name: plannedString('container_name'), container_size: plannedNumber('container_size'),
    container_count: plannedNumber('container_count'),
    target_value: kind === 'measurement' ? undefined : plannedNumber('target_value'),
    target_unit: plannedString('target_unit') || (kind === 'temperature_control' ? preferredUnits.temperature : kind === 'pressure_control' ? preferredUnits.pressure : undefined),
    container_unit: plannedString('container_unit') || preferredUnits.volume,
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
      <Form.Item name="actual_at" label={chillToTarget ? 'Reached target' : timedControl ? 'Started' : 'When'} rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
    </div>
    {timedControl && <div className="form-pair">
      <Form.Item name="duration_value" label="Length"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
      <Form.Item name="duration_unit" label="Unit"><Select options={timeUnits.map(({ value, label }) => ({ value, label }))}
        onChange={changeDurationUnit} /></Form.Item>
    </div>}
    {kind === 'measurement' && <>
      <Form.Item name="measurement_kind" label="Measurement" rules={[{ required: true }]}>
        <Select disabled={!!initialEvent} options={measurementKinds.map(item => ({ value: item.value, label: item.label }))}
          onChange={(value: MeasurementKind) => {
            setMeasurement(value);
            form.setFieldsValue({ unit: measurementUnit(value, preferredUnits), value: undefined,
              uncertainty: undefined, gravity_role: '' });
          }} />
      </Form.Item>
      {measurement === 'gravity' && <Form.Item name="gravity_role" label="Gravity role"><Select options={[
        { value: '', label: 'Other reading' }, { value: 'og', label: 'Original gravity (OG)' },
        { value: 'fg', label: 'Final gravity (FG)' }
      ]} /></Form.Item>}
      <div className="form-pair">
        <Form.Item name="value" label="Corrected value" rules={[{ required: true }]}><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="unit" label={measurement === 'gravity' ? 'Scale' : 'Unit'} rules={[{ required: true }]}><Select options={unitOptions(measurementUnits(measurement))}
          onChange={changeMainUnit} /></Form.Item>
      </div>
      <div className="form-pair">
        <Form.Item name="uncertainty" label="Uncertainty (±)"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="source" label="Method/source"><Input placeholder="e.g. refractometer" /></Form.Item>
      </div>
      <Form.Item name="equipment_id" label="Instrument"><Select allowClear placeholder="Choose equipment"
        options={equipment.map(item => ({ value: item.id, label: item.name }))} /></Form.Item>
    </>}
    <Form.Item name="stock_bucket_id" hidden><Input /></Form.Item>
    <Form.Item name="catalog_item_id" hidden><Input /></Form.Item>
    {kind === 'addition' && <>
      <>
        <Form.Item name="item_category" label="Type"><Select options={[...new Set([...inventoryCategories,
          ...inventory.map(row => row.category), ...(initialCategory ? [initialCategory] : [])])].map(value => ({ value, label: value }))}
          onChange={value => { form.setFieldsValue({ stock_bucket_id: undefined, catalog_item_id: undefined,
            item_name: undefined, unit: unitForCategory(value, preferredUnits.mass),
            quantity: undefined, pounds: undefined, ounces: undefined }); }} /></Form.Item>
        <Form.Item name="item_name" label="What was added?" rules={genericPitch ? [] : [{ required: true }]}
          extra={selectedStock ? ['From inventory', selectedStock.lot_code && `Lot ${selectedStock.lot_code}`,
            selectedStock.location_name].filter(Boolean).join(' · ')
            : selectedCatalogId ? 'Catalog product' : undefined}>
          <ProductPicker category={selectedCategory || initialCategory} inventory={inventory}
            catalogRevision={catalogRevision} onError={setError}
            onEdited={() => form.setFieldsValue({ stock_bucket_id: undefined, catalog_item_id: undefined })}
            onChoose={choice => {
              if (choice.source === 'inventory') {
                changeQuantityUnit(form, selectedUnit || initialUnit, choice.item.display_unit);
                form.setFieldsValue({ item_name: choice.item.name, stock_bucket_id: choice.item.id,
                  catalog_item_id: undefined, unit: choice.item.display_unit });
              } else {
                const nextUnit = unitGroups.mass.includes(choice.item.unit as typeof unitGroups.mass[number])
                  ? unitForCategory(choice.item.category, preferredUnits.mass) : choice.item.unit;
                changeQuantityUnit(form, selectedUnit || initialUnit, nextUnit);
                form.setFieldsValue({ item_name: choice.item.name, catalog_item_id: choice.item.id,
                  stock_bucket_id: undefined, unit: nextUnit });
              }
            }} />
        </Form.Item>
      </>
      <Form.Item name="unit" label="Unit" rules={[{ required: true }]}>
        <Select showSearch options={unitOptions(quantityUnitsForCategory(selectedCategory || initialCategory))}
          onChange={changeMainUnit} /></Form.Item>
      <QuantityFields unit={selectedUnit || initialUnit} optional={quantityOptional} />
    </>}
    {(kind === 'temperature_control' || kind === 'pressure_control') && <>
      <Form.Item name="equipment_id" label="Equipment"
        rules={kind === 'pressure_control' ? [{ required: true }] : []}><Select allowClear
        options={equipment.map(item => ({ value: item.id, label: item.name }))} placeholder="Choose equipment" /></Form.Item>
      {kind === 'temperature_control' && <Form.Item name="mode" label="Mode"><Select options={[
        { value: 'heat', label: 'Heat' }, { value: 'chill', label: 'Chill' }, { value: 'hold', label: 'Hold' }
      ]} /></Form.Item>}
      <div className="form-pair"><Form.Item name="target_value" label="Target" rules={kind === 'pressure_control' || chillToTarget ? [{ required: true }] : []}>
        <InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="target_unit" label="Unit" rules={kind === 'pressure_control' || chillToTarget ? [{ required: true }] : []}>
          <Select options={unitOptions(kind === 'pressure_control' ? unitGroups.pressure : unitGroups.temperature)}
            onChange={unit => changeNumberUnit(form, ['target_value'], selectedTargetUnit, unit)} /></Form.Item></div>
      {kind === 'temperature_control' && <Form.Item name="power_watts" label="Power (W), if set"><InputNumber className="full-width" min={0} /></Form.Item>}
    </>}
    {kind === 'transfer' && <>
      <Form.Item name="to_vessel_id" label="To vessel"><Select allowClear showSearch optionFilterProp="label" options={vesselOptions} /></Form.Item>
      <div className="form-pair"><Form.Item name="quantity" label="Quantity"><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit"><Select options={unitOptions(unitGroups.volume)} onChange={changeMainUnit} /></Form.Item></div>
    </>}
    {kind === 'packaging' && <>
      <Form.Item name="container_name" label="Container" rules={[{ required: true }]}
        extra={selectedStock ? ['From inventory', selectedStock.lot_code && `Lot ${selectedStock.lot_code}`,
          selectedStock.location_name].filter(Boolean).join(' · ')
          : selectedCatalogId ? 'Catalog product' : undefined}>
        <ProductPicker category="Packaging" inventory={inventory} catalogRevision={catalogRevision} onError={setError}
          onEdited={() => form.setFieldsValue({ stock_bucket_id: undefined, catalog_item_id: undefined })}
          onChoose={choice => form.setFieldsValue({ container_name: choice.item.name,
            stock_bucket_id: choice.source === 'inventory' ? choice.item.id : undefined,
            catalog_item_id: choice.source === 'catalog' ? choice.item.id : undefined })} />
      </Form.Item>
      <div className="form-triple"><Form.Item name="container_size" label="Size" rules={[{ required: true }]}><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="container_unit" label="Unit" rules={[{ required: true }]}><Select options={unitOptions(unitGroups.volume)}
          onChange={unit => changeNumberUnit(form, ['container_size'], selectedContainerUnit, unit)} /></Form.Item>
        <Form.Item name="container_count" label="Count" rules={[{ required: true }]}><InputNumber className="full-width" min={1} precision={0} /></Form.Item></div>
    </>}
    {kind === 'photo' && <Form.Item label={initialEvent ? 'Replace photo' : 'Photo'} required={!initialEvent}>
      <Input type="file" accept="image/*" onChange={event => setPhoto(event.target.files?.[0] || null)} />
    </Form.Item>}
    <Form.Item name="note" label={kind === 'note' ? 'Notes' : 'Note'} rules={kind === 'note' ? [{ required: true, whitespace: true }] : []}>
      <Input.TextArea rows={kind === 'note' ? 4 : 2} placeholder={kind === 'note' ? 'What happened?' : 'Optional context'} /></Form.Item>
    <div className="event-form-actions"><Button type="primary" htmlType="submit" loading={busy}>
      {completingPlan ? 'Mark done' : 'Save'}</Button>
      {initialPlan && !initialEvent && <Button onClick={() => void skipPlan()} disabled={busy}>Skip this event</Button>}</div>
  </Form>;
}
