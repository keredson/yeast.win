import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, InputNumber, Modal, Select, Table, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { inventoryCategories, unitForCategory, type CatalogInventory } from '../shared/catalog.ts';
import { addInventoryEntry, createInventoryItem, type InventoryItem, type LocalDb } from './db.ts';
import { formatTime } from './time.ts';
import type { PreferredUnits } from './api.ts';
import { capacityInLiters, capacityLabel, capacityUnits } from '../shared/capacity.ts';

interface Movement { id: string; kind: string; quantity: number; unit: string; at: number }

export function InventorySection({ db, basePath, accountId, items, catalog, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; items: InventoryItem[]; catalog: CatalogInventory[]; preferredUnits: PreferredUnits;
  selectedId: string | null; onSelect: (id: string | null) => void; onChanged: () => Promise<void>;
}) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [newItem, setNewItem] = useState(false);
  const [entryKind, setEntryKind] = useState<'purchase' | 'count' | null>(null);
  const [error, setError] = useState('');
  const [itemForm] = Form.useForm();
  const item = items.find(row => row.id === selectedId) || null;
  const selectedCategory = Form.useWatch('category', itemForm) as string | undefined;
  const categories = [...inventoryCategories, ...items.map(row => row.category).filter(category =>
    !inventoryCategories.some(known => known === category))].filter((category, index, all) => all.indexOf(category) === index);

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

  async function create(values: { name: string; category: string; default_unit: string; capacity?: number; capacity_unit?: string }) {
    try {
      const id = await createInventoryItem(db, values.name.trim(), values.category.trim(), values.default_unit.trim(),
        capacityInLiters(values.capacity, values.capacity_unit));
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

  return <div className="section-page">
    {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index"><div className="section-heading"><div><span className="eyebrow">Stock ledger</span><h1>Inventory</h1></div>
      <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label="New inventory item" title="New inventory item" onClick={() => setNewItem(true)} /></div>
      <p className="muted">Purchases, uses from batches, and physical counts.</p>
      {items.length ? <div className="group-tables">{categories.map(category => {
        const rows = items.filter(row => row.category === category);
        return rows.length ? <section key={category} className="group-table"><h2>{category}</h2>
          <Table<InventoryItem> dataSource={rows} rowKey="id" pagination={false} size="small"
            columns={[{ title: 'Item', dataIndex: 'name', render: (_, row) =>
              <a href={`${basePath}/inventory/${row.id}`} onClick={event => { event.preventDefault(); onSelect(row.id); }}>{row.name}</a> },
            { title: 'Capacity', dataIndex: 'capacity_liters', width: 110, responsive: ['sm'], render: value => capacityLabel(value) },
            { title: 'Unit', dataIndex: 'default_unit', width: 100 }]} /></section> : null;
      })}</div> : <Empty description="No inventory items" />}
    </section> : !item ? <Empty description="Inventory item not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">{item.category}</span><h2>{item.name}</h2>
          <p className="muted">{mixedUnits ? 'Balance needs unit conversion' : `${balance ?? 0} ${item.default_unit} estimated on hand`}
            {item.capacity_liters != null && ` · ${capacityLabel(item.capacity_liters)} per item`}</p></div>
          <div className="heading-actions"><Button onClick={() => setEntryKind('purchase')}>Bought some</Button>
            <Button type="primary" onClick={() => setEntryKind('count')}>Count stock</Button></div></div>
        <div className="card-stack">{movements.length ? movements.map(row => <Card size="small" key={`${row.kind}-${row.id}`}>
          <div className="timeline-card"><div><strong>{row.quantity} {row.unit}</strong><div className="muted">{formatTime(row.at)}</div></div><Tag>{row.kind}</Tag></div>
        </Card>) : <Card><Empty description="No movements yet" /></Card>}</div>
      </section>}
    <Modal title="New inventory item" open={newItem} onCancel={() => setNewItem(false)} footer={null} destroyOnHidden>
      <Form form={itemForm} layout="vertical" onFinish={create} initialValues={{ capacity_unit: 'L' }}>
        <Form.Item name="category" label="Type" rules={[{ required: true }]}><Select options={inventoryCategories.map(value => ({ value, label: value }))}
          onChange={value => itemForm.setFieldsValue({ catalog_id: undefined, name: undefined,
            default_unit: unitForCategory(value, preferredUnits.mass), capacity: undefined })} /></Form.Item>
        <Form.Item name="catalog_id" label="Find in shared inventory catalog">
          <Select showSearch allowClear disabled={!selectedCategory} placeholder={selectedCategory ? 'Search this inventory type' : 'Choose type first'} optionFilterProp="label"
            options={catalog.filter(row => row.category === selectedCategory).map(row => ({ value: row.id, label: row.name }))}
            onChange={value => { const entry = catalog.find(row => row.id === value);
              if (entry) itemForm.setFieldsValue({ name: entry.name,
                default_unit: ['Grain', 'Hops', 'Nutrient'].includes(entry.category) ? preferredUnits.mass : entry.unit,
                capacity: entry.capacity_liters ?? undefined, capacity_unit: 'L' }); }} />
        </Form.Item>
        <Form.Item name="name" label="Item" rules={[{ required: true }]}><Input placeholder="e.g. Maris Otter, 12 oz bottles" /></Form.Item>
        <Form.Item name="default_unit" label="Unit" rules={[{ required: true }]}><Input placeholder="g, ml, each, packet…" /></Form.Item>
        <div className="capacity-fields"><Form.Item name="capacity" label="Capacity per item (optional)"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="capacity_unit" label="Capacity unit"><Select options={[...capacityUnits]} /></Form.Item></div>
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
