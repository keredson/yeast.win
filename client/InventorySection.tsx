import { useEffect, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Checkbox, Dropdown, Empty, Form, Input, InputNumber, Modal, Select, Table } from 'antd';
import { EditOutlined, MoreOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { inventoryCategories, unitForCategory, type CatalogInventory } from '../shared/catalog.ts';
import { addInventoryEntry, convertInventoryUnit, createInventoryItem, inventoryBalance, inventoryLocationPath,
  listInventoryBalances, listInventoryLocations, listInventoryMovements, moveInventoryStock, saveInventoryLocation, stockAtLocation,
  updateIngredientProperties, updateLotIngredientProperties, supplyIngredientProperties, lotIngredientProperties, ingredientProperties,
  readSupplyMedia, saveSupplyMedia, linkSupplyCatalogProduct,
  supplyContainerSpecs, saveSupplyContainerSpecs,
  type ContainerSpecs, type IngredientProperties, type InventoryItem, type InventoryLocation, type InventoryMovement, type LocalDb, type SupplyMedia } from './db.ts';
import { formatTime } from './time.ts';
import type { PreferredUnits } from './api.ts';
import { compoundMassUnit, formatQuantity, quantityForStorage, quantityUnitsForCategory, storageUnit, unitOptions } from '../shared/units.ts';
import { QuantityFields } from './QuantityFields.tsx';
import { changeQuantityUnit } from './unitFields.ts';
import { inventoryPathSegment } from './inventoryRoutes.ts';
import { LocationFields } from './LocationFields.tsx';
import { LocationTreeSelect, newLocationOption } from './LocationTreeSelect.tsx';
import { locationDescendantIds } from './locationRoutes.ts';
import { CatalogImage, useCatalogMedia } from './CatalogImage.tsx';
import { findCatalogSupply, queryCatalogSupplies } from './catalog.ts';
import { WorkspaceThumbnail } from './WorkspaceThumbnail.tsx';

function catalogCharacteristics(product: CatalogInventory): string {
  const details: string[] = [product.category];
  if (product.category === 'Grain' || product.category === 'Adjunct') {
    if (product.grain_class) details.push(product.grain_class);
    if (product.color_lovibond != null) details.push(`${product.color_lovibond} °L`);
    if (product.yield_pct != null) details.push(`${product.yield_pct}% yield`);
  } else if (product.category === 'Other fermentables') {
    if (product.typical_brix != null) details.push(`Typical ${product.typical_brix} °Brix`);
    if (product.extract_color_value != null) details.push(`Color ${product.extract_color_value} ${product.extract_color_scale || ''}`.trim());
  } else if (product.category === 'Hops') {
    if (product.alpha_acid_pct != null) details.push(`${product.alpha_acid_pct}% alpha acid`);
    if (product.hop_form) details.push(product.hop_form);
  } else if (product.category === 'Yeast' && product.attenuation_pct != null) {
    details.push(`${product.attenuation_pct}% attenuation`);
  } else if (product.category === 'Packaging') {
    if (product.container_kind) details.push(product.container_kind);
    if (product.capacity_liters != null) details.push(`${Number(product.capacity_liters.toFixed(2))} L`);
    if (product.material) details.push(product.material);
    if (product.wood_origin || product.wood_species) details.push(
      [product.wood_origin, product.wood_species].filter(Boolean).join(' '));
    if (product.connector_type) details.push(product.connector_type);
  }
  return details.join(' · ');
}

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
type InventoryIndexRow = { key: string; supply: InventoryItem; stocks: InventoryItem[];
  locationId?: string | null; child?: boolean; children?: InventoryIndexRow[] };

function inventoryIndexRows(supplies: InventoryItem[], stocks: InventoryItem[], locations: InventoryLocation[]): InventoryIndexRow[] {
  return supplies.map(supply => {
    const productStocks = stocks.filter(stock => stock.supply_id === supply.id);
    const byLocation = new Map<string | null, InventoryItem[]>();
    for (const stock of productStocks) {
      const locationId = stock.location_id || null;
      byLocation.set(locationId, [...(byLocation.get(locationId) || []), stock]);
    }
    const locationRows = [...byLocation.entries()].sort(([a], [b]) =>
      inventoryLocationPath(a, locations).localeCompare(inventoryLocationPath(b, locations)));
    return { key: `supply:${supply.id}`, supply, stocks: productStocks,
      ...(locationRows.length === 1 ? { locationId: locationRows[0][0] } : {}),
      ...(locationRows.length > 1 ? { children: locationRows.map(([locationId, group]) => ({
        key: `location:${supply.id}:${locationId || 'none'}`, supply, stocks: group, locationId, child: true })) } : {}) };
  });
}

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
      locationLabel: stockRows[0].location_name || '', rows: stockRows,
      lotItem: stockRows[0], stockItem: stockRows[0] };
    return { key: `lot:${lotId}`, lotLabel, locationLabel: '', rows: stockRows, lotItem: stockRows[0],
      children: stockRows.map(row => ({ key: `stock:${row.id}`, lotLabel: '',
        locationLabel: row.location_name || '', rows: [row], stockItem: row })) };
  }).sort((a, b) => a.lotLabel.localeCompare(b.lotLabel));
}

