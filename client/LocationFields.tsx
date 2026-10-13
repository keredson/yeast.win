import { Form, Input, Select } from 'antd';
import type { InventoryLocation } from './db.ts';
import { inventoryLocationPath } from './db.ts';
import { locationDescendantIds } from './locationRoutes.ts';

export function LocationFields({ locations, editingId, showSlug = false }: {
  locations: InventoryLocation[]; editingId?: string | null; showSlug?: boolean;
}) {
  const excluded = editingId ? locationDescendantIds(editingId, locations) : new Set<string>();
  const options = locations.filter(location => !excluded.has(location.id)).map(location =>
    ({ value: location.id, label: inventoryLocationPath(location.id, locations) }));
  return <>
    <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
      <Input maxLength={100} placeholder="Back room" /></Form.Item>
    {showSlug && <Form.Item name="slug" label="URL slug" rules={[{ required: true },
      { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: 'Use lowercase letters, numbers, and hyphens' }]}>
      <Input maxLength={80} /></Form.Item>}
    {options.length > 0 && <Form.Item name="parent_id" label="Inside (optional)">
      <Select allowClear placeholder="Top level" options={options} showSearch optionFilterProp="label" /></Form.Item>}
  </>;
}
