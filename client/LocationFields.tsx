import { Form, Input } from 'antd';
import type { InventoryLocation } from './db.ts';
import { locationDescendantIds } from './locationRoutes.ts';
import { LocationTreeSelect } from './LocationTreeSelect.tsx';

export function LocationFields({ locations, editingId, showSlug = false }: {
  locations: InventoryLocation[]; editingId?: string | null; showSlug?: boolean;
}) {
  const excluded = editingId ? locationDescendantIds(editingId, locations) : new Set<string>();
  const hasParentOptions = locations.some(location => !excluded.has(location.id));
  return <>
    <Form.Item name="name" label="Name" rules={[{ required: true, whitespace: true }]}>
      <Input maxLength={100} placeholder="Back room" /></Form.Item>
    <Form.Item name="address" label="Address (optional)">
      <Input.TextArea maxLength={500} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="Street address or directions" /></Form.Item>
    {showSlug && <Form.Item name="slug" label="URL slug" rules={[{ required: true },
      { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: 'Use lowercase letters, numbers, and hyphens' }]}>
      <Input maxLength={80} /></Form.Item>}
    {hasParentOptions && <Form.Item name="parent_id" label="Inside (optional)">
      <LocationTreeSelect locations={locations} excludedIds={excluded} allowClear placeholder="Top level" /></Form.Item>}
  </>;
}