function PropertyFields({ category, includeClass = false }: { category: string; includeClass?: boolean }) {
  return <>
    {category === 'Grain' && includeClass && <Form.Item name="grain_class" label="Grain class">
      <Select allowClear options={['base', 'kilned', 'caramel', 'roasted', 'flaked', 'other']
        .map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }))} /></Form.Item>}
    {['Grain', 'Adjunct'].includes(category) && <><Form.Item name="yield_pct" label="Extract yield (%)">
      <InputNumber className="full-width" min={0} max={100} step="any" /></Form.Item>
      <Form.Item name="color_lovibond" label="Color (°L)"><InputNumber className="full-width" min={0} step="any" /></Form.Item></>}
    {category === 'Other fermentables' && <>
      <Form.Item name="typical_brix" label="Typical °Brix"><InputNumber className="full-width" min={0} max={100} step="any" /></Form.Item>
      <div className="form-pair"><Form.Item name="extract_color_value" label="Extract color">
        <InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="extract_color_scale" label="Color scale"><Select allowClear
          options={['°L', 'SRM', 'EBC'].map(value => ({ value, label: value }))} /></Form.Item></div>
      <div className="form-pair"><Form.Item name="extract_color_reference_value" label="Color measured at">
        <InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="extract_color_reference_unit" label="Reference unit"><Select allowClear
          options={['°P', '% w/v'].map(value => ({ value, label: value }))} /></Form.Item></div>
    </>}
    {category === 'Hops' && <><Form.Item name="alpha_acid_pct" label="Alpha acid (%)">
      <InputNumber className="full-width" min={0} max={100} step="any" /></Form.Item>
      <Form.Item name="hop_form" label="Form"><Select allowClear options={[
        { value: 'pellet', label: 'Pellet' }, { value: 'whole', label: 'Whole leaf' }, { value: 'plug', label: 'Plug' }
      ]} /></Form.Item></>}
    {category === 'Yeast' && <Form.Item name="attenuation_pct" label="Apparent attenuation (%)">
      <InputNumber className="full-width" min={0} max={100} step="any" /></Form.Item>}
  </>;
}

function PackagingFields({ defaults }: { defaults?: ContainerSpecs }) {
  const form = Form.useFormInstance();
  const kind = Form.useWatch('container_kind', form) || defaults?.container_kind;
  const material = Form.useWatch('material', form) || defaults?.material;
  return <>
    <Form.Item name="container_kind" label="Container type"><Select allowClear options={[
      { value: 'keg', label: 'Keg' }, { value: 'barrel', label: 'Barrel' }, { value: 'bottle', label: 'Bottle' }
    ]} /></Form.Item>
    {kind && <Form.Item name="capacity_liters" label="Capacity (L)" preserve={false}>
      <InputNumber className="full-width" min={0} step="any" placeholder={defaults?.capacity_liters?.toString()} />
    </Form.Item>}
    <Form.Item name="material" label="Material"><Input placeholder={defaults?.material || 'Stainless steel, PET, wood…'} /></Form.Item>
    {kind === 'barrel' && material?.toLowerCase() === 'wood' && <>
      <Form.Item name="wood_species" label="Wood species" preserve={false}><Input placeholder={defaults?.wood_species || 'Oak'} /></Form.Item>
      <Form.Item name="wood_origin" label="Wood origin" preserve={false}><Input placeholder={defaults?.wood_origin || 'French, American…'} /></Form.Item>
    </>}
    {kind === 'keg' && <Form.Item name="connector_type" label="Connector type" preserve={false}>
      <Input placeholder={defaults?.connector_type || 'Ball lock, Sanke D…'} /></Form.Item>}
  </>;
}

