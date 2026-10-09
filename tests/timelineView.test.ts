import { describe, expect, it } from "vitest";
import { centerOn, clampView, fitView, initialView, MAX_PX_PER_SEC, onScreen, stepPath, ticks, tickStep, timeAt, zoomAt, type Viewport } from "@/app/timelineView";

const T = 1_000_000;
const view = (over: Partial<Viewport> = {}): Viewport => ({ from: T, pxPerSec: 10, width: 500, ...over });

describe("timeline viewport", () => {
  it("zooming keeps the time under the mouse in place, within the scale limits", () => {
    const v = view();
    const anchor = timeAt(v, 200);
    const z = zoomAt(v, 2, 200, T, T + 600_000);
    expect(z.pxPerSec).toBe(20);
    expect(timeAt(z, 200)).toBeCloseTo(anchor, 6);
    expect(zoomAt(v, 100, 200, T, T + 600_000).pxPerSec).toBe(MAX_PX_PER_SEC);
  });

  it("zooms out no further than the whole encounter on screen", () => {
    const out = zoomAt(view(), 0.01, 200, T, T + 100_000);
    expect(out).toEqual({ from: T, width: 500, pxPerSec: 5 }); // 500 px for 100 s
    expect(clampView(view({ pxPerSec: 1 }), T, T + 100_000).pxPerSec).toBe(5);
  });

  it("opens on about two minutes, or the whole of a shorter pull", () => {
    expect(initialView(600, T, T + 400_000)).toEqual({ from: T, width: 600, pxPerSec: 5 });
    expect(initialView(600, T, T + 60_000).pxPerSec).toBe(10);
  });

  it("panning stops at the encounter's ends; a short encounter fills the screen from its start", () => {
    expect(clampView(view({ from: T - 30_000 }), T, T + 600_000).from).toBe(T);
    expect(clampView(view({ from: T + 590_000 }), T, T + 600_000).from).toBe(T + 550_000); // 500 px = 50 s on screen
    expect(clampView(view({ from: T + 10_000 }), T, T + 20_000)).toMatchObject({ from: T, pxPerSec: 25 });
    expect(centerOn(view(), T + 100_000, T, T + 600_000).from).toBe(T + 75_000);
  });

  it("fits the whole encounter into the width", () => {
    expect(fitView(600, T, T + 300_000)).toEqual({ from: T, width: 600, pxPerSec: 2 });
  });

  it("ticks at whole steps from the pull, at least 60 px apart", () => {
    expect(tickStep(14)).toBe(5);
    expect(tickStep(80)).toBe(1);
    expect(tickStep(1)).toBe(60);
    expect(ticks(view({ from: T + 3_000 }), T).map((t) => (t.t - T) / 1000)).toEqual([10, 20, 30, 40, 50]);
  });

  it("tells what is on screen, with a margin for icons at a start", () => {
    const v = view();
    expect(onScreen(v, T - 5_000, T - 1_000)).toBe(false);
    expect(onScreen(v, T - 2_000, T - 1_000, 20)).toBe(true);
    expect(onScreen(v, T + 40_000, T + 90_000)).toBe(true);
  });
});

describe("stepped curves", () => {
  const pts = (pairs: [number, number][]) => pairs.map(([sec, value]) => ({ time: T + sec * 1000, value }));

  it("holds each value until the next point and closes an area down to the base", () => {
    const p = pts([
      [0, 1],
      [10, 0.5],
    ]);
    expect(stepPath(p, (i) => p[i]!.value, view(), (val) => 100 - val * 100, T + 20_000, 100)).toBe("M0,100V0H100V50H200V100Z");
  });

  it("enters with the value from before the left edge, and draws a busy pixel as its low, high and last value", () => {
    const p = pts([
      [0, 1],
      [20, 0.9],
      [20.01, 0.1],
      [20.02, 0.6],
    ]);
    const d = stepPath(p, (i) => p[i]!.value, view({ from: T + 10_000 }), (val) => Math.round(100 - val * 100), T + 30_000);
    expect(d).toBe("M-1,0H100V10V90V40H200"); // off screen to the left: just past the edge
  });
});
