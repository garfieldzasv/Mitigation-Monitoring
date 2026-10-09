import { describe, expect, it } from "vitest";
import type { DamageRow, DeathRow } from "@/core/engine/types";
import {
  activeConditionCount,
  EMPTY_FILTER,
  filterOptions,
  matchesRow,
  normalizeFilter,
  type RowFilter,
} from "@/core/filter/rowFilter";

const hit = (over: Partial<DamageRow> = {}): DamageRow => ({
  kind: "hit",
  id: 1,
  time: 0,
  offset: 0,
  target: { id: "10000001", name: "P1", job: 19 },
  source: { id: "40000001", name: "Boss" },
  action: { id: 1, name: "极限炫技" },
  autoAttack: false,
  amount: 50000,
  fullyAbsorbed: false,
  damageType: "magical",
  result: "hit",
  crit: false,
  direct: false,
  invulnerable: false,
  hpBefore: 100000,
  maxHp: 100000,
  multiplier: 1,
  multiplierPartial: false,
  mitigation: [],
  targetStatuses: [],
  sourceStatuses: [],
  ...over,
});
const death: DeathRow = { kind: "death", id: 9, time: 0, offset: 0, target: { id: "10000002", name: "P2", job: 24 }, sourceName: "Boss" };
const filter = (over: Partial<RowFilter>): RowFilter => ({ ...EMPTY_FILTER, ...over });

describe("matchesRow", () => {
  it("shows everything with the empty filter", () => {
    expect(matchesRow(hit(), EMPTY_FILTER)).toBe(true);
    expect(matchesRow(death, EMPTY_FILTER)).toBe(true);
  });

  it("hides by member, ability, source, damage type and verdict", () => {
    expect(matchesRow(hit(), filter({ hiddenMembers: ["10000001"] }))).toBe(false);
    expect(matchesRow(hit(), filter({ hiddenActions: ["极限炫技"] }))).toBe(false);
    expect(matchesRow(hit(), filter({ hiddenSources: ["Boss"] }))).toBe(false);
    expect(matchesRow(hit(), filter({ hiddenDamageTypes: ["magical"] }))).toBe(false);
    expect(matchesRow(hit({ result: "block" }), filter({ hiddenVerdicts: ["block"] }))).toBe(false);
    expect(matchesRow(hit({ amount: 0, fullyAbsorbed: true }), filter({ hiddenVerdicts: ["absorbed"] }))).toBe(false);
    expect(matchesRow(hit({ amount: 0, fullyAbsorbed: true }), filter({ hiddenVerdicts: ["hit"] }))).toBe(true);
  });

  it("quick switches: auto-attacks, zero damage, DoTs, minimum amount", () => {
    expect(matchesRow(hit({ action: { id: 0xae46, name: "攻击" }, autoAttack: true }), filter({ hideAutoAttacks: true }))).toBe(false);
    expect(matchesRow(hit({ action: { id: 1, name: "机关炮" }, autoAttack: true }), filter({ hideAutoAttacks: true }))).toBe(false);
    expect(matchesRow(hit({ amount: 0 }), filter({ hideZero: true }))).toBe(false);
    expect(matchesRow(hit({ kind: "dot" }), filter({ hideDots: true }))).toBe(false);
    expect(matchesRow(hit({ amount: 999 }), filter({ minAmount: 1000 }))).toBe(false);
    expect(matchesRow(hit({ amount: 1000 }), filter({ minAmount: 1000 }))).toBe(true);
  });

  it("a DoT's unknown source filters as 未知", () => {
    expect(matchesRow(hit({ kind: "dot", source: { id: "", name: "" } }), filter({ hiddenSources: ["未知"] }))).toBe(false);
  });

  it("death rows follow only the member filter", () => {
    const everything = filter({ hiddenActions: ["x"], hiddenSources: ["Boss"], hideZero: true, minAmount: 1e9, hideDots: true });
    expect(matchesRow(death, everything)).toBe(true);
    expect(matchesRow(death, filter({ hiddenMembers: ["10000002"] }))).toBe(false);
  });
});

describe("filter bookkeeping", () => {
  it("counts active conditions", () => {
    expect(activeConditionCount(EMPTY_FILTER)).toBe(0);
    expect(activeConditionCount(filter({ hiddenMembers: ["a", "b"], hideZero: true, minAmount: 5 }))).toBe(3);
  });

  it("lists options from the rows: members by role, the rest most frequent first", () => {
    const rows = [
      hit({ action: { id: 1, name: "A" }, target: { id: "10000009", name: "P9", job: 38 } }), // DNC first to appear
      hit({ action: { id: 1, name: "A" } }),
      hit({ action: { id: 2, name: "B" }, target: { id: "10000003", name: "P3", job: 33 } }),
      hit({ action: { id: 2, name: "B" }, kind: "dot", source: { id: "", name: "" } }),
      death,
    ];
    const o = filterOptions(rows);
    expect(o.members.map((m) => [m.key, m.job])).toEqual([
      ["10000001", 19], // tank
      ["10000003", 33], // healers, in order of appearance
      ["10000002", 24],
      ["10000009", 38], // DPS
    ]);
    expect(o.actions.map((a) => [a.label, a.count])).toEqual([
      ["A", 2],
      ["B", 2],
    ]);
    expect(o.sources.map((s) => s.label)).toEqual(["Boss", "未知"]);
  });

  it("normalizes stored values", () => {
    expect(normalizeFilter(undefined)).toEqual(EMPTY_FILTER);
    expect(normalizeFilter({ hiddenMembers: ["a", 3], hideZero: "yes", minAmount: 12.7 })).toEqual({
      ...EMPTY_FILTER,
      hiddenMembers: ["a"],
      minAmount: 12,
    });
  });
});
