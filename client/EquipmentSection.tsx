import { useEffect, useState } from 'react';
import { Alert, AutoComplete, Button, Card, Dropdown, Empty, Form, Input, InputNumber, Modal, Select, Table, Tag } from 'antd';
import { DeleteOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { nanoid } from 'nanoid';
import { capacityKinds, equipmentKindLabel, equipmentKinds, measurementRangeUnits } from '../shared/equipment.ts';
import type { CatalogEquipment } from '../shared/catalog.ts';
import { createEquipment, deleteEquipment, updateEquipmentCapacity, updateEquipmentMeasurementRange,
  type Equipment, type EquipmentSpecifications, type LocalDb } from './db.ts';
import { capacityInLiters, capacityLabel, capacityUnits } from '../shared/capacity.ts';
import { fromDatetimeLocal, formatTime, toDatetimeLocal } from './time.ts';
import { changeNumberUnit } from './unitFields.ts';

interface Calibration { id: string; method: string; effective_at: number; parameters_json: string }

const calibrationProfiles: Record<string, { method: string; fields: { key: string; label: string }[] }> = {
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

export function EquipmentSection({ db, basePath, accountId, equipment, catalog, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; equipment: Equipment[]; catalog: CatalogEquipment[]; selectedId: string | null; onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [newEquipment, setNewEquipment] = useState(false);
  const [newCalibration, setNewCalibration] = useState(false);
  const [editCapacity, setEditCapacity] = useState(false);
  const [editRange, setEditRange] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState('');
  const [equipmentForm] = Form.useForm();
  const [capacityForm] = Form.useForm();
  const [rangeForm] = Form.useForm();
  const item = equipment.find(row => row.id === selectedId) || null;
  const selectedKind = Form.useWatch('kind', equipmentForm) as string | undefined;
  const newCapacityUnit = Form.useWatch('capacity_unit', equipmentForm) as string | undefined;
  const newRangeUnit = Form.useWatch('measurement_unit', equipmentForm) as string | undefined;
  const editCapacityUnit = Form.useWatch('capacity_unit', capacityForm) as string | undefined;
  const editRangeUnit = Form.useWatch('measurement_unit', rangeForm) as string | undefined;
  const profile = item ? calibrationProfiles[item.kind] : undefined;
  const specs = item ? JSON.parse(item.specification_json || '{}') as EquipmentSpecifications : {};
  const kinds = [...equipmentKinds.map(row => row.value), ...equipment.map(row => row.kind).filter(kind =>
    !equipmentKinds.some(known => known.value === kind))].filter((kind, index, all) => all.indexOf(kind) === index);

  useEffect(() => {
    if (!selectedId) return;
    void db.execO<Calibration>('SELECT id, method, effective_at, parameters_json FROM equipment_calibrations WHERE equipment_id = ? ORDER BY effective_at DESC', [selectedId])
      .then(setCalibrations);
  }, [db, selectedId, equipment]);

  function validRange(min: number | undefined, max: number | undefined, unit: string | undefined, kind: string) {
    if (min == null && max == null) return null;
    if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || min >= max
      || !unit || !measurementRangeUnits[kind]?.includes(unit)) throw new Error('Enter a valid measurement range and unit');
    return { min, max, unit };
  }

  async function create(values: { name: string; kind: string; catalog_id?: string; capacity?: number; capacity_unit?: string;
    measurement_min?: number; measurement_max?: number; measurement_unit?: string }) {
    try {
      const overrides: EquipmentSpecifications = {};
      if (capacityKinds.has(values.kind)) {
        const capacity = capacityInLiters(values.capacity, values.capacity_unit);
        if (capacity != null) overrides.capacity_liters = capacity;
      }
      if (measurementRangeUnits[values.kind]) {
        const range = validRange(values.measurement_min, values.measurement_max, values.measurement_unit, values.kind);
        if (range) Object.assign(overrides, { measurement_min: range.min, measurement_max: range.max, measurement_unit: range.unit });
      }
      const id = await createEquipment(db, values.name.trim(), values.kind, catalog.find(row => row.id === values.catalog_id), overrides);
      setNewEquipment(false); equipmentForm.resetFields(); onSelect(id); await onChanged();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveCapacity(values: { capacity?: number; capacity_unit?: string }) {
    if (!item) return;
    try { await updateEquipmentCapacity(db, item, capacityInLiters(values.capacity, values.capacity_unit)); setEditCapacity(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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
      setDeleteOpen(false);
      onSelect(null);
      await onChanged();
    } catch (cause) { setDeleteOpen(false); setError(cause instanceof Error ? cause.message : String(cause)); }
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

  return <div className="section-page">
    {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index equipment-index"><div className="section-heading"><div><span className="eyebrow">Your gear</span><h1>Equipment</h1></div>
      {equipment.length > 0 && <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="New equipment" title="New equipment"
        onClick={() => setNewEquipment(true)} />}</div>
      <p className="muted">Measurements and control settings can reference a specific item.</p>
      {equipment.length === 0 && <Button icon={<PlusOutlined />} onClick={() => setNewEquipment(true)}>Add equipment</Button>}
      {equipment.length > 0 && <div className="group-tables">{kinds.map(kind => {
        const rows = equipment.filter(row => row.kind === kind);
        return rows.length ? <section key={kind} className="group-table"><h2>{equipmentKindLabel(kind)}</h2>
          <Table<Equipment> dataSource={rows} rowKey="id" pagination={false} size="small"
            columns={[{ title: 'Equipment', dataIndex: 'name', render: (_, row) =>
              <a href={`${basePath}/equipment/${row.id}`} onClick={event => { event.preventDefault(); onSelect(row.id); }}>{row.name}</a> },
              ...(capacityKinds.has(kind) ? [{ title: 'Capacity', key: 'capacity', width: 140, responsive: ['sm' as const], render: (_: unknown, row: Equipment) =>
                capacityLabel((JSON.parse(row.specification_json || '{}') as EquipmentSpecifications).capacity_liters) }] : []),
              ...(measurementRangeUnits[kind] ? [{ title: 'Measurement range', key: 'range', width: 180, responsive: ['sm' as const], render: (_: unknown, row: Equipment) => {
                const spec = JSON.parse(row.specification_json || '{}') as EquipmentSpecifications;
                return spec.measurement_min != null && spec.measurement_max != null
                  ? `${spec.measurement_min}–${spec.measurement_max} ${spec.measurement_unit || ''}` : '';
              } }] : [])]} />
        </section> : null;
      })}</div>}
    </section> : !item ? <Empty description="Equipment not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">{equipmentKindLabel(item.kind)}</span><h2>{item.name}</h2></div>
          <div className="heading-actions"><Dropdown menu={{ items: [
            ...(profile ? [{ key: 'calibrate', label: 'New calibration' }] : []),
            ...(capacityKinds.has(item.kind) ? [{ key: 'capacity', label: 'Set capacity' }] : []),
            ...(measurementRangeUnits[item.kind] ? [{ key: 'range', label: 'Set measurement range' }] : []),
            { key: 'delete', label: 'Delete equipment', icon: <DeleteOutlined />, danger: true }
          ], onClick: ({ key }) => { if (key === 'calibrate') setNewCalibration(true);
            else if (key === 'capacity') setEditCapacity(true); else if (key === 'range') setEditRange(true); else setDeleteOpen(true); } }} trigger={['click']}>
            <Button type="text" shape="circle" icon={<SettingOutlined />} aria-label="Equipment settings" title="Equipment settings" />
          </Dropdown></div></div>
        {capacityKinds.has(item.kind) && specs.capacity_liters != null && <p className="muted">Capacity: {capacityLabel(specs.capacity_liters)}
          {specs.working_volume_liters != null && ` · Brewing volume: ${capacityLabel(specs.working_volume_liters)}`}</p>}
        {measurementRangeUnits[item.kind] && specs.measurement_min != null && specs.measurement_max != null &&
          <p className="muted">Measurement range: {specs.measurement_min}–{specs.measurement_max} {specs.measurement_unit}</p>}
        {calibrations.length > 0 && <><h3>Calibration history</h3>
        <div className="card-stack">{calibrations.map(row => <Card key={row.id} size="small">
          <div className="timeline-card"><div><strong>{row.method}</strong><div className="muted">{formatTime(row.effective_at)}</div></div><Tag>Immutable</Tag></div>
          <pre className="calibration-data">{row.parameters_json}</pre>
        </Card>)}</div></>}
      </section>}
    <Modal title="New equipment" open={newEquipment} onCancel={() => setNewEquipment(false)} footer={null} destroyOnHidden>
      <Form form={equipmentForm} layout="vertical" onFinish={create} initialValues={{ capacity_unit: 'L' }}>
        <Form.Item name="kind" label="Type" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" placeholder="Choose equipment type" options={[...equipmentKinds]}
          onChange={() => equipmentForm.setFieldsValue({ catalog_id: undefined, name: undefined, capacity: undefined,
            measurement_min: undefined, measurement_max: undefined, measurement_unit: undefined })} /></Form.Item>
        <Form.Item name="catalog_id" hidden><Input /></Form.Item>
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
          <AutoComplete disabled={!selectedKind} placeholder={selectedKind ? 'Search shared catalog or enter a name' : 'Choose type first'} maxLength={120}
            options={catalog.filter(row => row.kind === selectedKind).map(row => ({ value: row.name }))}
            filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
            onSelect={value => { const entry = catalog.find(row => row.kind === selectedKind && row.name === value);
              if (entry) { const specs = JSON.parse(entry.specification_json || '{}') as EquipmentSpecifications;
                equipmentForm.setFieldsValue({ catalog_id: entry.id, capacity: specs.capacity_liters, capacity_unit: 'L',
                  measurement_min: specs.measurement_min, measurement_max: specs.measurement_max,
                  measurement_unit: specs.measurement_unit || measurementRangeUnits[entry.kind]?.[0] }); } }} />
        </Form.Item>
        {selectedKind && capacityKinds.has(selectedKind) && <div className="capacity-fields"><Form.Item name="capacity" label="Capacity (optional)"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="capacity_unit" label="Unit"><Select options={[...capacityUnits]}
            onChange={unit => changeNumberUnit(equipmentForm, ['capacity'], newCapacityUnit || 'L', unit)} /></Form.Item></div>}
        {selectedKind && measurementRangeUnits[selectedKind] && <div className="form-triple">
          <Form.Item name="measurement_min" label="Range minimum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_max" label="Range maximum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_unit" label="Unit" initialValue={measurementRangeUnits[selectedKind][0]}>
            <Select options={measurementRangeUnits[selectedKind].map(value => ({ value, label: value }))}
              onChange={unit => changeNumberUnit(equipmentForm, ['measurement_min', 'measurement_max'],
                newRangeUnit || measurementRangeUnits[selectedKind][0], unit)} /></Form.Item>
        </div>}
        <Button type="primary" htmlType="submit">Create equipment</Button>
      </Form>
    </Modal>
    <Modal title="Set equipment capacity" open={editCapacity} onCancel={() => setEditCapacity(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={capacityForm} layout="vertical" onFinish={saveCapacity} initialValues={{ capacity: specs.capacity_liters, capacity_unit: 'L' }}>
        <div className="capacity-fields"><Form.Item name="capacity" label="Capacity"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="capacity_unit" label="Unit"><Select options={[...capacityUnits]}
            onChange={unit => changeNumberUnit(capacityForm, ['capacity'], editCapacityUnit || 'L', unit)} /></Form.Item></div>
        <Button type="primary" htmlType="submit">Save capacity</Button>
      </Form>
    </Modal>
    <Modal title="Set measurement range" open={editRange} onCancel={() => setEditRange(false)} footer={null} destroyOnHidden>
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
    <Modal title="Delete equipment?" open={deleteOpen} onCancel={() => setDeleteOpen(false)}
      onOk={() => void remove()} okText="Delete" okButtonProps={{ danger: true }}>
      <p>Delete {item?.name}? Equipment used by batch events will be hidden from your equipment list and kept in historical records. Unused equipment and its calibrations will be removed.</p>
    </Modal>
  </div>;
}
