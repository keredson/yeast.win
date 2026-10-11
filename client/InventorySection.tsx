import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, InputNumber, Modal, Select, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { inventoryCategories, unitForCategory, type CatalogInventory } from '../shared/catalog.ts';
import { addInventoryEntry, createInventoryItem, type InventoryItem, type LocalDb } from './db.ts';
import { formatTime } from './time.ts';
import type { PreferredUnits } from './api.ts';

interface Movement { id: string; kind: string; quantity: number; unit: string; at: number }

export function InventorySection({ db, accountId, items, catalog, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; accountId: string; items: InventoryItem[]; catalog: CatalogInventory[]; preferredUnits: PreferredUnits;
  selectedId: string | null; onSelect: (id: string) => void; onChanged: () => Promise<void>;
}) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [newItem, setNewItem] = useState(false);
  const [entryKind, setEntryKind] = useState<'purchase' | 'count' | null>(null);
  const [error, setError] = useState('');
  const [itemForm] = Form.useForm();
  const item = items.find(row => row.id === selectedId) || null;

  async function refreshMovements() {
    if (!selectedId) return;
    const rows = await db.execO<Movement>(`
      SELECT id, 'Purchased' AS kind, quantity, unit, purchased_at AS at FROM inventory_purchases WHERE inventory_item_id = ?
      UNION ALL SELECT id, 'Counted' AS kind, quantity, unit, counted_at AS at FROM inventory_counts WHERE inventory_item_id = ?
      UNION ALL SELECT a.event_id AS id, 'Used' AS kind, a.quantity, a.unit, e.actual_at AS at
        FROM additions a JOIN batch_events e ON e.id = a.event_id WHERE a.inventory_item_id = ?
      ORDER BY at DESC, id DESC`, [selectedId, selectedId, selectedId]);
    setMovements(rows);
  }
  useEffect(() => { void refreshMovements(); }, [db, selectedId, items]);

  const currentCountIndex = movements.findIndex(row => row.kind === 'Counted');
  const currentCount = currentCountIndex < 0 ? null : movements[currentCountIndex];
  const afterAnchor = currentCount ? movements.filter(row => row.at > currentCount.at) : movements;
  const mixedUnits = !!item && (currentCount && currentCount.unit !== item.default_unit ||
    afterAnchor.some(row => row.unit !== item.default_unit));
  const balance = item && !mixedUnits ? (currentCount?.quantity || 0) + afterAnchor.reduce((sum, row) =>
    sum + (row.kind === 'Purchased' ? row.quantity : row.kind === 'Used' ? -row.quantity : 0), 0) : null;

  async function create(values: { name: string; category: string; default_unit: string }) {
    try {
      const id = await createInventoryItem(db, values.name.trim(), values.category.trim(), values.default_unit.trim());
      setNewItem(false); itemForm.resetFields(); onSelect(id); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function addEntry(values: { quantity: number; unit: string }) {
    if (!item || !entryKind) return;
    try {
      await addInventoryEntry(db, item.id, entryKind, values.quantity, values.unit.trim(), accountId);
      setEntryKind(null); await refreshMovements(); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="section-grid">
    <div className="section-sidebar"><div className="section-heading"><div><span className="eyebrow">Stock ledger</span><h1>Inventory</h1></div>
      <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="New inventory item" title="New inventory item" onClick={() => setNewItem(true)} /></div>
      <p className="muted">Purchases, uses from batches, and physical counts.</p>
      {items.length ? <div className="choice-list">{items.map(row => <button key={row.id}
        className={row.id === selectedId ? 'list-choice selected' : 'list-choice'} onClick={() => onSelect(row.id)}>
        <strong>{row.name}</strong><small>{row.category} · {row.default_unit}</small></button>)}</div> : <Empty description="No inventory items" />}
    </div>
    <div className="section-content">
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      {!item ? <Empty description="Create or select an item" /> : <>
        <div className="content-heading"><div><span className="eyebrow">{item.category}</span><h2>{item.name}</h2>
          <p className="muted">{mixedUnits ? 'Balance needs unit conversion' : `${balance ?? 0} ${item.default_unit} estimated on hand`}</p></div>
          <div className="heading-actions"><Button onClick={() => setEntryKind('purchase')}>Bought some</Button>
            <Button type="primary" onClick={() => setEntryKind('count')}>Count stock</Button></div></div>
        <div className="card-stack">{movements.length ? movements.map(row => <Card size="small" key={`${row.kind}-${row.id}`}>
          <div className="timeline-card"><div><strong>{row.quantity} {row.unit}</strong><div className="muted">{formatTime(row.at)}</div></div><Tag>{row.kind}</Tag></div>
        </Card>) : <Card><Empty description="No movements yet" /></Card>}</div>
      </>}
    </div>
    <Modal title="New inventory item" open={newItem} onCancel={() => setNewItem(false)} footer={null} destroyOnHidden>
      <Form form={itemForm} layout="vertical" onFinish={create}>
        <Form.Item name="catalog_id" label="Find in shared inventory catalog">
          <Select showSearch allowClear placeholder="Search common ingredients and supplies" optionFilterProp="label"
            options={catalog.map(row => ({ value: row.id, label: `${row.name} · ${row.category}` }))}
            onChange={value => { const entry = catalog.find(row => row.id === value);
              if (entry) itemForm.setFieldsValue({ name: entry.name, category: entry.category,
                default_unit: ['Grain', 'Hops', 'Nutrient'].includes(entry.category) ? preferredUnits.mass : entry.unit }); }} />
        </Form.Item>
        <Form.Item name="name" label="Item" rules={[{ required: true }]}><Input placeholder="e.g. Maris Otter, 12 oz bottles" /></Form.Item>
        <Form.Item name="category" label="Category" rules={[{ required: true }]}><Select options={inventoryCategories.map(value => ({ value, label: value }))}
          onChange={value => itemForm.setFieldValue('default_unit', unitForCategory(value, preferredUnits.mass))} /></Form.Item>
        <Form.Item name="default_unit" label="Unit" rules={[{ required: true }]}><Input placeholder="g, ml, each, packet…" /></Form.Item>
        <Button type="primary" htmlType="submit">Create item</Button>
      </Form>
    </Modal>
    <Modal title={entryKind === 'count' ? 'Count stock' : 'Record purchase'} open={!!entryKind}
      onCancel={() => setEntryKind(null)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={addEntry} initialValues={{ unit: item?.default_unit }}>
        <Form.Item name="quantity" label="Quantity" rules={[{ required: true }]}><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="unit" label="Unit" rules={[{ required: true }]}><Input /></Form.Item>
        <Button type="primary" htmlType="submit">Save</Button>
      </Form>
    </Modal>
  </div>;
}
