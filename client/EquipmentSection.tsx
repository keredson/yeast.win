import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, InputNumber, Modal, Select, Tag } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { nanoid } from 'nanoid';
import { equipmentKindLabel, equipmentKinds } from '../shared/equipment.ts';
import type { CatalogEquipment } from '../shared/catalog.ts';
import { createEquipment, deleteEquipment, type Equipment, type LocalDb } from './db.ts';
import { fromDatetimeLocal, formatTime, toDatetimeLocal } from './time.ts';

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

export function EquipmentSection({ db, accountId, equipment, catalog, selectedId, onSelect, onChanged }: {
  db: LocalDb; accountId: string; equipment: Equipment[]; catalog: CatalogEquipment[]; selectedId: string | null; onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [newEquipment, setNewEquipment] = useState(false);
  const [newCalibration, setNewCalibration] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState('');
  const [equipmentForm] = Form.useForm();
  const item = equipment.find(row => row.id === selectedId) || null;
  const selectedCatalogId = Form.useWatch('catalog_id', equipmentForm) as string | undefined;
  const profile = item ? calibrationProfiles[item.kind] : undefined;

  useEffect(() => {
    if (!selectedId) return;
    void db.execO<Calibration>('SELECT id, method, effective_at, parameters_json FROM equipment_calibrations WHERE equipment_id = ? ORDER BY effective_at DESC', [selectedId])
      .then(setCalibrations);
  }, [db, selectedId, equipment]);

  async function create(values: { name: string; kind: string; catalog_id?: string }) {
    try { const id = await createEquipment(db, values.name.trim(), values.kind, catalog.find(row => row.id === values.catalog_id)); setNewEquipment(false); equipmentForm.resetFields(); onSelect(id); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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

  return <div className="section-grid">
    <div className="section-sidebar"><div className="section-heading"><div><span className="eyebrow">Your gear</span><h1>Equipment</h1></div>
      <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="New equipment" title="New equipment" onClick={() => setNewEquipment(true)} /></div>
      <p className="muted">Measurements and control settings can reference a specific item.</p>
      {equipment.length ? <div className="choice-list">{equipment.map(row => <button key={row.id}
        className={row.id === selectedId ? 'list-choice selected' : 'list-choice'} onClick={() => onSelect(row.id)}>
        <strong>{row.name}</strong><small>{equipmentKindLabel(row.kind)}</small></button>)}</div> : <Empty description="No equipment yet" />}
    </div>
    <div className="section-content">
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      {!item ? <Empty description="Create or select equipment" /> : <>
        <div className="content-heading"><div><span className="eyebrow">{equipmentKindLabel(item.kind)}</span><h2>{item.name}</h2></div>
          <div className="heading-actions"><Button type="text" danger shape="circle" icon={<DeleteOutlined />} aria-label="Delete equipment" title="Delete equipment" onClick={() => setDeleteOpen(true)} />
            {profile && <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="New calibration" title="New calibration" onClick={() => setNewCalibration(true)} />}</div></div>
        <h3>{profile ? 'Calibration history' : 'Equipment details'}</h3>
        <div className="card-stack">{calibrations.length ? calibrations.map(row => <Card key={row.id} size="small">
          <div className="timeline-card"><div><strong>{row.method}</strong><div className="muted">{formatTime(row.effective_at)}</div></div><Tag>Immutable</Tag></div>
          <pre className="calibration-data">{row.parameters_json}</pre>
        </Card>) : <Card><Empty description={profile ? 'No calibrations yet' : 'This equipment type does not use measurement calibration'} /></Card>}</div>
      </>}
    </div>
    <Modal title="New equipment" open={newEquipment} onCancel={() => setNewEquipment(false)} footer={null} destroyOnHidden>
      <Form form={equipmentForm} layout="vertical" onFinish={create}>
        <Form.Item name="catalog_id" label="Find in shared equipment catalog">
          <Select showSearch allowClear placeholder="Search common equipment" optionFilterProp="label"
            options={catalog.map(row => ({ value: row.id, label: `${row.name} · ${equipmentKindLabel(row.kind)}` }))}
            onChange={value => { const entry = catalog.find(row => row.id === value);
              if (entry) equipmentForm.setFieldsValue({ name: entry.name, kind: entry.kind }); }} />
        </Form.Item>
        <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input placeholder="e.g. pH meter #2" /></Form.Item>
        <Form.Item name="kind" label="Kind" rules={[{ required: true }]}><Select disabled={!!selectedCatalogId} placeholder="Choose equipment kind" options={[...equipmentKinds]} /></Form.Item>
        <Button type="primary" htmlType="submit">Create equipment</Button>
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
      <p>Delete {item?.name}? Its unused calibrations and observations will also be deleted. Equipment used by batch events cannot be deleted.</p>
    </Modal>
  </div>;
}
