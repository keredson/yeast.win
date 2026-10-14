import { useEffect, useRef, useState } from 'react';
import { catalogMediaGeneration, catalogMediaUrl } from './catalog.ts';

export type CatalogMediaKind = 'supply' | 'model' | 'thumbnail' | 'logo';

const visibleCallbacks = new WeakMap<Element, () => void>();
let imageObserver: IntersectionObserver | undefined;

function catalogImageObserver(): IntersectionObserver {
  imageObserver ||= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      visibleCallbacks.get(entry.target)?.();
      imageObserver?.unobserve(entry.target);
      visibleCallbacks.delete(entry.target);
    }
  });
  return imageObserver;
}

export function useCatalogMedia(kind: CatalogMediaKind, id: string | null | undefined,
  enabled = true): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const generation = catalogMediaGeneration();
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    if (id && enabled) void catalogMediaUrl(kind, id).then(url => {
      if (!cancelled) setSrc(url);
    }).catch(() => { if (!cancelled) setSrc(null); });
    return () => { cancelled = true; };
  }, [kind, id, enabled, generation]);
  return src;
}

export function CatalogImage({ kind, id, className, alt = '', immediate = false }: {
  kind: CatalogMediaKind; id: string; className?: string; alt?: string; immediate?: boolean;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(immediate);
  useEffect(() => {
    if (immediate || !ref.current || !('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const element = ref.current;
    const observer = catalogImageObserver();
    visibleCallbacks.set(element, () => setVisible(true));
    observer.observe(element);
    return () => { observer.unobserve(element); visibleCallbacks.delete(element); };
  }, [id, immediate]);
  const src = useCatalogMedia(kind, id, visible);
  return <img ref={ref} className={className} src={src || undefined} alt={alt} loading="lazy" />;
}
