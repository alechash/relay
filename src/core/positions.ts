/**
 * Ordering uses fractional positions so moving one item never rewrites its
 * siblings. The public API speaks in 0-based indexes; these helpers translate.
 */
const STEP = 1024;

export interface Positioned {
  id: string;
  position: number;
}

/**
 * Returns the position value that places an item at `index` among `siblings`
 * (sorted ascending, NOT including the item being placed). Returns `null` when
 * the gap is too small and the caller should renumber first.
 */
export function positionAt(siblings: Positioned[], index: number | undefined): number | null {
  const n = siblings.length;
  const i = index === undefined || index < 0 || index > n ? n : Math.floor(index);
  if (n === 0) return STEP;
  if (i === 0) return siblings[0].position - STEP;
  if (i === n) return siblings[n - 1].position + STEP;
  const lo = siblings[i - 1].position;
  const hi = siblings[i].position;
  const mid = (lo + hi) / 2;
  if (hi - lo < 1e-6 || mid === lo || mid === hi) return null;
  return mid;
}

/** Evenly re-spaced positions for an ordered list. */
export function renumber<T extends Positioned>(items: T[]): T[] {
  return items.map((it, i) => ({ ...it, position: (i + 1) * STEP }));
}
