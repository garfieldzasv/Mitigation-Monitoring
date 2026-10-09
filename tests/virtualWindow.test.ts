import { describe, expect, it } from "vitest";
import { isAtTop, virtualWindow } from "@/app/virtualWindow";

describe("virtualWindow", () => {
  it("renders the visible rows plus overscan, padding the rest", () => {
    // 22px rows, 220px viewport → 10 visible (+1 partial), overscan 6
    expect(virtualWindow(0, 220, 22, 1000)).toEqual({ start: 0, end: 17, padTop: 0, padBottom: 983 * 22 });
    expect(virtualWindow(22 * 100, 220, 22, 1000)).toEqual({ start: 94, end: 117, padTop: 94 * 22, padBottom: 883 * 22 });
  });

  it("clamps at the end and handles short or empty lists", () => {
    expect(virtualWindow(22 * 995, 220, 22, 1000)).toMatchObject({ end: 1000, padBottom: 0 });
    expect(virtualWindow(0, 220, 22, 3)).toEqual({ start: 0, end: 3, padTop: 0, padBottom: 0 });
    expect(virtualWindow(0, 220, 22, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it("a taller viewport renders more rows", () => {
    const short = virtualWindow(0, 300, 22, 1000);
    const tall = virtualWindow(0, 400, 22, 1000);
    expect(tall.end - tall.start).toBeGreaterThan(short.end - short.start);
  });
});

describe("isAtTop", () => {
  it("is true less than one row from the top", () => {
    expect(isAtTop(0, 22)).toBe(true);
    expect(isAtTop(21, 22)).toBe(true);
    expect(isAtTop(22, 22)).toBe(false);
  });
});
