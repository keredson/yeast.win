import { useEffect, useState } from 'react';
import { Alert, Form, Select } from 'antd';
import { listRecipePlans, type Equipment, type LocalDb } from './db.ts';

export function RecipeEquipmentFields({ db, recipeId, equipment, models }: {
  db: LocalDb; recipeId?: string; equipment: Equipment[]; models: Equipment[];
}) {
  const [modelIds, setModelIds] = useState<string[]>([]);
  useEffect(() => {
    if (!recipeId) { setModelIds([]); return; }
    let active = true;
    void listRecipePlans(db, recipeId).then(plans => {
      if (active) setModelIds([...new Set(plans.flatMap(plan =>
        [plan.details.equipment_id, plan.details.mash_equipment_id, plan.details.to_vessel_id]
          .filter((id): id is string => typeof id === 'string' && !!id)))]);
    });
    return () => { active = false; };
  }, [db, recipeId]);
  if (!modelIds.length) return null;
  return <>
    {modelIds.map(id => {
      const choices = equipment.filter(item => item.model_id === id);
      const model = models.find(item => item.id === id);
      return choices.length ? <Form.Item key={id} name={['unit_ids', id]}
        label={`${model?.name || 'Equipment'} unit`}
        rules={choices.length > 1 ? [{ required: true, message: 'Choose a physical unit' }] : []}>
        <Select allowClear={choices.length > 1} placeholder={choices.length === 1 ? choices[0].name : 'Choose a unit'}
          options={choices.map(item => ({ value: item.id, label: item.stock_id
            ? `${item.name} · ${item.stock_id}` : item.name }))} />
      </Form.Item> : <Alert key={id} type="warning" className="form-alert"
        message={`Add a physical unit of ${model?.name || 'this equipment model'} before starting this batch.`} />;
    })}
  </>;
}
