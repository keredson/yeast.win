import { useEffect, useState } from 'react';
import { Alert, AutoComplete, Button, Card, Checkbox, Empty, Form, Input, Modal, Select, Table, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { inventoryCategories, unitForCategory, type CatalogInventory } from '../shared/catalog.ts';
import { addInventoryEntry, convertInventoryUnit, createInventoryItem, inventoryBalance, listInventoryMovements,
  type InventoryItem, type InventoryMovement, type LocalDb } from './db.ts';
import { formatTime } from './time.ts';
import type { PreferredUnits } from './api.ts';
import { compoundMassUnit, formatQuantity, quantityForStorage, quantityUnitsForCategory, storageUnit, unitOptions } from '../shared/units.ts';
import { QuantityFields } from './QuantityFields.tsx';

export function InventorySection({ db, basePath, accountId, items, catalog, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; items: InventoryItem[]; catalog: CatalogInventory[]; preferredUnits: PreferredUnits;
  selectedId: string | null; onSelect: (id: string | null) => void; onChanged: () => Promise<void>;
}) {
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [newItem, setNewItem] = useState(false);
  const [entryKind, setEntryKind] = useState<'purchase' | 'count' | 'discard' | null>(null);
  const [entryAvailable, setEntryAvailable] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [itemForm] = Form.useForm();
  const [entryForm] = Form.useForm();
  const item = items.find(row => row.id === selectedId) || null;
  const selectedCategory = Form.useWatch('category', itemForm) as string | undefined;
  const newItemUnit = Form.useWatch('default_unit', itemForm) as string | undefined;
  const newItemName = Form.useWatch('name', itemForm) as string | undefined;
  const entryUnit = Form.useWatch('unit', entryForm) as string | undefined;
  const discardAll = Form.useWatch('all', entryForm) as boolean | undefined;
  const itemDisplayUnit = item?.display_unit === compoundMassUnit || item?.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit
    ? compoundMassUnit : item?.display_unit || item?.default_unit;
  const categories = [...inventoryCategories, ...items.map(row => row.category).filter(category =>
    !inventoryCategories.some(known => known === category))].filter((category, index, all) => all.indexOf(category) === index);
  const missingCategories = categories.filter(category => !items.some(row => row.category === category));
  const existingItem = items.find(row => row.category === selectedCategory && row.name.trim().toLocaleLowerCase() === newItemName?.trim().toLocaleLowerCase());

  function openCreate(category: string) {
    itemForm.resetFields();
    itemForm.setFieldsValue({ category, default_unit: unitForCategory(category, preferredUnits.mass) });
    setNewItem(true);
  }

  async function openEntry(target: InventoryItem, kind: 'purchase' | 'count' | 'discard') {
    try {
      const available = kind === 'discard' ? inventoryBalance(await listInventoryMovements(db, target.id), target.default_unit) : null;
      entryForm.resetFields();
      entryForm.setFieldsValue({ unit: target.display_unit === compoundMassUnit || target.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit
        ? compoundMassUnit : target.display_unit || target.default_unit, all: false });
      setEntryAvailable(available);
      setEntryKind(kind);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function refreshMovements() {
    if (!selectedId) return;
    setMovements(await listInventoryMovements(db, selectedId));
  }
  useEffect(() => { void refreshMovements(); }, [db, selectedId, items]);

  const balance = item ? inventoryBalance(movements, item.default_unit) : null;

  async function create(values: { name: string; category: string; default_unit: string;
    starting_quantity?: number; pounds?: number; ounces?: number }) {
    try {
      const starting = quantityForStorage(values.default_unit, values.starting_quantity, values.pounds, values.ounces);
      const match = items.find(row => row.category === values.category && row.name.trim().toLocaleLowerCase() === values.name.trim().toLocaleLowerCase());
      let id: string;
      if (match) {
        if (!starting || starting.quantity <= 0) throw new Error('Enter a quantity to add to this existing item');
        if (convertInventoryUnit(starting.quantity, starting.unit, match.default_unit) == null) throw new Error('Choose a unit compatible with the existing item');
        await addInventoryEntry(db, match.id, 'purchase', starting.quantity, starting.unit, accountId);
        id = match.id;
      } else {
        id = await createInventoryItem(db, values.name.trim(), values.category.trim(), storageUnit(values.default_unit),
          starting?.quantity ?? null, accountId, values.default_unit);
      }
      setNewItem(false); itemForm.resetFields(); onSelect(id); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function addEntry(values: { quantity?: number; unit: string; pounds?: number; ounces?: number; all?: boolean }) {
    if (!item || !entryKind) return;
    try {
      const available = entryKind === 'discard' ? inventoryBalance(await listInventoryMovements(db, item.id), item.default_unit) : null;
      const amount = entryKind === 'discard' && values.all && available != null && available > 0
        ? { quantity: available, unit: item.default_unit }
        : quantityForStorage(values.unit, values.quantity, values.pounds, values.ounces);
      if (!amount) throw new Error('Enter a quantity');
      if (entryKind === 'discard') {
        const discarded = convertInventoryUnit(amount.quantity, amount.unit, item.default_unit);
        if (discarded == null) throw new Error('Choose a unit compatible with this item');
        if (available != null && discarded > available + 1e-9) throw new Error('Cannot discard more than the available stock');
      }
      await addInventoryEntry(db, item.id, entryKind, amount.quantity, amount.unit, accountId);
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
            { title: 'Unit', dataIndex: 'display_unit', width: 100 }]} /></section> : null;
      })}</div> : <Empty description="No inventory items" />}
      {missingCategories.length > 0 && <p className="inventory-add-types">Add {missingCategories.map((category, index) =>
        <span key={category}>{index > 0 && (index === missingCategories.length - 1 ? missingCategories.length === 2 ? ' or ' : ', or ' : ', ')}
          <a href={`${basePath}/inventory`} onClick={event => { event.preventDefault(); openCreate(category); }}>{category.toLowerCase()}</a></span>)}.</p>}
    </section> : !item ? <Empty description="Inventory item not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">{item.category}</span><h2>{item.name}</h2>
          <p className="muted">{balance == null ? 'Balance needs unit conversion'
            : `${formatQuantity(balance ?? 0, item.default_unit, itemDisplayUnit)} estimated on hand`}</p></div>
          <div className="heading-actions"><Button onClick={() => void openEntry(item, 'purchase')}>Bought some</Button>
            <Button onClick={() => void openEntry(item, 'discard')}>Discard</Button>
            <Button type="primary" onClick={() => void openEntry(item, 'count')}>Count stock</Button></div></div>
        <div className="card-stack">{movements.length ? movements.map(row => <Card size="small" key={`${row.kind}-${row.id}`}>
          <div className="timeline-card"><div><strong>{formatQuantity(row.quantity, row.unit, itemDisplayUnit)}</strong>
            <div className="muted">{formatTime(row.at)}</div></div><Tag>{row.kind}</Tag></div>
        </Card>) : <Card><Empty description="No movements yet" /></Card>}</div>
      </section>}
    <Modal title="New inventory item" open={newItem} onCancel={() => setNewItem(false)} footer={null} destroyOnHidden>
      <Form form={itemForm} layout="vertical" onFinish={create}>
        <Form.Item name="category" label="Type" rules={[{ required: true }]}><Select options={inventoryCategories.map(value => ({ value, label: value }))}
          onChange={value => itemForm.setFieldsValue({ catalog_id: undefined, name: undefined,
            default_unit: unitForCategory(value, preferredUnits.mass), starting_quantity: undefined,
            pounds: undefined, ounces: undefined })} /></Form.Item>
        <Form.Item name="name" label="Item" rules={[{ required: true, whitespace: true }]}>
          <AutoComplete disabled={!selectedCategory} placeholder={selectedCategory ? 'Search shared catalog or enter an item' : 'Choose type first'} maxLength={120}
            options={catalog.filter(row => row.category === selectedCategory).map(row => ({ value: row.name }))}
            filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
            onSelect={value => { const entry = catalog.find(row => row.category === selectedCategory && row.name === value);
              if (entry) itemForm.setFieldValue('default_unit', ['Grain', 'Hops', 'Nutrient'].includes(entry.category)
                ? preferredUnits.mass : entry.unit === 'ml' ? 'mL' : entry.unit); }} />
        </Form.Item>
        <Form.Item name="default_unit" label="Unit" rules={[{ required: true }]}>
          <Select showSearch options={unitOptions(quantityUnitsForCategory(selectedCategory || 'Other'))} /></Form.Item>
        <QuantityFields unit={newItemUnit} label="Starting quantity on hand" name="starting_quantity" optional />
        {existingItem && <p className="muted">This item is already in your inventory. The quantity will be recorded as a purchase.</p>}
        <Button type="primary" htmlType="submit">{existingItem ? 'Add stock' : 'Create item'}</Button>
      </Form>
    </Modal>
    <Modal title={entryKind === 'count' ? 'Count stock' : entryKind === 'discard' ? `Discard ${item?.name || 'stock'}` : 'Record purchase'} open={!!entryKind}
      onCancel={() => setEntryKind(null)} footer={null} destroyOnHidden>
      <Form key={`${item?.id || 'none'}-${entryKind}-${preferredUnits.mass}`} form={entryForm} layout="vertical" onFinish={addEntry}
        initialValues={{ unit: itemDisplayUnit }}>
        {entryKind === 'discard' && <><p className="muted">{entryAvailable == null ? 'Available stock cannot be calculated' :
          `${formatQuantity(entryAvailable, item?.default_unit || 'each', itemDisplayUnit)} available`}</p>
          {entryAvailable != null && entryAvailable > 0 && <Form.Item name="all" valuePropName="checked"><Checkbox>All available stock</Checkbox></Form.Item>}</>}
        {!discardAll && <><Form.Item name="unit" label="Unit" rules={[{ required: true }]}>
          <Select showSearch options={unitOptions(quantityUnitsForCategory(item?.category || 'Other'))} /></Form.Item>
        <QuantityFields unit={entryUnit || itemDisplayUnit} /></>}
        <Button type="primary" htmlType="submit">Save</Button>
      </Form>
    </Modal>
  </div>;
}
