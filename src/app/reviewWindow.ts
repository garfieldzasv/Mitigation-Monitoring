import { archiveIdOf } from "@/core/archive/types";
import { pageUrl } from "./composables/useUrlParams";

/**
 * The review window (docs/DESIGN.md 8): a plain popup opened from the monitor, which reads the
 * archive from IndexedDB. It opens where the user last left it: inside ACT the overlay cannot see
 * the monitor and the popup cannot move itself, so remembering the placement is what works
 * (the approach of Skills Monitoring's settings window).
 */
const WINDOW_NAME = "mitigation-monitoring-review";
const POSITION_KEY = "mitigation-monitoring:review-window";
const DEFAULT_SIZE = { width: 1320, height: 820 };

interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
}

export { archiveIdOf };

/** The review window's tabs (docs/DESIGN.md 8). */
export type ReviewTab = "damage" | "deaths" | "aoe" | "stats" | "timeline";

function savedPlacement(): Placement | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null") as Partial<Placement> | null;
    return v && [v.left, v.top, v.width, v.height].every(Number.isFinite) ? (v as Placement) : undefined;
  } catch {
    return undefined;
  }
}

/** `row` selects a row in the damage tab, or the death to replay with `tab: "deaths"`. */
export function openReviewWindow(target: { encounter?: string; tab?: ReviewTab; row?: number }): void {
  const query = new URLSearchParams();
  if (target.encounter) query.set("enc", target.encounter);
  if (target.tab) query.set("tab", target.tab);
  if (target.row) query.set("row", String(target.row));
  const p = savedPlacement();
  const size = p ? `width=${p.width},height=${p.height},left=${p.left},top=${p.top}` : `width=${DEFAULT_SIZE.width},height=${DEFAULT_SIZE.height}`;
  const qs = query.toString();
  window.open(pageUrl(`/review${qs ? `?${qs}` : ""}`), WINDOW_NAME, size);
}

/** Run in the review window: remember where it is when it closes; forget a placement that went off screen. */
export function trackReviewWindowPlacement(): void {
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  const onScreen =
    window.screenX + window.outerWidth >= (s.availLeft ?? 0) + 100 &&
    window.screenX <= (s.availLeft ?? 0) + s.availWidth - 100 &&
    window.screenY >= (s.availTop ?? 0) - 100 &&
    window.screenY <= (s.availTop ?? 0) + s.availHeight - 100;
  try {
    if (!onScreen) localStorage.removeItem(POSITION_KEY);
  } catch {
    // nothing to forget
  }
  window.addEventListener("pagehide", () => {
    try {
      localStorage.setItem(
        POSITION_KEY,
        JSON.stringify({ left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight }),
      );
    } catch {
      // the next open uses the default placement
    }
  });
}
