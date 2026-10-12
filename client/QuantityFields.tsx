import { Form, InputNumber } from 'antd';
import { compoundMassUnit } from '../shared/units.ts';

export function QuantityFields({ unit, label = 'Quantity', name = 'quantity', optional = false }: {
  unit?: string; label?: string; name?: string; optional?: boolean;
}) {
  if (unit === compoundMassUnit) return <div className="form-pair">
    <Form.Item name="pounds" label={`${label} · pounds`}><InputNumber className="full-width" min={0} precision={0} placeholder="lb" /></Form.Item>
    <Form.Item name="ounces" label="Ounces"><InputNumber className="full-width" min={0} max={15.999} step="any" placeholder="oz" /></Form.Item>
  </div>;
  return <Form.Item name={name} label={label} rules={optional ? [] : [{ required: true }]}>
    <InputNumber className="full-width" min={0} step="any" />
  </Form.Item>;
}
