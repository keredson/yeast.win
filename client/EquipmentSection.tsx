import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Checkbox, Dropdown, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Table, Tooltip } from 'antd';
import { CloudOutlined, ContainerOutlined, ControlOutlined, DashboardOutlined, EditOutlined, ExperimentOutlined,
  FireOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons';
import { boilOffKinds, capacityKinds, equipmentGroups, equipmentKindLabel, measurementRangeUnits, temperatureCalibrationKinds } from '../shared/equipment.ts';
import type { CatalogEquipment } from '../shared/catalog.ts';
import { assignEquipmentToBatch, createEquipment, deleteEquipment, listCurrentEquipmentUses, releaseEquipmentUse,
  updateEquipmentBoilHeatLoss, updateEquipmentCalibration, updateEquipmentIdentity, updateEquipmentRatedPower, updateEquipmentCapacity,
  updateEquipmentTemperatureOffset, updateEquipmentThermalCapabilities, updateBrewingLosses, latestMeasuredMashEfficiency,
  updateFermenterCapabilities,
  updateEquipmentMeasurementRange,
  type Batch, type Equipment, type EquipmentSpecifications, type EquipmentUse, type LocalDb } from './db.ts';
import { capacityInLiters, capacityLabel, capacityUnits } from '../shared/capacity.ts';
import { changeNumberUnit } from './unitFields.ts';
import { equipmentPathSegment, equipmentSlug } from './equipmentRoutes.ts';
import { heatLossFromBoil, predictedBoilOff } from './boilOff.ts';
import { convertUnit, unitOptions, unitGroups, type PreferredUnits } from '../shared/units.ts';

function rangeLabel(min: number, max: number, scale: string | undefined): string {
  return `${min}–${max}${scale === 'SG' ? ' (specific gravity)' : ` ${scale || ''}`}`;
}

const calibrationProfiles: Record<string, { fields: { key: string; label: string }[] }> = {
  ph_meter: { fields: [
    { key: 'buffer_4_observed', label: 'pH 4.00 buffer reading' }, { key: 'buffer_7_observed', label: 'pH 7.00 buffer reading' }
  ] },
  hydrometer: { fields: [
    { key: 'reference_sg', label: 'Reference specific gravity' }, { key: 'observed_sg', label: 'Hydrometer reading' }
  ] },
  refractometer: { fields: [
    { key: 'reference_brix', label: 'Reference °Brix' }, { key: 'observed_brix', label: 'Refractometer reading °Brix' }
  ] },
  scale: { fields: [
    { key: 'reference_g', label: 'Reference weight g' }, { key: 'observed_g', label: 'Scale reading g' }
  ] },
  pressure_gauge: { fields: [
    { key: 'reference_kpa', label: 'Reference pressure kPa' }, { key: 'observed_kpa', label: 'Gauge reading kPa' }
  ] },
  carbonation_meter: { fields: [
    { key: 'reference_volumes', label: 'Reference CO₂ volumes' }, { key: 'observed_volumes', label: 'Meter reading CO₂ volumes' }
  ] },
  dissolved_oxygen_meter: { fields: [
    { key: 'reference_mg_l', label: 'Reference oxygen mg/L' }, { key: 'observed_mg_l', label: 'Meter reading mg/L' }
  ] }
};

const equipmentMenuItems = equipmentGroups.map(group => ({ key: group.key, label: group.label,
  children: group.kinds.map(kind => ({ key: kind, label: equipmentKindLabel(kind) })) }));

function addEquipmentTitle(kind: string): string {
  const label = equipmentKindLabel(kind);
  return `Add ${label[0].toLowerCase()}${label.slice(1)}`;
}

function pressureInKpa(value: number | undefined, unit: string | undefined): number | undefined {
  if (value == null) return undefined;
  const converted = convertUnit(value, unit || 'kPa', 'kPa');
  if (converted == null || converted <= 0) throw new Error('Enter a positive pressure rating');
  return converted;
}

function pressureLabel(kpa: number | null | undefined, unit: PreferredUnits['pressure']): string {
  if (kpa == null) return 'Not set';
  return `${Number(convertUnit(kpa, 'kPa', unit)!.toFixed(2))} ${unit}`;
}

function equipmentCapabilities(row: Equipment): ReactNode {
  const capabilities: { label: string; icon: ReactNode }[] = [];
  if (capacityKinds.has(row.kind)) capabilities.push({ label: 'Holds liquid', icon: <ContainerOutlined /> });
  if (row.has_heating) capabilities.push({ label: 'Heating', icon: <FireOutlined /> });
  if (row.has_cooling || ['chiller', 'glycol_chiller', 'refrigerator'].includes(row.kind)) {
    capabilities.push({ label: 'Cooling', icon: <CloudOutlined /> });
  }
  if (row.has_temperature_control) capabilities.push({ label: 'Temperature control', icon: <ControlOutlined /> });
  if (row.max_pressure_kpa != null) capabilities.push({ label: 'Pressure rated', icon: <DashboardOutlined /> });
  if (row.kind === 'pump') capabilities.push({ label: 'Moves liquid', icon: <SwapOutlined /> });
  const measured = [...new Set(row.measurement_channels?.map(channel => channel.measurement_kind) || [])];
  if (measured.length || measurementRangeUnits[row.kind]) {
    capabilities.push({ label: measured.length ? `Measures ${measured.join(', ')}` : 'Measures', icon: <ExperimentOutlined /> });
  }
  return capabilities.length ? <div className="equipment-capabilities">{capabilities.map(({ label, icon }) =>
    <Tooltip key={label} title={label}><span role="img" aria-label={label} className="equipment-capability">{icon}</span></Tooltip>)}</div> : '—';
}

export function EquipmentSection({ db, basePath, accountId, batches, equipment, catalog, preferredUnits, selectedId, onSelect, onSelectBatch, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; batches: Batch[]; equipment: Equipment[]; catalog: CatalogEquipment[]; preferredUnits: PreferredUnits;
  selectedId: string | null; onSelect: (id: string | null) => void; onSelectBatch: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [creatingKind, setCreatingKind] = useState<string | null>(null);
  const [catalogPickerOpen, setCatalogPickerOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogKind, setCatalogKind] = useState<string | undefined>();
  const [selectedCatalogModel, setSelectedCatalogModel] = useState<CatalogEquipment | null>(null);
  const [editCalibration, setEditCalibration] = useState(false);
  const [newBoilCalibration, setNewBoilCalibration] = useState(false);
  const [newTemperatureCalibration, setNewTemperatureCalibration] = useState(false);
  const [editIdentity, setEditIdentity] = useState(false);
  const [editCapacity, setEditCapacity] = useState(false);
  const [editPower, setEditPower] = useState(false);
  const [editThermal, setEditThermal] = useState(false);
  const [editBrewingLosses, setEditBrewingLosses] = useState(false);
  const [recentMashEfficiency, setRecentMashEfficiency] = useState<number | null>(null);
  const [editRange, setEditRange] = useState(false);
  const [editFermenter, setEditFermenter] = useState(false);
  const [error, setError] = useState('');
  const [uses, setUses] = useState<EquipmentUse[]>([]);
  const [assignBatchId, setAssignBatchId] = useState<string | undefined>();
  const [equipmentForm] = Form.useForm();
  const [capacityForm] = Form.useForm();
  const [powerForm] = Form.useForm();
  const [thermalForm] = Form.useForm();
  const [rangeForm] = Form.useForm();
  const [fermenterForm] = Form.useForm();
  const item = equipment.find(row => row.id === selectedId) || null;
  const newCapacityUnit = Form.useWatch('capacity_unit', equipmentForm) as string | undefined;
  const newRangeUnit = Form.useWatch('measurement_unit', equipmentForm) as string | undefined;
  const editCapacityUnit = Form.useWatch('capacity_unit', capacityForm) as string | undefined;
  const editRangeUnit = Form.useWatch('measurement_unit', rangeForm) as string | undefined;
  const newPressureUnit = Form.useWatch('pressure_unit', equipmentForm) as string | undefined;
  const newHeating = Form.useWatch('has_heating', equipmentForm) as boolean | undefined;
  const newCooling = Form.useWatch('has_cooling', equipmentForm) as boolean | undefined;
  const editCooling = Form.useWatch('has_cooling', thermalForm) as boolean | undefined;
  const newFermenterControl = Form.useWatch('built_in_temperature_control', equipmentForm) as boolean | undefined;
  const editPressureUnit = Form.useWatch('pressure_unit', fermenterForm) as string | undefined;
  const profile = item ? calibrationProfiles[item.kind] : undefined;
  const specs: EquipmentSpecifications = item || {};
  const calibrationValues = Object.fromEntries((profile?.fields || []).map(field => [field.key,
    (specs as Record<string, unknown>)[field.key]]));
  const hasTemperatureReading = !!item && (temperatureCalibrationKinds.has(item.kind)
    || item.measurement_channels?.some(channel => channel.measurement_kind === 'temperature')
    || !!item.has_temperature_control);
  const ratedEstimate = specs.rated_power_watts == null || specs.boil_heat_loss_watts == null
    ? null : predictedBoilOff(specs.rated_power_watts, specs.boil_heat_loss_watts);
  const thermalKind = !!item && (boilOffKinds.has(item.kind) || item.kind === 'fermenter'
    || item.kind === 'fermentation_temperature_control');
  const coolingAvailableForNew = creatingKind === 'fermenter' || creatingKind === 'fermentation_temperature_control'
    || !!selectedCatalogModel?.has_cooling;
  const coolingAvailableForItem = item?.kind === 'fermenter' || item?.kind === 'fermentation_temperature_control'
    || !!specs.has_cooling;
  const itemUses = uses.filter(use => use.equipment_id === item?.id);
  const availableBatches = batches.filter(batch => !itemUses.some(use => use.batch_id === batch.id));

  useEffect(() => { void listCurrentEquipmentUses(db).then(setUses).catch(cause => setError(String(cause))); }, [db, equipment, batches]);

  async function assignBatch() {
    if (!item || !assignBatchId) return;
    try {
      await assignEquipmentToBatch(db, item.id, assignBatchId, accountId);
      setAssignBatchId(undefined);
      setUses(await listCurrentEquipmentUses(db));
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function releaseBatch(useId: string) {
    try {
      await releaseEquipmentUse(db, useId);
      setUses(await listCurrentEquipmentUses(db));
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  useEffect(() => {
    if (!item || !['all_in_one', 'mash_tun', 'kettle', 'electric_kettle'].includes(item.kind)) return;
    let active = true;
    setRecentMashEfficiency(null);
    void latestMeasuredMashEfficiency(db, item.id).then(value => { if (active) setRecentMashEfficiency(value); });
    return () => { active = false; };
  }, [db, item?.id]);

  function validRange(min: number | undefined, max: number | undefined, unit: string | undefined, kind: string) {
    if (min == null && max == null) return null;
    if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || min >= max
      || !unit || !measurementRangeUnits[kind]?.includes(unit)) throw new Error('Enter a valid measurement range and unit');
    return { min, max, unit };
  }

  async function create(values: { name: string; capacity?: number; capacity_unit?: string;
    measurement_min?: number; measurement_max?: number; measurement_unit?: string; rated_power_watts?: number;
    built_in_temperature_control?: boolean; max_pressure?: number; pressure_unit?: string;
    has_heating?: boolean; has_cooling?: boolean; rated_heat_removal_watts?: number;
    min_temperature_c?: number; max_temperature_c?: number }) {
    if (!creatingKind) return;
    try {
      const overrides: EquipmentSpecifications = {};
      if (capacityKinds.has(creatingKind)) {
        const capacity = capacityInLiters(values.capacity, values.capacity_unit);
        if (capacity != null) overrides.capacity_liters = capacity;
      }
      if (measurementRangeUnits[creatingKind]) {
        const range = validRange(values.measurement_min, values.measurement_max, values.measurement_unit, creatingKind);
        if (range) Object.assign(overrides, { measurement_min: range.min, measurement_max: range.max, measurement_unit: range.unit });
      }
      if (boilOffKinds.has(creatingKind) && values.rated_power_watts != null) {
        if (!Number.isFinite(values.rated_power_watts) || values.rated_power_watts <= 0) throw new Error('Enter a positive power');
        overrides.rated_power_watts = values.rated_power_watts;
      }
      if (creatingKind === 'fermenter') {
        overrides.built_in_temperature_control = !!values.built_in_temperature_control;
        overrides.max_pressure_kpa = pressureInKpa(values.max_pressure, values.pressure_unit);
      }
      if (['all_in_one', 'electric_kettle', 'fermentation_temperature_control', 'fermenter'].includes(creatingKind)) {
        overrides.has_heating = !!values.has_heating;
        overrides.has_cooling = !!values.has_cooling;
        overrides.has_temperature_control = creatingKind === 'fermenter'
          ? !!values.built_in_temperature_control : true;
        if (values.has_heating && values.rated_power_watts != null) overrides.rated_power_watts = values.rated_power_watts;
        if (values.has_cooling && values.rated_heat_removal_watts != null) {
          if (!Number.isFinite(values.rated_heat_removal_watts) || values.rated_heat_removal_watts <= 0) {
            throw new Error('Enter a positive heat removal rate');
          }
          overrides.rated_heat_removal_watts = values.rated_heat_removal_watts;
        }
        if (overrides.has_temperature_control) {
          if (values.min_temperature_c != null && values.max_temperature_c != null
            && values.min_temperature_c >= values.max_temperature_c) throw new Error('Enter a valid temperature range');
          overrides.min_temperature_c = values.min_temperature_c;
          overrides.max_temperature_c = values.max_temperature_c;
        }
      }
      const id = await createEquipment(db, values.name.trim(), creatingKind, selectedCatalogModel || undefined, overrides);
      setCreatingKind(null); setSelectedCatalogModel(null); onSelect(id); await onChanged();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveFermenter(values: { built_in_temperature_control?: boolean; max_pressure?: number; pressure_unit?: string }) {
    if (!item) return;
    try {
      await updateFermenterCapabilities(db, item, !!values.built_in_temperature_control,
        pressureInKpa(values.max_pressure, values.pressure_unit) ?? null);
      setEditFermenter(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveCapacity(values: { capacity?: number; capacity_unit?: string }) {
    if (!item) return;
    try { await updateEquipmentCapacity(db, item, capacityInLiters(values.capacity, values.capacity_unit)); setEditCapacity(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function savePower(values: { rated_power_watts?: number }) {
    if (!item) return;
    try {
      await updateEquipmentRatedPower(db, item, values.rated_power_watts ?? null);
      setEditPower(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveThermal(values: { has_heating?: boolean; rated_power_watts?: number;
    has_cooling?: boolean; rated_heat_removal_watts?: number;
    min_temperature_c?: number; max_temperature_c?: number }) {
    if (!item) return;
    try {
      await updateEquipmentThermalCapabilities(db, item, {
        has_heating: !!values.has_heating, rated_power_watts: values.has_heating ? values.rated_power_watts ?? null : null,
        has_cooling: !!values.has_cooling,
        rated_heat_removal_watts: values.has_cooling ? values.rated_heat_removal_watts ?? null : null,
        has_temperature_control: !!item.has_temperature_control || thermalKind && item.kind !== 'fermenter',
        min_temperature_c: values.min_temperature_c ?? null, max_temperature_c: values.max_temperature_c ?? null
      });
      setEditThermal(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveBrewingLosses(values: { mash_efficiency_pct?: number; grain_absorption_l_per_kg?: number;
    mash_deadspace_liters?: number; kettle_retention_liters?: number }) {
    if (!item) return;
    try { await updateBrewingLosses(db, item, values); setEditBrewingLosses(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveIdentity(values: { name: string; slug: string }) {
    if (!item) return;
    try {
      await updateEquipmentIdentity(db, item, values.name, values.slug, equipment);
      setEditIdentity(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveBoilCalibration(values: { power_watts: number; start_liters: number;
    end_liters: number; duration_minutes: number }) {
    if (!item) return;
    try {
      const heatLoss = heatLossFromBoil(values.power_watts, values.start_liters, values.end_liters, values.duration_minutes);
      await updateEquipmentBoilHeatLoss(db, item, heatLoss);
      setNewBoilCalibration(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveTemperatureCalibration(values: { reference_c: number; observed_c: number }) {
    if (!item) return;
    try {
      if (!Number.isFinite(values.reference_c) || !Number.isFinite(values.observed_c)) throw new Error('Enter valid temperatures');
      await updateEquipmentTemperatureOffset(db, item, values.reference_c - values.observed_c);
      setNewTemperatureCalibration(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveRange(values: { measurement_min?: number; measurement_max?: number; measurement_unit?: string }) {
    if (!item) return;
    try {
      const range = validRange(values.measurement_min, values.measurement_max, values.measurement_unit, item.kind);
      await updateEquipmentMeasurementRange(db, item, range);
      setEditRange(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function remove() {
    if (!item) return;
    try {
      await deleteEquipment(db, item.id);
      onSelect(null);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveCalibration(values: { parameters: Record<string, number> }) {
    if (!item || !profile) return;
    try {
      const parameters = Object.fromEntries(profile.fields.map(field => [field.key, values.parameters[field.key]]));
      await updateEquipmentCalibration(db, item, parameters);
      setEditCalibration(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  const addMenu = { items: equipmentMenuItems, triggerSubMenuAction: 'click' as const,
    onClick: ({ key }: { key: string }) => { setSelectedCatalogModel(null); setCreatingKind(key); } };
  const catalogKinds = [...new Set(catalog.map(model => model.kind))].sort((left, right) =>
    equipmentKindLabel(left).localeCompare(equipmentKindLabel(right)));
  const query = catalogQuery.trim().toLocaleLowerCase();
  const matchingModels = catalog.filter(model => (!catalogKind || model.kind === catalogKind)
    && (!query || `${model.name} ${equipmentKindLabel(model.kind)}`.toLocaleLowerCase().includes(query)));
  function chooseCatalogModel(model: CatalogEquipment) {
    setCatalogPickerOpen(false);
    setSelectedCatalogModel(model);
    setCreatingKind(model.kind);
  }
  function closeCreation() {
    setCreatingKind(null);
    setSelectedCatalogModel(null);
  }

  return <div className="section-page">
    {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index equipment-index"><div className="section-heading"><div><span className="eyebrow">Your gear</span><h1>Equipment</h1></div></div>
      <p className="muted">Measurements, control settings, and transfers can reference your equipment.</p>
      <div className="equipment-add-actions">
        <Button icon={<PlusOutlined />} onClick={() => { setCatalogQuery(''); setCatalogKind(undefined); setCatalogPickerOpen(true); }}>Add from catalog</Button>
        <Dropdown trigger={['click']} menu={addMenu} placement="bottomLeft">
          <Button icon={<PlusOutlined />}>Define equipment</Button>
        </Dropdown>
      </div>
      {equipment.length > 0 && <Table<Equipment> className="equipment-table" dataSource={[...equipment].sort((a, b) => a.name.localeCompare(b.name))}
        rowKey="id" pagination={false} size="small" tableLayout="fixed" columns={[
          { title: 'Name', dataIndex: 'name', width: '42%', render: (_, row) =>
            <a href={`${basePath}/equipment/${equipmentPathSegment(row, equipment)}`}
              onClick={event => { event.preventDefault(); onSelect(row.id); }}>{row.name}</a> },
          { title: 'Capabilities', key: 'capabilities', width: '30%', render: (_: unknown, row: Equipment) => equipmentCapabilities(row) },
          { title: 'Current batch', key: 'current-batch', width: '28%', render: (_: unknown, row: Equipment) => {
            const current = uses.filter(use => use.equipment_id === row.id);
            return current.length ? <div className="equipment-current-batches">{current.map(use =>
              <a key={use.id} href={`${basePath}/batch/${use.batch_id}`}
                onClick={event => { event.preventDefault(); onSelectBatch(use.batch_id); }}>{use.batch_name}</a>)}</div> : '—';
          } }
        ]} />}
    </section> : !item ? <Empty description="Equipment not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">{equipmentKindLabel(item.kind)}</span>
          <div className="equipment-title"><h2>{item.name}</h2>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit equipment name and slug" onClick={() => setEditIdentity(true)} /></div>
          <div className="muted">Slug: {equipmentPathSegment(item, equipment)}</div></div></div>
        <div className="equipment-parameters">
          <div className="equipment-parameter equipment-assignments"><strong>Current batches</strong>
            {itemUses.map(use => <div key={use.id} className="equipment-assignment">
              <a href={`${basePath}/batch/${use.batch_id}`} onClick={event => { event.preventDefault(); onSelectBatch(use.batch_id); }}>{use.batch_name}</a>
              <Button type="text" size="small" onClick={() => void releaseBatch(use.id)}>Release</Button>
            </div>)}
            {availableBatches.length > 0 && <div className="equipment-assignment-form">
              <Select aria-label="Assign to batch" placeholder="Choose a batch" showSearch optionFilterProp="label"
                value={assignBatchId} onChange={setAssignBatchId}
                options={availableBatches.map(batch => ({ value: batch.id, label: batch.name }))} />
              <Button disabled={!assignBatchId} onClick={() => void assignBatch()}>Assign</Button>
            </div>}
          </div>
          {capacityKinds.has(item.kind) && <div className="equipment-parameter"><span>Capacity: {capacityLabel(specs.capacity_liters ?? undefined) || 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit capacity" onClick={() => setEditCapacity(true)} /></div>}
          {item.kind === 'fermenter' && <div className="equipment-parameter"><span>
            Built-in temperature control: {specs.built_in_temperature_control ? 'Yes' : 'No'}<br />
            Pressure rating: {pressureLabel(specs.max_pressure_kpa, preferredUnits.pressure)}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit fermenter capabilities" onClick={() => setEditFermenter(true)} /></div>}
          {boilOffKinds.has(item.kind) && <div className="equipment-parameter"><span>Rated power: {specs.rated_power_watts != null
            ? `${specs.rated_power_watts} W` : 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit rated power" onClick={() => setEditPower(true)} /></div>}
          {thermalKind && <div className="equipment-parameter"><span>
            {(item.kind !== 'fermenter' || specs.has_temperature_control) && <>Temperature range: {
              specs.min_temperature_c == null && specs.max_temperature_c == null ? 'Not set'
                : `${specs.min_temperature_c ?? '—'}–${specs.max_temperature_c ?? '—'} °C`}<br /></>}
            {!boilOffKinds.has(item.kind) && <>Heating: {specs.has_heating
              ? specs.rated_power_watts == null ? 'Available' : `${specs.rated_power_watts} W` : 'Not configured'}<br /></>}
            Cooling: {specs.has_cooling ? specs.rated_heat_removal_watts == null
              ? 'Available' : `${specs.rated_heat_removal_watts} W heat removal` : 'Not configured'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit thermal capabilities" onClick={() => setEditThermal(true)} /></div>}
          {hasTemperatureReading && <div className="equipment-parameter"><span>Temperature offset: {specs.temperature_offset_c == null
            ? 'Not calibrated' : `${specs.temperature_offset_c > 0 ? '+' : ''}${Number(specs.temperature_offset_c.toFixed(2))} °C`}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit temperature offset" onClick={() => setNewTemperatureCalibration(true)} /></div>}
          {boilOffKinds.has(item.kind) && <div className="equipment-parameter"><span>Heat loss at boil: {specs.boil_heat_loss_watts == null
            ? 'Not calibrated' : `${Math.round(specs.boil_heat_loss_watts)} W`}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit boil heat loss" onClick={() => setNewBoilCalibration(true)} /></div>}
          {ratedEstimate != null && <div className="equipment-parameter">Estimated boil-off at rated power: {Number(ratedEstimate.toFixed(2))} L/h</div>}
          {['all_in_one', 'mash_tun', 'kettle', 'electric_kettle'].includes(item.kind) &&
            <div className="equipment-parameter"><span>Mash efficiency: {specs.mash_efficiency_pct != null
              ? `${specs.mash_efficiency_pct}% (set)` : recentMashEfficiency != null ? `${recentMashEfficiency}% (recent batch)` : 'Not set'}<br />
              Grain absorption: {specs.grain_absorption_l_per_kg == null ? 'Not set' : `${specs.grain_absorption_l_per_kg} L/kg`}<br />
              Mash dead space: {specs.mash_deadspace_liters == null ? 'Not set' : `${specs.mash_deadspace_liters} L`}<br />
              Kettle retention: {specs.kettle_retention_liters == null ? 'Not set' : `${specs.kettle_retention_liters} L`}</span>
              <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit brewing losses" onClick={() => setEditBrewingLosses(true)} /></div>}
          {measurementRangeUnits[item.kind] && <div className="equipment-parameter"><span>Measurement range: {specs.measurement_min != null && specs.measurement_max != null
            ? rangeLabel(specs.measurement_min, specs.measurement_max, specs.measurement_unit ?? undefined) : 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit measurement range" onClick={() => setEditRange(true)} /></div>}
          {item.measurement_channels?.filter(channel => channel.measurement_kind === 'temperature'
            && item.kind !== 'thermometer').map(channel => <div key={channel.id} className="equipment-parameter">
              Temperature measurement: {channel.measurement_min != null && channel.measurement_max != null
                ? rangeLabel(channel.measurement_min, channel.measurement_max,
                  channel.measurement_scale || channel.measurement_unit || undefined) : 'Available'}
            </div>)}
          {profile?.fields.map(field => <div key={field.key} className="equipment-parameter"><span>{field.label}: {calibrationValues[field.key] == null ? 'Not calibrated' : String(calibrationValues[field.key])}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Edit ${field.label}`} onClick={() => setEditCalibration(true)} /></div>)}
        </div>
        <div className="equipment-delete"><Popconfirm title={`Delete ${item.name}?`}
          description="Used equipment stays in batch history. Unused equipment and calibrations are removed."
          okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => void remove()}>
          <Button type="text" danger>Delete</Button>
        </Popconfirm></div>
      </section>}
    <Modal title="Add from catalog" open={catalogPickerOpen} onCancel={() => setCatalogPickerOpen(false)} footer={null} destroyOnHidden>
      <div className="equipment-catalog-filters">
        <Input.Search aria-label="Search equipment models" placeholder="Search equipment models" allowClear value={catalogQuery}
          onChange={event => setCatalogQuery(event.target.value)} />
        <Select aria-label="Filter equipment type" placeholder="All equipment types" allowClear showSearch optionFilterProp="label"
          value={catalogKind} onChange={setCatalogKind}
          options={catalogKinds.map(kind => ({ value: kind, label: equipmentKindLabel(kind) }))} />
      </div>
      {matchingModels.length ? <div className="equipment-catalog-list" role="list">
        {matchingModels.map(model => <div key={model.id} role="listitem">
          <button type="button" className="equipment-catalog-option" onClick={() => chooseCatalogModel(model)}>
            <strong>{model.name}</strong><span>{equipmentKindLabel(model.kind)}</span>
          </button>
        </div>)}
      </div> : <Empty description={catalog.length ? 'No matching equipment' : 'No catalog equipment available'} />}
    </Modal>
    <Modal title={creatingKind ? addEquipmentTitle(creatingKind) : 'Add equipment'} open={!!creatingKind}
      onCancel={closeCreation} footer={null} destroyOnHidden>
      {creatingKind && <Form key={`${creatingKind}:${selectedCatalogModel?.id || 'custom'}`} form={equipmentForm} layout="vertical" onFinish={create} preserve={false}
        initialValues={{ name: selectedCatalogModel?.name, capacity: selectedCatalogModel?.capacity_liters,
          capacity_unit: 'L', measurement_min: selectedCatalogModel?.measurement_min,
          measurement_max: selectedCatalogModel?.measurement_max,
          measurement_unit: selectedCatalogModel?.measurement_unit || measurementRangeUnits[creatingKind]?.[0],
          rated_power_watts: selectedCatalogModel?.rated_power_watts,
          has_heating: !!selectedCatalogModel?.has_heating || boilOffKinds.has(creatingKind),
          has_cooling: !!selectedCatalogModel?.has_cooling,
          rated_heat_removal_watts: selectedCatalogModel?.rated_heat_removal_watts,
          min_temperature_c: selectedCatalogModel?.min_temperature_c,
          max_temperature_c: selectedCatalogModel?.max_temperature_c,
          built_in_temperature_control: selectedCatalogModel?.built_in_temperature_control || false,
          max_pressure: selectedCatalogModel?.max_pressure_kpa == null ? undefined
            : convertUnit(selectedCatalogModel.max_pressure_kpa, 'kPa', preferredUnits.pressure),
          pressure_unit: preferredUnits.pressure }}>
        {selectedCatalogModel && <p className="muted">Based on {selectedCatalogModel.name}. Review the settings before adding it.</p>}
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
          <Input placeholder="Equipment name" maxLength={120} />
        </Form.Item>
        {capacityKinds.has(creatingKind) && <div className="capacity-fields"><Form.Item name="capacity" label="Capacity (optional)"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="capacity_unit" label="Unit"><Select options={[...capacityUnits]}
            onChange={unit => changeNumberUnit(equipmentForm, ['capacity'], newCapacityUnit || 'L', unit)} /></Form.Item></div>}
        {creatingKind === 'fermenter' && <>
          <Form.Item name="built_in_temperature_control" valuePropName="checked"><Checkbox
            disabled={!!selectedCatalogModel?.has_temperature_control}>Built-in temperature control</Checkbox></Form.Item>
          <div className="form-pair"><Form.Item name="max_pressure" label="Maximum working pressure (optional)">
            <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
            <Form.Item name="pressure_unit" label="Unit"><Select options={unitOptions(unitGroups.pressure)}
              onChange={unit => changeNumberUnit(equipmentForm, ['max_pressure'], newPressureUnit || preferredUnits.pressure, unit)} /></Form.Item></div>
        </>}
        {boilOffKinds.has(creatingKind) && <Form.Item name="rated_power_watts" label="Rated power (W, optional)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        {['fermentation_temperature_control', 'fermenter'].includes(creatingKind) && <>
          <Form.Item name="has_heating" valuePropName="checked"><Checkbox disabled={!!selectedCatalogModel?.has_heating}>Heating</Checkbox></Form.Item>
          {newHeating && <Form.Item name="rated_power_watts" label="Rated heating power (W, optional)">
            <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        </>}
        {coolingAvailableForNew && <>
          <Form.Item name="has_cooling" valuePropName="checked"><Checkbox disabled={!!selectedCatalogModel?.has_cooling}>Cooling</Checkbox></Form.Item>
          {newCooling && <Form.Item name="rated_heat_removal_watts" label="Rated heat removal (W, optional)">
            <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        </>}
        {['fermentation_temperature_control', 'fermenter', 'electric_kettle', 'all_in_one'].includes(creatingKind) && <>
          {(creatingKind !== 'fermenter' || newFermenterControl) && <div className="form-pair">
            <Form.Item name="min_temperature_c" label="Minimum temperature (°C)"><InputNumber className="full-width" step="any" /></Form.Item>
            <Form.Item name="max_temperature_c" label="Maximum temperature (°C)"><InputNumber className="full-width" step="any" /></Form.Item>
          </div>}
        </>}
        {measurementRangeUnits[creatingKind] && <div className="form-triple">
          <Form.Item name="measurement_min" label="Range minimum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_max" label="Range maximum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_unit" label="Scale">
            <Select options={unitOptions(measurementRangeUnits[creatingKind])}
              onChange={unit => changeNumberUnit(equipmentForm, ['measurement_min', 'measurement_max'],
                newRangeUnit || measurementRangeUnits[creatingKind][0], unit)} /></Form.Item>
        </div>}
        <Button type="primary" htmlType="submit">Create equipment</Button>
      </Form>}
    </Modal>
    <Modal title="Edit capacity" open={editCapacity} onCancel={() => setEditCapacity(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={capacityForm} layout="vertical" onFinish={saveCapacity} initialValues={{ capacity: specs.capacity_liters, capacity_unit: 'L' }}>
        <div className="capacity-fields"><Form.Item name="capacity" label="Capacity"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="capacity_unit" label="Unit"><Select options={[...capacityUnits]}
            onChange={unit => changeNumberUnit(capacityForm, ['capacity'], editCapacityUnit || 'L', unit)} /></Form.Item></div>
        <Button type="primary" htmlType="submit">Save capacity</Button>
      </Form>
    </Modal>
    <Modal title="Fermenter capabilities" open={editFermenter} onCancel={() => setEditFermenter(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={fermenterForm} layout="vertical" onFinish={saveFermenter}
        initialValues={{ built_in_temperature_control: !!specs.built_in_temperature_control,
          max_pressure: specs.max_pressure_kpa == null ? undefined : convertUnit(specs.max_pressure_kpa, 'kPa', preferredUnits.pressure),
          pressure_unit: preferredUnits.pressure }}>
        <Form.Item name="built_in_temperature_control" valuePropName="checked"><Checkbox disabled={!!specs.built_in_temperature_control}>Built-in temperature control</Checkbox></Form.Item>
        <div className="form-pair"><Form.Item name="max_pressure" label="Maximum working pressure (optional)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="pressure_unit" label="Unit"><Select options={unitOptions(unitGroups.pressure)}
            onChange={unit => changeNumberUnit(fermenterForm, ['max_pressure'], editPressureUnit || preferredUnits.pressure, unit)} /></Form.Item></div>
        <Button type="primary" htmlType="submit">Save capabilities</Button>
      </Form>
    </Modal>
    <Modal title="Edit rated power" open={editPower} onCancel={() => setEditPower(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={powerForm} layout="vertical" onFinish={savePower}
        initialValues={{ rated_power_watts: specs.rated_power_watts }}>
        <Form.Item name="rated_power_watts" label="Rated power (W)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Save rated power</Button>
      </Form>
    </Modal>
    <Modal title="Thermal capabilities" open={editThermal} onCancel={() => setEditThermal(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={thermalForm} layout="vertical" onFinish={saveThermal}
        initialValues={{ has_heating: !!specs.has_heating, rated_power_watts: specs.rated_power_watts,
          has_cooling: !!specs.has_cooling, rated_heat_removal_watts: specs.rated_heat_removal_watts,
          min_temperature_c: specs.min_temperature_c, max_temperature_c: specs.max_temperature_c }}>
        <Form.Item name="has_heating" valuePropName="checked"><Checkbox disabled={!!specs.has_heating}>Heating</Checkbox></Form.Item>
        <Form.Item name="rated_power_watts" label="Rated heating power (W)"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
        {coolingAvailableForItem && <>
          <Form.Item name="has_cooling" valuePropName="checked"><Checkbox disabled={!!specs.has_cooling}>Cooling</Checkbox></Form.Item>
          {editCooling && <Form.Item name="rated_heat_removal_watts" label="Rated heat removal (W)">
            <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        </>}
        {(item?.kind !== 'fermenter' || specs.has_temperature_control) && <div className="form-pair">
          <Form.Item name="min_temperature_c" label="Minimum temperature (°C)"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="max_temperature_c" label="Maximum temperature (°C)"><InputNumber className="full-width" step="any" /></Form.Item>
        </div>}
        <Button type="primary" htmlType="submit">Save capabilities</Button>
      </Form>
    </Modal>
    <Modal title="Mash efficiency and liquid losses" open={editBrewingLosses} onCancel={() => setEditBrewingLosses(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={saveBrewingLosses} initialValues={specs}>
        <Form.Item name="mash_efficiency_pct" label="Mash efficiency (%)"><InputNumber className="full-width" min={0} max={100} step="any" /></Form.Item>
        <Form.Item name="grain_absorption_l_per_kg" label="Grain absorption (L per kg)"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="mash_deadspace_liters" label="Mash dead space (L)"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Form.Item name="kettle_retention_liters" label="Wort left in kettle after transfer (L)"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Save</Button>
      </Form>
    </Modal>
    <Modal title="Edit equipment name and slug" open={editIdentity} onCancel={() => setEditIdentity(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={saveIdentity} initialValues={{ name: item?.name, slug: item ? equipmentSlug(item) : '' }}>
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}><Input maxLength={120} /></Form.Item>
        <Form.Item name="slug" label="Slug" rules={[{ required: true }, { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: 'Use lowercase letters, numbers, and hyphens' }]}>
          <Input maxLength={80} /></Form.Item>
        <Button type="primary" htmlType="submit">Save name and slug</Button>
      </Form>
    </Modal>
    <Modal title="Edit measurement range" open={editRange} onCancel={() => setEditRange(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={rangeForm} layout="vertical" onFinish={saveRange} initialValues={{ measurement_min: specs.measurement_min, measurement_max: specs.measurement_max,
        measurement_unit: specs.measurement_unit || (item && measurementRangeUnits[item.kind]?.[0]) }}>
        <div className="form-triple"><Form.Item name="measurement_min" label="Range minimum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_max" label="Range maximum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_unit" label="Scale"><Select options={unitOptions(item && measurementRangeUnits[item.kind] || [])}
            onChange={unit => changeNumberUnit(rangeForm, ['measurement_min', 'measurement_max'], editRangeUnit, unit)} /></Form.Item></div>
        <Button type="primary" htmlType="submit">Save range</Button>
      </Form>
    </Modal>
    <Modal title={profile ? `Calibrate ${equipmentKindLabel(item?.kind || '')}` : 'Edit calibration'} open={editCalibration} onCancel={() => setEditCalibration(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={saveCalibration} initialValues={{ parameters: calibrationValues }}>
        {profile?.fields.map(field => <Form.Item key={field.key} name={['parameters', field.key]} label={field.label} rules={[{ required: true }]}>
          <InputNumber className="full-width" step="any" /></Form.Item>)}
        <Button type="primary" htmlType="submit">Save calibration</Button>
      </Form>
    </Modal>
    <Modal title="Calibrate boil-off" open={newBoilCalibration} onCancel={() => setNewBoilCalibration(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={saveBoilCalibration}
        initialValues={{ power_watts: specs.rated_power_watts }}>
        <p className="muted">Measure volume loss during a steady boil. Only the derived heat loss is saved.</p>
        <Form.Item name="power_watts" label="Power used (W)" rules={[{ required: true }]}><InputNumber className="full-width" min={1} /></Form.Item>
        <div className="form-pair"><Form.Item name="start_liters" label="Start volume (L)" rules={[{ required: true }]}><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="end_liters" label="End volume (L)" rules={[{ required: true }]}><InputNumber className="full-width" min={0} step="any" /></Form.Item></div>
        <Form.Item name="duration_minutes" label="Boil duration (minutes)" rules={[{ required: true }]}><InputNumber className="full-width" min={0.01} step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Save calibration</Button>
      </Form>
    </Modal>
    <Modal title="Calibrate temperature" open={newTemperatureCalibration} onCancel={() => setNewTemperatureCalibration(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={saveTemperatureCalibration}>
        <p className="muted">The offset is added to the equipment reading. Saving replaces the previous offset.</p>
        <Form.Item name="reference_c" label="Reference temperature (°C)" rules={[{ required: true }]}><InputNumber className="full-width" step="any" /></Form.Item>
        <Form.Item name="observed_c" label="Equipment reading (°C)" rules={[{ required: true }]}><InputNumber className="full-width" step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Save temperature calibration</Button>
      </Form>
    </Modal>
  </div>;
}
