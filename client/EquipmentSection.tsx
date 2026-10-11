import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Modal, Select, Tag } from 'antd';
import { nanoid } from 'nanoid';
import { equipmentKindLabel, equipmentKinds } from '../shared/equipment.ts';
import { createEquipment, deleteEquipment, type Equipment, type LocalDb } from './db.ts';
import { fromDatetimeLocal, formatTime, toDatetimeLocal } from './time.ts';

interface Calibration { id: string; method: string; effective_at: number; parameters_json: string }

export function EquipmentSection({ db, equipment, selectedId, onSelect, onChanged }: {
  db: LocalDb; equipment: Equipment[]; selectedId: string | null; onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [newEquipment, setNewEquipment] = useState(false);
  const [newCalibration, setNewCalibration] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState('');
  const item = equipment.find(row => row.id === selectedId) || null;

  useEffect(() => {
    if (!selectedId) return;
    void db.execO<Calibration>('SELECT id, method, effective_at, parameters_json FROM equipment_calibrations WHERE equipment_id = ? ORDER BY effective_at DESC', [selectedId])
      .then(setCalibrations);
  }, [db, selectedId, equipment]);

  async function create(values: { name: string; kind: string }) {
    try { const id = await createEquipment(db, values.name.trim(), values.kind); setNewEquipment(false); onSelect(id); await onChanged(); }
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

  async function calibrate(values: { method: string; effective_at: string; parameters_json: string }) {
    if (!item) return;
    try {
      const parsed = JSON.parse(values.parameters_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Parameters must be a JSON object');
      await db.exec(`INSERT INTO equipment_calibrations(id, equipment_id, effective_at, method, parameters_json)
        VALUES (?, ?, ?, ?, ?)`, [nanoid(), item.id, fromDatetimeLocal(values.effective_at), values.method.trim(), JSON.stringify(parsed)]);
      setNewCalibration(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="section-grid">
    <div className="section-sidebar"><div className="section-heading"><div><span className="eyebrow">Your gear</span><h1>Equipment</h1></div>
      <Button type="primary" onClick={() => setNewEquipment(true)}>New</Button></div>
      <p className="muted">Measurements and control settings can reference a specific item.</p>
      {equipment.length ? <div className="choice-list">{equipment.map(row => <button key={row.id}
        className={row.id === selectedId ? 'list-choice selected' : 'list-choice'} onClick={() => onSelect(row.id)}>
        <strong>{row.name}</strong><small>{equipmentKindLabel(row.kind)}</small></button>)}</div> : <Empty description="No equipment yet" />}
    </div>
    <div className="section-content">
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      {!item ? <Empty description="Create or select equipment" /> : <>
        <div className="content-heading"><div><span className="eyebrow">{equipmentKindLabel(item.kind)}</span><h2>{item.name}</h2></div>
          <div className="heading-actions"><Button danger onClick={() => setDeleteOpen(true)}>Delete equipment</Button>
            <Button type="primary" onClick={() => setNewCalibration(true)}>Add calibration</Button></div></div>
        <h3>Calibration history</h3>
        <div className="card-stack">{calibrations.length ? calibrations.map(row => <Card key={row.id} size="small">
          <div className="timeline-card"><div><strong>{row.method}</strong><div className="muted">{formatTime(row.effective_at)}</div></div><Tag>Immutable</Tag></div>
          <pre className="calibration-data">{row.parameters_json}</pre>
        </Card>) : <Card><Empty description="No calibrations yet" /></Card>}</div>
      </>}
    </div>
    <Modal title="New equipment" open={newEquipment} onCancel={() => setNewEquipment(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={create}>
        <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input placeholder="e.g. pH meter #2" /></Form.Item>
        <Form.Item name="kind" label="Kind" rules={[{ required: true }]}><Select placeholder="Choose equipment kind" options={[...equipmentKinds]} /></Form.Item>
        <Button type="primary" htmlType="submit">Create equipment</Button>
      </Form>
    </Modal>
    <Modal title="Record calibration" open={newCalibration} onCancel={() => setNewCalibration(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={calibrate} initialValues={{ effective_at: toDatetimeLocal(), parameters_json: '{}' }}>
        <Form.Item name="method" label="Method" rules={[{ required: true }]}><Input placeholder="e.g. two-point pH calibration" /></Form.Item>
        <Form.Item name="effective_at" label="When" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
        <Form.Item name="parameters_json" label="Calibration parameters (JSON)" rules={[{ required: true }]}>
          <Input.TextArea rows={4} placeholder='{"offset": 0.02}' /></Form.Item>
        <Button type="primary" htmlType="submit">Save calibration</Button>
      </Form>
    </Modal>
    <Modal title="Delete equipment?" open={deleteOpen} onCancel={() => setDeleteOpen(false)}
      onOk={() => void remove()} okText="Delete" okButtonProps={{ danger: true }}>
      <p>Delete {item?.name}? Its unused calibrations and observations will also be deleted. Equipment used by batch events cannot be deleted.</p>
    </Modal>
  </div>;
}
