import { phaseAt, type Phase } from "@/core/engine/phases";
import type { Row } from "@/core/engine/types";

/** One line of the monitor's list: a row, or the start of a phase. */
export type MonitorItem = { kind: "row"; key: string; row: Row } | { kind: "phase"; key: string; phase: Phase };

/**
 * What the monitor lists, newest first (docs/DESIGN.md 7.1): the rows, and above the first row of
 * each phase a line saying it started. The first phase starts with the pull and gets no line; an
 * encounter with a single phase gets none at all. A phase without rows (an intermission nobody was
 * hit in, or the one just begun) still gets its line, so a transition shows the moment it happens.
 */
export function monitorItems(rows: readonly Row[], phases: readonly Phase[]): MonitorItem[] {
  const items: MonitorItem[] = [];
  if (phases.length < 2) {
    for (let i = rows.length - 1; i >= 0; i--) items.push({ kind: "row", key: `row:${rows[i]!.id}`, row: rows[i]! });
    return items;
  }
  const lines = (from: number, downTo: number) => {
    for (let p = from; p > downTo; p--) items.push({ kind: "phase", key: `phase:${p}`, phase: phases[p]! });
  };
  let above = phases.length - 1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const index = phaseAt(phases, row.time)!.index;
    lines(above, index);
    above = Math.min(above, index);
    items.push({ kind: "row", key: `row:${row.id}`, row });
  }
  lines(above, 0);
  return items;
}
