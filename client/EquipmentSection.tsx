import { useEffect, useState } from 'react';
import { Alert, AutoComplete, Button, Checkbox, Dropdown, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Table } from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { boilOffKinds, capacityKinds, equipmentGroups, equipmentKindLabel, measurementRangeUnits, temperatureCalibrationKinds } from '../shared/equipment.ts';
import type { CatalogEquipment } from '../shared/catalog.ts';
import { createEquipment, deleteEquipment, updateEquipmentBoilHeatLoss, updateEquipmentCalibration, updateEquipmentIdentity, updateEquipmentRatedPower, updateEquipmentCapacity,
  updateEquipmentTemperatureOffset, updateBrewingLosses, latestMeasuredMashEfficiency,
  updateFermenterCapabilities,
  updateEquipmentMeasurementRange,
  type Equipment, type EquipmentSpecifications, type LocalDb } from './db.ts';
import { capacityInLiters, capacityLabel, capacityUnits } from '../shared/capacity.ts';
import { changeNumberUnit } from './unitFields.ts';
import { equipmentPathSegment, equipmentSlug } from './equipmentRoutes.ts';
import { heatLossFromBoil, predictedBoilOff } from './boilOff.ts';
import { convertUnit, unitOptions, unitGroups, type PreferredUnits } from '../shared/units.ts';

function rangeLabel(min: number, max: number, scale: string | undefined): string {
  return `${min}–${max}${scale === 'SG' ? ' (specific gravity)' : ` ${scale || ''}`}`;
}

