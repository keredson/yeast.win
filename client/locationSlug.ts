import { recordSlug } from './recordSlug.ts';

export function locationSlug(name: string, used: Set<string>): string {
  const base = recordSlug(name).slice(0, 70);
  let slug = base;
  for (let number = 2; used.has(slug); number++) slug = `${base}-${number}`;
  return slug;
}

export function hasGeneratedLocationSuffix(name: string, id: string, slug: string): boolean {
  const base = recordSlug(name);
  const oldRandom = `${base.slice(0, 40)}-`;
  if (slug.startsWith(oldRandom) && /^[a-z0-9]{8}$/.test(slug.slice(oldRandom.length))) return true;
  const idHex = [...id].map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return slug === `${base.slice(0, 14)}-${idHex}`;
}
