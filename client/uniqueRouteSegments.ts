// Build URL segments from the complete visible set. Every replica with the same
// rows derives the same result, including when offline edits chose equal names.
export function uniqueRouteSegments<T extends { id: string }>(items: T[],
  base: (item: T) => string, reserveIds = false): Map<string, string> {
  const segments = new Map(items.map(item => [item.id, base(item)]));
  const ids = reserveIds ? new Set(items.map(item => item.id)) : new Set<string>();
  for (;;) {
    const counts = new Map<string, number>();
    for (const segment of segments.values()) counts.set(segment, (counts.get(segment) || 0) + 1);
    let changed = false;
    for (const item of items) {
      const segment = segments.get(item.id)!;
      if ((counts.get(segment) || 0) > 1 || ids.has(segment) && segment !== item.id) {
        // Preserve NanoID case. Lowercasing the ID would make distinct IDs collide.
        segments.set(item.id, `${segment}-${item.id}`);
        changed = true;
      }
    }
    if (!changed) return segments;
  }
}
