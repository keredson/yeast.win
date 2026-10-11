import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Modal, Tag } from 'antd';
import { nanoid } from 'nanoid';
import { createEquipment, type Equipment, type LocalDb } from './db.ts';
import { fromDatetimeLocal, formatTime, toDatetimeLocal } from './time.ts';

interface Calibration { id: string; method: string; effective_at: number; parameters_json: string }

export function EquipmentSection({ db, equipment, onChanged }: {
  db: LocalDb; equipment: Equipment[]; onChanged: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [newEquipment, setNewEquipment] = useState(false);
  const [newCalibration, setNewCalibration] = useState(false);
  const [error, setError] = useState('');
  const item = equipment.find(row => row.id === selectedId) || null;

  useEffect(() => {
    if (!selectedId && equipment.length) setSelectedId(equipment[0].id);
  }, [equipment, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    void db.execO<Calibration>('SELECT id, method, effective_at, parameters_json FROM equipment_calibrations WHERE equipment_id = ? ORDER BY effective_at DESC', [selectedId])
      .then(setCalibrations);
  }, [db, selectedId, equipment]);

  async function create(values: { name: string; kind: string }) {
    try { await createEquipment(db, values.name.trim(), values.kind.trim()); setNewEquipment(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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
        className={row.id === selectedId ? 'list-choice selected' : 'list-choice'} onClick={() => setSelectedId(row.id)}>
        <strong>{row.name}</strong><small>{row.kind}</small></button>)}</div> : <Empty description="No equipment yet" />}
    </div>
    <div className="section-content">
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      {!item ? <Empty description="Create or select equipment" /> : <>
        <div className="content-heading"><div><span className="eyebrow">{item.kind}</span><h2>{item.name}</h2></div>
          <Button type="primary" onClick={() => setNewCalibration(true)}>Add calibration</Button></div>
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
        <Form.Item name="kind" label="Kind" rules={[{ required: true }]}><Input placeholder="Meter, kettle, fridge…" /></Form.Item>
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
  </div>;
}
