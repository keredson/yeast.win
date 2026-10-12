import { compoundMassUnit, convertUnit, splitOunces } from '../shared/units.ts';
import type { FormInstance } from 'antd';

/** Convert a populated number when its adjacent unit changes. */
export function changeNumberUnit<T>(form: FormInstance<T>, names: string[], from: string | undefined, to: string,
  deltaNames: string[] = []): void {
  if (!from || from === to) return;
  const read = form.getFieldValue as (name: string) => unknown;
  const write = form.setFieldsValue as (values: Record<string, number | undefined>) => void;
  const updates: Record<string, number | undefined> = {};
  for (const name of names) {
    const value = read(name);
    if (typeof value === 'number') updates[name] = convertUnit(value, from, to, deltaNames.includes(name)) ?? undefined;
  }
  write(updates);
}

/** Handles the two-input pounds + ounces presentation as well as simple quantities. */
export function changeQuantityUnit<T>(form: FormInstance<T>, from: string | undefined, to: string,
  name = 'quantity'): void {
  if (!from || from === to) return;
  const read = form.getFieldValue as (name: string) => unknown;
  const write = form.setFieldsValue as (values: Record<string, number | undefined>) => void;
  const value = from === compoundMassUnit
    ? (typeof read('pounds') === 'number' || typeof read('ounces') === 'number'
      ? Number(read('pounds') || 0) * 16 + Number(read('ounces') || 0) : undefined)
    : read(name);
  if (typeof value !== 'number') return;
  const converted = convertUnit(value, from, to);
  if (to === compoundMassUnit && converted != null) {
    write({ [name]: undefined, ...splitOunces(converted) });
  } else {
    write({ [name]: converted ?? undefined, pounds: undefined, ounces: undefined });
  }
}