export function InventorySection({ db, basePath, accountId, items, supplies, catalogRevision, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; items: InventoryItem[]; supplies: InventoryItem[]; catalogRevision: number; preferredUnits: PreferredUnits;
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
  const [catalogPickerOpen, setCatalogPickerOpen] = useState(false);
  const [catalogPickerPurpose, setCatalogPickerPurpose] = useState<'add' | 'link'>('add');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogCategory, setCatalogCategory] = useState<string | undefined>();
  const [catalogForOwned, setCatalogForOwned] = useState<CatalogInventory[]>([]);
  const [matchingCatalog, setMatchingCatalog] = useState<CatalogInventory[]>([]);
  const [catalogSuggestions, setCatalogSuggestions] = useState<CatalogInventory[]>([]);
  const [selectedCatalogProduct, setSelectedCatalogProduct] = useState<CatalogInventory | null>(null);
  const [catalogProductChosen, setCatalogProductChosen] = useState(false);
  const [supplyMedia, setSupplyMedia] = useState<{ supplyId: string; row: SupplyMedia | null; imageUrl: string | null } | null>(null);
  const [mediaRevision, setMediaRevision] = useState(0);
  const [editingProductUrl, setEditingProductUrl] = useState(false);
  const [productUrlDraft, setProductUrlDraft] = useState('');
  const [editingProductImage, setEditingProductImage] = useState(false);
  const [imageEdit, setImageEdit] = useState<File | null | undefined>();
  const [creatingCustomProduct, setCreatingCustomProduct] = useState(false);
  const [ingredientSettingsOpen, setIngredientSettingsOpen] = useState(false);
  const [supplyProperties, setSupplyProperties] = useState<IngredientProperties>({});
  const [containerProperties, setContainerProperties] = useState<ContainerSpecs>({});
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
  const catalog = [...catalogForOwned, ...matchingCatalog, ...catalogSuggestions];
  const item = supplies.find(row => row.id === selectedId) || null;
  const catalogProduct = catalog.find(row => row.id === item?.catalog_supply_id);
  const activeMedia = supplyMedia?.supplyId === item?.id ? supplyMedia : null;
  const catalogProductImageUrl = useCatalogMedia('supply', catalogProduct?.has_image ? catalogProduct.id : null);
  const productImageUrl = activeMedia?.imageUrl || catalogProductImageUrl;
  const productUrl = activeMedia?.row?.product_url || catalogProduct?.product_url;
  const productRows = items.filter(row => row.supply_id === item?.id);
  const stockTreeRows = stockTree(productRows);
  const currentIngredientProperties = ingredientProperties(item);
  const entryItem = items.find(row => row.id === entryItemId) || null;
  const newItemUnit = Form.useWatch('default_unit', itemForm) as string | undefined;
  const draftCategory = Form.useWatch('category', itemForm) as string | undefined;
  const activeNewCategory = draftCategory || newItemCategory || 'Other';
  const newItemName = Form.useWatch('name', itemForm) as string | undefined;
  const ownedCatalogIds = supplies.map(row => row.catalog_supply_id).filter((id): id is string => !!id).join('\u0000');
  useEffect(() => {
    let cancelled = false;
    const ids = ownedCatalogIds ? ownedCatalogIds.split('\u0000') : [];
    void queryCatalogSupplies({ ids }).then(rows => { if (!cancelled) setCatalogForOwned(rows); })
      .catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [ownedCatalogIds, catalogRevision]);
  useEffect(() => {
    if (!catalogPickerOpen) { setMatchingCatalog([]); return; }
    let cancelled = false;
    void queryCatalogSupplies({ category: catalogCategory, query: catalogQuery, limit: null })
      .then(rows => { if (!cancelled) setMatchingCatalog(rows); })
      .catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [catalogPickerOpen, catalogCategory, catalogQuery, catalogRevision]);
  useEffect(() => {
    if (!newItemCategory) { setCatalogSuggestions([]); return; }
    let cancelled = false;
    void queryCatalogSupplies({ category: activeNewCategory, query: newItemName || '', limit: 80 })
      .then(rows => { if (!cancelled) setCatalogSuggestions(rows); })
      .catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [newItemCategory, activeNewCategory, newItemName, catalogRevision]);
  const newLotCode = Form.useWatch('lot_code', itemForm) as string | undefined;
  const entryUnit = Form.useWatch('unit', entryForm) as string | undefined;
  const discardAll = Form.useWatch('all', entryForm) as boolean | undefined;
  const newLocationId = Form.useWatch('location_id', itemForm) as string | undefined;
  const moveAll = Form.useWatch('all', moveForm) as boolean | undefined;
  const moveUnit = Form.useWatch('unit', moveForm) as string | undefined;
  const moveItem = items.find(row => row.id === moveItemId) || null;
  const itemDisplayUnit = item?.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit
    ? compoundMassUnit : productRows[0]?.display_unit || item?.display_unit || item?.default_unit;
  const categories = [...new Set([...inventoryCategories,
    ...supplies.map(row => row.category)])].filter(Boolean);
  const addCategories = inventoryCategories.filter(category => category !== 'Other');
  const activeLocationId = locations.some(location => location.id === locationFilterId) ? locationFilterId : null;
  const locationFilterLabel = inventoryLocationPath(activeLocationId, locations) || 'All locations';
  const locationFilterWidth = Math.max(18, Math.min(42, locationFilterLabel.length + 5));
  const visibleLocationIds = activeLocationId ? locationDescendantIds(activeLocationId, locations) : null;
  const visibleItems = visibleLocationIds ? items.filter(row => row.location_id && visibleLocationIds.has(row.location_id)) : items;
  const visibleSupplies = supplies.filter(row => visibleItems.some(stock => stock.supply_id === row.id));
  const indexRows = inventoryIndexRows(visibleSupplies, visibleItems, locations);
  const existingItem = items.find(row => row.category === activeNewCategory && row.name.trim().toLocaleLowerCase() === newItemName?.trim().toLocaleLowerCase());
  const existingAtLocation = existingItem
    ? stockAtLocation(items, existingItem.name, existingItem.category, newLocationId || null, newLotCode?.trim() || null) : undefined;
  const entryDisplayUnit = entryItem?.display_unit === compoundMassUnit || entryItem?.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit
    ? compoundMassUnit : entryItem?.display_unit || entryItem?.default_unit;

  function openCreate(category: string, product?: InventoryItem, lotCode?: string | null, lockLot = false,
    catalogProduct?: CatalogInventory) {
    itemForm.resetFields();
    const unit = product?.default_unit || catalogProduct?.unit || unitForCategory(category, preferredUnits.mass);
    previousItemUnit.current = unit;
    itemForm.setFieldsValue({ category, name: product?.name, lot_code: lotCode || undefined,
      default_unit: unit, location_id: activeLocationId || undefined });
    setNewStockProduct(product || null);
    setSelectedCatalogProduct(catalogProduct || null);
    setCatalogProductChosen(false);
    setCreatingCustomProduct(false);
    setNewStockLotCode(lockLot ? lotCode || null : undefined);
    setNewItemCategory(category);
  }

  function openCatalog(category?: string, purpose: 'add' | 'link' = 'add') {
    setCatalogQuery(''); setCatalogCategory(category);
    setCatalogPickerPurpose(purpose); setCatalogPickerOpen(true);
  }

  function createCustomProduct(category: string) {
    setCatalogPickerOpen(false);
    openCreate(category);
    setCreatingCustomProduct(true);
  }

  function createOtherProduct() {
    openCreate('Other');
    setCreatingCustomProduct(true);
  }

  function addCategory(category: string) {
    if (category === 'Other') createOtherProduct();
    else openCatalog(category);
  }

  async function chooseCatalogProduct(product: CatalogInventory) {
    setCatalogPickerOpen(false);
    if (catalogPickerPurpose === 'link' && item) {
      try { await linkSupplyCatalogProduct(db, item.id, product.id); await onChanged(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      return;
    }
    const existing = supplies.find(row => row.catalog_supply_id === product.id)
      || supplies.find(row => row.category === product.category && row.name.toLocaleLowerCase() === product.name.toLocaleLowerCase());
    openCreate(product.category, existing, undefined, false, product);
    if (!existing) itemForm.setFieldValue('name', product.name);
    setCatalogProductChosen(true);
  }

  async function saveIngredientProperties(values: IngredientProperties) {
    if (!item) return;
    try { await updateIngredientProperties(db, item, values); setIngredientSettingsOpen(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveContainerProperties(values: ContainerSpecs) {
    if (!item?.supply_id) return;
    try { await saveSupplyContainerSpecs(db, item.supply_id, values); setIngredientSettingsOpen(false); await onChanged(); }
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
  useEffect(() => {
    if (!item) { setSupplyMedia(null); return; }
    let cancelled = false;
    let imageUrl: string | null = null;
    setSupplyMedia(null);
    void readSupplyMedia(db, item.id).then(row => {
      if (row?.image_bytes?.length && row.image_mime_type) {
        imageUrl = URL.createObjectURL(new Blob([new Uint8Array(row.image_bytes)], { type: row.image_mime_type }));
      }
      if (cancelled) { if (imageUrl) URL.revokeObjectURL(imageUrl); }
      else setSupplyMedia({ supplyId: item.id, row, imageUrl });
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [db, item?.id, mediaRevision]);
  const balance = item ? stockTotal(productRows, onHand, item.default_unit) : undefined;

  async function create(values: { name: string; category: string; default_unit: string;
    starting_quantity?: number; pounds?: number; ounces?: number; location_id?: string; lot_code?: string }
    & IngredientProperties & ContainerSpecs) {
    try {
      if (newStockProduct) {
        values.name = newStockProduct.name;
        values.category = newStockProduct.category;
      }
      if (newStockLotCode !== undefined) values.lot_code = newStockLotCode || undefined;
      const starting = quantityForStorage(values.default_unit, values.starting_quantity, values.pounds, values.ounces);
      const locationId = values.location_id || null;
      if (creatingCustomProduct && supplies.some(row => row.category === values.category
        && row.name.trim().toLocaleLowerCase() === values.name.trim().toLocaleLowerCase())) {
        throw new Error('This product already exists in your supplies');
      }
      const match = stockAtLocation(items, values.name, values.category, locationId, values.lot_code?.trim() || null);
      if (items.some(row => row.category === values.category && row.name.trim().toLocaleLowerCase() === values.name.trim().toLocaleLowerCase())
        && (!starting || starting.quantity <= 0)) throw new Error('Enter a positive quantity to add this existing item');
      if (match) {
        if (!starting) throw new Error('Enter a quantity');
        if (convertInventoryUnit(starting.quantity, starting.unit, match.default_unit) == null) throw new Error('Choose a unit compatible with the existing item');
        await addInventoryEntry(db, match.id, 'purchase', starting.quantity, starting.unit, accountId);
      } else {
        const catalogMatch = creatingCustomProduct ? null : selectedCatalogProduct?.name === values.name
          ? selectedCatalogProduct : await findCatalogSupply(values.category, values.name);
        await createInventoryItem(db, values.name.trim(), values.category.trim(), storageUnit(values.default_unit),
          starting?.quantity ?? null, accountId, values.default_unit, locationId,
          catalogMatch?.id || null,
          values.lot_code || null, creatingCustomProduct ? {
            grain_class: values.grain_class, yield_pct: values.yield_pct, color_lovibond: values.color_lovibond,
            alpha_acid_pct: values.alpha_acid_pct, hop_form: values.hop_form, attenuation_pct: values.attenuation_pct,
            typical_brix: values.typical_brix, extract_color_value: values.extract_color_value,
            extract_color_scale: values.extract_color_scale, extract_color_reference_value: values.extract_color_reference_value,
            extract_color_reference_unit: values.extract_color_reference_unit
          } : undefined, creatingCustomProduct && values.category === 'Packaging' ? {
            container_kind: values.container_kind, capacity_liters: values.capacity_liters,
            material: values.material, wood_species: values.wood_species,
            wood_origin: values.wood_origin, connector_type: values.connector_type
          } : undefined);
      }
      setNewItemCategory(null); setNewStockProduct(null); setNewStockLotCode(undefined);
      setSelectedCatalogProduct(null); setCatalogProductChosen(false); setCreatingCustomProduct(false);
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
        const rows = indexRows.filter(row => row.supply.category === category);
        return rows.length ? <section key={category} className="group-table"><div className="group-table-heading"><h2>{category}</h2>
          <Button type="text" shape="circle" icon={<PlusOutlined />} aria-label={`Add ${category.toLowerCase()}`} title={`Add ${category.toLowerCase()}`}
            onClick={() => addCategory(category)} /></div>
          <Table<InventoryIndexRow> key={rows.filter(row => row.children).map(row => row.key).join(',')}
            className="inventory-table" dataSource={rows} rowKey="key" pagination={false} size="small"
            expandable={{ defaultExpandAllRows: true, expandIconColumnIndex: 1 }} scroll={{ x: 660 }}
            columns={[{ title: '', key: 'image', width: 20, className: 'inventory-thumbnail-cell', render: (_, row) => {
              if (row.child) return null;
              const catalogProduct = catalog.find(product => product.id === row.supply.catalog_supply_id);
              return <WorkspaceThumbnail db={db} kind="supply" id={row.supply.id} revision={mediaRevision}
                className="inventory-table-thumbnail" fallback={catalogProduct?.has_image
                  ? <CatalogImage kind="supply" id={catalogProduct.id} className="inventory-table-thumbnail" /> : null} />;
            } },
            { title: 'Item', key: 'name', render: (_, row) => row.child ? null
              : <a href={`${basePath}/inventory/${inventoryPathSegment(row.supply, supplies)}`}
                onClick={event => { event.preventDefault(); onSelect(row.supply.id); }}>{row.supply.name}</a> },
            { title: 'Location', key: 'location', width: 180, render: (_, row) => row.locationId !== undefined
              ? inventoryLocationPath(row.locationId, locations) : '' },
            { title: 'Lots', key: 'lots', width: 90, render: (_, row) => new Set(row.stocks
              .map(stock => stock.lot_id || stock.id)).size },
            { title: 'On hand', key: 'on_hand', width: 170, align: 'right', render: (_, row) => stockQuantity(
              row.stocks, onHand, row.supply.default_unit,
              row.supply.default_unit === 'oz' && preferredUnits.mass === compoundMassUnit ? compoundMassUnit
                : row.stocks[0]?.display_unit || row.supply.default_unit) }]} /></section> : null;
      })}</div>}
      <p className="inventory-add-types">Add {addCategories.map((category, index) =>
        <span key={category}>{index > 0 && ', '}
          <a href={`${basePath}/inventory`} onClick={event => { event.preventDefault(); addCategory(category); }}>{category.toLowerCase()}</a></span>)}{addCategories.length ? ', or ' : ''}
        <a href={`${basePath}/inventory`} onClick={event => { event.preventDefault(); createOtherProduct(); }}>other</a>.</p>
    </section> : !item ? <Empty description="Inventory item not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">{item.category}</span><h2>{item.name}</h2>
          <p className="muted">{balance === undefined ? 'Calculating stock' : balance === null ? 'Balance needs unit conversion'
            : `${formatStockQuantity(balance, item.default_unit, itemDisplayUnit || item.default_unit)} estimated on hand`}</p></div>
          <div className="heading-actions">{['Grain', 'Other fermentables', 'Adjunct', 'Hops', 'Yeast', 'Packaging'].includes(item.category) &&
            <Button icon={<SettingOutlined />} onClick={() => {
                setError(''); void (item.category === 'Packaging' && item.supply_id
                  ? supplyContainerSpecs(db, item.supply_id) : supplyIngredientProperties(db, item)).then(values => {
                  if (item.category === 'Packaging') setContainerProperties(values as ContainerSpecs);
                  else setSupplyProperties(values as IngredientProperties);
                  setIngredientSettingsOpen(true);
                }).catch(cause => setError(String(cause)));
              }}>Supply properties</Button>}
            <Button type="primary" onClick={() => openCreate(item.category, item)}>Add stock</Button></div></div>
        <div className="supply-product-overview">
          <div className="supply-product-links">
            {catalogProduct?.manufacturer && <p><strong>{catalogProduct.manufacturer}</strong></p>}
            <div><span>Product: </span>{productUrl
              ? <a href={productUrl} target="_blank" rel="noopener noreferrer">{productUrl}</a> : <span>Not set</span>}</div>
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
              setProductUrlDraft(activeMedia?.row?.product_url || productUrl || '');
              setEditingProductUrl(true);
            }}>Edit product URL</Button>
            {!catalogProduct && <Button type="link" className="supply-catalog-link" onClick={() => openCatalog(item.category, 'link')}>
              Link catalog product
            </Button>}
          </div>
          <div className={`supply-product-image${!activeMedia?.imageUrl && catalogProduct?.manufacturer === 'Briess'
            && catalogProduct.category === 'Grain' ? ' catalog-grain-banner' : ''}`}>
            {productImageUrl ? <img src={productImageUrl} alt={item.name} /> : <span className="muted">No product image</span>}
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => {
              setImageEdit(undefined); setEditingProductImage(true);
            }}>Edit image</Button>
          </div>
        </div>
        {Object.keys(currentIngredientProperties).length > 0 && <p className="muted">{[
          currentIngredientProperties.yield_pct != null && `Yield ${currentIngredientProperties.yield_pct}%`,
          currentIngredientProperties.color_lovibond != null && `Color ${currentIngredientProperties.color_lovibond} °L`,
          currentIngredientProperties.alpha_acid_pct != null && `Alpha acid ${currentIngredientProperties.alpha_acid_pct}%`,
          currentIngredientProperties.hop_form && `${currentIngredientProperties.hop_form} hops`,
          currentIngredientProperties.attenuation_pct != null && `Attenuation ${currentIngredientProperties.attenuation_pct}%`,
          currentIngredientProperties.typical_brix != null && `Typical ${currentIngredientProperties.typical_brix} °Brix`,
          currentIngredientProperties.extract_color_value != null && `Extract color ${currentIngredientProperties.extract_color_value} ${currentIngredientProperties.extract_color_scale || ''}${currentIngredientProperties.extract_color_reference_value != null ? ` at ${currentIngredientProperties.extract_color_reference_value} ${currentIngredientProperties.extract_color_reference_unit || ''}` : ''}`,
          item.grain_class && `${item.grain_class} grain class`
        ].filter(Boolean).join(' · ')}</p>}
        {item.category === 'Packaging' && <p className="muted">{catalogCharacteristics({
          id: item.id, name: item.name, category: item.category, unit: item.default_unit,
          container_kind: item.container_kind, capacity_liters: item.capacity_liters,
          material: item.material, wood_species: item.wood_species,
          wood_origin: item.wood_origin, connector_type: item.connector_type
        })}</p>}
        <h3>Lots and locations</h3>
        <Table<StockTreeRow> key={`${item.id}:${stockTreeRows.filter(row => row.children).map(row => row.key).join(',')}`}
          dataSource={stockTreeRows} rowKey="key" pagination={false} size="small"
          defaultExpandAllRows scroll={{ x: 620 }}
          columns={[{ title: 'Lot', dataIndex: 'lotLabel' },
          { title: 'Location', key: 'location', render: (_, row) => row.stockItem
            ? inventoryLocationPath(row.stockItem.location_id, locations) : '' },
          { title: 'On hand', key: 'on_hand', width: 170, align: 'right', render: (_, row) =>
            stockQuantity(row.rows, onHand, item.default_unit, itemDisplayUnit || item.default_unit) },
          { title: '', key: 'actions', width: 60, align: 'right', render: (_, row) => <Dropdown trigger={['click']}
            menu={{ items: [
              ...(row.lotItem && ['Grain', 'Other fermentables', 'Adjunct', 'Hops', 'Yeast'].includes(item.category)
                ? [{ key: 'lot', label: 'Edit lot properties' }] : []),
              ...(row.lotItem ? [{ key: 'add', label: 'Add stock' }] : []),
              ...(row.stockItem ? [{ key: 'purchase', label: 'Buy' }, { key: 'count', label: 'Count' },
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
              aria-label={`Actions for ${row.lotLabel || row.locationLabel || item.name}`} />
          </Dropdown> }]} />
        {movements.length > 0 && <><h3>Stock history</h3>
        <Table<StockMovement> className="inventory-history" dataSource={movements} rowKey={row => `${row.stock_id}-${row.kind}-${row.id}`}
          pagination={false} size="small" scroll={{ x: 650 }}
          columns={[{ title: 'When', dataIndex: 'at', width: 190, render: at => formatTime(at) },
            { title: 'Activity', dataIndex: 'kind', width: 120 },
            { title: 'Lot', key: 'lot', render: (_, row) => row.lot_code || 'Unspecified' },
            { title: 'Location', key: 'location', render: (_, row) => inventoryLocationPath(row.location_id, locations) },
            { title: 'Quantity', key: 'quantity', align: 'right', render: (_, row) =>
              `${row.kind === 'Purchased' || row.kind === 'Moved in' ? '+' : row.kind === 'Used' || row.kind === 'Discarded' || row.kind === 'Moved out' ? '−' : 'Set to '}${formatStockQuantity(row.quantity, row.unit, itemDisplayUnit || row.unit)}` }]} /></>}
      </section>}
    <Modal title="Edit product URL" open={editingProductUrl} onCancel={() => setEditingProductUrl(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={async () => {
        if (!item) return;
        try {
          await saveSupplyMedia(db, item.id, {
            productUrl: productUrlDraft.trim() === (catalogProduct?.product_url || '') ? null : productUrlDraft
          });
          setEditingProductUrl(false); setMediaRevision(value => value + 1); await onChanged();
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>
        <Form.Item label="Product URL"><Input type="url" aria-label="Product URL" value={productUrlDraft}
          onChange={event => setProductUrlDraft(event.target.value)} placeholder="https://manufacturer.example/product" /></Form.Item>
        {catalogProduct && <Button type="text" onClick={() => {
          setProductUrlDraft(catalogProduct.product_url || '');
        }}>Restore catalog URL</Button>}
        <Button type="primary" htmlType="submit">Save URL</Button>
      </Form>
    </Modal>
    <Modal title="Edit product image" open={editingProductImage} onCancel={() => setEditingProductImage(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={async () => {
        if (!item || imageEdit === undefined) return;
        try {
          const image = imageEdit === null ? null
            : { bytes: new Uint8Array(await imageEdit.arrayBuffer()), mimeType: imageEdit.type };
          await saveSupplyMedia(db, item.id, { image });
          setEditingProductImage(false); setMediaRevision(value => value + 1); await onChanged();
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>
        <Form.Item label="Product image"><input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Product image"
          onChange={event => setImageEdit(event.target.files?.[0])} /></Form.Item>
        {imageEdit instanceof File && <p className="muted">Selected: {imageEdit.name}</p>}
        {activeMedia?.row?.image_bytes && <Button type="text" onClick={() => setImageEdit(null)}>
          Restore image to {catalogProduct?.has_image ? 'catalog default' : 'no image'}</Button>}
        {imageEdit === null && <p className="muted">The saved image will be removed.</p>}
        <Button type="primary" htmlType="submit" disabled={imageEdit === undefined}>Save image</Button>
      </Form>
    </Modal>
    <Modal title={catalogPickerPurpose === 'link' ? 'Link catalog product' : 'Add from catalog'} open={catalogPickerOpen}
      onCancel={() => setCatalogPickerOpen(false)} footer={null} destroyOnHidden>
      {catalogPickerPurpose === 'link' && <p className="muted">Catalog specs apply where this supply has no override.</p>}
      <div className="catalog-explorer-filters">
        <Input.Search aria-label="Search inventory products" placeholder="Search inventory products" allowClear value={catalogQuery}
          onChange={event => setCatalogQuery(event.target.value)} />
        <Select aria-label="Filter inventory type" placeholder="All inventory types" allowClear
          value={catalogCategory} onChange={setCatalogCategory}
          options={categories.map(category => ({ value: category, label: category }))} />
      </div>
      {matchingCatalog.length ? <div className="catalog-explorer-list" role="list">
        {matchingCatalog.map(product => <div key={product.id} role="listitem">
          <button type="button" className="catalog-explorer-option" onClick={() => chooseCatalogProduct(product)}>
            <span className="catalog-explorer-option-name"><strong>{product.name}</strong>
              <small>{catalogCharacteristics(product)}</small></span>
            {!!product.has_image && <CatalogImage kind="supply" id={product.id}
              className={`catalog-explorer-thumbnail${product.manufacturer === 'Briess'
                && product.category === 'Grain' ? ' catalog-grain-banner' : ''}`} />}
          </button>
        </div>)}
      </div> : <Empty description={catalog.length ? 'No matching products' : 'No catalog products available'} />}
      {catalogPickerPurpose === 'link' ? null : catalogCategory ? <Button type="link" className="catalog-create-custom"
        onClick={() => createCustomProduct(catalogCategory)}>Specify {catalogCategory.toLowerCase()} not in catalog</Button>
        : <Dropdown trigger={['click']} menu={{ items: categories.map(category => ({ key: category, label: category })),
          onClick: ({ key }) => createCustomProduct(key) }}>
          <Button type="link" className="catalog-create-custom">Specify product not in catalog</Button>
        </Dropdown>}
    </Modal>
    <Modal title={item ? `${item.name} supply defaults` : 'Supply defaults'} open={ingredientSettingsOpen}
      onCancel={() => setIngredientSettingsOpen(false)} footer={null} destroyOnHidden>
      {error && <Alert type="error" message={error} className="form-alert" />}
      <Form key={`${item?.supply_id}:${ingredientSettingsOpen}`} layout="vertical"
        initialValues={item?.category === 'Packaging' ? containerProperties : supplyProperties}
        onFinish={(values: ContainerSpecs & IngredientProperties) => item?.category === 'Packaging'
          ? saveContainerProperties(values) : saveIngredientProperties(values)}>
        {item?.category === 'Packaging' ? <>
          {catalogProduct && <p className="muted">Leave a field empty to use the catalog value.</p>}
          <PackagingFields defaults={catalogProduct || undefined} />
        </> : <PropertyFields category={item?.category || ''} includeClass />}
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
    <Modal title={newStockProduct ? `Add ${newStockProduct.name} stock` : creatingCustomProduct && newItemCategory
      ? `Specify ${newItemCategory.toLowerCase()} product` : newItemCategory
      ? `New ${newItemCategory.toLowerCase()} item` : 'New inventory item'} open={!!newItemCategory}
      onCancel={() => { setNewItemCategory(null); setNewStockProduct(null); setNewStockLotCode(undefined);
        setSelectedCatalogProduct(null); setCatalogProductChosen(false); setCreatingCustomProduct(false); }} footer={null} destroyOnHidden>
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      <Form form={itemForm} layout="vertical" onFinish={create}>
        <Form.Item name="category" hidden><Input /></Form.Item>
        {newStockProduct || catalogProductChosen ? <Form.Item name="name" hidden><Input /></Form.Item>
          : <Form.Item name="name" label={creatingCustomProduct ? 'Product name' : 'Item'}
            rules={[{ required: true, whitespace: true }]}>
          <AutoComplete placeholder={creatingCustomProduct ? 'Product name' : 'Search supplies or enter an item'} maxLength={120}
            onChange={value => { if (value !== selectedCatalogProduct?.name) setSelectedCatalogProduct(null); }}
            options={creatingCustomProduct ? [] : [
              ...supplies.filter(row => row.category === activeNewCategory).map(row => ({ value: row.name, label: `${row.name} · Your supplies` })),
              ...catalogSuggestions.filter(row => row.category === activeNewCategory && !supplies.some(owned =>
                owned.category === row.category && owned.name.toLowerCase() === row.name.toLowerCase()))
                .map(row => ({ value: row.name, label: `${row.name} · Catalog` }))
            ]}
            filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
            onSelect={value => { const catalogEntry = catalogSuggestions.find(row => row.category === activeNewCategory && row.name === value);
              setSelectedCatalogProduct(catalogEntry || null);
              const entry = supplies.find(row => row.category === activeNewCategory && row.name === value) || catalogEntry;
              if (entry) { const storedUnit = 'unit' in entry ? entry.unit : entry.default_unit;
                const nextUnit = ['Grain', 'Hops', 'Nutrient'].includes(entry.category)
                  ? unitForCategory(entry.category, preferredUnits.mass) : storedUnit === 'ml' ? 'mL' : storedUnit;
                changeQuantityUnit(itemForm, previousItemUnit.current, nextUnit, 'starting_quantity');
                previousItemUnit.current = nextUnit;
                itemForm.setFieldValue('default_unit', nextUnit); } }} />
        </Form.Item>}
        {selectedCatalogProduct && (newStockProduct || catalogProductChosen || newItemName === selectedCatalogProduct.name) &&
          <div className={`inventory-catalog-source${selectedCatalogProduct.manufacturer === 'Briess'
            && selectedCatalogProduct.category === 'Grain' ? ' catalog-grain-banner' : ''}`}>
            {!!selectedCatalogProduct.has_image && <CatalogImage kind="supply" id={selectedCatalogProduct.id}
              alt={selectedCatalogProduct.name} immediate />}
            <div><strong>{selectedCatalogProduct.name}</strong>
              <p>{catalogCharacteristics(selectedCatalogProduct)}</p>
              {selectedCatalogProduct.manufacturer && <p>{selectedCatalogProduct.manufacturer}</p>}
              {selectedCatalogProduct.product_url && <p><a href={selectedCatalogProduct.product_url}
                target="_blank" rel="noopener noreferrer">Product information</a></p>}
            </div>
          </div>}
        <Form.Item name="location_id" label="Location" normalize={(value, previousValue) => {
          if (value === newLocationOption) { openLocationCreate('item'); return previousValue; }
          return value;
        }}>
          <LocationTreeSelect locations={locations} includeCreate allowClear placeholder="Choose a location" />
        </Form.Item>
        <Form.Item name="lot_code" label="Lot code"><Input maxLength={80} disabled={newStockLotCode !== undefined} /></Form.Item>
        <Form.Item name="default_unit" label="Unit" rules={[{ required: true }]}>
          <Select showSearch options={unitOptions(quantityUnitsForCategory(activeNewCategory))}
            onChange={unit => { changeQuantityUnit(itemForm, previousItemUnit.current, unit, 'starting_quantity'); previousItemUnit.current = unit; }} /></Form.Item>
        {creatingCustomProduct && (activeNewCategory === 'Packaging' ? <PackagingFields />
          : <PropertyFields category={activeNewCategory} includeClass />)}
        <QuantityFields unit={newItemUnit} label="Starting quantity on hand" name="starting_quantity" optional={!existingItem} />
        {existingAtLocation && <p className="muted">This item is already at this location. The quantity will be recorded as a purchase.</p>}
        {existingItem && !existingAtLocation && <p className="muted">This creates another stock row for the selected location.</p>}
        <Button type="primary" htmlType="submit">{existingAtLocation ? 'Add stock' : creatingCustomProduct ? 'Save product' : 'Create item'}</Button>
      </Form>
    </Modal>
    <Modal title="Move stock" open={!!moveItem} onCancel={() => setMoveItemId(null)} footer={null} destroyOnHidden>
      {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
      <Form form={moveForm} layout="vertical" onFinish={move} initialValues={{ unit: moveItem?.display_unit || moveItem?.default_unit }}>
        <p className="muted">{moveItem?.location_id && `From ${inventoryLocationPath(moveItem.location_id, locations)}. `}
          {moveItem && onHand[moveItem.id] != null ? ` ${formatQuantity(onHand[moveItem.id]!, moveItem.default_unit, moveItem.display_unit)} available.` : ''}</p>
        <Form.Item name="location_id" label="To location" normalize={(value, previousValue) => {
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
      ? `Discard ${entryItem?.name || 'stock'}` : `Buy ${entryItem?.name || 'stock'}`} open={!!entryKind}
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
