import { useEffect, useState } from 'react';
import { AutoComplete } from 'antd';
import type { InventoryItem } from './db.ts';
import type { CatalogInventory } from '../shared/catalog.ts';
import { queryCatalogSupplies } from './catalog.ts';

export type ProductChoice = { source: 'inventory'; item: InventoryItem }
  | { source: 'catalog'; item: CatalogInventory };

export function ProductPicker({ category, inventory, catalogRevision, inventoryLabel = 'Your inventory',
  id, value, onChange, onEdited, onChoose, onError }: {
  category: string; inventory: InventoryItem[]; catalogRevision: number; inventoryLabel?: string;
  id?: string; value?: string; onChange?: (value: string) => void; onEdited?: () => void;
  onChoose: (choice: ProductChoice) => void;
  onError?: (message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<CatalogInventory[]>([]);
  useEffect(() => {
    if (!category) { setCatalog([]); return; }
    let cancelled = false;
    void queryCatalogSupplies({ category, query, limit: null })
      .then(rows => { if (!cancelled) setCatalog(rows); })
      .catch(cause => { if (!cancelled) onError?.(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [category, query, catalogRevision]);

  return <AutoComplete id={id} value={value} onChange={next => { onChange?.(next); onEdited?.(); }}
    onSearch={setQuery} filterOption={false}
    placeholder="Search inventory or catalog, or enter a name" maxLength={120}
    options={[
      ...inventory.filter(item => item.category === category && item.name.toLowerCase().includes(query.toLowerCase()))
        .map(item => ({ value: `stock:${item.id}`, label: [item.name, item.lot_code && `Lot ${item.lot_code}`,
          item.location_name, inventoryLabel].filter(Boolean).join(' · ') })),
      ...catalog.map(item => ({ value: `catalog:${item.id}`,
        label: [item.name, item.manufacturer, 'Catalog'].filter(Boolean).join(' · ') }))
    ]}
    onSelect={token => {
      if (token.startsWith('stock:')) {
        const item = inventory.find(row => row.id === token.slice(6));
        if (item) onChoose({ source: 'inventory', item });
      } else if (token.startsWith('catalog:')) {
        const item = catalog.find(row => row.id === token.slice(8));
        if (item) onChoose({ source: 'catalog', item });
      }
    }} />;
}
