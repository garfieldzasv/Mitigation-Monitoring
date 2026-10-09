import { describe, expect, it } from "vitest";
import { phaseSpan, phaseSummary } from "@/app/format";
import { monitorItems } from "@/app/monitorItems";
import type { Phase } from "@/core/engine/phases";
import type { Row } from "@/core/engine/types";
import { filterOptions, matchesRow, normalizeFilter } from "@/core/filter/rowFilter";

const row = (id: number, time: number, kind: Row["kind"] = "hit") =>
  ({
    id,
    time,
    kind,
    target: { id: "10000001", name: "P1", job: 19 },
    source: { id: "40000001", name: "Boss" },
    action: { id: 1, name: "a" },
    amount: 1000,
    damageType: "magical",
    result: "hit",
    fullyAbsorbed: false,
    autoAttack: false,
  }) as unknown as Row;
const phases: Phase[] = [
  { index: 0, kind: "fight", label: "00:00–00:00", start: 0, end: 100, hpStart: 100, hpEnd: 44 },
  { index: 1, kind: "intermission", label: "离场 00:00–00:00", start: 100, end: 160, hpStart: 44, hpEnd: 44 },
  { index: 2, kind: "fight", label: "00:00 起", start: 160, hpStart: 44, hpEnd: 0 },
];

describe("monitorItems", () => {
  it("newest first, a line above each phase's first row, none for the first", () => {
    const items = monitorItems([row(1, 10), row(2, 90), row(3, 120), row(4, 170)], phases);
    expect(items.map((i) => (i.kind === "row" ? `row ${i.row.id}` : `start ${i.phase.label}`))).toEqual([
      "row 4",
      "start 00:00 起",
      "row 3",
      "start 离场 00:00–00:00",
      "row 2",
      "row 1",
    ]);
  });

  it("a phase nobody was hit in still gets its line, also at the top while it is the current one", () => {
    const items = monitorItems([row(1, 10), row(2, 90)], phases);
    expect(items.map((i) => i.key)).toEqual(["phase:2", "phase:1", "row:2", "row:1"]);
  });

  it("a single phase: rows only", () => {
    expect(monitorItems([row(1, 10), row(2, 20)], [phases[0]!]).map((i) => i.key)).toEqual(["row:2", "row:1"]);
  });
});

describe("phase text", () => {
  it("monitor line and review span", () => {
    expect(phaseSummary(phases[2]!, 0)).toBe("在场 00:00 起 · boss 44%");
    expect(phaseSummary(phases[1]!, -60_000)).toBe("离场 01:00 起 · 无可选中的敌人（boss 44%）");
    expect(phaseSpan(phases[0]!, 0, 300_000)).toBe("在场 00:00–00:00 · boss 100%→44%");
    expect(phaseSpan(phases[1]!, 0, 300_000)).toBe("离场 00:00–00:00 · 无可选中的敌人");
    expect(phaseSpan(phases[2]!, 0, 300_000)).toBe("在场 00:00–05:00 · boss 44%→0%");
  });
});

describe("filtering by phase", () => {
  const first = { label: "00:00–01:40", inPlay: true };
  const window = { label: "离场 01:40–02:40", inPlay: false };
  const second = { label: "02:40–05:00", inPlay: true };

  it("hides every row of a hidden stretch 在场, deaths included", () => {
    const f = normalizeFilter({ hiddenPhases: [first.label] });
    expect(matchesRow(row(1, 10), f, first)).toBe(false);
    expect(matchesRow(row(2, 10, "death"), f, first)).toBe(false);
    expect(matchesRow(row(3, 170), f, second)).toBe(true);
    expect(matchesRow(row(4, 10), f)).toBe(true); // no phases known: nothing to hide by
  });

  it("a 离场 window is not offered; its rows show only while no stretch is hidden", () => {
    expect(matchesRow(row(1, 120), normalizeFilter({}), window)).toBe(true);
    expect(matchesRow(row(1, 120), normalizeFilter({ hiddenPhases: [first.label] }), window)).toBe(false);
    const phaseOf = (r: Row) => (r.time < 100 ? first : r.time < 160 ? window : second);
    expect(filterOptions([row(1, 10), row(2, 170), row(3, 120), row(4, 20)], phaseOf).phases.map((o) => [o.label, o.count])).toEqual([
      [first.label, 2],
      [second.label, 1],
    ]);
  });
});
