import { useEffect, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Checkbox, Dropdown, Empty, Form, Input, InputNumber, Modal, Select, Table } from 'antd';
import { MoreOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { inventoryCategories, unitForCategory, type CatalogInventory } from '../shared/catalog.ts';
import { addInventoryEntry, convertInventoryUnit, createInventoryItem, inventoryBalance, inventoryLocationPath,
  listInventoryBalances, listInventoryLocations, listInventoryMovements, moveInventoryStock, saveInventoryLocation, stockAtLocation,
  updateIngredientProperties, updateLotIngredientProperties, supplyIngredientProperties, lotIngredientProperties, ingredientProperties, type IngredientProperties, type InventoryItem, type InventoryLocation, type InventoryMovement, type LocalDb } from './db.ts';
import { formatTime } from './time.ts';
import type { PreferredUnits } from './api.ts';
import { compoundMassUnit, formatQuantity, quantityForStorage, quantityUnitsForCategory, storageUnit, unitOptions } from '../shared/units.ts';
import { QuantityFields } from './QuantityFields.tsx';
import { changeQuantityUnit } from './unitFields.ts';
import { inventoryPathSegment } from './inventoryRoutes.ts';
import { LocationFields } from './LocationFields.tsx';
import { LocationTreeSelect, newLocationOption } from './LocationTreeSelect.tsx';
import { locationDescendantIds } from './locationRoutes.ts';

function stockTotal(rows: InventoryItem[], balances: Record<string, number | null>, unit: string): number | null | undefined {
  let total = 0;
  for (const row of rows) {
    const balance = balances[row.id];
    if (balance === undefined) return undefined;
    if (balance === null) return null;
    const converted = convertInventoryUnit(balance, row.default_unit, unit);
    if (converted === null) return null;
    total += converted;
  }
  return total;
}

function stockQuantity(rows: InventoryItem[], balances: Record<string, number | null>, unit: string,
  displayUnit: string): string {
  const total = stockTotal(rows, balances, unit);
  return total === undefined ? '—' : total === null ? 'Needs conversion' : formatStockQuantity(total, unit, displayUnit);
}

function formatStockQuantity(quantity: number, unit: string, displayUnit: string): string {
  const converted = convertInventoryUnit(quantity, unit, displayUnit === compoundMassUnit ? 'oz' : displayUnit);
  return converted === null ? formatQuantity(quantity, unit) : formatQuantity(converted,
    displayUnit === compoundMassUnit ? 'oz' : displayUnit, displayUnit);
}

type StockMovement = InventoryMovement & { stock_id: string; lot_code: string | null; location_id: string | null };
type StockTreeRow = { key: string; lotLabel: string; locationLabel: string; rows: InventoryItem[];
  lotItem?: InventoryItem; stockItem?: InventoryItem; children?: StockTreeRow[] };

function stockTree(rows: InventoryItem[]): StockTreeRow[] {
  const lots = new Map<string, InventoryItem[]>();
  for (const row of rows) {
    const key = row.lot_id || 'no-lot';
    const existing = lots.get(key) || [];
    existing.push(row);
    lots.set(key, existing);
  }
  return [...lots.entries()].map(([lotId, stockRows]) => {
    const lotLabel = stockRows[0].lot_code ? `Lot ${stockRows[0].lot_code}` : 'Unspecified lot';
    if (stockRows.length === 1) return { key: `stock:${stockRows[0].id}`, lotLabel,
      locationLabel: stockRows[0].location_name || 'No location', rows: stockRows,
      lotItem: stockRows[0], stockItem: stockRows[0] };
    return { key: `lot:${lotId}`, lotLabel, locationLabel: '', rows: stockRows, lotItem: stockRows[0],
      children: stockRows.map(row => ({ key: `stock:${row.id}`, lotLabel: '',
        locationLabel: row.location_name || 'No location', rows: [row], stockItem: row })) };
  }).sort((a, b) => a.lotLabel.localeCompare(b.lotLabel));
}

function PropertyFields({ category }: { category: string }) {
  return <>
    {['Grain', 'Adjunct'].includes(category) && <><Form.Item name="yield_pct" label="Extract yield (%)">
      <InputNumber className="full-width" min={0} max={100} step="any" /></Form.Item>
      <Form.Item name="color_lovibond" label="Color (°L)"><InputNumber className="full-width" min={0} step="any" /></Form.Item></>}
    {category === 'Hops' && <><Form.Item name="alpha_acid_pct" label="Alpha acid (%)">
      <InputNumber className="full-width" min={0} max={100} step="any" /></Form.Item>
      <Form.Item name="hop_form" label="Form"><Select allowClear options={[
        { value: 'pellet', label: 'Pellet' }, { value: 'whole', label: 'Whole leaf' }, { value: 'plug', label: 'Plug' }
      ]} /></Form.Item></>}
    {category === 'Yeast' && <Form.Item name="attenuation_pct" label="Apparent attenuation (%)">
      <InputNumber className="full-width" min={0} max={100} step="any" /></Form.Item>}
  </>;
}

export function InventorySection({ db, basePath, accountId, items, supplies, catalog, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; items: InventoryItem[]; supplies: InventoryItem[]; catalog: CatalogInventory[]; preferredUnits: PreferredUnits;
  selectedId: string | null; onSelect: (id: string | null) => void; onChanged: () => Promise<void>;
}) {
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [onHand, setOnHand] = useState<Record<string, number | null>>({});
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [locationFilterId, setLocationFilterId] = useState<string | null>(null);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [moveItemId, setMoveItemId] = useState<string | null>(null);
  const [locationReturn, setLocationReturn] = useState<'item' | 'move' | null>(null);
  const [newItemCategory, setNewItemCategory] = useState<string | null>(null);
  const [newStockProduct, setNewStockProduct] = useState<InventoryItem | null>(null);
  const [newStockLotCode, setNewStockLotCode] = useState<string | null | undefined>(undefined);
  const [ingredientSettingsOpen, setIngredientSettingsOpen] = useState(false);
  const [supplyProperties, setSupplyProperties] = useState<IngredientProperties>({});
  const [lotSettingsOpen, setLotSettingsOpen] = useState(false);
  const [lotTarget, setLotTarget] = useState<InventoryItem | null>(null);
  const [lotProperties, setLotProperties] = useState<IngredientProperties>({});
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
  const item = supplies.find(row => row.id === selectedId) || null;
  const productRows = items.filter(row => row.supply_id === item?.id);
  const stockTreeRows = stockTree(productRows);
  const currentIngredientProperties = ingredientProperties(item);
  const entryItem = items.find(row => row.id === entryItemId) || null;
  const newItemUnit = Form.useWatch('default_unit', itemForm) as string | undefined;
  const newItemName = Form.useWatch('name', itemForm) as string | undefined;
  const newLotCode = Form.useWatch('lot_code', itemForm) as string | undefined;
  const entryUnit = Form.useWatch('unit', entryForm) as string | undefined;
  const discardAll = Form.useWatch('all', entryForm) as boolean | undefined;
  const newLocationId = Form.useWatch('location_id', itemForm) as string | undefined;
  const moveAll = Form.useWatch('all', moveForm) as boolean | undefined;
  const moveUnit = Form.useWatch('unit', moveForm) as string | undefined;
  const moveItem = items.find(row => row.id === moveItemId) || null;
  const itemDisplayUnit = item?.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit
    ? compoundMassUnit : productRows[0]?.display_unit || item?.display_unit || item?.default_unit;
  const categories = [...inventoryCategories, ...supplies.map(row => row.category).filter(category =>
    !inventoryCategories.some(known => known === category))].filter((category, index, all) => all.indexOf(category) === index);
  const activeLocationId = locations.some(location => location.id === locationFilterId) ? locationFilterId : null;
  const locationFilterLabel = inventoryLocationPath(activeLocationId, locations) || 'All locations';
  const locationFilterWidth = Math.max(18, Math.min(42, locationFilterLabel.length + 5));
  const visibleLocationIds = activeLocationId ? locationDescendantIds(activeLocationId, locations) : null;
  const visibleItems = visibleLocationIds ? items.filter(row => row.location_id && visibleLocationIds.has(row.location_id)) : items;
  const visibleSupplies = supplies.filter(row => visibleItems.some(stock => stock.supply_id === row.id));
  const missingCategories = categories.filter(category => !visibleSupplies.some(row => row.category === category));
  const existingItem = items.find(row => row.category === newItemCategory && row.name.trim().toLocaleLowerCase() === newItemName?.trim().toLocaleLowerCase());
  const existingAtLocation = existingItem
    ? stockAtLocation(items, existingItem.name, existingItem.category, newLocationId || null, newLotCode?.trim() || null) : undefined;
  const entryDisplayUnit = entryItem?.display_unit === compoundMassUnit || entryItem?.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit
    ? compoundMassUnit : entryItem?.display_unit || entryItem?.default_unit;

  function openCreate(category: string, product?: InventoryItem, lotCode?: string | null, lockLot = false) {
    itemForm.resetFields();
    const unit = product?.default_unit || unitForCategory(category, preferredUnits.mass);
    previousItemUnit.current = unit;
    itemForm.setFieldsValue({ category, name: product?.name, lot_code: lotCode || undefined,
      default_unit: unit, location_id: activeLocationId || undefined });
    setNewStockProduct(product || null);
    setNewStockLotCode(lockLot ? lotCode || null : undefined);
    setNewItemCategory(category);
  }

  async function saveIngredientProperties(values: IngredientProperties) {
    if (!item) return;
    try { await updateIngredientProperties(db, item, values); setIngredientSettingsOpen(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveLotProperties(values: IngredientProperties) {
    if (!lotTarget) return;
    try { await updateLotIngredientProperties(db, lotTarget, values); setLotSettingsOpen(false); setLotTarget(null); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function openLocationCreate(returnTo: 'item' | 'move') {
    locationForm.resetFields();
    setLocationReturn(returnTo);
    setLocationsOpen(true);
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
    const rows = items.filter(row => row.supply_id === selectedId);
    const histories = await Promise.all(rows.map(async row => (await listInventoryMovements(db, row.id))
      .map(movement => ({ ...movement, stock_id: row.id, lot_code: row.lot_code || null,
        location_id: row.location_id }))));
    setMovements(histories.flat().sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)));
  }
  useEffect(() => { void refreshMovements(); }, [db, selectedId, items]);
  useEffect(() => {
    let cancelled = false;
    void listInventoryBalances(db, items).then(balances => { if (!cancelled) setOnHand(balances); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [db, items]);
  useEffect(() => { void listInventoryLocations(db).then(setLocations).catch(cause => setError(String(cause))); }, [db, items]);

  const balance = item ? stockTotal(productRows, onHand, item.default_unit) : undefined;

  async function create(values: { name: string; category: string; default_unit: string;
    starting_quantity?: number; pounds?: number; ounces?: number; location_id?: string; lot_code?: string }) {
    try {
      if (newStockProduct) {
        values.name = newStockProduct.name;
        values.category = newStockProduct.category;
      }
      if (newStockLotCode !== undefined) values.lot_code = newStockLotCode || undefined;
      const starting = quantityForStorage(values.default_unit, values.starting_quantity, values.pounds, values.ounces);
      const locationId = values.location_id || null;
      const match = stockAtLocation(items, values.name, values.category, locationId, values.lot_code?.trim() || null);
      if (items.some(row => row.category === values.category && row.name.trim().toLocaleLowerCase() === values.name.trim().toLocaleLowerCase())
        && (!starting || starting.quantity <= 0)) throw new Error('Enter a positive quantity to add this existing item');
      if (match) {
        if (!starting) throw new Error('Enter a quantity');
        if (convertInventoryUnit(starting.quantity, starting.unit, match.default_unit) == null) throw new Error('Choose a unit compatible with the existing item');
        await addInventoryEntry(db, match.id, 'purchase', starting.quantity, starting.unit, accountId);
      } else {
        await createInventoryItem(db, values.name.trim(), values.category.trim(), storageUnit(values.default_unit),
          starting?.quantity ?? null, accountId, values.default_unit, locationId,
          catalog.find(row => row.category === values.category && row.name === values.name)?.id || null,
          values.lot_code || null);
      }
      setNewItemCategory(null); setNewStockProduct(null); setNewStockLotCode(undefined);
      itemForm.resetFields(); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveLocation(values: { name: string; parent_id?: string; address?: string }) {
    try {
      const id = await saveInventoryLocation(db, values.name, values.parent_id || null, undefined, undefined, values.address);
      setLocations(await listInventoryLocations(db));
      if (locationReturn === 'item') itemForm.setFieldValue('location_id', id);
      if (locationReturn === 'move') moveForm.setFieldValue('location_id', id);
      setLocationsOpen(false);
      locationForm.resetFields(); setLocationReturn(null);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function move(values: { location_id?: string; unit: string; quantity?: number; pounds?: number; ounces?: number; all?: boolean }) {
    if (!moveItem) return;
    try {
      const available = inventoryBalance(await listInventoryMovements(db, moveItem.id), moveItem.default_unit);
      const amount = values.all && available != null ? { quantity: available, unit: moveItem.default_unit }
        : quantityForStorage(values.unit, values.quantity, values.pounds, values.ounces);
      if (!amount) throw new Error('Enter a quantity');
      await moveInventoryStock(db, moveItem, values.location_id || null, amount.quantity, amount.unit);
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
    {!selectedId ? <section className="record-index"><div className="section-heading"><div><span className="eyebrow">Stock ledger</span><h1>Inventory</h1></div></div>
      <p className="muted">Purchases, uses from batches, and physical counts.</p>
      {locations.length > 0 && <div className="inventory-filter"><label htmlFor="inventory-location-filter">Location</label>
        <LocationTreeSelect id="inventory-location-filter" locations={locations} value={activeLocationId}
          style={{ width: `min(100%, ${locationFilterWidth}ch)` }}
          onChange={value => setLocationFilterId(typeof value === 'string' ? value : null)} allowClear placeholder="All locations" />
      </div>}
      {visibleSupplies.length > 0 && <div className="group-tables">{categories.map(category => {
        const rows = visibleSupplies.filter(row => row.category === category);
        return rows.length ? <section key={category} className="group-table"><div className="group-table-heading"><h2>{category}</h2>
          <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label={`Add ${category.toLowerCase()}`} title={`Add ${category.toLowerCase()}`}
            onClick={() => openCreate(category)} /></div>
          <Table<InventoryItem> dataSource={rows} rowKey="id" pagination={false} size="small" scroll={{ x: 520 }}
            columns={[{ title: 'Item', dataIndex: 'name', render: (_, row) =>
              <a href={`${basePath}/inventory/${inventoryPathSegment(row, supplies)}`} onClick={event => { event.preventDefault(); onSelect(row.id); }}>{row.name}</a> },
            { title: 'Lots', key: 'lots', width: 90, render: (_, row) => new Set(visibleItems.filter(stock => stock.supply_id === row.id)
              .map(stock => stock.lot_id || stock.id)).size },
            { title: 'On hand', key: 'on_hand', width: 170, align: 'right', render: (_, row) => stockQuantity(
              visibleItems.filter(stock => stock.supply_id === row.id), onHand, row.default_unit,
              row.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit ? compoundMassUnit
                : visibleItems.find(stock => stock.supply_id === row.id)?.display_unit || row.default_unit) }]} /></section> : null;
      })}</div>}
      {missingCategories.length > 0 && <p className="inventory-add-types">Add {missingCategories.map((category, index) =>
        <span key={category}>{index > 0 && (index === missingCategories.length - 1 ? missingCategories.length === 2 ? ' or ' : ', or ' : ', ')}
          <a href={`${basePath}/inventory`} onClick={event => { event.preventDefault(); openCreate(category); }}>{category.toLowerCase()}</a></span>)}.</p>}
    </section> : !item ? <Empty description="Inventory item not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">{item.category}</span><h2>{item.name}</h2>
          <p className="muted">{balance === undefined ? 'Calculating stock' : balance === null ? 'Balance needs unit conversion'
            : `${formatStockQuantity(balance, item.default_unit, itemDisplayUnit || item.default_unit)} estimated on hand`}</p></div>
          <div className="heading-actions">{['Grain', 'Adjunct', 'Hops', 'Yeast'].includes(item.category) &&
            <Button icon={<SettingOutlined />} onClick={() => {
                setError(''); void supplyIngredientProperties(db, item).then(values => {
                  setSupplyProperties(values); setIngredientSettingsOpen(true);
                }).catch(cause => setError(String(cause)));
              }}>Supply properties</Button>}
            <Button type="primary" onClick={() => openCreate(item.category, item)}>Add stock</Button></div></div>
        {Object.keys(currentIngredientProperties).length > 0 && <p className="muted">{[
          currentIngredientProperties.yield_pct != null && `Yield ${currentIngredientProperties.yield_pct}%`,
          currentIngredientProperties.color_lovibond != null && `Color ${currentIngredientProperties.color_lovibond} °L`,
          currentIngredientProperties.alpha_acid_pct != null && `Alpha acid ${currentIngredientProperties.alpha_acid_pct}%`,
          currentIngredientProperties.hop_form && `${currentIngredientProperties.hop_form} hops`,
          currentIngredientProperties.attenuation_pct != null && `Attenuation ${currentIngredientProperties.attenuation_pct}%`
        ].filter(Boolean).join(' · ')}</p>}
        <h3>Lots and locations</h3>
        <Table<StockTreeRow> key={`${item.id}:${stockTreeRows.filter(row => row.children).map(row => row.key).join(',')}`}
          dataSource={stockTreeRows} rowKey="key" pagination={false} size="small"
          defaultExpandAllRows scroll={{ x: 620 }}
          columns={[{ title: 'Lot', dataIndex: 'lotLabel' },
          { title: 'Location', key: 'location', render: (_, row) => row.stockItem
            ? inventoryLocationPath(row.stockItem.location_id, locations) || 'No location' : '' },
          { title: 'On hand', key: 'on_hand', width: 170, align: 'right', render: (_, row) =>
            stockQuantity(row.rows, onHand, item.default_unit, itemDisplayUnit || item.default_unit) },
          { title: '', key: 'actions', width: 60, align: 'right', render: (_, row) => <Dropdown trigger={['click']}
            menu={{ items: [
              ...(row.lotItem && ['Grain', 'Adjunct', 'Hops', 'Yeast'].includes(item.category)
                ? [{ key: 'lot', label: 'Edit lot properties' }] : []),
              ...(row.lotItem ? [{ key: 'add', label: 'Add stock' }] : []),
              ...(row.stockItem ? [{ key: 'purchase', label: 'Bought' }, { key: 'count', label: 'Counted' },
                { key: 'discard', label: 'Discard' }, { key: 'move', label: 'Move' }] : [])],
            onClick: ({ key }) => {
              if (key === 'lot' && row.lotItem) {
                setLotTarget(row.lotItem);
                void lotIngredientProperties(db, row.lotItem).then(values => {
                  setLotProperties(values); setLotSettingsOpen(true);
                }).catch(cause => setError(String(cause)));
              } else if (key === 'add' && row.lotItem) openCreate(item.category, item, row.lotItem.lot_code, true);
              else if (key === 'move' && row.stockItem) setMoveItemId(row.stockItem.id);
              else if (row.stockItem) void openEntry(row.stockItem, key as 'purchase' | 'count' | 'discard');
            } }}>
            <Button type="text" shape="circle" icon={<MoreOutlined />}
              aria-label={`Actions for ${row.lotLabel || row.locationLabel}`} />
          </Dropdown> }]} />
        {movements.length > 0 && <><h3>Stock history</h3>
        <Table<StockMovement> className="inventory-history" dataSource={movements} rowKey={row => `${row.stock_id}-${row.kind}-${row.id}`}
          pagination={false} size="small" scroll={{ x: 650 }}
          columns={[{ title: 'When', dataIndex: 'at', width: 190, render: at => formatTime(at) },
            { title: 'Activity', dataIndex: 'kind', width: 120 },
            { title: 'Lot', key: 'lot', render: (_, row) => row.lot_code || 'Unspecified' },
            { title: 'Location', key: 'location', render: (_, row) => inventoryLocationPath(row.location_id, locations) || 'No location' },
            { title: 'Quantity', key: 'quantity', align: 'right', render: (_, row) =>
              `${row.kind === 'Purchased' || row.kind === 'Moved in' ? '+' : row.kind === 'Used' || row.kind === 'Discarded' || row.kind === 'Moved out' ? '−' : 'Set to '}${formatStockQuantity(row.quantity, row.unit, itemDisplayUnit || row.unit)}` }]} /></>}
      </section>}
    <Modal title={item ? `${item.name} supply defaults` : 'Supply defaults'} open={ingredientSettingsOpen}
      onCancel={() => setIngredientSettingsOpen(false)} footer={null} destroyOnHidden>
      {error && <Alert type="error" message={error} className="form-alert" />}
      <Form key={`${item?.supply_id}:${ingredientSettingsOpen}`} layout="vertical" initialValues={supplyProperties} onFinish={saveIngredientProperties}>
        <PropertyFields category={item?.category || ''} />
        <Button type="primary" htmlType="submit">Save properties</Button>
      </Form>
    </Modal>
    <Modal title={lotTarget ? `${lotTarget.lot_code ? `Lot ${lotTarget.lot_code}` : 'Unspecified lot'} properties` : 'Lot properties'} open={lotSettingsOpen}
      onCancel={() => { setLotSettingsOpen(false); setLotTarget(null); }} footer={null} destroyOnHidden>
      <p className="muted">Set values specific to this lot. Leave a value empty to use the supply or catalog default.</p>
      <Form key={`${lotTarget?.lot_id}:lot:${lotSettingsOpen}`} layout="vertical" initialValues={lotProperties} onFinish={saveLotProperties}>
        <PropertyFields category={lotTarget?.category || ''} />
        <Button type="primary" htmlType="submit">Save lot properties</Button>
      </Form>
    </Modal>
    <Modal title={newStockProduct ? `Add ${newStockProduct.name} stock` : newItemCategory
      ? `New ${newItemCategory.toLowerCase()} item` : 'New inventory item'} open={!!newItemCategory}
      onCancel={() => { setNewItemCategory(null); setNewStockProduct(null); setNewStockLotCode(undefined); }} footer={null} destroyOnHidden>
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      <Form form={itemForm} layout="vertical" onFinish={create}>
        <Form.Item name="category" hidden><Input /></Form.Item>
        <Form.Item name="name" label="Item" rules={[{ required: true, whitespace: true }]}>
          <AutoComplete placeholder="Search supplies or enter an item" maxLength={120} disabled={!!newStockProduct}
            options={[
              ...supplies.filter(row => row.category === newItemCategory).map(row => ({ value: row.name, label: `${row.name} · Your supplies` })),
              ...catalog.filter(row => row.category === newItemCategory && !supplies.some(owned =>
                owned.category === row.category && owned.name.toLowerCase() === row.name.toLowerCase()))
                .map(row => ({ value: row.name, label: `${row.name} · Shared catalog` }))
            ]}
            filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
            onSelect={value => { const entry = supplies.find(row => row.category === newItemCategory && row.name === value)
              || catalog.find(row => row.category === newItemCategory && row.name === value);
              if (entry) { const storedUnit = 'unit' in entry ? entry.unit : entry.default_unit;
                const nextUnit = ['Grain', 'Hops', 'Nutrient'].includes(entry.category)
                  ? unitForCategory(entry.category, preferredUnits.mass) : storedUnit === 'ml' ? 'mL' : storedUnit;
                changeQuantityUnit(itemForm, previousItemUnit.current, nextUnit, 'starting_quantity');
                previousItemUnit.current = nextUnit;
                itemForm.setFieldValue('default_unit', nextUnit); } }} />
        </Form.Item>
        <Form.Item name="location_id" label="Location (optional)" normalize={(value, previousValue) => {
          if (value === newLocationOption) { openLocationCreate('item'); return previousValue; }
          return value;
        }}>
          <LocationTreeSelect locations={locations} includeCreate allowClear placeholder="Choose a location" />
        </Form.Item>
        <Form.Item name="lot_code" label="Lot code (optional)"><Input maxLength={80} disabled={newStockLotCode !== undefined} /></Form.Item>
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
        <p className="muted">From {inventoryLocationPath(moveItem?.location_id || null, locations) || 'no location'}.
          {moveItem && onHand[moveItem.id] != null ? ` ${formatQuantity(onHand[moveItem.id]!, moveItem.default_unit, moveItem.display_unit)} available.` : ''}</p>
        <Form.Item name="location_id" label="To location (optional)" normalize={(value, previousValue) => {
          if (value === newLocationOption) { openLocationCreate('move'); return previousValue; }
          return value;
        }}>
          <LocationTreeSelect locations={locations} excludedIds={new Set(moveItem?.location_id ? [moveItem.location_id] : [])}
            includeCreate allowClear placeholder="Leave empty to clear location" />
        </Form.Item>
        <Form.Item name="all" valuePropName="checked"><Checkbox>Move all available stock</Checkbox></Form.Item>
        {!moveAll && <><Form.Item name="unit" label="Unit" rules={[{ required: true }]}>
          <Select options={unitOptions(quantityUnitsForCategory(moveItem?.category || 'Other'))} /></Form.Item>
          <QuantityFields unit={moveUnit || moveItem?.display_unit || moveItem?.default_unit || 'each'} /></>}
        <Button type="primary" htmlType="submit">Move stock</Button>
      </Form>
    </Modal>
    <Modal title="New location" open={locationsOpen} onCancel={() => { setLocationsOpen(false); setLocationReturn(null); }}
      footer={null} width={620} zIndex={locationReturn ? 1100 : undefined}>
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      <Form form={locationForm} layout="vertical" onFinish={saveLocation}>
        <LocationFields locations={locations} />
        <Button type="primary" htmlType="submit">Add location</Button>
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
