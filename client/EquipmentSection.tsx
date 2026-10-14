import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Checkbox, Dropdown, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Table, Tooltip } from 'antd';
import { CloudOutlined, ContainerOutlined, ControlOutlined, DashboardOutlined, EditOutlined, ExperimentOutlined,
  FireOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons';
import { boilOffKinds, capacityKinds, equipmentGroups, equipmentKindLabel, measurementRangeUnits, temperatureCalibrationKinds } from '../shared/equipment.ts';
import type { CatalogEquipment } from '../shared/catalog.ts';
import { assignEquipmentToBatch, createEquipment, createEquipmentUnit, deleteEquipment, listCurrentEquipmentUses, releaseEquipmentUse,
  addEquipmentModelCapability, removeEquipmentModelCapability, restoreEquipmentModelCapability,
  updateEquipmentBoilHeatLoss, clearEquipmentBoilHeatLoss,
  updateEquipmentModelBoilHeatLoss, clearEquipmentModelBoilHeatLoss,
  updateEquipmentCalibration, updateEquipmentStockId,
  clearEquipmentUnitOverrides, clearEquipmentUnitMeasurementOverrides,
  clearEquipmentModelOverride, clearEquipmentModelMeasurementOverrides,
  updateEquipmentModelAttribute, updateEquipmentModelMeasurementRange,
  updateEquipmentRatedPower, updateEquipmentCapacity, updateEquipmentPressureRating,
  updateEquipmentTemperatureOffset, updateEquipmentThermalCapabilities, updateBrewingLosses, latestMeasuredMashEfficiency,
  updateEquipmentMeasurementRange,
  type Batch, type Equipment, type EquipmentModelOverrideField, type EquipmentOverrideField,
  type EquipmentSpecifications, type EquipmentUse, type LocalDb } from './db.ts';
import { capacityInLiters, capacityLabel, capacityUnits } from '../shared/capacity.ts';
import { changeNumberUnit } from './unitFields.ts';
import { equipmentModelPathSegment, equipmentUnitPathSegment } from './equipmentRoutes.ts';
import { heatLossFromBoil, predictedBoilOff } from './boilOff.ts';
import { convertUnit, unitOptions, unitGroups, type PreferredUnits } from '../shared/units.ts';
import { measurementKinds } from './constants.ts';

function rangeLabel(min: number, max: number, scale: string | undefined): string {
  return `${min}–${max}${scale === 'SG' ? ' (specific gravity)' : ` ${scale || ''}`}`;
}

function measurementLabel(kind: string): string {
  if (kind === 'mass') return 'Mass';
  return measurementKinds.find(item => item.value === kind)?.label || kind;
}

function measurementSentenceLabel(kind: string): string {
  const label = measurementLabel(kind);
  return label[0].toLowerCase() + label.slice(1);
}

function channelSummary(channels: { measurement_kind: string }[] | undefined): string {
  return [...new Set((channels || []).map(channel => measurementLabel(channel.measurement_kind)))].join(' · ');
}

const channelEquipmentKinds: Record<string, string> = {
  gravity: 'hydrometer', temperature: 'thermometer', ph: 'ph_meter', mass: 'scale',
  pressure: 'pressure_gauge', carbonation: 'carbonation_meter',
  dissolved_oxygen: 'dissolved_oxygen_meter'
};

function channelUnits(kind: string): readonly string[] {
  if (kind === 'volume') return unitGroups.volume;
  return measurementRangeUnits[channelEquipmentKinds[kind]] || [];
}

const measurementCapabilityKinds = [...measurementKinds, { value: 'mass', label: 'Mass', unit: 'g' }];

const modelAttributeLabels: Record<EquipmentModelOverrideField, string> = {
  capacity_liters: 'Capacity (L)', max_pressure_kpa: 'Maximum working pressure (kPa)',
  rated_power_watts: 'Rated heating power (W)', rated_heat_removal_watts: 'Rated heat removal (W)',
  min_temperature_c: 'Minimum temperature (°C)', max_temperature_c: 'Maximum temperature (°C)',
  mash_efficiency_pct: 'Mash efficiency (%)', grain_absorption_l_per_kg: 'Grain absorption (L per kg)'
};
const modelAttributeCapabilities: Partial<Record<EquipmentModelOverrideField, string>> = {
  capacity_liters: 'liquid_containment', max_pressure_kpa: 'pressure_rating',
  rated_power_watts: 'heating', rated_heat_removal_watts: 'cooling',
  min_temperature_c: 'temperature_control', max_temperature_c: 'temperature_control'
};
const modelCapabilityFlags = {
  liquid_containment: 'has_liquid_containment', pressure_rating: 'has_pressure_rating',
  heating: 'has_heating', cooling: 'has_cooling', temperature_control: 'has_temperature_control'
} as const;

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
  if (row.has_liquid_containment) capabilities.push({ label: 'Holds liquid', icon: <ContainerOutlined /> });
  if (row.has_heating) capabilities.push({ label: 'Heating', icon: <FireOutlined /> });
  if (row.has_cooling) {
    capabilities.push({ label: 'Cooling', icon: <CloudOutlined /> });
  }
  if (row.has_temperature_control) capabilities.push({ label: 'Temperature control', icon: <ControlOutlined /> });
  if (row.has_pressure_rating) capabilities.push({ label: 'Pressure rated', icon: <DashboardOutlined /> });
  if (row.kind === 'pump') capabilities.push({ label: 'Moves liquid', icon: <SwapOutlined /> });
  const measured = [...new Set(row.measurement_channels?.map(channel => channel.measurement_kind) || [])];
  if (measured.length) {
    capabilities.push({ label: measured.length ? `Measures ${measured.join(', ')}` : 'Measures', icon: <ExperimentOutlined /> });
  }
  return capabilities.length ? <div className="equipment-capabilities">{capabilities.map(({ label, icon }) =>
    <Tooltip key={label} title={label}><span role="img" aria-label={label} className="equipment-capability">{icon}</span></Tooltip>)}</div> : '—';
}

