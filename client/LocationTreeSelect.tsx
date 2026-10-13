import { TreeSelect } from 'antd';
import type { InventoryLocation } from './db.ts';

export const newLocationOption = '__new_location__';
interface LocationTreeNode { value: string; title: string; label: string; children?: LocationTreeNode[] }

export function locationTreeData(locations: InventoryLocation[], excludedIds = new Set<string>(), includeCreate = false): LocationTreeNode[] {
  const available = locations.filter(location => !excludedIds.has(location.id));
  const byId = new Map(available.map(location => [location.id, location]));
  const visited = new Set<string>();
  const nodeFor = (location: InventoryLocation, parentPath = ''): LocationTreeNode => {
    visited.add(location.id);
    const label = parentPath ? `${parentPath} / ${location.name}` : location.name;
    const children = available.filter(child => child.parent_id === location.id && !visited.has(child.id))
      .map(child => nodeFor(child, label));
    return { value: location.id, title: location.name, label, ...(children.length ? { children } : {}) };
  };
  const roots = available.filter(location => !location.parent_id || !byId.has(location.parent_id))
    .map(location => nodeFor(location));
  for (const location of available) if (!visited.has(location.id)) roots.push(nodeFor(location));
  return includeCreate ? [...roots, { value: newLocationOption, title: 'New location…', label: 'New location…' }] : roots;
}

export function LocationTreeSelect({ locations, excludedIds, includeCreate = false, ...props }: {
  locations: InventoryLocation[]; excludedIds?: Set<string>; includeCreate?: boolean;
} & Omit<React.ComponentProps<typeof TreeSelect>, 'treeData'>) {
  return <TreeSelect {...props} treeData={locationTreeData(locations, excludedIds, includeCreate)}
    treeDefaultExpandAll showSearch treeNodeFilterProp="title" treeNodeLabelProp="label" />;
}
