import { useEffect, useRef, useState, type ReactNode } from 'react';
import { readEquipmentModelMedia, readSupplyMedia, type LocalDb } from './db.ts';

/** Fetch a workspace image only when its table row approaches the viewport. */
export function WorkspaceThumbnail({ db, kind, id, revision, className, fallback }: {
  db: LocalDb; kind: 'supply' | 'model'; id: string; revision: number; className: string; fallback?: ReactNode;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const node = element.current;
    if (!node || visible) return;
    if (!('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '300px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    const read = kind === 'supply' ? readSupplyMedia(db, id) : readEquipmentModelMedia(db, id);
    void read.then(row => {
      if (!row?.image_bytes?.length || !row.image_mime_type || cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(row.image_bytes)], { type: row.image_mime_type }));
      setUrl(objectUrl);
    }).catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [db, kind, id, revision, visible]);

  return <span ref={element} style={{ display: 'inline-block', width: 20, height: 20 }}>
    {url ? <img className={className} src={url} alt="" /> : fallback}
  </span>;
}
