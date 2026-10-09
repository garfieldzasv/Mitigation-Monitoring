/** Which rows of a fixed-row-height list to render. Pure, so it can be tested without a DOM. */
export interface VirtualWindow {
  start: number;
  /** Exclusive. */
  end: number;
  padTop: number;
  padBottom: number;
}

export function virtualWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan = 6,
): VirtualWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const start = Math.max(0, Math.min(count, first - overscan));
  const end = Math.min(count, first + visible + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

/** Less than one row from the top counts as "at the newest row" (the monitor shows newest first). */
export function isAtTop(scrollTop: number, rowHeight: number): boolean {
  return scrollTop < rowHeight;
}