export function EquipmentSection({ db, basePath, accountId, batches, equipment, models, catalog, preferredUnits, selectedId, onSelect, onSelectBatch, onChanged }: {
  db: LocalDb; basePath: string; accountId: string; batches: Batch[]; equipment: Equipment[]; models: Equipment[]; catalog: CatalogEquipment[]; preferredUnits: PreferredUnits;
  selectedId: string | null; onSelect: (id: string | null) => void; onSelectBatch: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [creatingKind, setCreatingKind] = useState<string | null>(null);
  const [addingUnit, setAddingUnit] = useState(false);
  const [catalogPickerOpen, setCatalogPickerOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogKind, setCatalogKind] = useState<string | undefined>();
  const [selectedCatalogModel, setSelectedCatalogModel] = useState<CatalogEquipment | null>(null);
  const [editCalibration, setEditCalibration] = useState(false);
  const [newBoilCalibration, setNewBoilCalibration] = useState(false);
  const [editModelBoilHeatLoss, setEditModelBoilHeatLoss] = useState(false);
  const [editModelField, setEditModelField] = useState<EquipmentModelOverrideField | null>(null);
  const [editModelRange, setEditModelRange] = useState<string | null>(null);
  const [newTemperatureCalibration, setNewTemperatureCalibration] = useState(false);
  const [editIdentity, setEditIdentity] = useState(false);
  const [editCapacity, setEditCapacity] = useState(false);
  const [editPressure, setEditPressure] = useState(false);
  const [editPower, setEditPower] = useState(false);
  const [editThermal, setEditThermal] = useState(false);
  const [editBrewingLosses, setEditBrewingLosses] = useState(false);
  const [recentMashEfficiency, setRecentMashEfficiency] = useState<number | null>(null);
  const [editRange, setEditRange] = useState<string | null>(null);
  const [addingCapability, setAddingCapability] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [uses, setUses] = useState<EquipmentUse[]>([]);
  const [assignBatchId, setAssignBatchId] = useState<string | undefined>();
  const [equipmentForm] = Form.useForm();
  const [capacityForm] = Form.useForm();
  const [pressureForm] = Form.useForm();
  const [powerForm] = Form.useForm();
  const [thermalForm] = Form.useForm();
  const [rangeForm] = Form.useForm();
  const [modelRangeForm] = Form.useForm();
  const [capabilityForm] = Form.useForm();
  const item = equipment.find(row => row.id === selectedId) || null;
  const itemModel = item ? models.find(row => row.id === item.model_id) : undefined;
  const selectedModel = models.find(row => row.id === selectedId) || null;
  const catalogParent = selectedModel ? catalog.find(row => row.id === selectedModel.catalog_model_id) : undefined;
  const addingCatalogDefault = !!addingCapability && !!catalogParent && (addingCapability.startsWith('measurement:')
    ? !!catalogParent.measurement_channels?.some(channel => channel.measurement_kind === addingCapability.slice('measurement:'.length))
    : !!catalogParent[modelCapabilityFlags[addingCapability as keyof typeof modelCapabilityFlags]]);
  const modelRangeChannel = selectedModel?.measurement_channels?.find(channel => channel.measurement_kind === editModelRange);
  const modelUnits = selectedModel ? equipment.filter(row => row.model_id === selectedModel.id) : [];
  const sortedModelUnits = [...modelUnits].sort((a, b) => (a.stock_id || '').localeCompare(b.stock_id || '') || a.id.localeCompare(b.id));
  const newCapacityUnit = Form.useWatch('capacity_unit', equipmentForm) as string | undefined;
  const newRangeUnit = Form.useWatch('measurement_unit', equipmentForm) as string | undefined;
  const editCapacityUnit = Form.useWatch('capacity_unit', capacityForm) as string | undefined;
  const editPressureRatingUnit = Form.useWatch('pressure_unit', pressureForm) as string | undefined;
  const editRangeUnit = Form.useWatch('measurement_unit', rangeForm) as string | undefined;
  const editModelRangeUnit = Form.useWatch('measurement_unit', modelRangeForm) as string | undefined;
  const addChannelUnit = Form.useWatch('measurement_unit', capabilityForm) as string | undefined;
  const newPressureUnit = Form.useWatch('pressure_unit', equipmentForm) as string | undefined;
  const newHeating = Form.useWatch('has_heating', equipmentForm) as boolean | undefined;
  const newCooling = Form.useWatch('has_cooling', equipmentForm) as boolean | undefined;
  const newFermenterControl = Form.useWatch('built_in_temperature_control', equipmentForm) as boolean | undefined;
  const profile = item ? calibrationProfiles[item.kind] : undefined;
  const specs: EquipmentSpecifications = item || {};
  const calibrationValues = Object.fromEntries((profile?.fields || []).map(field => [field.key,
    (specs as Record<string, unknown>)[field.key]]));
  const hasTemperatureReading = !!item && (temperatureCalibrationKinds.has(item.kind)
    || item.measurement_channels?.some(channel => channel.measurement_kind === 'temperature')
    || !!item.has_temperature_control);
  const createPrimaryMeasurement = !!creatingKind && !selectedCatalogModel && !!measurementRangeUnits[creatingKind];
  const catalogCreationChannels = selectedCatalogModel?.measurement_channels || [];
  const editingChannel = item?.measurement_channels?.find(channel => channel.measurement_kind === editRange);
  const ratedEstimate = !item?.has_heating || specs.rated_power_watts == null || specs.boil_heat_loss_watts == null
    ? null : predictedBoilOff(specs.rated_power_watts, specs.boil_heat_loss_watts);
  const boilHeatLossSource = specs.unit_boil_heat_loss_watts != null ? 'this unit'
    : specs.workspace_model_boil_heat_loss_watts != null ? 'brewery model'
      : specs.catalog_model_boil_heat_loss_watts != null ? 'catalog model' : null;
  const thermalKind = !!item && (!!item.has_cooling || !!item.has_temperature_control);
  const showCooling = !!item?.has_cooling;
  const createCapacity = !!creatingKind && (selectedCatalogModel
    ? !!selectedCatalogModel.has_liquid_containment : capacityKinds.has(creatingKind));
  const createHeating = !!creatingKind && (selectedCatalogModel
    ? !!selectedCatalogModel.has_heating : boilOffKinds.has(creatingKind)
      || ['fermenter', 'fermentation_temperature_control'].includes(creatingKind));
  const createCooling = !!creatingKind && (selectedCatalogModel
    ? !!selectedCatalogModel.has_cooling : ['fermenter', 'fermentation_temperature_control'].includes(creatingKind));
  const newTemperatureControl = !!creatingKind && (selectedCatalogModel
    ? !!selectedCatalogModel.has_temperature_control : boilOffKinds.has(creatingKind)
      || creatingKind === 'fermentation_temperature_control');
  const newThermal = createHeating || createCooling || newTemperatureControl
    || !!creatingKind && !selectedCatalogModel && creatingKind === 'fermenter';
  const initialEquipmentValues = {
    name: selectedCatalogModel?.name, capacity: selectedCatalogModel?.capacity_liters,
    capacity_unit: 'L', measurement_min: selectedCatalogModel?.measurement_min,
    measurement_max: selectedCatalogModel?.measurement_max,
    measurement_unit: selectedCatalogModel?.measurement_unit || measurementRangeUnits[creatingKind || '']?.[0],
    channel_ranges: Object.fromEntries(catalogCreationChannels.map(channel => [channel.measurement_kind, {
      min: channel.measurement_min, max: channel.measurement_max,
      unit: channel.measurement_scale || channel.measurement_unit || channelUnits(channel.measurement_kind)[0]
    }])),
    rated_power_watts: selectedCatalogModel?.rated_power_watts,
    has_heating: !!selectedCatalogModel?.has_heating || !!creatingKind && !selectedCatalogModel && boilOffKinds.has(creatingKind),
    has_cooling: !!selectedCatalogModel?.has_cooling,
    rated_heat_removal_watts: selectedCatalogModel?.rated_heat_removal_watts,
    min_temperature_c: selectedCatalogModel?.min_temperature_c,
    max_temperature_c: selectedCatalogModel?.max_temperature_c,
    built_in_temperature_control: selectedCatalogModel?.built_in_temperature_control || false,
    max_pressure: selectedCatalogModel?.max_pressure_kpa == null ? undefined
      : convertUnit(selectedCatalogModel.max_pressure_kpa, 'kPa', preferredUnits.pressure),
    pressure_unit: preferredUnits.pressure
  };
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
    if (!creatingKind) return;
    equipmentForm.resetFields();
    equipmentForm.setFieldsValue(initialEquipmentValues);
  }, [creatingKind, selectedCatalogModel?.id, preferredUnits.pressure, equipmentForm]);

  useEffect(() => {
    if (!editRange || !editingChannel) return;
    rangeForm.resetFields();
    rangeForm.setFieldsValue({
      measurement_min: editingChannel.measurement_min,
      measurement_max: editingChannel.measurement_max,
      measurement_unit: editingChannel.measurement_scale || editingChannel.measurement_unit || channelUnits(editRange)[0]
    });
  }, [editRange, item?.id, rangeForm]);

  useEffect(() => {
    if (!addingCapability) return;
    capabilityForm.resetFields();
    if (addingCapability.startsWith('measurement:')) {
      capabilityForm.setFieldValue('measurement_unit', channelUnits(addingCapability.slice('measurement:'.length))[0]);
    }
  }, [addingCapability, selectedModel?.id, capabilityForm]);

  useEffect(() => {
    if (!editThermal || !item) return;
    thermalForm.resetFields();
    thermalForm.setFieldsValue({
      rated_heat_removal_watts: item.rated_heat_removal_watts,
      min_temperature_c: item.min_temperature_c,
      max_temperature_c: item.max_temperature_c
    });
  }, [editThermal, item?.id, thermalForm]);

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
      || !unit || !(measurementRangeUnits[kind] || channelUnits(kind)).includes(unit)) {
      throw new Error('Enter a valid measurement range and unit');
    }
    return { min, max, unit };
  }

  async function create(values: { name: string; stock_id?: string; capacity?: number; capacity_unit?: string;
    measurement_min?: number; measurement_max?: number; measurement_unit?: string; rated_power_watts?: number;
    channel_ranges?: Record<string, { min?: number; max?: number; unit?: string }>;
    built_in_temperature_control?: boolean; max_pressure?: number; pressure_unit?: string;
    has_heating?: boolean; has_cooling?: boolean; rated_heat_removal_watts?: number;
    min_temperature_c?: number; max_temperature_c?: number }) {
    if (!creatingKind) return;
    try {
      const overrides: EquipmentSpecifications = {};
      if (createCapacity) {
        const capacity = capacityInLiters(values.capacity, values.capacity_unit);
        if (capacity != null) overrides.capacity_liters = capacity;
      }
      if (createPrimaryMeasurement) {
        const range = validRange(values.measurement_min, values.measurement_max, values.measurement_unit, creatingKind);
        if (range) Object.assign(overrides, { measurement_min: range.min, measurement_max: range.max, measurement_unit: range.unit });
      }
      if (boilOffKinds.has(creatingKind) && createHeating && values.rated_power_watts != null) {
        if (!Number.isFinite(values.rated_power_watts) || values.rated_power_watts <= 0) throw new Error('Enter a positive power');
        overrides.rated_power_watts = values.rated_power_watts;
      }
      if (creatingKind === 'fermenter' && !selectedCatalogModel || selectedCatalogModel?.has_temperature_control) {
        overrides.built_in_temperature_control = !!values.built_in_temperature_control;
      }
      if (selectedCatalogModel?.has_pressure_rating || !selectedCatalogModel && creatingKind === 'fermenter') {
        overrides.max_pressure_kpa = pressureInKpa(values.max_pressure, values.pressure_unit);
      }
      if (newThermal) {
        overrides.has_heating = createHeating && (!!values.has_heating || boilOffKinds.has(creatingKind));
        overrides.has_cooling = createCooling && !!values.has_cooling;
        overrides.has_temperature_control = creatingKind === 'fermenter'
          ? !!values.built_in_temperature_control : newTemperatureControl;
        if (createHeating && values.rated_power_watts != null) overrides.rated_power_watts = values.rated_power_watts;
        if (createCooling && values.has_cooling && values.rated_heat_removal_watts != null) {
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
      const channelRanges: Record<string, { min: number; max: number; unit: string }> = {};
      for (const channel of catalogCreationChannels) {
        const value = values.channel_ranges?.[channel.measurement_kind];
        const range = validRange(value?.min, value?.max, value?.unit,
          channelEquipmentKinds[channel.measurement_kind]);
        if (range) channelRanges[channel.measurement_kind] = range;
      }
      const id = await createEquipment(db, values.name.trim(), creatingKind,
        selectedCatalogModel || undefined, overrides, channelRanges, values.stock_id);
      setCreatingKind(null); setSelectedCatalogModel(null); onSelect(id); await onChanged();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveCapacity(values: { capacity?: number; capacity_unit?: string }) {
    if (!item) return;
    try { await updateEquipmentCapacity(db, item, capacityInLiters(values.capacity, values.capacity_unit), itemModel); setEditCapacity(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function savePressure(values: { max_pressure?: number; pressure_unit?: string }) {
    if (!item) return;
    try {
      await updateEquipmentPressureRating(db, item, pressureInKpa(values.max_pressure, values.pressure_unit) ?? null, itemModel);
      setEditPressure(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function savePower(values: { rated_power_watts?: number }) {
    if (!item) return;
    try {
      await updateEquipmentRatedPower(db, item, values.rated_power_watts ?? null, itemModel);
      setEditPower(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveThermal(values: { has_heating?: boolean; rated_power_watts?: number;
    has_cooling?: boolean; rated_heat_removal_watts?: number;
    min_temperature_c?: number; max_temperature_c?: number }) {
    if (!item) return;
    try {
      await updateEquipmentThermalCapabilities(db, item, {
        has_heating: !!item.has_heating, rated_power_watts: item.rated_power_watts ?? null,
        has_cooling: !!item.has_cooling,
        rated_heat_removal_watts: item.has_cooling ? values.rated_heat_removal_watts ?? null : null,
        has_temperature_control: !!item.has_temperature_control,
        min_temperature_c: values.min_temperature_c ?? null, max_temperature_c: values.max_temperature_c ?? null
      }, itemModel);
      setEditThermal(false); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveBrewingLosses(values: { mash_efficiency_pct?: number; grain_absorption_l_per_kg?: number }) {
    if (!item) return;
    try { await updateBrewingLosses(db, item, values, itemModel); setEditBrewingLosses(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveIdentity(values: { stock_id?: string }) {
    if (!item) return;
    try {
      await updateEquipmentStockId(db, item, values.stock_id, equipment);
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

  async function clearBoilCalibration() {
    if (!item) return;
    try { await clearEquipmentBoilHeatLoss(db, item); setNewBoilCalibration(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveModelBoilHeatLoss(values: { heat_loss_watts: number }) {
    if (!selectedModel) return;
    try { await updateEquipmentModelBoilHeatLoss(db, selectedModel, values.heat_loss_watts);
      setEditModelBoilHeatLoss(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function clearModelBoilHeatLoss() {
    if (!selectedModel) return;
    try { await clearEquipmentModelBoilHeatLoss(db, selectedModel); setEditModelBoilHeatLoss(false); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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
    if (!item || !editRange) return;
    try {
      const range = validRange(values.measurement_min, values.measurement_max, values.measurement_unit,
        channelEquipmentKinds[editRange]);
      await updateEquipmentMeasurementRange(db, item, range, editRange, itemModel);
      setEditRange(null); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function resetUnitOverride(fields: EquipmentOverrideField[]) {
    if (!item) return;
    try {
      await clearEquipmentUnitOverrides(db, item, fields);
      setEditCapacity(false); setEditPressure(false); setEditPower(false);
      setEditThermal(false); setEditBrewingLosses(false);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function resetMeasurementOverride() {
    if (!item || !editRange) return;
    try {
      await clearEquipmentUnitMeasurementOverrides(db, item, editRange);
      setEditRange(null); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function resetModelOverride() {
    if (!selectedModel || !editModelField) return;
    try { await clearEquipmentModelOverride(db, selectedModel, editModelField); setEditModelField(null); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function resetModelMeasurementOverride() {
    if (!selectedModel || !editModelRange) return;
    try { await clearEquipmentModelMeasurementOverrides(db, selectedModel, editModelRange);
      setEditModelRange(null); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveModelAttribute(values: { value?: number }) {
    if (!selectedModel || !editModelField) return;
    try {
      const catalogValue = (catalogParent as EquipmentSpecifications | undefined)?.[editModelField];
      await updateEquipmentModelAttribute(db, selectedModel, editModelField, values.value ?? null, catalogValue);
      setEditModelField(null); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveModelRange(values: { measurement_min?: number; measurement_max?: number; measurement_unit?: string }) {
    if (!selectedModel || !editModelRange) return;
    try {
      const range = validRange(values.measurement_min, values.measurement_max, values.measurement_unit,
        channelEquipmentKinds[editModelRange]);
      const catalogChannel = catalogParent?.measurement_channels?.find(channel => channel.measurement_kind === editModelRange);
      await updateEquipmentModelMeasurementRange(db, selectedModel, editModelRange, range, catalogChannel);
      setEditModelRange(null); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveAddedCapability(values: { capacity_liters?: number; max_pressure_kpa?: number;
    rated_power_watts?: number; rated_heat_removal_watts?: number;
    min_temperature_c?: number; max_temperature_c?: number;
    measurement_min?: number; measurement_max?: number; measurement_unit?: string }) {
    if (!selectedModel || !addingCapability) return;
    try {
      if (addingCapability.startsWith('measurement:')) {
        const kind = addingCapability.slice('measurement:'.length);
        const range = validRange(values.measurement_min, values.measurement_max, values.measurement_unit,
          channelEquipmentKinds[kind] || kind);
        await addEquipmentModelCapability(db, selectedModel, addingCapability, {
          measurement_min: range?.min, measurement_max: range?.max,
          measurement_unit: values.measurement_unit || channelUnits(kind)[0]
        });
      } else {
        await addEquipmentModelCapability(db, selectedModel, addingCapability, values);
      }
      setAddingCapability(null); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function removeModelCapability(capability: string) {
    if (!selectedModel) return;
    try {
      await removeEquipmentModelCapability(db, selectedModel, capability);
      setEditModelField(null); setEditModelRange(null);
      await onChanged();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function restoreModelCapability(capability: string) {
    if (!selectedModel) return;
    try {
      await restoreEquipmentModelCapability(db, selectedModel, capability);
      setAddingCapability(null);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function remove() {
    if (!item) return;
    try {
      await deleteEquipment(db, item.id);
      onSelect(item.model_id || null);
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
  const missingCapabilities = selectedModel ? [
    ...(!selectedModel.has_liquid_containment ? [{ key: 'liquid_containment', label: 'Liquid capacity' }] : []),
    ...(!selectedModel.has_pressure_rating ? [{ key: 'pressure_rating', label: 'Pressure rating' }] : []),
    ...(!selectedModel.has_heating ? [{ key: 'heating', label: 'Heating' }] : []),
    ...(!selectedModel.has_cooling ? [{ key: 'cooling', label: 'Cooling' }] : []),
    ...(!selectedModel.has_temperature_control ? [{ key: 'temperature_control', label: 'Temperature control' }] : []),
    { key: 'measurement', label: 'Measurement channel', children: measurementCapabilityKinds
      .filter(kind => !selectedModel.measurement_channels?.some(channel => channel.measurement_kind === kind.value))
      .map(kind => ({ key: `measurement:${kind.value}`, label: kind.label })) }
  ].filter(entry => entry.key !== 'measurement' || entry.children?.length) : [];
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
        {models.length > 0 && <Button icon={<PlusOutlined />} onClick={() => setAddingUnit(true)}>Add unit</Button>}
        <Button icon={<PlusOutlined />} onClick={() => { setCatalogQuery(''); setCatalogKind(undefined); setCatalogPickerOpen(true); }}>Add from catalog</Button>
        <Dropdown trigger={['click']} menu={addMenu} placement="bottomLeft">
          <Button icon={<PlusOutlined />}>Define equipment</Button>
        </Dropdown>
      </div>
      {models.length > 0 && <Table<Equipment> className="equipment-table" dataSource={[...models].sort((a, b) => a.name.localeCompare(b.name))}
        rowKey="id" pagination={false} size="small" tableLayout="fixed" columns={[
          { title: 'Model', dataIndex: 'name', width: '50%', render: (_, row) =>
            <a href={`${basePath}/equipment/${equipmentModelPathSegment(row, models)}`}
              onClick={event => { event.preventDefault(); onSelect(row.id); }}>{row.name}</a> },
          { title: 'Units', key: 'units', width: '20%', render: (_: unknown, row: Equipment) =>
            equipment.filter(unit => unit.model_id === row.id).length },
          { title: 'Capabilities', key: 'capabilities', width: '30%', render: (_: unknown, row: Equipment) => equipmentCapabilities(row) }
        ]} />}
    </section> : selectedModel ? <section className="record-detail">
      <div className="content-heading"><div><span className="eyebrow">{equipmentKindLabel(selectedModel.kind)}</span>
        <h2>{selectedModel.name}</h2><p className="muted">Model defaults shared by all its units. Individual units can override them.</p></div>
        <Button icon={<PlusOutlined />} onClick={() => setAddingUnit(true)}>Add unit</Button></div>
      <div className="equipment-parameters">
        <div className="equipment-parameter"><span>Capabilities:</span> {equipmentCapabilities(selectedModel)}</div>
        {selectedModel.has_liquid_containment && <div className="equipment-parameter"><span>
          Capacity: {capacityLabel(selectedModel.capacity_liters ?? undefined) || 'Not set'}</span>
          <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit model capacity"
            onClick={() => setEditModelField('capacity_liters')} /></div>}
        {selectedModel.has_pressure_rating && <div className="equipment-parameter"><span>
          Pressure rating: {pressureLabel(selectedModel.max_pressure_kpa, preferredUnits.pressure)}</span>
          <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit model pressure rating"
            onClick={() => setEditModelField('max_pressure_kpa')} /></div>}
        {selectedModel.has_heating && <div className="equipment-parameter"><span>
          Rated power: {selectedModel.rated_power_watts == null ? 'Not set' : `${selectedModel.rated_power_watts} W`}</span>
          <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit model rated power"
            onClick={() => setEditModelField('rated_power_watts')} /></div>}
        {selectedModel.has_cooling && <div className="equipment-parameter"><span>
          Rated heat removal: {selectedModel.rated_heat_removal_watts == null ? 'Not set' : `${selectedModel.rated_heat_removal_watts} W`}</span>
          <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit model heat removal"
            onClick={() => setEditModelField('rated_heat_removal_watts')} /></div>}
        {selectedModel.has_temperature_control && <>
          <div className="equipment-parameter"><span>Minimum temperature: {selectedModel.min_temperature_c == null
            ? 'Not set' : `${selectedModel.min_temperature_c} °C`}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit model minimum temperature"
              onClick={() => setEditModelField('min_temperature_c')} /></div>
          <div className="equipment-parameter"><span>Maximum temperature: {selectedModel.max_temperature_c == null
            ? 'Not set' : `${selectedModel.max_temperature_c} °C`}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit model maximum temperature"
              onClick={() => setEditModelField('max_temperature_c')} /></div>
        </>}
        {['all_in_one', 'mash_tun', 'kettle', 'electric_kettle'].includes(selectedModel.kind) && <div className="equipment-parameter"><span>
          Mash efficiency: {selectedModel.mash_efficiency_pct == null ? 'Not set' : `${selectedModel.mash_efficiency_pct}%`}</span>
          <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit model mash efficiency"
            onClick={() => setEditModelField('mash_efficiency_pct')} /></div>}
        {['all_in_one', 'mash_tun', 'kettle', 'electric_kettle'].includes(selectedModel.kind) && <div className="equipment-parameter"><span>
          Grain absorption: {selectedModel.grain_absorption_l_per_kg == null ? 'Not set'
            : `${selectedModel.grain_absorption_l_per_kg} L/kg`}</span>
          <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit model grain absorption"
            onClick={() => setEditModelField('grain_absorption_l_per_kg')} /></div>}
        {selectedModel.measurement_channels?.map(channel => <div key={channel.measurement_kind} className="equipment-parameter"><span>
          {measurementLabel(channel.measurement_kind)}: {channel.measurement_min != null && channel.measurement_max != null
            ? rangeLabel(channel.measurement_min, channel.measurement_max,
              channel.measurement_scale || channel.measurement_unit || undefined) : 'Available'}</span>
          <Button type="text" size="small" icon={<EditOutlined />}
            aria-label={`Edit model ${measurementSentenceLabel(channel.measurement_kind)} range`}
            onClick={() => setEditModelRange(channel.measurement_kind)} /></div>)}
        {selectedModel.has_heating && boilOffKinds.has(selectedModel.kind) && <div className="equipment-parameter"><span>Heat loss at boil: {
          selectedModel.boil_heat_loss_watts == null ? 'Not set'
            : `${Math.round(selectedModel.boil_heat_loss_watts)} W (${selectedModel.workspace_model_boil_heat_loss_watts != null
              ? 'brewery model' : 'catalog model'})`}</span>
          <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit model heat loss"
            onClick={() => setEditModelBoilHeatLoss(true)} /></div>}
      </div>
      {missingCapabilities.length > 0 && <Dropdown trigger={['click']} placement="bottomLeft"
        menu={{ items: missingCapabilities, triggerSubMenuAction: 'click', onClick: ({ key }) => setAddingCapability(key) }}>
        <Button icon={<PlusOutlined />}>Add capability</Button>
      </Dropdown>}
      {modelUnits.length > 0 && <Table<Equipment> className="equipment-table" dataSource={sortedModelUnits}
        rowKey="id" pagination={false} size="small" tableLayout="fixed" columns={[
          { title: 'Stock ID', dataIndex: 'stock_id', width: '65%', render: (value, row) =>
            <a href={`${basePath}/equipment/${equipmentUnitPathSegment(row, equipment, models)}`}
              onClick={event => { event.preventDefault(); onSelect(row.id); }}>{value || `Unit ${row.id.slice(0, 6)}`}</a> },
          { title: 'Current batch', key: 'current-batch', width: '35%', render: (_: unknown, row: Equipment) => {
            const current = uses.filter(use => use.equipment_id === row.id);
            return current.length ? <div className="equipment-current-batches">{current.map(use =>
              <a key={use.id} href={`${basePath}/batch/${use.batch_id}`}
                onClick={event => { event.preventDefault(); onSelectBatch(use.batch_id); }}>{use.batch_name}</a>)}</div> : '—';
          } }
        ]} />}
    </section> : !item ? <Empty description="Equipment not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">{equipmentKindLabel(item.kind)}</span>
          <div className="equipment-title"><h2>{item.stock_id || `Unit ${item.id.slice(0, 6)}`}</h2></div></div></div>
        <div className="equipment-parameters">
          <div className="equipment-parameter"><span>Stock ID: {item.stock_id || 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit Stock ID" onClick={() => setEditIdentity(true)} /></div>
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
          {item.has_liquid_containment && <div className="equipment-parameter"><span>Capacity: {capacityLabel(specs.capacity_liters ?? undefined) || 'Not set'}
            {specs.capacity_liters != null && (item.unit_capacity_liters != null ? ' (this unit)' : ' (model)')}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Override capacity for this unit" onClick={() => setEditCapacity(true)} /></div>}
          {item.has_pressure_rating && <div className="equipment-parameter"><span>
            Pressure rating: {pressureLabel(specs.max_pressure_kpa, preferredUnits.pressure)}
            {specs.max_pressure_kpa != null && (item.unit_max_pressure_kpa != null ? ' (this unit)' : ' (model)')}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Override pressure rating for this unit" onClick={() => setEditPressure(true)} /></div>}
          {item.has_heating && <div className="equipment-parameter"><span>Rated power: {specs.rated_power_watts != null
            ? `${specs.rated_power_watts} W (${item.unit_rated_power_watts != null ? 'this unit' : 'model'})` : 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Override rated power for this unit" onClick={() => setEditPower(true)} /></div>}
          {thermalKind && <div className="equipment-parameter"><span>
            {specs.has_temperature_control && <>Temperature range: {
              specs.min_temperature_c == null && specs.max_temperature_c == null ? 'Not set'
                : `${specs.min_temperature_c ?? '—'}–${specs.max_temperature_c ?? '—'} °C`}<br /></>}
            {showCooling &&
              <>Rated heat removal: {specs.rated_heat_removal_watts == null
                ? 'Not set' : `${specs.rated_heat_removal_watts} W`}</>}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Override thermal settings for this unit" onClick={() => setEditThermal(true)} /></div>}
          {hasTemperatureReading && <div className="equipment-parameter"><span>Temperature offset: {specs.temperature_offset_c == null
            ? 'Not calibrated' : `${specs.temperature_offset_c > 0 ? '+' : ''}${Number(specs.temperature_offset_c.toFixed(2))} °C`}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit temperature offset" onClick={() => setNewTemperatureCalibration(true)} /></div>}
          {item.has_heating && boilOffKinds.has(item.kind) && <div className="equipment-parameter"><span>Heat loss at boil: {specs.boil_heat_loss_watts == null
            ? 'Not calibrated' : `${Math.round(specs.boil_heat_loss_watts)} W (${boilHeatLossSource})`}</span>
            <Button type="text" size="small" onClick={() => setNewBoilCalibration(true)}>Calibrate unit</Button></div>}
          {ratedEstimate != null && <div className="equipment-parameter">Estimated boil-off at rated power: {Number(ratedEstimate.toFixed(2))} L/h</div>}
          {['all_in_one', 'mash_tun', 'kettle', 'electric_kettle'].includes(item.kind) &&
            <div className="equipment-parameter"><span>Mash efficiency: {specs.mash_efficiency_pct != null
              ? `${specs.mash_efficiency_pct}% (set)` : recentMashEfficiency != null ? `${recentMashEfficiency}% (recent batch)` : 'Not set'}<br />
              Grain absorption: {specs.grain_absorption_l_per_kg == null ? 'Not set' : `${specs.grain_absorption_l_per_kg} L/kg`}</span>
              <Button type="text" size="small" icon={<EditOutlined />} aria-label="Override mash assumptions for this unit" onClick={() => setEditBrewingLosses(true)} /></div>}
          {item.measurement_channels?.map(channel => <div key={channel.id} className="equipment-parameter"><span>
              {measurementLabel(channel.measurement_kind)}: {channel.measurement_min != null && channel.measurement_max != null
                ? rangeLabel(channel.measurement_min, channel.measurement_max,
                  channel.measurement_scale || channel.measurement_unit || undefined) : 'Available'}</span>
              <Button type="text" size="small" icon={<EditOutlined />}
                aria-label={`Override ${measurementSentenceLabel(channel.measurement_kind)} range for this unit`}
                onClick={() => setEditRange(channel.measurement_kind)} />
            </div>)}
          {profile?.fields.map(field => <div key={field.key} className="equipment-parameter"><span>{field.label}: {calibrationValues[field.key] == null ? 'Not calibrated' : String(calibrationValues[field.key])}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Edit ${field.label}`} onClick={() => setEditCalibration(true)} /></div>)}
        </div>
        <div className="equipment-delete"><Popconfirm title={`Delete ${item.name}?`}
          description="The unit is removed from your equipment list. Its batch history and calibrations remain."
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
            {model.thumbnail_src && <img className="equipment-catalog-thumbnail" src={model.thumbnail_src} alt="" loading="lazy" />}
            <span className="equipment-catalog-option-name"><strong>{model.name}</strong>
              <small>{equipmentKindLabel(model.kind)}{model.measurement_channels?.length
                ? ` · ${channelSummary(model.measurement_channels)}` : ''}</small></span>
          </button>
        </div>)}
      </div> : <Empty description={catalog.length ? 'No matching equipment' : 'No catalog equipment available'} />}
    </Modal>
    <Modal title="Add equipment unit" open={addingUnit} onCancel={() => setAddingUnit(false)} footer={null} destroyOnHidden>
      <Form key={selectedModel?.id || 'all'} layout="vertical" initialValues={{ model_id: selectedModel?.id }}
        onFinish={async (values: { model_id: string; stock_id?: string }) => {
        try {
          const id = await createEquipmentUnit(db, values.model_id, values.stock_id);
          setAddingUnit(false); await onChanged(); onSelect(id);
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>
        <Form.Item name="model_id" label="Model" rules={[{ required: true }]}><Select showSearch optionFilterProp="label"
          options={models.map(model => ({ value: model.id, label: model.name }))} /></Form.Item>
        <Form.Item name="stock_id" label="Stock ID (optional)"><Input maxLength={80} /></Form.Item>
        <Button type="primary" htmlType="submit">Add unit</Button>
      </Form>
    </Modal>
    <Modal title={creatingKind ? addEquipmentTitle(creatingKind) : 'Add equipment'} open={!!creatingKind}
      onCancel={closeCreation} footer={null} destroyOnHidden>
      {creatingKind && <Form key={`${creatingKind}:${selectedCatalogModel?.id || 'custom'}`} form={equipmentForm} layout="vertical" onFinish={create} preserve={false}
        initialValues={initialEquipmentValues}>
        {selectedCatalogModel && <div className="equipment-catalog-source">
          {selectedCatalogModel.image_src && <img src={selectedCatalogModel.image_src} alt={selectedCatalogModel.name} />}
          {selectedCatalogModel.manufacturer && <div className="equipment-catalog-manufacturer">
            {selectedCatalogModel.manufacturer_logo_src && <img src={selectedCatalogModel.manufacturer_logo_src} alt="" />}
            {selectedCatalogModel.manufacturer_website_url
              ? <a href={selectedCatalogModel.manufacturer_website_url} target="_blank" rel="noopener noreferrer">
                {selectedCatalogModel.manufacturer}</a>
              : selectedCatalogModel.manufacturer}
          </div>}
          <p className="muted">Based on {selectedCatalogModel.name}. Review the settings before adding it.
            {selectedCatalogModel.product_url && <> <a href={selectedCatalogModel.product_url} target="_blank"
              rel="noopener noreferrer">Product details</a></>}
          </p>
        </div>}
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
          <Input placeholder="Equipment name" maxLength={120} />
        </Form.Item>
        <Form.Item name="stock_id" label="Stock ID (optional)"><Input maxLength={80} /></Form.Item>
        {selectedCatalogModel && (selectedCatalogModel.measurement_channels?.length || 0) > 1 &&
          <p className="muted">Measures {channelSummary(selectedCatalogModel.measurement_channels)}.</p>}
        {createCapacity && <div className="capacity-fields"><Form.Item name="capacity" label="Capacity (optional)"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="capacity_unit" label="Unit"><Select options={[...capacityUnits]}
            onChange={unit => changeNumberUnit(equipmentForm, ['capacity'], newCapacityUnit || 'L', unit)} /></Form.Item></div>}
        {creatingKind === 'fermenter' && (!selectedCatalogModel || selectedCatalogModel.has_temperature_control) && <>
          <Form.Item name="built_in_temperature_control" valuePropName="checked"><Checkbox
            disabled={!!selectedCatalogModel?.has_temperature_control}>Built-in temperature control</Checkbox></Form.Item>
        </>}
        {(!selectedCatalogModel && creatingKind === 'fermenter' || selectedCatalogModel?.has_pressure_rating) &&
          <div className="form-pair"><Form.Item name="max_pressure" label="Maximum working pressure (optional)">
            <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
            <Form.Item name="pressure_unit" label="Unit"><Select options={unitOptions(unitGroups.pressure)}
              onChange={unit => changeNumberUnit(equipmentForm, ['max_pressure'], newPressureUnit || preferredUnits.pressure, unit)} /></Form.Item></div>
        }
        {boilOffKinds.has(creatingKind) && createHeating && <Form.Item name="rated_power_watts" label="Rated power (W, optional)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        {createHeating && !boilOffKinds.has(creatingKind) && <>
          <Form.Item name="has_heating" valuePropName="checked"><Checkbox disabled={!!selectedCatalogModel?.has_heating}>Heating</Checkbox></Form.Item>
          {newHeating && <Form.Item name="rated_power_watts" label="Rated heating power (W, optional)">
            <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        </>}
        {newThermal && <>
          {createCooling && <Form.Item name="has_cooling" valuePropName="checked"><Checkbox disabled={!!selectedCatalogModel?.has_cooling}>Cooling</Checkbox></Form.Item>}
          {createCooling && newCooling && <Form.Item name="rated_heat_removal_watts" label="Rated heat removal (W, optional)">
            <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
          {(newTemperatureControl || creatingKind === 'fermenter' && newFermenterControl) && <div className="form-pair">
            <Form.Item name="min_temperature_c" label="Minimum temperature (°C)"><InputNumber className="full-width" step="any" /></Form.Item>
            <Form.Item name="max_temperature_c" label="Maximum temperature (°C)"><InputNumber className="full-width" step="any" /></Form.Item>
          </div>}
        </>}
        {createPrimaryMeasurement && <div className="form-triple">
          <Form.Item name="measurement_min" label="Range minimum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_max" label="Range maximum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_unit" label="Scale">
            <Select options={unitOptions(measurementRangeUnits[creatingKind])}
              onChange={unit => changeNumberUnit(equipmentForm, ['measurement_min', 'measurement_max'],
                newRangeUnit || measurementRangeUnits[creatingKind][0], unit)} /></Form.Item>
        </div>}
        {catalogCreationChannels.map(channel => <div key={channel.measurement_kind}>
          <p className="muted">{measurementLabel(channel.measurement_kind)}</p>
          <div className="form-triple">
            <Form.Item name={['channel_ranges', channel.measurement_kind, 'min']}
              label={`${measurementLabel(channel.measurement_kind)} range minimum`}>
              <InputNumber className="full-width" step="any" /></Form.Item>
            <Form.Item name={['channel_ranges', channel.measurement_kind, 'max']}
              label={`${measurementLabel(channel.measurement_kind)} range maximum`}>
              <InputNumber className="full-width" step="any" /></Form.Item>
            <Form.Item name={['channel_ranges', channel.measurement_kind, 'unit']}
              label={`${measurementLabel(channel.measurement_kind)} unit`}>
              <Select options={unitOptions(channelUnits(channel.measurement_kind))} onChange={unit => {
                const previous = equipmentForm.getFieldValue(['channel_ranges', channel.measurement_kind, 'unit']);
                if (!previous || previous === unit) return;
                const changes: Record<string, number> = {};
                for (const field of ['min', 'max']) {
                  const value = equipmentForm.getFieldValue(['channel_ranges', channel.measurement_kind, field]);
                  if (typeof value === 'number') {
                    const converted = convertUnit(value, previous, unit);
                    if (converted != null) changes[field] = converted;
                  }
                }
                equipmentForm.setFieldValue(['channel_ranges', channel.measurement_kind], {
                  ...equipmentForm.getFieldValue(['channel_ranges', channel.measurement_kind]), ...changes, unit
                });
              }} /></Form.Item>
          </div>
        </div>)}
        <Button type="primary" htmlType="submit">Create equipment</Button>
      </Form>}
    </Modal>
    <Modal title={addingCapability?.startsWith('measurement:')
      ? `Add ${measurementSentenceLabel(addingCapability.slice('measurement:'.length))} measurement`
      : `Add ${missingCapabilities.find(capability => capability.key === addingCapability)?.label || 'capability'}`}
      open={!!addingCapability} onCancel={() => setAddingCapability(null)} footer={null} destroyOnHidden>
      <Form key={`${selectedModel?.id}:${addingCapability}`} form={capabilityForm} layout="vertical" onFinish={saveAddedCapability}
        initialValues={{ measurement_unit: addingCapability?.startsWith('measurement:')
          ? channelUnits(addingCapability.slice('measurement:'.length))[0] : undefined }}>
        {addingCapability === 'liquid_containment' && <Form.Item name="capacity_liters" label="Capacity (L, optional)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        {addingCapability === 'pressure_rating' && <Form.Item name="max_pressure_kpa" label="Maximum working pressure (kPa, optional)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        {addingCapability === 'heating' && <Form.Item name="rated_power_watts" label="Rated heating power (W, optional)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        {addingCapability === 'cooling' && <Form.Item name="rated_heat_removal_watts" label="Rated heat removal (W, optional)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        {addingCapability === 'temperature_control' && <div className="form-pair">
          <Form.Item name="min_temperature_c" label="Minimum temperature (°C)">
            <InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="max_temperature_c" label="Maximum temperature (°C)">
            <InputNumber className="full-width" step="any" /></Form.Item>
        </div>}
        {addingCapability?.startsWith('measurement:') && <div className="form-triple">
          <Form.Item name="measurement_min" label="Range minimum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_max" label="Range maximum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_unit" label="Unit" rules={[{ required: true }]}>
            <Select options={unitOptions(channelUnits(addingCapability.slice('measurement:'.length)))}
              onChange={unit => changeNumberUnit(capabilityForm, ['measurement_min', 'measurement_max'],
                addChannelUnit || channelUnits(addingCapability.slice('measurement:'.length))[0], unit)} /></Form.Item>
        </div>}
        <Button type="primary" htmlType="submit">Add capability</Button>
        {addingCatalogDefault && <Button type="text" onClick={() => void restoreModelCapability(addingCapability!)}>
          Restore to default</Button>}
      </Form>
    </Modal>
    <Modal title="Unit capacity override" open={editCapacity} onCancel={() => setEditCapacity(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={capacityForm} layout="vertical" onFinish={saveCapacity} initialValues={{ capacity: specs.capacity_liters, capacity_unit: 'L' }}>
        <div className="capacity-fields"><Form.Item name="capacity" label="Capacity"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="capacity_unit" label="Unit"><Select options={[...capacityUnits]}
            onChange={unit => changeNumberUnit(capacityForm, ['capacity'], editCapacityUnit || 'L', unit)} /></Form.Item></div>
        <Button type="primary" htmlType="submit">Save capacity</Button>
        {item?.unit_capacity_liters != null && <Button type="text" onClick={() => void resetUnitOverride(['capacity_liters'])}>Restore to default</Button>}
      </Form>
    </Modal>
    <Modal title="Unit pressure rating override" open={editPressure} onCancel={() => setEditPressure(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={pressureForm} layout="vertical" onFinish={savePressure}
        initialValues={{ max_pressure: specs.max_pressure_kpa == null ? undefined
          : convertUnit(specs.max_pressure_kpa, 'kPa', preferredUnits.pressure), pressure_unit: preferredUnits.pressure }}>
        <div className="form-pair"><Form.Item name="max_pressure" label="Maximum working pressure">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="pressure_unit" label="Unit"><Select options={unitOptions(unitGroups.pressure)}
            onChange={unit => changeNumberUnit(pressureForm, ['max_pressure'],
              editPressureRatingUnit || preferredUnits.pressure, unit)} /></Form.Item></div>
        <Button type="primary" htmlType="submit">Save pressure rating</Button>
        {item?.unit_max_pressure_kpa != null && <Button type="text" onClick={() => void resetUnitOverride(['max_pressure_kpa'])}>Restore to default</Button>}
      </Form>
    </Modal>
    <Modal title="Unit rated power override" open={editPower} onCancel={() => setEditPower(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={powerForm} layout="vertical" onFinish={savePower}
        initialValues={{ rated_power_watts: specs.rated_power_watts }}>
        <Form.Item name="rated_power_watts" label="Rated power (W)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Save rated power</Button>
        {item?.unit_rated_power_watts != null && <Button type="text" onClick={() => void resetUnitOverride(['rated_power_watts'])}>Restore to default</Button>}
      </Form>
    </Modal>
    <Modal title="Unit thermal overrides" open={editThermal} onCancel={() => setEditThermal(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} form={thermalForm} layout="vertical" onFinish={saveThermal}
        initialValues={{ has_heating: !!specs.has_heating, rated_power_watts: specs.rated_power_watts,
          has_cooling: !!specs.has_cooling, rated_heat_removal_watts: specs.rated_heat_removal_watts,
          min_temperature_c: specs.min_temperature_c, max_temperature_c: specs.max_temperature_c }}>
        {showCooling && <Form.Item name="rated_heat_removal_watts" label="Rated heat removal (W)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
        {item?.unit_rated_heat_removal_watts != null && <Button type="text" aria-label="Restore heat removal to default"
          onClick={() => void resetUnitOverride(['rated_heat_removal_watts'])}>Restore to default</Button>}
        {specs.has_temperature_control && <div className="form-pair">
          <Form.Item name="min_temperature_c" label="Minimum temperature (°C)"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="max_temperature_c" label="Maximum temperature (°C)"><InputNumber className="full-width" step="any" /></Form.Item>
        </div>}
        {item?.unit_min_temperature_c != null && <Button type="text" aria-label="Restore minimum temperature to default"
          onClick={() => void resetUnitOverride(['min_temperature_c'])}>Restore to default</Button>}
        {item?.unit_max_temperature_c != null && <Button type="text" aria-label="Restore maximum temperature to default"
          onClick={() => void resetUnitOverride(['max_temperature_c'])}>Restore to default</Button>}
        <Button type="primary" htmlType="submit">Save capabilities</Button>
      </Form>
    </Modal>
    <Modal title="Unit mash assumption overrides" open={editBrewingLosses} onCancel={() => setEditBrewingLosses(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={saveBrewingLosses} initialValues={specs}>
        <Form.Item name="mash_efficiency_pct" label="Mash efficiency (%)"><InputNumber className="full-width" min={0} max={100} step="any" /></Form.Item>
        {item?.unit_mash_efficiency_pct != null && <Button type="text" aria-label="Restore mash efficiency to default"
          onClick={() => void resetUnitOverride(['mash_efficiency_pct'])}>Restore to default</Button>}
        <Form.Item name="grain_absorption_l_per_kg" label="Grain absorption (L per kg)"><InputNumber className="full-width" min={0} step="any" /></Form.Item>
        {item?.unit_grain_absorption_l_per_kg != null && <Button type="text" aria-label="Restore grain absorption to default"
          onClick={() => void resetUnitOverride(['grain_absorption_l_per_kg'])}>Restore to default</Button>}
        <Button type="primary" htmlType="submit">Save</Button>
      </Form>
    </Modal>
    <Modal title="Edit Stock ID" open={editIdentity} onCancel={() => setEditIdentity(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={saveIdentity} initialValues={{ stock_id: item?.stock_id }}>
        <Form.Item name="stock_id" label="Stock ID (optional)"><Input maxLength={80} /></Form.Item>
        <Button type="primary" htmlType="submit">Save unit</Button>
      </Form>
    </Modal>
    <Modal title={editRange ? `Unit ${measurementSentenceLabel(editRange)} range override` : 'Unit measurement range override'}
      open={!!editRange} onCancel={() => setEditRange(null)} footer={null} destroyOnHidden>
      <Form key={`${item?.id}:${editRange}`} form={rangeForm} layout="vertical" onFinish={saveRange}
        initialValues={{ measurement_min: editingChannel?.measurement_min, measurement_max: editingChannel?.measurement_max,
          measurement_unit: editingChannel?.measurement_scale || editingChannel?.measurement_unit ||
            (editRange ? channelUnits(editRange)[0] : undefined) }}>
        <div className="form-triple"><Form.Item name="measurement_min" label="Range minimum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_max" label="Range maximum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_unit" label="Scale"><Select options={unitOptions(editRange ? channelUnits(editRange) : [])}
            onChange={unit => changeNumberUnit(rangeForm, ['measurement_min', 'measurement_max'], editRangeUnit, unit)} /></Form.Item></div>
        <Button type="primary" htmlType="submit">Save range</Button>
        {(editingChannel?.unit_measurement_min != null || editingChannel?.unit_measurement_max != null
          || editingChannel?.unit_measurement_unit != null || editingChannel?.unit_measurement_scale != null)
          && <Button type="text" onClick={() => void resetMeasurementOverride()}>Restore to default</Button>}
      </Form>
    </Modal>
    <Modal title={profile ? `Calibrate ${equipmentKindLabel(item?.kind || '')}` : 'Edit calibration'} open={editCalibration} onCancel={() => setEditCalibration(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={saveCalibration} initialValues={{ parameters: calibrationValues }}>
        {profile?.fields.map(field => <Form.Item key={field.key} name={['parameters', field.key]} label={field.label} rules={[{ required: true }]}>
          <InputNumber className="full-width" step="any" /></Form.Item>)}
        <Button type="primary" htmlType="submit">Save calibration</Button>
      </Form>
    </Modal>
    <Modal title="Calibrate this unit's boil-off" open={newBoilCalibration} onCancel={() => setNewBoilCalibration(false)} footer={null} destroyOnHidden>
      <Form key={item?.id} layout="vertical" onFinish={saveBoilCalibration}
        initialValues={{ power_watts: specs.rated_power_watts }}>
        <p className="muted">Measure volume loss during a steady boil. Only the derived heat loss is saved for this unit{item?.stock_id ? ` (stock ${item.stock_id})` : ''}.</p>
        <Form.Item name="power_watts" label="Power used (W)" rules={[{ required: true }]}><InputNumber className="full-width" min={1} /></Form.Item>
        <div className="form-pair"><Form.Item name="start_liters" label="Start volume (L)" rules={[{ required: true }]}><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="end_liters" label="End volume (L)" rules={[{ required: true }]}><InputNumber className="full-width" min={0} step="any" /></Form.Item></div>
        <Form.Item name="duration_minutes" label="Boil duration (minutes)" rules={[{ required: true }]}><InputNumber className="full-width" min={0.01} step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Save calibration</Button>
        {specs.unit_boil_heat_loss_watts != null && <Button type="text" onClick={() => void clearBoilCalibration()}>Restore to default</Button>}
      </Form>
    </Modal>
    <Modal title="Edit brewery model heat loss" open={editModelBoilHeatLoss}
      onCancel={() => setEditModelBoilHeatLoss(false)} footer={null} destroyOnHidden>
      <Form key={`${selectedModel?.id}:${editModelBoilHeatLoss}`} layout="vertical" onFinish={saveModelBoilHeatLoss}
        initialValues={{ heat_loss_watts: selectedModel?.workspace_model_boil_heat_loss_watts ?? undefined }}>
        <p className="muted">Default for every {selectedModel?.name || 'model'} unit without its own calibration.
          {selectedModel?.catalog_model_boil_heat_loss_watts != null &&
            ` Catalog default: ${Math.round(selectedModel.catalog_model_boil_heat_loss_watts)} W.`}</p>
        <Form.Item name="heat_loss_watts" label="Heat loss at boil (W)" rules={[{ required: true }]}>
          <InputNumber className="full-width" min={0} step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Save model default</Button>
        {selectedModel?.workspace_model_boil_heat_loss_watts != null && <Button type="text" onClick={() => void clearModelBoilHeatLoss()}>Restore to default</Button>}
      </Form>
    </Modal>
    <Modal title={editModelField ? `Edit model ${modelAttributeLabels[editModelField]}` : 'Edit model attribute'}
      open={!!editModelField} onCancel={() => setEditModelField(null)} footer={null} destroyOnHidden>
      <Form key={`${selectedModel?.id}:${editModelField}`} layout="vertical" onFinish={saveModelAttribute}
        initialValues={{ value: editModelField ? selectedModel?.[editModelField] : undefined }}>
        <Form.Item name="value" label={editModelField ? modelAttributeLabels[editModelField] : 'Value'}>
          <InputNumber className="full-width" step="any" /></Form.Item>
        <Button type="primary" htmlType="submit">Save model value</Button>
        {editModelField && (selectedModel as EquipmentSpecifications | null)?.[`workspace_model_${editModelField}`] != null
          && <Button type="text" onClick={() => void resetModelOverride()}>Restore to default</Button>}
        {editModelField && modelAttributeCapabilities[editModelField] && <Popconfirm
          title="Remove this capability from the model?"
          description="It will also disappear from every unit of this model."
          okText="Remove" okButtonProps={{ danger: true }}
          onConfirm={() => void removeModelCapability(modelAttributeCapabilities[editModelField] as string)}>
          <Button type="text" danger>Remove capability</Button>
        </Popconfirm>}
      </Form>
    </Modal>
    <Modal title={editModelRange ? `Edit model ${measurementSentenceLabel(editModelRange)} range` : 'Edit model measurement range'}
      open={!!editModelRange} onCancel={() => setEditModelRange(null)} footer={null} destroyOnHidden>
      <Form key={`${selectedModel?.id}:${editModelRange}`} form={modelRangeForm} layout="vertical" onFinish={saveModelRange}
        initialValues={{ measurement_min: modelRangeChannel?.measurement_min,
          measurement_max: modelRangeChannel?.measurement_max,
          measurement_unit: modelRangeChannel?.measurement_scale || modelRangeChannel?.measurement_unit ||
            (editModelRange ? channelUnits(editModelRange)[0] : undefined) }}>
        <div className="form-triple">
          <Form.Item name="measurement_min" label="Range minimum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_max" label="Range maximum"><InputNumber className="full-width" step="any" /></Form.Item>
          <Form.Item name="measurement_unit" label="Scale">
            <Select options={unitOptions(editModelRange ? channelUnits(editModelRange) : [])}
              onChange={unit => changeNumberUnit(modelRangeForm, ['measurement_min', 'measurement_max'], editModelRangeUnit, unit)} /></Form.Item>
        </div>
        <Button type="primary" htmlType="submit">Save model range</Button>
        {(modelRangeChannel?.workspace_model_measurement_min != null
          || modelRangeChannel?.workspace_model_measurement_max != null
          || modelRangeChannel?.workspace_model_measurement_unit != null
          || modelRangeChannel?.workspace_model_measurement_scale != null)
          && <Button type="text" onClick={() => void resetModelMeasurementOverride()}>Restore to default</Button>}
        {editModelRange && <Popconfirm title="Remove this measurement from the model?"
          description="It will also disappear from every unit of this model."
          okText="Remove" okButtonProps={{ danger: true }}
          onConfirm={() => void removeModelCapability(`measurement:${editModelRange}`)}>
          <Button type="text" danger>Remove capability</Button>
        </Popconfirm>}
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
