/**
 * The timeline tab's viewport (docs/DESIGN.md 8.6): which stretch of the encounter is on screen and
 * at what scale, and the drawing math that depends on it. Pure functions, no Vue.
 */

export interface Viewport {
  /** The time at the left edge, ms (absolute, like row times). */
  from: number;
  pxPerSec: number;
  /** Width of the drawing area, px. */
  width: number;
}

/** Zoomed in at most this far. Zoomed out, at most the whole encounter on screen. */
export const MAX_PX_PER_SEC = 80;
/** What a pull opens with: about two minutes on screen. */
export const DEFAULT_SPAN_SEC = 120;
/** Neighbouring tick labels keep at least this apart. */
const MIN_TICK_GAP_PX = 60;
const TICK_STEPS_SEC = [1, 2, 5, 10, 15, 30, 60, 120, 300];

export const xOf = (v: Viewport, t: number): number => ((t - v.from) / 1000) * v.pxPerSec;
export const timeAt = (v: Viewport, x: number): number => v.from + (x / v.pxPerSec) * 1000;
export const viewEnd = (v: Viewport): number => timeAt(v, v.width);

/** The scale that puts [min, max] exactly into the width: the furthest out one can zoom. */
export function fitScale(width: number, min: number, max: number): number {
  return width / Math.max(1, (max - min) / 1000);
}

/** A scale within limits: no further out than the whole encounter, no further in than MAX_PX_PER_SEC (unless the encounter is that short). */
function clampScale(px: number, width: number, min: number, max: number): number {
  return Math.max(fitScale(width, min, max), Math.min(MAX_PX_PER_SEC, px));
}

/** Keeps the encounter filling the screen: the scale within limits, the left edge no earlier than `min`, the right no later than `max`. */
export function clampView(v: Viewport, min: number, max: number): Viewport {
  const pxPerSec = clampScale(v.pxPerSec, v.width, min, max);
  const span = (v.width / pxPerSec) * 1000;
  const latest = Math.max(min, max - span);
  return { ...v, pxPerSec, from: Math.min(latest, Math.max(min, v.from)) };
}

/** Zooms by `factor` keeping the time under `anchorX` where it is. */
export function zoomAt(v: Viewport, factor: number, anchorX: number, min: number, max: number): Viewport {
  const anchor = timeAt(v, anchorX);
  const pxPerSec = clampScale(v.pxPerSec * factor, v.width, min, max);
  return clampView({ ...v, pxPerSec, from: anchor - (anchorX / pxPerSec) * 1000 }, min, max);
}

/** The whole of [min, max] in the width. */
export function fitView(width: number, min: number, max: number): Viewport {
  return { from: min, width, pxPerSec: Math.min(MAX_PX_PER_SEC, fitScale(width, min, max)) };
}

/** How a pull opens: its start, about DEFAULT_SPAN_SEC on screen (all of it when shorter). */
export function initialView(width: number, min: number, max: number): Viewport {
  return clampView({ from: min, width, pxPerSec: width / DEFAULT_SPAN_SEC }, min, max);
}

/** `t` in the middle of the screen. */
export function centerOn(v: Viewport, t: number, min: number, max: number): Viewport {
  return clampView({ ...v, from: t - (v.width / 2 / v.pxPerSec) * 1000 }, min, max);
}

/** The tick step, s: the smallest of 1 / 2 / 5 / 10 / 15 / 30 / 60… that keeps the labels apart. */
export function tickStep(pxPerSec: number): number {
  return TICK_STEPS_SEC.find((s) => s * pxPerSec >= MIN_TICK_GAP_PX) ?? TICK_STEPS_SEC.at(-1)!;
}

/** Ticks on screen, at whole steps from `origin` (the pull). */
export function ticks(v: Viewport, origin: number): { t: number; x: number }[] {
  const step = tickStep(v.pxPerSec) * 1000;
  const out: { t: number; x: number }[] = [];
  for (let t = origin + Math.ceil((v.from - origin) / step) * step; t <= viewEnd(v); t += step) out.push({ t, x: xOf(v, t) });
  return out;
}

/** Whether [start, end] shows, with `marginPx` to spare on both sides (an icon drawn at the start sticks out). */
export function onScreen(v: Viewport, start: number, end: number, marginPx = 0): boolean {
  const margin = (marginPx / v.pxPerSec) * 1000;
  return end >= v.from - margin && start <= viewEnd(v) + margin;
}

/**
 * A stepped curve through time-ordered points (the value holds until the next point), as an SVG
 * path, for the visible part only and at most a few vertices per pixel: within one pixel column,
 * the lowest and highest values (a dip to 5 % in a busy second still shows) and the last one. With
 * `baseY`, a closed area down to it.
 */
export function stepPath(
  points: readonly { time: number }[],
  value: (i: number) => number,
  v: Viewport,
  y: (value: number) => number,
  end: number,
  baseY?: number,
): string {
  if (points.length === 0) return "";
  // The last point at or before the left edge: the value the curve enters the screen with.
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid]!.time <= v.from) lo = mid;
    else hi = mid - 1;
  }
  const right = Math.min(viewEnd(v), end);
  const clampX = (t: number) => Math.max(-1, Math.min(v.width + 1, xOf(v, t)));
  let d = "";
  // The pixel column being collected: where it starts, and its lowest, highest and last value.
  let col: { px: number; x: number; min: number; max: number; last: number } | undefined;
  const flush = () => {
    if (!col) return;
    const ys = (col.min === col.max ? [col.last] : [col.max, col.min, col.last]).map(y);
    if (d !== "") d += `H${col.x}`;
    else if (baseY !== undefined) d = `M${col.x},${baseY}`;
    else d = `M${col.x},${ys.shift()}`;
    d += ys.map((v) => `V${v}`).join("");
  };
  for (let i = lo; i < points.length && points[i]!.time <= right; i++) {
    const x = clampX(points[i]!.time);
    const val = value(i);
    if (col && Math.round(x) === col.px) {
      col.min = Math.min(col.min, val);
      col.max = Math.max(col.max, val);
      col.last = val;
      continue;
    }
    flush();
    col = { px: Math.round(x), x, min: val, max: val, last: val };
  }
  flush();
  if (d === "") return "";
  d += `H${clampX(right)}`;
  return baseY !== undefined ? `${d}V${baseY}Z` : d;
}