const calibrationProfiles: Record<string, { method: string; fields: { key: string; label: string }[] }> = {
  ph_meter: { method: 'Two-point pH', fields: [
    { key: 'buffer_4_observed', label: 'pH 4.00 buffer reading' }, { key: 'buffer_7_observed', label: 'pH 7.00 buffer reading' }
  ] },
  hydrometer: { method: 'Hydrometer SG', fields: [
    { key: 'reference_sg', label: 'Reference specific gravity' }, { key: 'observed_sg', label: 'Hydrometer reading' }
  ] },
  refractometer: { method: 'Refractometer Brix', fields: [
    { key: 'reference_brix', label: 'Reference °Brix' }, { key: 'observed_brix', label: 'Refractometer reading °Brix' }
  ] },
  scale: { method: 'Scale g', fields: [
    { key: 'reference_g', label: 'Reference weight g' }, { key: 'observed_g', label: 'Scale reading g' }
  ] },
  pressure_gauge: { method: 'Pressure kPa', fields: [
    { key: 'reference_kpa', label: 'Reference pressure kPa' }, { key: 'observed_kpa', label: 'Gauge reading kPa' }
  ] },
  carbonation_meter: { method: 'Carbonation volumes', fields: [
    { key: 'reference_volumes', label: 'Reference CO₂ volumes' }, { key: 'observed_volumes', label: 'Meter reading CO₂ volumes' }
  ] },
  dissolved_oxygen_meter: { method: 'Dissolved oxygen mg/L', fields: [
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

function pressureLabel(kpa: number | undefined, unit: PreferredUnits['pressure']): string {
  if (kpa == null) return 'Not set';
  return `${Number(convertUnit(kpa, 'kPa', unit)!.toFixed(2))} ${unit}`;
}

export function EquipmentSection({ db, basePath, equipment, catalog, preferredUnits, selectedId, onSelect, onChanged }: {
  db: LocalDb; basePath: string; equipment: Equipment[]; catalog: CatalogEquipment[]; preferredUnits: PreferredUnits;
  selectedId: string | null; onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [creatingKind, setCreatingKind] = useState<string | null>(null);
  const [editCalibration, setEditCalibration] = useState(false);
  const [newBoilCalibration, setNewBoilCalibration] = useState(false);
  const [newTemperatureCalibration, setNewTemperatureCalibration] = useState(false);
  const [editIdentity, setEditIdentity] = useState(false);
  const [editCapacity, setEditCapacity] = useState(false);
  const [editPower, setEditPower] = useState(false);
  const [editBrewingLosses, setEditBrewingLosses] = useState(false);
  const [recentMashEfficiency, setRecentMashEfficiency] = useState<number | null>(null);
  const [editRange, setEditRange] = useState(false);
  const [editFermenter, setEditFermenter] = useState(false);
  const [error, setError] = useState('');
  const [equipmentForm] = Form.useForm();
  const [capacityForm] = Form.useForm();
  const [powerForm] = Form.useForm();
  const [rangeForm] = Form.useForm();
  const [fermenterForm] = Form.useForm();
  const item = equipment.find(row => row.id === selectedId) || null;
  const newCapacityUnit = Form.useWatch('capacity_unit', equipmentForm) as string | undefined;
  const newRangeUnit = Form.useWatch('measurement_unit', equipmentForm) as string | undefined;
  const editCapacityUnit = Form.useWatch('capacity_unit', capacityForm) as string | undefined;
  const editRangeUnit = Form.useWatch('measurement_unit', rangeForm) as string | undefined;
  const newPressureUnit = Form.useWatch('pressure_unit', equipmentForm) as string | undefined;
  const editPressureUnit = Form.useWatch('pressure_unit', fermenterForm) as string | undefined;
  const profile = item ? calibrationProfiles[item.kind] : undefined;
  const specs = item ? JSON.parse(item.specification_json || '{}') as EquipmentSpecifications : {};
  const hasTemperatureReading = !!item && (temperatureCalibrationKinds.has(item.kind)
    || item.kind === 'fermenter' && !!specs.built_in_temperature_control);
  const ratedEstimate = specs.rated_power_watts == null || specs.boil_heat_loss_watts == null
    ? null : predictedBoilOff(specs.rated_power_watts, specs.boil_heat_loss_watts);
  const groupedKinds: { key: string; label: string; kinds: string[] }[] = equipmentGroups.map(group => ({ key: group.key, label: group.label,
    kinds: group.kinds.filter(kind => equipment.some(row => row.kind === kind)) })).filter(group => group.kinds.length);
  const earlierKinds = [...new Set(equipment.map(row => row.kind))].filter(kind =>
    !equipmentGroups.some(group => (group.kinds as readonly string[]).includes(kind)));
  if (earlierKinds.length) groupedKinds.push({ key: 'earlier', label: 'Previously added equipment', kinds: earlierKinds });

  useEffect(() => {
    if (!item || !['all_in_one', 'mash_tun', 'kettle', 'electric_kettle'].includes(item.kind)) return;
    let active = true;
    setRecentMashEfficiency(null);
    void latestMeasuredMashEfficiency(db, item.id).then(value => { if (active) setRecentMashEfficiency(value); });
    return () => { active = false; };
  }, [db, item?.id]);

  useEffect(() => {
    if (!item || !boilOffKinds.has(item.kind) || specs.boil_heat_loss_watts != null) return;
    let active = true;
    void (async () => {
      const previous = await db.execO<{ power_watts: number; start_liters: number; end_liters: number; duration_seconds: number }>(
        `SELECT power_watts, start_liters, end_liters, duration_seconds FROM equipment_characterization_observations
          WHERE equipment_id = ? ORDER BY observed_at DESC, id DESC`, [item.id]);
      let heatLoss: number | null = null;
      for (const row of previous) {
        try {
          heatLoss = heatLossFromBoil(row.power_watts, row.start_liters, row.end_liters, row.duration_seconds / 60);
          break;
        } catch { /* Skip incomplete legacy observations. */ }
      }
      if (active && heatLoss != null) {
        await updateEquipmentBoilHeatLoss(db, item, heatLoss);
        await onChanged();
      }
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [db, item?.id, item?.specification_json]);

  useEffect(() => {
    if (!item || !hasTemperatureReading || specs.temperature_offset_c != null) return;
    let active = true;
    void (async () => {
      const rows = await db.execO<{ parameters_json: string }>(`SELECT parameters_json FROM equipment_calibrations
        WHERE equipment_id = ? AND method = 'Temperature °C' ORDER BY effective_at DESC, id DESC LIMIT 1`, [item.id]);
      if (!rows.length) return;
      const values = JSON.parse(rows[0].parameters_json) as { reference_c?: number; observed_c?: number };
      if (active && Number.isFinite(values.reference_c) && Number.isFinite(values.observed_c)) {
        await updateEquipmentTemperatureOffset(db, item, Number(values.reference_c) - Number(values.observed_c));
        await onChanged();
      }
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [db, item?.id, item?.specification_json]);

  useEffect(() => {
    if (!item || !profile || specs.current_calibration) return;
    let active = true;
    void (async () => {
      const rows = await db.execO<{ parameters_json: string }>(`SELECT parameters_json FROM equipment_calibrations
        WHERE equipment_id = ? AND method = ? ORDER BY effective_at DESC, id DESC LIMIT 1`, [item.id, profile.method]);
      if (!rows.length) return;
      const values = JSON.parse(rows[0].parameters_json) as Record<string, number>;
      if (active && profile.fields.every(field => Number.isFinite(values[field.key]))) {
        await updateEquipmentCalibration(db, item, Object.fromEntries(profile.fields.map(field => [field.key, values[field.key]])));
        await onChanged();
      }
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [db, item?.id, item?.specification_json]);

  function validRange(min: number | undefined, max: number | undefined, unit: string | undefined, kind: string) {
    if (min == null && max == null) return null;
    if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || min >= max
      || !unit || !measurementRangeUnits[kind]?.includes(unit)) throw new Error('Enter a valid measurement range and unit');
    return { min, max, unit };
  }

  async function create(values: { name: string; catalog_id?: string; capacity?: number; capacity_unit?: string;
    measurement_min?: number; measurement_max?: number; measurement_unit?: string; rated_power_watts?: number;
    built_in_temperature_control?: boolean; max_pressure?: number; pressure_unit?: string }) {
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
      const id = await createEquipment(db, values.name.trim(), creatingKind, catalog.find(row => row.id === values.catalog_id), overrides);
      setCreatingKind(null); equipmentForm.resetFields(); onSelect(id); await onChanged();
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
    onClick: ({ key }: { key: string }) => setCreatingKind(key) };

  return <div className="section-page">
    {error && <Alert type="error" message={error} closable onClose={() => setError('')} className="form-alert" />}
    {!selectedId ? <section className="record-index equipment-index"><div className="section-heading"><div><span className="eyebrow">Your gear</span><h1>Equipment</h1></div></div>
      <p className="muted">Measurements, control settings, and transfers can reference your equipment.</p>
      <Dropdown trigger={['click']} menu={addMenu} placement="bottomLeft">
        <Button icon={<PlusOutlined />}>Add equipment</Button>
      </Dropdown>
      {equipment.length > 0 && <div className="group-tables">{groupedKinds.map(group => <section key={group.key} className="equipment-category">
        <h2>{group.label}</h2>{group.kinds.map(kind => {
        const rows = equipment.filter(row => row.kind === kind);
        return rows.length ? <section key={kind} className="group-table"><h3>{equipmentKindLabel(kind)}</h3>
          <Table<Equipment> dataSource={rows} rowKey="id" pagination={false} size="small"
            columns={[{ title: 'Equipment', dataIndex: 'name', render: (_, row) =>
              <a href={`${basePath}/equipment/${equipmentPathSegment(row, equipment)}`}
                onClick={event => { event.preventDefault(); onSelect(row.id); }}>{row.name}</a> },
              ...(capacityKinds.has(kind) ? [{ title: 'Capacity', key: 'capacity', width: 140, responsive: ['sm' as const], render: (_: unknown, row: Equipment) =>
                capacityLabel((JSON.parse(row.specification_json || '{}') as EquipmentSpecifications).capacity_liters) }] : []),
              ...(measurementRangeUnits[kind] ? [{ title: 'Measurement range', key: 'range', width: 180, responsive: ['sm' as const], render: (_: unknown, row: Equipment) => {
                const spec = JSON.parse(row.specification_json || '{}') as EquipmentSpecifications;
                return spec.measurement_min != null && spec.measurement_max != null
                  ? rangeLabel(spec.measurement_min, spec.measurement_max, spec.measurement_unit) : '';
              } }] : [])]} />
        </section> : null;
      })}</section>)}</div>}
    </section> : !item ? <Empty description="Equipment not found" /> : <section className="record-detail">
        <div className="content-heading"><div><span className="eyebrow">{equipmentKindLabel(item.kind)}</span>
          <div className="equipment-title"><h2>{item.name}</h2>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit equipment name and slug" onClick={() => setEditIdentity(true)} /></div>
          <div className="muted">Slug: {equipmentPathSegment(item, equipment)}</div></div></div>
        <div className="equipment-parameters">
          {capacityKinds.has(item.kind) && <div className="equipment-parameter"><span>Capacity: {capacityLabel(specs.capacity_liters) || 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit capacity" onClick={() => setEditCapacity(true)} /></div>}
          {item.kind === 'fermenter' && <div className="equipment-parameter"><span>
            Built-in temperature control: {specs.built_in_temperature_control ? 'Yes' : 'No'}<br />
            Pressure rating: {pressureLabel(specs.max_pressure_kpa, preferredUnits.pressure)}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit fermenter capabilities" onClick={() => setEditFermenter(true)} /></div>}
          {boilOffKinds.has(item.kind) && <div className="equipment-parameter"><span>Rated power: {specs.rated_power_watts != null
            ? `${specs.rated_power_watts} W` : 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit rated power" onClick={() => setEditPower(true)} /></div>}
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
            ? rangeLabel(specs.measurement_min, specs.measurement_max, specs.measurement_unit) : 'Not set'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label="Edit measurement range" onClick={() => setEditRange(true)} /></div>}
          {profile?.fields.map(field => <div key={field.key} className="equipment-parameter"><span>{field.label}: {specs.current_calibration?.[field.key] ?? 'Not calibrated'}</span>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={`Edit ${field.label}`} onClick={() => setEditCalibration(true)} /></div>)}
        </div>
        <div className="equipment-delete"><Popconfirm title={`Delete ${item.name}?`}
          description="Used equipment stays in batch history. Unused equipment and calibrations are removed."
          okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => void remove()}>
          <Button type="text" danger>Delete</Button>
        </Popconfirm></div>
      </section>}
    <Modal title={creatingKind ? addEquipmentTitle(creatingKind) : 'Add equipment'} open={!!creatingKind}
      onCancel={() => setCreatingKind(null)} footer={null} destroyOnHidden>
      {creatingKind && <Form key={creatingKind} form={equipmentForm} layout="vertical" onFinish={create} preserve={false}
        initialValues={{ capacity_unit: 'L', measurement_unit: measurementRangeUnits[creatingKind]?.[0],
          pressure_unit: preferredUnits.pressure }}>
        <Form.Item name="catalog_id" hidden><Input /></Form.Item>
        <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
          <AutoComplete placeholder="Search shared catalog or enter a name" maxLength={120}
            options={catalog.filter(row => row.kind === creatingKind).map(row => ({ value: row.name }))}
            filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())}
            onSelect={value => { const entry = catalog.find(row => row.kind === creatingKind && row.name === value);
              if (entry) { const specs = JSON.parse(entry.specification_json || '{}') as EquipmentSpecifications;
                equipmentForm.setFieldsValue({ catalog_id: entry.id, capacity: specs.capacity_liters, capacity_unit: 'L',
                  rated_power_watts: specs.rated_power_watts,
                  built_in_temperature_control: specs.built_in_temperature_control || false,
                  max_pressure: specs.max_pressure_kpa == null ? undefined : convertUnit(specs.max_pressure_kpa, 'kPa', preferredUnits.pressure),
                  pressure_unit: preferredUnits.pressure,
                  measurement_min: specs.measurement_min, measurement_max: specs.measurement_max,
                  measurement_unit: specs.measurement_unit || measurementRangeUnits[entry.kind]?.[0] }); } }} />
        </Form.Item>
        {capacityKinds.has(creatingKind) && <div className="capacity-fields"><Form.Item name="capacity" label="Capacity (optional)"><InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
          <Form.Item name="capacity_unit" label="Unit"><Select options={[...capacityUnits]}
            onChange={unit => changeNumberUnit(equipmentForm, ['capacity'], newCapacityUnit || 'L', unit)} /></Form.Item></div>}
        {creatingKind === 'fermenter' && <>
          <Form.Item name="built_in_temperature_control" valuePropName="checked"><Checkbox>Built-in temperature control</Checkbox></Form.Item>
          <div className="form-pair"><Form.Item name="max_pressure" label="Maximum working pressure (optional)">
            <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>
            <Form.Item name="pressure_unit" label="Unit"><Select options={unitOptions(unitGroups.pressure)}
              onChange={unit => changeNumberUnit(equipmentForm, ['max_pressure'], newPressureUnit || preferredUnits.pressure, unit)} /></Form.Item></div>
        </>}
        {boilOffKinds.has(creatingKind) && <Form.Item name="rated_power_watts" label="Rated power (W, optional)">
          <InputNumber className="full-width" min={0.001} step="any" /></Form.Item>}
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
        <Form.Item name="built_in_temperature_control" valuePropName="checked"><Checkbox>Built-in temperature control</Checkbox></Form.Item>
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
      <Form key={item?.id} layout="vertical" onFinish={saveCalibration} initialValues={{ parameters: specs.current_calibration }}>
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
