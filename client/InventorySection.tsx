import { useEffect, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Checkbox, Dropdown, Empty, Form, Input, Modal, Select, Table } from 'antd';
import { MoreOutlined, PlusOutlined } from '@ant-design/icons';
import { inventoryCategories, unitForCategory, type CatalogInventory } from '../shared/catalog.ts';
import { addInventoryEntry, convertInventoryUnit, createInventoryItem, deleteInventoryLocation, inventoryBalance, inventoryLocationPath,
  listInventoryBalances, listInventoryLocations, listInventoryMovements, moveInventoryStock, saveInventoryLocation, stockAtLocation,
  type InventoryItem, type InventoryLocation, type InventoryMovement, type LocalDb } from './db.ts';
import { formatTime } from './time.ts';
import type { PreferredUnits } from './api.ts';
import { compoundMassUnit, formatQuantity, quantityForStorage, quantityUnitsForCategory, storageUnit, unitOptions } from '../shared/units.ts';
import { QuantityFields } from './QuantityFields.tsx';
import { changeQuantityUnit } from './unitFields.ts';
import { inventoryPathSegment } from './inventoryRoutes.ts';

function onHandQuantity(item: InventoryItem, balance: number): string {
  if (item.display_unit === compoundMassUnit) return formatQuantity(balance, item.default_unit, compoundMassUnit);
  const amount = convertInventoryUnit(balance, item.default_unit, item.display_unit);
  return amount == null ? 'Needs conversion' : String(Number(amount.toFixed(6)));
}
const unspecifiedLocation = '__unspecified__';

function locationTree(locations: InventoryLocation[], parentId: string | null = null, seen = new Set<string>()): (InventoryLocation & { children?: InventoryLocation[] })[] {
  return locations.filter(location => location.parent_id === parentId && !seen.has(location.id)).map(location => {
    const branch = new Set(seen).add(location.id);
    const children = locationTree(locations, location.id, branch);
    return { ...location, ...(children.length ? { children } : {}) };
  });
}

