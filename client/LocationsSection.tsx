import { useEffect, useState } from 'react';
import { Alert, Button, Form, Modal, Popconfirm } from 'antd';
import { DeleteOutlined, EnvironmentOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { convertInventoryUnit, deleteInventoryLocation, listInventoryBalances, saveInventoryLocation,
  type Equipment, type InventoryRecord, type InventoryLocation, type LocalDb } from './db.ts';
import { LocationFields } from './LocationFields.tsx';
import { locationDescendantIds, locationPathSegment } from './locationRoutes.ts';
import { inventoryPathSegment } from './inventoryRoutes.ts';
import { equipmentUnitPathSegment } from './equipmentRoutes.ts';
import { compoundMassUnit, formatQuantity } from '../shared/units.ts';

function LocationCards({ parentId, locations, items, equipment, basePath, onSelect, visited = new Set<string>() }: {
  parentId: string | null; locations: InventoryLocation[]; items: InventoryRecord[]; equipment: Equipment[]; basePath: string;
  onSelect: (id: string) => void; visited?: Set<string>;
}) {
  const children = locations.filter(location => !visited.has(location.id)
    && (location.parent_id === parentId || parentId === null && location.parent_id
      && !locations.some(parent => parent.id === location.parent_id)));
  if (!children.length) return null;
  return <div className="location-cards">{children.map(location => {
    const descendantIds = locationDescendantIds(location.id, locations);
    const directCount = items.filter(item => item.location_id === location.id).length
      + equipment.filter(unit => unit.location_id === location.id).length;
    const totalCount = items.filter(item => item.location_id && descendantIds.has(item.location_id)).length
      + equipment.filter(unit => unit.location_id && descendantIds.has(unit.location_id)).length;
    return <article className="location-card" key={location.id}>
      <a className="location-card-heading" href={`${basePath}/location/${locationPathSegment(location, locations)}`}
        onClick={event => { event.preventDefault(); onSelect(location.id); }}>
        <span className="location-card-text"><strong>{location.name}</strong><small>{directCount} here · {totalCount} including sublocations</small></span>
      </a>
      {location.address && <p className="location-card-address">{location.address}</p>}
      <LocationCards parentId={location.id} locations={locations} items={items} equipment={equipment} basePath={basePath}
        onSelect={onSelect} visited={new Set([...visited, location.id])} />
    </article>;
  })}</div>;
}

export function LocationsSection({ db, basePath, locations, items, supplies, equipment, equipmentModels, selectedId,
  onSelect, onInventorySelect, onEquipmentSelect, onChanged }: {
  db: LocalDb; basePath: string; locations: InventoryLocation[]; items: InventoryRecord[]; supplies: InventoryRecord[];
  equipment: Equipment[]; equipmentModels: Equipment[];
  selectedId: string | null; onSelect: (id: string | null) => void; onInventorySelect: (id: string) => void;
  onEquipmentSelect: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [form] = Form.useForm<{ name: string; parent_id?: string; slug?: string; address?: string }>();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [balances, setBalances] = useState<Record<string, number | null>>({});
  const selected = locations.find(location => location.id === selectedId) || null;
  const directItems = items.filter(item => item.location_id === selectedId && !!selectedId);
  const directEquipment = equipment.filter(unit => unit.location_id === selectedId && !!selectedId);
  const categories = [...new Set(directItems.map(item => item.category))].sort();
  const unassigned = items.filter(item => !item.location_id);
  const unassignedEquipment = equipment.filter(unit => !unit.location_id);

  useEffect(() => {
    let cancelled = false;
    void listInventoryBalances(db, items).then(result => { if (!cancelled) setBalances(result); })
      .catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [db, items]);

  function openCreate(parentId: string | null) {
    form.resetFields();
    form.setFieldsValue({ parent_id: parentId || undefined });
    setError(''); setCreating(true);
  }

  function openSettings() {
    if (!selected) return;
    form.setFieldsValue({ name: selected.name, parent_id: selected.parent_id || undefined,
      slug: selected.slug, address: selected.address || undefined });
    setError(''); setEditing(true);
  }

  async function save(values: { name: string; parent_id?: string; slug?: string; address?: string }) {
    try {
      const id = await saveInventoryLocation(db, values.name, values.parent_id || null,
        editing ? selected?.id : undefined, editing ? values.slug : undefined, values.address);
      setCreating(false); setEditing(false); form.resetFields();
      await onChanged();
      if (editing) onSelect(id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function remove() {
    if (!selected) return;
    try {
      await deleteInventoryLocation(db, selected.id);
      setEditing(false); onSelect(selected.parent_id); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  const stockRows = (rows: InventoryRecord[]) => <div className="location-stock-list">{rows.map(item => {
    const supply = supplies.find(row => row.id === item.supply_id);
    const balance = balances[item.id];
    const converted = balance == null || item.display_unit === compoundMassUnit ? balance
      : convertInventoryUnit(balance, item.default_unit, item.display_unit);
    const displayed = converted == null ? converted === null ? 'Needs conversion' : '—'
      : formatQuantity(converted, item.display_unit === compoundMassUnit ? item.default_unit : item.display_unit,
        item.display_unit === compoundMassUnit ? compoundMassUnit : undefined);
    return <a key={item.id} href={`${basePath}/inventory/${supply ? inventoryPathSegment(supply, supplies) : item.id}`}
      onClick={event => { event.preventDefault(); onInventorySelect(supply?.id || item.id); }}>
      <span>{item.name}</span><small>{displayed}</small>
    </a>;
  })}</div>;

  const equipmentRows = (rows: Equipment[]) => <div className="location-stock-list">{rows.map(unit =>
    <a key={unit.id} href={`${basePath}/equipment/${equipmentUnitPathSegment(unit, equipment, equipmentModels)}`}
      onClick={event => { event.preventDefault(); onEquipmentSelect(unit.id); }}>
      <span>{unit.model_name || unit.name}</span><small>{unit.stock_id || `Unit ${unit.id.slice(0, 6)}`}</small>
    </a>)}</div>;

  return <div className="section-page">
    {error && !creating && !editing && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index location-index">
      <div className="section-heading"><div><span className="eyebrow">Storage map</span><h1>Locations</h1></div></div>
      <p className="muted">Buildings, rooms, shelves, and other places where stock and equipment are kept.</p>
      {locations.length > 0 && <div className="location-map"><LocationCards parentId={null} locations={locations} items={items} equipment={equipment}
        basePath={basePath} onSelect={id => onSelect(id)} /></div>}
      {unassigned.length > 0 && <section className="location-stock-section"><h2>Unassigned stock</h2>{stockRows(unassigned)}</section>}
      {unassignedEquipment.length > 0 && <section className="location-stock-section"><h2>Unassigned equipment</h2>
        {equipmentRows(unassignedEquipment)}</section>}
      <Button className="location-add" icon={<PlusOutlined />} onClick={() => openCreate(null)}>Add location</Button>
    </section> : !selected ? <p className="muted">Location not found.</p> : <section className="record-detail location-detail">
      <div className="content-heading"><div><h2>{selected.name}</h2></div><div className="heading-actions">
        <Button type="text" shape="circle" icon={<SettingOutlined />} aria-label="Location settings" title="Location settings"
          onClick={openSettings} /></div></div>
      {selected.address && <p className="location-detail-address"><EnvironmentOutlined aria-hidden /> {selected.address}</p>}
      {locations.some(location => location.parent_id === selected.id) && <section className="location-stock-section">
        <h3>Inside {selected.name}</h3><div className="location-map"><LocationCards parentId={selected.id} locations={locations}
          items={items} equipment={equipment} basePath={basePath} onSelect={id => onSelect(id)} /></div></section>}
      {directItems.length > 0 && <section className="location-stock-section"><h3>Stock here</h3>
        {categories.map(category => <div key={category} className="location-stock-category">
          <h4>{category}</h4>{stockRows(directItems.filter(item => item.category === category))}</div>)}</section>}
      {directEquipment.length > 0 && <section className="location-stock-section"><h3>Equipment here</h3>
        {equipmentRows(directEquipment)}</section>}
      <Button className="location-add" type="text" icon={<PlusOutlined />} onClick={() => openCreate(selected.id)}>New sublocation</Button>
    </section>}
    <Modal title={editing ? 'Location settings' : 'New location'} open={creating || editing}
      onCancel={() => { setCreating(false); setEditing(false); setError(''); }} footer={null} forceRender>
      {error && <Alert type="error" message={error} className="form-alert" />}
      <Form form={form} layout="vertical" onFinish={save}>
        <LocationFields locations={locations} editingId={editing ? selected?.id : null} showSlug={editing} />
        <div className="recipe-settings-actions"><Button type="primary" htmlType="submit">{editing ? 'Save changes' : 'Add location'}</Button>
          {editing && <Popconfirm title={`Delete ${selected?.name}?`}
            description="Move its stock, equipment, and child locations before deleting it." okText="Delete" okButtonProps={{ danger: true }}
            onConfirm={() => void remove()}><Button type="text" danger icon={<DeleteOutlined />}>Delete location</Button></Popconfirm>}</div>
      </Form>
    </Modal>
  </div>;
}
