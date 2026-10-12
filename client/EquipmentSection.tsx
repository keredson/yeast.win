import { useEffect, useState } from 'react';
import { Alert, AutoComplete, Button, Card, Dropdown, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Table, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { nanoid } from 'nanoid';
import { boilOffKinds, capacityKinds, equipmentGroups, equipmentKindLabel, measurementRangeUnits } from '../shared/equipment.ts';
import type { CatalogEquipment } from '../shared/catalog.ts';
import { createEquipment, deleteEquipment, updateEquipmentIdentity, updateEquipmentRatedPower, updateEquipmentCapacity,
  updateEquipmentMeasurementRange,
  type Equipment, type EquipmentSpecifications, type LocalDb } from './db.ts';
import { capacityInLiters, capacityLabel, capacityUnits } from '../shared/capacity.ts';
import { fromDatetimeLocal, formatTime, toDatetimeLocal } from './time.ts';
import { changeNumberUnit } from './unitFields.ts';
import { equipmentPathSegment, equipmentSlug } from './equipmentRoutes.ts';
import { boilOffByPower, boilOffRate, estimatedBoilOffAtPower, type BoilObservation } from './boilOff.ts';

interface Calibration { id: string; method: string; effective_at: number; parameters_json: string }

const calibrationProfiles: Record<string, { method: string; fields: { key: string; label: string }[] }> = {
  electric_kettle: { method: 'Temperature °C', fields: [
    { key: 'reference_c', label: 'Reference temperature °C' }, { key: 'observed_c', label: 'Kettle reading °C' }
  ] },
  all_in_one: { method: 'Temperature °C', fields: [
    { key: 'reference_c', label: 'Reference temperature °C' }, { key: 'observed_c', label: 'System reading °C' }
  ] },
  controlled_fermenter: { method: 'Temperature °C', fields: [
    { key: 'reference_c', label: 'Reference temperature °C' }, { key: 'observed_c', label: 'Fermenter reading °C' }
  ] },
  ph_meter: { method: 'Two-point pH', fields: [
    { key: 'buffer_4_observed', label: 'pH 4.00 buffer reading' }, { key: 'buffer_7_observed', label: 'pH 7.00 buffer reading' }
  ] },
  hydrometer: { method: 'Hydrometer SG', fields: [
    { key: 'reference_sg', label: 'Reference specific gravity' }, { key: 'observed_sg', label: 'Hydrometer reading' }
  ] },
  refractometer: { method: 'Refractometer Brix', fields: [
    { key: 'reference_brix', label: 'Reference °Brix' }, { key: 'observed_brix', label: 'Refractometer reading °Brix' }
  ] },
  temperature_controller: { method: 'Temperature °C', fields: [
    { key: 'reference_c', label: 'Reference temperature °C' }, { key: 'observed_c', label: 'Controller reading °C' }
  ] },
  fermentation_temperature_control: { method: 'Temperature °C', fields: [
    { key: 'reference_c', label: 'Reference temperature °C' }, { key: 'observed_c', label: 'Controller reading °C' }
  ] },
  thermometer: { method: 'Temperature °C', fields: [
    { key: 'reference_c', label: 'Reference temperature °C' }, { key: 'observed_c', label: 'Thermometer reading °C' }
  ] },
  scale: { method: 'Scale g', fields: [
    { key: 'reference_g', label: 'Reference weight g' }, { key: 'observed_g', label: 'Scale reading g' }
  ] },
  pressure_gauge: { method: 'Pressure kPa', fields: [
    { key: 'reference_kpa', label: 'Reference pressure kPa' }, { key: 'observed_kpa', label: 'Gauge reading kPa' }
  ] },
  carbonation_meter: { method: 'Carbonation volumes', fields: [
    { key: 'reference_volumes', label: 'Reference CO₂ volumes' }, { key: 'observed_volumes', label: 'Meter reading CO₂ volumes' }
  ] },
  dissolved_oxygen_meter: { method: 'Dissolved oxygen mg/L', fields: [
    { key: 'reference_mg_l', label: 'Reference oxygen mg/L' }, { key: 'observed_mg_l', label: 'Meter reading mg/L' }
  ] }
};

const equipmentMenuItems = equipmentGroups.map(group => ({ key: group.key, label: group.label,
  children: group.kinds.map(kind => ({ key: kind, label: equipmentKindLabel(kind) })) }));

function addEquipmentTitle(kind: string): string {
  const label = equipmentKindLabel(kind);
  return `Add ${label[0].toLowerCase()}${label.slice(1)}`;
}

export function EquipmentSection({ db, basePath, accountId, equipment, catalog, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; equipment: Equipment[]; catalog: CatalogEquipment[]; selectedId: string | null; onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [creatingKind, setCreatingKind] = useState<string | null>(null);
  const [newCalibration, setNewCalibration] = useState(false);
  const [newBoilObservation, setNewBoilObservation] = useState(false);
  const [editIdentity, setEditIdentity] = useState(false);
  const [editCapacity, setEditCapacity] = useState(false);
  const [editPower, setEditPower] = useState(false);
  const [editRange, setEditRange] = useState(false);
  const [error, setError] = useState('');
  const [equipmentForm] = Form.useForm();
  const [capacityForm] = Form.useForm();
  const [powerForm] = Form.useForm();
  const [rangeForm] = Form.useForm();
  const item = equipment.find(row => row.id === selectedId) || null;
  const newCapacityUnit = Form.useWatch('capacity_unit', equipmentForm) as string | undefined;
  const newRangeUnit = Form.useWatch('measurement_unit', equipmentForm) as string | undefined;
  const editCapacityUnit = Form.useWatch('capacity_unit', capacityForm) as string | undefined;
  const editRangeUnit = Form.useWatch('measurement_unit', rangeForm) as string | undefined;
  const profile = item ? calibrationProfiles[item.kind] : undefined;
  const specs = item ? JSON.parse(item.specification_json || '{}') as EquipmentSpecifications : {};
  const [boilObservations, setBoilObservations] = useState<BoilObservation[]>([]);
  const boilRates = boilOffByPower(boilObservations);
  const ratedEstimate = specs.rated_power_watts == null ? null : estimatedBoilOffAtPower(boilObservations, specs.rated_power_watts);
  const groupedKinds: { key: string; label: string; kinds: string[] }[] = equipmentGroups.map(group => ({ key: group.key, label: group.label,
    kinds: group.kinds.filter(kind => equipment.some(row => row.kind === kind)) })).filter(group => group.kinds.length);
  const earlierKinds = [...new Set(equipment.map(row => row.kind))].filter(kind =>
    !equipmentGroups.some(group => (group.kinds as readonly string[]).includes(kind)));
  if (earlierKinds.length) groupedKinds.push({ key: 'earlier', label: 'Previously added equipment', kinds: earlierKinds });

  useEffect(() => {
    if (!selectedId) return;
    void db.execO<Calibration>('SELECT id, method, effective_at, parameters_json FROM equipment_calibrations WHERE equipment_id = ? ORDER BY effective_at DESC', [selectedId])
      .then(setCalibrations);
  }, [db, selectedId, equipment]);

  useEffect(() => {
    if (!selectedId) return;
    void db.execO<BoilObservation>(`SELECT id, observed_at, power_watts, ambient_c, liquid_c, start_liters, end_liters,
      duration_seconds FROM equipment_characterization_observations WHERE equipment_id = ? ORDER BY observed_at DESC`, [selectedId])
      .then(setBoilObservations);
  }, [db, selectedId, equipment]);

  function validRange(min: number | undefined, max: number | undefined, unit: string | undefined, kind: string) {
    if (min == null && max == null) return null;
    if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || min >= max
      || !unit || !measurementRangeUnits[kind]?.includes(unit)) throw new Error('Enter a valid measurement range and unit');
    return { min, max, unit };
  }

  async function create(values: { name: string; catalog_id?: string; capacity?: number; capacity_unit?: string;
    measurement_min?: number; measurement_max?: number; measurement_unit?: string; rated_power_watts?: number }) {
    if (!creatingKind) return;
    try {
      const overrides: EquipmentSpecifications = {};
      if (capacityKinds.has(creatingKind)) {
        const capacity = capacityInLiters(values.capacity, values.capacity_unit);
        if (capacity != null) overrides.capacity_liters = capacity;
      }
      if (measurementRangeUnits[creatingKind]) {
        const range = validRange(values.measurement_min, values.measurement_max, values.measurement_unit, creatingKind);
        if (range) Object.assign(overrides, { measurement_min: range.min, measurement_max: range.max, measurement_unit: range.unit });
      }
      if (boilOffKinds.has(creatingKind) && values.rated_power_watts != null) {
        if (!Number.isFinite(values.rated_power_watts) || values.rated_power_watts <= 0) throw new Error('Enter a positive power');
        overrides.rated_power_watts = values.rated_power_watts;
      }
      const id = await createEquipment(db, values.name.trim(), creatingKind, catalog.find(row => row.id === values.catalog_id), overrides);
      setCreatingKind(null); equipmentForm.resetFields(); onSelect(id); await onChanged();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveCapacity(values: { capacity?: number; capacity_unit?: string }) {
    if (!item) return;
    try { await updateEquipmentCapacity(db, item, capacityInLiters(values.capacity, values.capacity_unit)); setEditCapacity(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function savePower(values: { rated_power_watts?: number }) {
    if (!item) return;
    try {
      await updateEquipmentRatedPower(db, item, values.rated_power_watts ?? null);
      setEditPower(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveIdentity(values: { name: string; slug: string }) {
    if (!item) return;
    try {
      await updateEquipmentIdentity(db, item, values.name, values.slug, equipment);
      setEditIdentity(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function recordBoilObservation(values: { observed_at: string; power_watts: number; start_liters: number;
    end_liters: number; duration_minutes: number; ambient_c?: number; liquid_c?: number }) {
    if (!item) return;
    try {
      if (!Number.isFinite(values.power_watts) || values.power_watts <= 0 || !Number.isFinite(values.duration_minutes)
        || values.duration_minutes <= 0 || !Number.isFinite(values.start_liters) || !Number.isFinite(values.end_liters)
        || values.start_liters <= values.end_liters || values.end_liters < 0) {
        throw new Error('Enter positive power and duration, with an end volume below the start volume');
      }
      await db.exec(`INSERT INTO equipment_characterization_observations
        (id, equipment_id, observed_at, power_watts, ambient_c, liquid_c, start_liters, end_liters, duration_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [nanoid(), item.id, fromDatetimeLocal(values.observed_at), values.power_watts,
        values.ambient_c ?? null, values.liquid_c ?? null, values.start_liters, values.end_liters,
        Math.round(values.duration_minutes * 60)]);
      setNewBoilObservation(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveRange(values: { measurement_min?: number; measurement_max?: number; measurement_unit?: string }) {
    if (!item) return;
    try {
      const range = validRange(values.measurement_min, values.measurement_max, values.measurement_unit, item.kind);
      await updateEquipmentMeasurementRange(db, item, range);
      setEditRange(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function remove() {
    if (!item) return;
    try {
      await deleteEquipment(db, item.id);
      onSelect(null);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function calibrate(values: { effective_at: string; parameters: Record<string, number> }) {
    if (!item || !profile) return;
    try {
      const parameters = Object.fromEntries(profile.fields.map(field => [field.key, values.parameters[field.key]]));
      await db.exec(`INSERT INTO equipment_calibrations(id, equipment_id, effective_at, method, parameters_json, created_by_account_id)
        VALUES (?, ?, ?, ?, ?, ?)`, [nanoid(), item.id, fromDatetimeLocal(values.effective_at), profile.method, JSON.stringify(parameters), accountId]);
      setNewCalibration(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  const addMenu = { items: equipmentMenuItems, triggerSubMenuAction: 'click' as const,
    onClick: ({ key }: { key: string }) => setCreatingKind(key) };

  return <div className="section-page">
    {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index equipment-index"><div className="section-heading"><div><span className="eyebrow">Your gear</span><h1>Equipment</h1></div></div>
      <p className="muted">Measurements, control settings, and transfers can reference your equipment.</p>
      <Dropdown trigger={['click']} menu={addMenu} placement="bottomLeft">
        <Button icon={<PlusOutlined />}>Add equipment</Button>
      </Dropdown>
      {equipment.length > 0 && <div className="group-tables">{groupedKinds.map(group => <section key={group.key} className="equipment-category">
        <h2>{group.label}</h2>{group.kinds.map(kind => {
        const rows = equipment.filter(row => row.kind === kind);
        return rows.length ? <section key={kind} className="group-table"><h3>{equipmentKindLabel(kind)}</h3>
          <Table<Equipment> dataSource={rows} rowKey="id" pagination={false} size="small"
            columns={[{ title: 'Equipment', dataIndex: 'name', render: (_, row) =>
              <a href={`${basePath}/equipment/${equipmentPathSegment(row, equipment)}`}
                onClick={event => { event.preventDefault(); onSelect(row.id); }}>{row.name}</a> },
              ...(capacityKinds.has(kind) ? [{ title: 'Capacity', key: 'capacity', width: 140, responsive: ['sm' as const], render: (_: unknown, row: Equipment) =>
                capacityLabel((JSON.parse(row.specification_json || '{}') as EquipmentSpecifications).capacity_liters) }] : []),
              ...(measurementRangeUnits[kind] ? [{ title: 'Measurement range', key: 'range', width: 180, responsive: ['sm' as const], render: (_: unknown, row: Equipment) => {
                const spec = JSON.parse(row.specification_json || '{}') as EquipmentSpecifications;
                return spec.measurement_min != null && spec.measurement_max != null
                  ? `${spec.measurement_min}–${spec.measurement_max} ${spec.measurement_unit || ''}` : '';
              } }] : [])]} />
        </section> : null;
      })}</section>)}</div>}
    </section> : !item ? <Empty description="Equipment not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">{equipmentKindLabel(item.kind)}</span>
          <div className="equipment-title"><h2>{item.name}</h2>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit equipment name and slug" onClick={() => setEditIdentity(true)} /></div>
          <div className="muted">Slug: {equipmentPathSegment(item, equipment)}</div></div></div>
        <div className="equipment-parameters">
          {capacityKinds.has(item.kind) && <div className="equipment-parameter"><span>Capacity: {capacityLabel(specs.capacity_liters) || 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit capacity" onClick={() => setEditCapacity(true)} /></div>}
          {boilOffKinds.has(item.kind) && <div className="equipment-parameter"><span>Rated power: {specs.rated_power_watts != null
            ? `${specs.rated_power_watts} W` : 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit rated power" onClick={() => setEditPower(true)} /></div>}
          {measurementRangeUnits[item.kind] && <div className="equipment-parameter"><span>Measurement range: {specs.measurement_min != null && specs.measurement_max != null
            ? `${specs.measurement_min}–${specs.measurement_max} ${specs.measurement_unit}` : 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit measurement range" onClick={() => setEditRange(true)} /></div>}
        </div>
        {(profile || boilOffKinds.has(item.kind)) && <div className="equipment-calibration"><div className="equipment-calibration-heading"><h3>Calibration</h3>
          <div className="heading-actions">{boilOffKinds.has(item.kind) && <Button icon={<PlusOutlined />} onClick={() => setNewBoilObservation(true)}>Record boil observation</Button>}
          {profile && <Button icon={<PlusOutlined />} onClick={() => setNewCalibration(true)}>Record calibration</Button>}</div></div>
        {boilOffKinds.has(item.kind) && <>
          {ratedEstimate != null && <p>Estimated boil-off at rated power: {Number(ratedEstimate.toFixed(2))} L/h</p>}
          {boilRates.length > 0 ? <div className="card-stack">{boilRates.map(point =>
            <Card key={point.watts} size="small"><strong>{point.watts} W</strong> · {Number(point.litersPerHour.toFixed(2))} L/h observed</Card>)}</div>
            : <p className="muted">Record a boil to measure evaporation at its power setting.</p>}
          {specs.boil_off_liters_per_hour != null && <p className="muted">Previous estimate without power: {specs.boil_off_liters_per_hour} L/h</p>}
          {boilObservations.length > 0 && <div className="card-stack">{boilObservations.map(row => <Card key={row.id} size="small">
            {formatTime(row.observed_at)} · {row.power_watts} W · {Number(boilOffRate(row).toFixed(2))} L/h
            <div className="muted">{row.start_liters} → {row.end_liters} L over {Number((row.duration_seconds / 60).toFixed(1))} min</div>
          </Card>)}</div>}
        </>}
        {calibrations.length > 0 &&
        <div className="card-stack">{calibrations.map(row => <Card key={row.id} size="small">
          <div className="timeline-card"><div><strong>{row.method}</strong><div className="muted">{formatTime(row.effective_at)}</div></div><Tag>Immutable</Tag></div>
          <pre className="calibration-data">{row.parameters_json}</pre>
        </Card>)}</div>}</div>}
        <div className="equipment-delete"><Popconfirm title={`Delete ${item.name}?`}
          description="Used equipment stays in batch history. Unused equipment and calibrations are removed."
          okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => void remove()}>
          <Button danger icon={<DeleteOutlined />}>Delete equipment</Button>
        </Popconfirm></div>
      </section>}
    <Modal title={creatingKind ? addEquipmentTitle(creatingKind) : 'Add equipment'} open={!!creatingKind}
      onCancel={() => setCreatingKind(null)} footer={null} destroyOnHidden>
      {creatingKind && <Form key={creatingKind} form={equipmentForm} layout="vertical" onFinish={create} preserve={false}
        initialValues={{ capacity_unit: 'L', measurement_unit: measurementRangeUnits[creatingKind]?.[0] }}>
        <Form.Item name="catalog_id" hidden><Input /></Form.Item>
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
          <AutoComplete placeholder="Search shared catalog or enter a name" maxLength={120}
            options={catalog.filter(row => row.kind === creatingKind).map(row => ({ value: row.name }))}
            filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
            onSelect={value => { const entry = catalog.find(row => row.kind === creatingKind && row.name === value);
              if (entry) { const specs = JSON.parse(entry.specification_json || '{}') as EquipmentSpecifications;
                equipmentForm.setFieldsValue({ catalog_id: entry.id, capacity: specs.capacity_liters, capacity_unit: 'L',
                  rated_power_watts: specs.rated_power_watts,
                  measurement_min: specs.measurement_min, measurement_max: specs.measurement_max,
                  measurement_unit: specs.measurement_unit || measurementRangeUnits[entry.kind]?.[0] }); } }} />
        </Form.Item>
        {capacityKinds.has(creatingKind) && <div className="capacity-fields"><Form.Item name="capacity" label="Capacity (optional)"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="capacity_unit" label="Unit"><Select options={[...capacityUnits]}
            onChange={unit => changeNumberUnit(equipmentForm, ['capacity'], newCapacityUnit || 'L', unit)} /></Form.Item></div>}
        {boilOffKinds.has(creatingKind) && <Form.Item name="rated_power_watts" label="Rated power (W, optional)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        {measurementRangeUnits[creatingKind] && <div className="form-triple">
          <Form.Item name="measurement_min" label="Range minimum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_max" label="Range maximum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_unit" label="Unit">
            <Select options={measurementRangeUnits[creatingKind].map(value => ({ value, label: value }))}
              onChange={unit => changeNumberUnit(equipmentForm, ['measurement_min', 'measurement_max'],
                newRangeUnit || measurementRangeUnits[creatingKind][0], unit)} /></Form.Item>
        </div>}
        <Button type="primary" htmlType="submit">Create equipment</Button>
      </Form>}
    </Modal>
    <Modal title="Edit capacity" open={editCapacity} onCancel={() => setEditCapacity(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={capacityForm} layout="vertical" onFinish={saveCapacity} initialValues={{ capacity: specs.capacity_liters, capacity_unit: 'L' }}>
        <div className="capacity-fields"><Form.Item name="capacity" label="Capacity"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="capacity_unit" label="Unit"><Select options={[...capacityUnits]}
            onChange={unit => changeNumberUnit(capacityForm, ['capacity'], editCapacityUnit || 'L', unit)} /></Form.Item></div>
        <Button type="primary" htmlType="submit">Save capacity</Button>
      </Form>
    </Modal>
    <Modal title="Edit rated power" open={editPower} onCancel={() => setEditPower(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={powerForm} layout="vertical" onFinish={savePower}
        initialValues={{ rated_power_watts: specs.rated_power_watts }}>
        <Form.Item name="rated_power_watts" label="Rated power (W)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Save rated power</Button>
      </Form>
    </Modal>
    <Modal title="Edit equipment name and slug" open={editIdentity} onCancel={() => setEditIdentity(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={saveIdentity} initialValues={{ name: item?.name, slug: item ? equipmentSlug(item) : '' }}>
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}><Input maxLength={120} /></Form.Item>
        <Form.Item name="slug" label="Slug" rules={[{ required: true }, { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: 'Use lowercase letters, numbers, and hyphens' }]}>
          <Input maxLength={80} /></Form.Item>
        <Button type="primary" htmlType="submit">Save name and slug</Button>
      </Form>
    </Modal>
    <Modal title="Edit measurement range" open={editRange} onCancel={() => setEditRange(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={rangeForm} layout="vertical" onFinish={saveRange} initialValues={{ measurement_min: specs.measurement_min, measurement_max: specs.measurement_max,
        measurement_unit: specs.measurement_unit || (item && measurementRangeUnits[item.kind]?.[0]) }}>
        <div className="form-triple"><Form.Item name="measurement_min" label="Range minimum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_max" label="Range maximum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_unit" label="Unit"><Select options={(item && measurementRangeUnits[item.kind] || []).map(value => ({ value, label: value }))}
            onChange={unit => changeNumberUnit(rangeForm, ['measurement_min', 'measurement_max'], editRangeUnit, unit)} /></Form.Item></div>
        <Button type="primary" htmlType="submit">Save range</Button>
      </Form>
    </Modal>
    <Modal title={profile ? `Calibrate ${equipmentKindLabel(item?.kind || '')}` : 'Record calibration'} open={newCalibration} onCancel={() => setNewCalibration(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={calibrate} initialValues={{ effective_at: toDatetimeLocal() }}>
        <Form.Item name="effective_at" label="When" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
        {profile?.fields.map(field => <Form.Item key={field.key} name={['parameters', field.key]} label={field.label} rules={[{ required: true }]}>
          <InputNumber className="full-width" step="any" /></Form.Item>)}
        <Button type="primary" htmlType="submit">Save calibration</Button>
      </Form>
    </Modal>
    <Modal title="Record boil observation" open={newBoilObservation} onCancel={() => setNewBoilObservation(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={recordBoilObservation}
        initialValues={{ observed_at: toDatetimeLocal(), power_watts: specs.rated_power_watts }}>
        <Form.Item name="observed_at" label="When" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
        <Form.Item name="power_watts" label="Power used (W)" rules={[{ required: true }]}><InputNumber className="full-width" min={1} /></Form.Item>
        <div className="form-pair"><Form.Item name="start_liters" label="Start volume (L)" rules={[{ required: true }]}><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="end_liters" label="End volume (L)" rules={[{ required: true }]}><InputNumber className="full-width" min={0} step="any" /></Form.Item></div>
        <Form.Item name="duration_minutes" label="Boil duration (minutes)" rules={[{ required: true }]}><InputNumber className="full-width" min={0.01} step="any" /></Form.Item>
        <div className="form-pair"><Form.Item name="ambient_c" label="Ambient temperature (°C, optional)"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="liquid_c" label="Liquid temperature (°C, optional)"><InputNumber className="full-width" step="any" /></Form.Item></div>
        <Button type="primary" htmlType="submit">Save boil observation</Button>
      </Form>
    </Modal>
  </div>;
}