export function InventorySection({ db, basePath, accountId, items, catalog, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; items: InventoryItem[]; catalog: CatalogInventory[]; preferredUnits: PreferredUnits;
  selectedId: string | null; onSelect: (id: string | null) => void; onChanged: () => Promise<void>;
}) {
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [onHand, setOnHand] = useState<Record<string, number | null>>({});
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [locationEditing, setLocationEditing] = useState<string | null>(null);
  const [moveItemId, setMoveItemId] = useState<string | null>(null);
  const [locationReturn, setLocationReturn] = useState<'item' | 'move' | null>(null);
  const [newItemCategory, setNewItemCategory] = useState<string | null>(null);
  const [entryKind, setEntryKind] = useState<'purchase' | 'count' | 'discard' | null>(null);
  const [entryItemId, setEntryItemId] = useState<string | null>(null);
  const [entryAvailable, setEntryAvailable] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [itemForm] = Form.useForm();
  const [entryForm] = Form.useForm();
  const [locationForm] = Form.useForm();
  const [moveForm] = Form.useForm();
  const previousItemUnit = useRef<string | undefined>(undefined);
  const previousEntryUnit = useRef<string | undefined>(undefined);
  const item = items.find(row => row.id === selectedId) || null;
  const entryItem = items.find(row => row.id === entryItemId) || item;
  const newItemUnit = Form.useWatch('default_unit', itemForm) as string | undefined;
  const newItemName = Form.useWatch('name', itemForm) as string | undefined;
  const entryUnit = Form.useWatch('unit', entryForm) as string | undefined;
  const discardAll = Form.useWatch('all', entryForm) as boolean | undefined;
  const newLocationId = Form.useWatch('location_id', itemForm) as string | undefined;
  const moveAll = Form.useWatch('all', moveForm) as boolean | undefined;
  const moveUnit = Form.useWatch('unit', moveForm) as string | undefined;
  const moveItem = items.find(row => row.id === moveItemId) || null;
  const itemDisplayUnit = item?.display_unit === compoundMassUnit || item?.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit
    ? compoundMassUnit : item?.display_unit || item?.default_unit;
  const categories = [...inventoryCategories, ...items.map(row => row.category).filter(category =>
    !inventoryCategories.some(known => known === category))].filter((category, index, all) => all.indexOf(category) === index);
  const missingCategories = categories.filter(category => !items.some(row => row.category === category));
  const existingItem = items.find(row => row.category === newItemCategory && row.name.trim().toLocaleLowerCase() === newItemName?.trim().toLocaleLowerCase());
  const existingAtLocation = existingItem && newLocationId !== undefined
    ? stockAtLocation(items, existingItem.name, existingItem.category, newLocationId === unspecifiedLocation ? null : newLocationId) : undefined;
  const locationOptions = [{ value: unspecifiedLocation, label: 'Unspecified' }, ...locations.map(location =>
    ({ value: location.id, label: inventoryLocationPath(location.id, locations) }))];
  const entryDisplayUnit = entryItem?.display_unit === compoundMassUnit || entryItem?.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit
    ? compoundMassUnit : entryItem?.display_unit || entryItem?.default_unit;

  function openCreate(category: string) {
    itemForm.resetFields();
    const unit = unitForCategory(category, preferredUnits.mass);
    previousItemUnit.current = unit;
    itemForm.setFieldsValue({ category, default_unit: unit, location_id: undefined });
    setNewItemCategory(category);
  }

  async function openEntry(target: InventoryItem, kind: 'purchase' | 'count' | 'discard') {
    try {
      const available = kind === 'discard' ? inventoryBalance(await listInventoryMovements(db, target.id), target.default_unit) : null;
      entryForm.resetFields();
      const unit = target.display_unit === compoundMassUnit || target.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit
        ? compoundMassUnit : target.display_unit || target.default_unit;
      previousEntryUnit.current = unit;
      entryForm.setFieldsValue({ unit, all: false });
      setEntryAvailable(available);
      setEntryItemId(target.id);
      setEntryKind(kind);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function refreshMovements() {
    if (!selectedId) return;
    setMovements(await listInventoryMovements(db, selectedId));
  }
  useEffect(() => { void refreshMovements(); }, [db, selectedId, items]);
  useEffect(() => {
    let cancelled = false;
    void listInventoryBalances(db, items).then(balances => { if (!cancelled) setOnHand(balances); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [db, items]);
  useEffect(() => { void listInventoryLocations(db).then(setLocations).catch(cause => setError(String(cause))); }, [db, items]);

  const balance = item ? inventoryBalance(movements, item.default_unit) : null;

  async function create(values: { name: string; category: string; default_unit: string;
    starting_quantity?: number; pounds?: number; ounces?: number; location_id?: string }) {
    try {
      const starting = quantityForStorage(values.default_unit, values.starting_quantity, values.pounds, values.ounces);
      const locationId = !values.location_id || values.location_id === unspecifiedLocation ? null : values.location_id;
      const match = stockAtLocation(items, values.name, values.category, locationId);
      if (items.some(row => row.category === values.category && row.name.trim().toLocaleLowerCase() === values.name.trim().toLocaleLowerCase())
        && (!starting || starting.quantity <= 0)) throw new Error('Enter a positive quantity to add this existing item');
      if (match) {
        if (!starting) throw new Error('Enter a quantity');
        if (convertInventoryUnit(starting.quantity, starting.unit, match.default_unit) == null) throw new Error('Choose a unit compatible with the existing item');
        await addInventoryEntry(db, match.id, 'purchase', starting.quantity, starting.unit, accountId);
      } else {
        await createInventoryItem(db, values.name.trim(), values.category.trim(), storageUnit(values.default_unit),
          starting?.quantity ?? null, accountId, values.default_unit, locationId);
      }
      setNewItemCategory(null); itemForm.resetFields(); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveLocation(values: { name: string; parent_id?: string }) {
    try {
      const id = await saveInventoryLocation(db, values.name,
        !values.parent_id || values.parent_id === unspecifiedLocation ? null : values.parent_id, locationEditing || undefined);
      setLocations(await listInventoryLocations(db));
      if (locationReturn === 'item') itemForm.setFieldValue('location_id', id);
      if (locationReturn === 'move') moveForm.setFieldValue('location_id', id);
      setLocationEditing(null); locationForm.resetFields(); setLocationReturn(null);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function removeLocation(id: string) {
    try { await deleteInventoryLocation(db, id); setLocations(await listInventoryLocations(db)); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function move(values: { location_id: string; unit: string; quantity?: number; pounds?: number; ounces?: number; all?: boolean }) {
    if (!moveItem) return;
    try {
      const available = inventoryBalance(await listInventoryMovements(db, moveItem.id), moveItem.default_unit);
      const amount = values.all && available != null ? { quantity: available, unit: moveItem.default_unit }
        : quantityForStorage(values.unit, values.quantity, values.pounds, values.ounces);
      if (!amount) throw new Error('Enter a quantity');
      await moveInventoryStock(db, moveItem, values.location_id === unspecifiedLocation ? null : values.location_id, amount.quantity, amount.unit);
      setMoveItemId(null); moveForm.resetFields(); await refreshMovements(); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function addEntry(values: { quantity?: number; unit: string; pounds?: number; ounces?: number; all?: boolean }) {
    if (!entryItem || !entryKind) return;
    try {
      const available = entryKind === 'discard' ? inventoryBalance(await listInventoryMovements(db, entryItem.id), entryItem.default_unit) : null;
      const amount = entryKind === 'discard' && values.all && available != null && available > 0
        ? { quantity: available, unit: entryItem.default_unit }
        : quantityForStorage(values.unit, values.quantity, values.pounds, values.ounces);
      if (!amount) throw new Error('Enter a quantity');
      if (entryKind === 'discard') {
        const discarded = convertInventoryUnit(amount.quantity, amount.unit, entryItem.default_unit);
        if (discarded == null) throw new Error('Choose a unit compatible with this item');
        if (available != null && discarded > available + 1e-9) throw new Error('Cannot discard more than the available stock');
      }
      await addInventoryEntry(db, entryItem.id, entryKind, amount.quantity, amount.unit, accountId);
      setEntryKind(null); setEntryItemId(null); await refreshMovements(); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="section-page">
    {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index"><div className="section-heading"><div><span className="eyebrow">Stock ledger</span><h1>Inventory</h1></div>
      <Button onClick={() => setLocationsOpen(true)}>Manage locations</Button></div>
      <p className="muted">Purchases, uses from batches, and physical counts.</p>
      {items.length > 0 && <div className="group-tables">{categories.map(category => {
        const rows = items.filter(row => row.category === category);
        return rows.length ? <section key={category} className="group-table"><div className="group-table-heading"><h2>{category}</h2>
          <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label={`Add ${category.toLowerCase()}`} title={`Add ${category.toLowerCase()}`}
            onClick={() => openCreate(category)} /></div>
          <Table<InventoryItem> dataSource={rows} rowKey="id" pagination={false} size="small"
            columns={[{ title: 'Item', dataIndex: 'name', render: (_, row) =>
              <a href={`${basePath}/inventory/${inventoryPathSegment(row, items)}`} onClick={event => { event.preventDefault(); onSelect(row.id); }}>{row.name}</a> },
            { title: 'Location', key: 'location', width: 190, render: (_, row) => inventoryLocationPath(row.location_id, locations) },
            { title: 'Qty', key: 'on_hand', width: 140, align: 'right', render: (_, row) => onHand[row.id] === undefined ? '—'
              : onHand[row.id] === null ? 'Needs conversion'
                : onHandQuantity(row, onHand[row.id]!) },
            { title: 'Unit', dataIndex: 'display_unit', width: 100 },
            { title: '', key: 'actions', width: 48, align: 'right', render: (_, row) => <Dropdown trigger={['click']}
              menu={{ items: [{ key: 'purchase', label: 'Bought' }, { key: 'count', label: 'Counted' }, { key: 'discard', label: 'Discard' }, { key: 'move', label: 'Move' }],
                onClick: ({ key }) => key === 'move' ? setMoveItemId(row.id) : void openEntry(row, key as 'purchase' | 'count' | 'discard') }}>
              <Button type="text" shape="circle" icon={<MoreOutlined />} aria-label={`Actions for ${row.name}`} />
            </Dropdown> }]} /></section> : null;
      })}</div>}
      {missingCategories.length > 0 && <p className="inventory-add-types">Add {missingCategories.map((category, index) =>
        <span key={category}>{index > 0 && (index === missingCategories.length - 1 ? missingCategories.length === 2 ? ' or ' : ', or ' : ', ')}
          <a href={`${basePath}/inventory`} onClick={event => { event.preventDefault(); openCreate(category); }}>{category.toLowerCase()}</a></span>)}.</p>}
    </section> : !item ? <Empty description="Inventory item not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">{item.category}</span><h2>{item.name}</h2>
          <p className="muted">{inventoryLocationPath(item.location_id, locations)} · {balance == null ? 'Balance needs unit conversion'
            : `${formatQuantity(balance ?? 0, item.default_unit, itemDisplayUnit)} estimated on hand`}</p></div>
          <div className="heading-actions"><Button onClick={() => void openEntry(item, 'purchase')}>Bought some</Button>
            <Button onClick={() => void openEntry(item, 'discard')}>Discard</Button>
            <Button onClick={() => setMoveItemId(item.id)}>Move stock</Button>
            <Button type="primary" onClick={() => void openEntry(item, 'count')}>Count stock</Button></div></div>
        {movements.length > 0 && <><h3>Stock history</h3>
        <Table<InventoryMovement> className="inventory-history" dataSource={movements} rowKey={row => `${row.kind}-${row.id}`}
          pagination={false} size="small" scroll={{ x: 480 }}
          columns={[{ title: 'When', dataIndex: 'at', width: 190, render: at => formatTime(at) },
            { title: 'Activity', dataIndex: 'kind', width: 120 },
            { title: 'Quantity', key: 'quantity', align: 'right', render: (_, row) =>
              `${row.kind === 'Purchased' || row.kind === 'Moved in' ? '+' : row.kind === 'Used' || row.kind === 'Discarded' || row.kind === 'Moved out' ? '−' : 'Set to '}${formatQuantity(row.quantity, row.unit, itemDisplayUnit)}` }]} /></>}
      </section>}
    <Modal title={newItemCategory ? `New ${newItemCategory.toLowerCase()} item` : 'New inventory item'} open={!!newItemCategory}
      onCancel={() => setNewItemCategory(null)} footer={null} destroyOnHidden>
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      <Form form={itemForm} layout="vertical" onFinish={create}>
        <Form.Item name="category" hidden><Input /></Form.Item>
        <Form.Item name="name" label="Item" rules={[{ required: true, whitespace: true }]}>
          <AutoComplete placeholder="Search shared catalog or enter an item" maxLength={120}
            options={catalog.filter(row => row.category === newItemCategory).map(row => ({ value: row.name }))}
            filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
            onSelect={value => { const entry = catalog.find(row => row.category === newItemCategory && row.name === value);
              if (entry) { const nextUnit = ['Grain', 'Hops', 'Nutrient'].includes(entry.category) ? preferredUnits.mass : entry.unit === 'ml' ? 'mL' : entry.unit;
                changeQuantityUnit(itemForm, previousItemUnit.current, nextUnit, 'starting_quantity');
                previousItemUnit.current = nextUnit;
                itemForm.setFieldValue('default_unit', nextUnit); } }} />
        </Form.Item>
        <Form.Item name="location_id" label="Location" rules={existingItem ? [{ required: true, message: 'Choose where to add this item' }] : []}>
          <Select placeholder="Choose a location" options={locationOptions} />
        </Form.Item>
        <Button type="link" onClick={() => { setLocationReturn('item'); setLocationsOpen(true); }}>Create or manage locations</Button>
        <Form.Item name="default_unit" label="Unit" rules={[{ required: true }]}>
          <Select showSearch options={unitOptions(quantityUnitsForCategory(newItemCategory || 'Other'))}
            onChange={unit => { changeQuantityUnit(itemForm, previousItemUnit.current, unit, 'starting_quantity'); previousItemUnit.current = unit; }} /></Form.Item>
        <QuantityFields unit={newItemUnit} label="Starting quantity on hand" name="starting_quantity" optional={!existingItem} />
        {existingAtLocation && <p className="muted">This item is already at this location. The quantity will be recorded as a purchase.</p>}
        {existingItem && !existingAtLocation && <p className="muted">This creates another stock row for the selected location.</p>}
        <Button type="primary" htmlType="submit">{existingAtLocation ? 'Add stock' : 'Create item'}</Button>
      </Form>
    </Modal>
    <Modal title="Move stock" open={!!moveItem} onCancel={() => setMoveItemId(null)} footer={null} destroyOnHidden>
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      <Form form={moveForm} layout="vertical" onFinish={move} initialValues={{ unit: moveItem?.display_unit || moveItem?.default_unit }}>
        <p className="muted">From {inventoryLocationPath(moveItem?.location_id || null, locations)}.
          {moveItem && onHand[moveItem.id] != null ? ` ${formatQuantity(onHand[moveItem.id]!, moveItem.default_unit, moveItem.display_unit)} available.` : ''}</p>
        <Form.Item name="location_id" label="To location" rules={[{ required: true, message: 'Choose a destination' }]}>
          <Select options={locationOptions.filter(option => option.value !== (moveItem?.location_id || unspecifiedLocation))} />
        </Form.Item>
        <Button type="link" onClick={() => { setLocationReturn('move'); setLocationsOpen(true); }}>Create or manage locations</Button>
        <Form.Item name="all" valuePropName="checked"><Checkbox>Move all available stock</Checkbox></Form.Item>
        {!moveAll && <><Form.Item name="unit" label="Unit" rules={[{ required: true }]}>
          <Select options={unitOptions(quantityUnitsForCategory(moveItem?.category || 'Other'))} /></Form.Item>
          <QuantityFields unit={moveUnit || moveItem?.display_unit || moveItem?.default_unit || 'each'} /></>}
        <Button type="primary" htmlType="submit">Move stock</Button>
      </Form>
    </Modal>
    <Modal title="Inventory locations" open={locationsOpen} onCancel={() => { setLocationsOpen(false); setLocationReturn(null); }} footer={null} width={620}>
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      <p className="muted">Create a room, shelf, or building at any level. A parent is optional.</p>
      {locations.length > 0 && <Table<InventoryLocation> dataSource={locationTree(locations)} rowKey="id" size="small" pagination={false}
        expandable={{ expandedRowKeys: locations.map(location => location.id) }}
        columns={[{ title: 'Location', dataIndex: 'name' },
          { title: '', width: 155, render: (_, row) => <><Button type="link" onClick={() => { setLocationEditing(row.id);
            locationForm.setFieldsValue({ name: row.name, parent_id: row.parent_id || unspecifiedLocation }); }}>Edit</Button>
            <Button type="link" danger onClick={() => void removeLocation(row.id)}>Delete</Button></> }]} />}
      <h3>{locationEditing ? 'Edit location' : 'New location'}</h3>
      <Form form={locationForm} layout="vertical" onFinish={saveLocation}>
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}><Input maxLength={100} placeholder="Back room" /></Form.Item>
        <Form.Item name="parent_id" label="Inside" initialValue={unspecifiedLocation}><Select options={locationOptions.filter(option => option.value !== locationEditing)} /></Form.Item>
        <Button type="primary" htmlType="submit">{locationEditing ? 'Save location' : 'Add location'}</Button>
        {locationEditing && <Button onClick={() => { setLocationEditing(null); locationForm.resetFields(); }}>Cancel edit</Button>}
      </Form>
    </Modal>
    <Modal title={entryKind === 'count' ? `Count ${entryItem?.name || 'stock'}` : entryKind === 'discard'
      ? `Discard ${entryItem?.name || 'stock'}` : `Bought ${entryItem?.name || 'stock'}`} open={!!entryKind}
      onCancel={() => { setEntryKind(null); setEntryItemId(null); }} footer={null} destroyOnHidden>
      <Form key={`${entryItem?.id || 'none'}-${entryKind}-${preferredUnits.mass}`} form={entryForm} layout="vertical" onFinish={addEntry}
        initialValues={{ unit: entryDisplayUnit }}>
        {entryKind === 'discard' && <><p className="muted">{entryAvailable == null ? 'Available stock cannot be calculated' :
          `${formatQuantity(entryAvailable, entryItem?.default_unit || 'each', entryDisplayUnit)} available`}</p>
          {entryAvailable != null && entryAvailable > 0 && <Form.Item name="all" valuePropName="checked"><Checkbox>All available stock</Checkbox></Form.Item>}</>}
        {!discardAll && <><Form.Item name="unit" label="Unit" rules={[{ required: true }]}>
          <Select showSearch options={unitOptions(quantityUnitsForCategory(entryItem?.category || 'Other'))}
            onChange={unit => { changeQuantityUnit(entryForm, previousEntryUnit.current, unit); previousEntryUnit.current = unit; }} /></Form.Item>
        <QuantityFields unit={entryUnit || entryDisplayUnit} /></>}
        <Button type="primary" htmlType="submit">Save</Button>
      </Form>
    </Modal>
  </div>;
}
