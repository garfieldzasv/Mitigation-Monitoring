import { describe, expect, it } from "vitest";
import { computeMitigation, termApplies, vulnerabilityFactor, type MitigationInput } from "@/core/mitigation/multiplier";
import type { StatusSnap } from "@/core/status/statusTracker";

const snap = (id: number, name: string, category: StatusSnap["category"], over: Partial<StatusSnap> = {}): StatusSnap => ({
  id,
  name,
  stacks: 0,
  remainingMs: 5000,
  sourceId: "10000001",
  sourceName: "P1",
  category,
  ...over,
});
const input = (over: Partial<MitigationInput>): MitigationInput => ({
  kind: "hit",
  damageType: "magical",
  targetId: "10000009",
  targetLevel: 100,
  targetStatuses: [],
  sourceStatuses: [],
  ...over,
});

describe("computeMitigation", () => {
  it("nothing known: 0%", () => {
    expect(computeMitigation(input({}))).toEqual({ multiplier: 1, partial: false, terms: [] });
  });

  it("multiplies target mitigation and source debuffs", () => {
    const r = computeMitigation(
      input({
        targetStatuses: [snap(1873, "节制", "mitigation"), snap(299, "野战治疗阵", "mitigation")],
        sourceStatuses: [snap(1193, "雪仇", "damageDown")],
      }),
    );
    expect(r.multiplier).toBeCloseTo(0.9 * 0.9 * 0.9);
    expect(r.partial).toBe(false);
    expect(r.terms.map((t) => [t.name, t.percent, t.side, t.effect])).toEqual([
      ["节制", 10, "target", "reduction"],
      ["野战治疗阵", 10, "target", "reduction"],
      ["雪仇", 10, "source", "reduction"],
    ]);
  });

  it("a blocked or parried hit takes off what its damage effect says, on top of the statuses", () => {
    const blocked = computeMitigation(input({ result: "block", reduction: 20, targetStatuses: [snap(1873, "节制", "mitigation")] }));
    expect(blocked.multiplier).toBeCloseTo(0.9 * 0.8);
    expect(blocked.terms.at(-1)).toMatchObject({ name: "格挡", percent: 20, effect: "reduction" });
    expect(computeMitigation(input({ result: "parry", reduction: 15 })).multiplier).toBeCloseTo(0.85);
    expect(computeMitigation(input({ result: "hit" })).multiplier).toBe(1);
    // no reduction in the line: unknown
    expect(computeMitigation(input({ result: "block" }))).toMatchObject({ multiplier: 1, partial: true });
  });

  it("leaves the tanks' passive trait out", () => {
    const r = computeMitigation(input({ targetId: "10000001", targetStatuses: [snap(1191, "铁壁", "mitigation")] }));
    expect(r.multiplier).toBeCloseTo(0.8);
    expect(r.terms).toHaveLength(1);
  });

  it("split values follow the damage type (Addle: physical 5%, magic 10%)", () => {
    const addle = [snap(1203, "昏乱", "damageDown")];
    expect(computeMitigation(input({ damageType: "magical", sourceStatuses: addle })).multiplier).toBeCloseTo(0.9);
    expect(computeMitigation(input({ damageType: "physical", sourceStatuses: addle })).multiplier).toBeCloseTo(0.95);
    // Breath, and no attack type: the game data does not say which defence they meet. A split value is unknown,
    // one value for both applies.
    expect(computeMitigation(input({ damageType: "special", sourceStatuses: addle }))).toMatchObject({ multiplier: 1, partial: true });
    expect(computeMitigation(input({ damageType: "unknown", sourceStatuses: addle }))).toMatchObject({ multiplier: 1, partial: true });
    expect(computeMitigation(input({ damageType: "unknown", targetStatuses: [snap(1191, "铁壁", "mitigation")] })).multiplier).toBeCloseTo(0.8);
  });

  it("a magic-only reduction on a physical hit counts 0 and is marked as not applying", () => {
    const r = computeMitigation(input({ damageType: "physical", targetStatuses: [snap(2707, "抗死", "mitigation")] }));
    expect(r.multiplier).toBe(1);
    expect(r.terms[0]?.percent).toBe(0);
    expect(termApplies(r.terms[0])).toBe(false);
    expect(termApplies(computeMitigation(input({ targetStatuses: [snap(2707, "抗死", "mitigation")] })).terms[0])).toBe(true);
  });

  it("two Reprisals do not stack; a direct one wins over an inherited copy", () => {
    const r = computeMitigation(
      input({
        sourceStatuses: [
          snap(1193, "雪仇", "damageDown", { inherited: true }),
          snap(1193, "雪仇", "damageDown", { sourceId: "10000002" }),
        ],
      }),
    );
    expect(r.multiplier).toBeCloseTo(0.9);
    expect(r.terms).toHaveLength(1);
    expect(r.terms[0]?.inherited).toBeUndefined();
  });

  it("vulnerabilities and damage-ups are listed but never counted, and do not make it partial", () => {
    const r = computeMitigation(
      input({
        targetStatuses: [snap(1873, "节制", "mitigation"), snap(1789, "受伤加重", "vulnerability", { stacks: 2, params: { first: 20, second: 0 } })],
        sourceStatuses: [snap(505, "伤害提高", "damageUp")],
      }),
    );
    expect(r).toMatchObject({ multiplier: 0.9, partial: false });
    expect(r.terms.filter((t) => t.effect === "increase").map((t) => [t.name, t.stacks, t.percent])).toEqual([
      ["受伤加重", 2, 40],
      ["伤害提高", undefined, null],
    ]);
    expect(r.terms.every((t) => termApplies(t))).toBe(true);
  });

  it("a vulnerability is what its put-on line's modifier byte says, per stack, whatever the duty", () => {
    const terms = (statuses: StatusSnap[]) => computeMitigation(input({ targetStatuses: statuses })).terms;
    const vuln = (id: number, first: number, stacks = 0) => snap(id, "易伤", "vulnerability", { stacks, params: { first, second: 0 } });
    expect(vulnerabilityFactor(terms([vuln(1789, 20, 1)]))).toBeCloseTo(1.2);
    expect(vulnerabilityFactor(terms([vuln(1789, 30, 1)]))).toBeCloseTo(1.3); // the same status, another mechanic
    expect(vulnerabilityFactor(terms([vuln(1789, 20, 3)]))).toBeCloseTo(1.6);
    expect(vulnerabilityFactor(terms([vuln(1426, 50)]))).toBeCloseTo(1.5); // no stacks
    // no put-on line in the log: unknown
    const none = terms([snap(1789, "受伤加重", "vulnerability", { stacks: 1 })]);
    expect(none[0]!.percent).toBeNull();
    expect(vulnerabilityFactor(none)).toBe(1);
    // a byte of the wrong sign is no modifier
    expect(terms([vuln(1789, -5, 1)])[0]!.percent).toBeNull();
  });

  it("a status that covers one damage type (its description: 物理 / 魔法) applies to that type only", () => {
    const physicalVuln = [snap(56, "物理受伤加重", "vulnerability", { params: { first: 10, second: 0 } })];
    const t = (damageType: MitigationInput["damageType"]) => computeMitigation(input({ damageType, targetStatuses: physicalVuln })).terms[0]!;
    expect(t("physical").percent).toBe(10);
    expect(t("magical").percent).toBe(0);
    expect(termApplies(t("magical"))).toBe(false);
    expect(t("unknown").percent).toBeNull(); // which defence it meets is not in the game data
  });

  it("a reduction no tooltip values (a duty's own): its put-on line's modifier byte, over the damage it names", () => {
    const duty = (id: number, first: number) => snap(id, "受伤减轻", "mitigation", { params: { first, second: 0 } });
    expect(computeMitigation(input({ targetStatuses: [duty(63, -20)] }))).toMatchObject({ multiplier: 0.8, partial: false });
    expect(computeMitigation(input({ damageType: "magical", targetStatuses: [duty(59, -50)] })).multiplier).toBeCloseTo(0.5);
    expect(computeMitigation(input({ damageType: "physical", targetStatuses: [duty(59, -50)] }))).toMatchObject({ multiplier: 1, partial: false });
    expect(computeMitigation(input({ targetStatuses: [duty(63, 5)] }))).toMatchObject({ multiplier: 1, partial: true }); // not a reduction byte
  });

  it("an element's vulnerability applies to hits of that element only; a conditional one is unknown", () => {
    const fire = [snap(2128, "火之烙印", "vulnerability", { params: { first: 50, second: 0 } })];
    const t = (element: number) => computeMitigation(input({ element, targetStatuses: fire })).terms[0]!.percent;
    expect(t(1)).toBe(50);
    expect(t(2)).toBe(0);
    expect(t(0)).toBeNull(); // the hit's element is not known
    const tether = [snap(2424, "离别之锁", "vulnerability", { params: { first: 50, second: 0 } })];
    expect(computeMitigation(input({ targetStatuses: tether })).terms[0]!.percent).toBeNull();
  });

  it("with other modifiers: the byte of its own sign, or none", () => {
    // 缩小: damage dealt down, damage taken up — the positive byte is the vulnerability, whichever field it is in
    const shrink = (first: number, second: number) => computeMitigation(input({ targetStatuses: [snap(438, "缩小", "vulnerability", { params: { first, second } })] })).terms[0]!.percent;
    expect(shrink(-10, 20)).toBe(20);
    expect(shrink(20, -10)).toBe(20);
    // 攻击形态: damage dealt up and taken up — both positive, no telling
    expect(computeMitigation(input({ targetStatuses: [snap(681, "攻击形态", "vulnerability", { params: { first: 20, second: 30 } })] })).terms[0]!.percent).toBeNull();
  });

  it("a stacked duty reduction is unknown: nothing says how its stacks count", () => {
    const r = computeMitigation(input({ targetStatuses: [snap(63, "受伤减轻", "mitigation", { stacks: 3, params: { first: -10, second: 0 } })] }));
    expect(r).toMatchObject({ multiplier: 1, partial: true });
  });

  it("a tooltip's value wins over the bytes (some statuses use them for other data)", () => {
    const r = computeMitigation(input({ targetStatuses: [snap(1873, "节制", "mitigation", { params: { first: -122, second: -37 } })] }));
    expect(r.multiplier).toBeCloseTo(0.9);
  });

  it("an unlisted reduction with no bytes makes it partial (the real mitigation is higher)", () => {
    expect(computeMitigation(input({ targetStatuses: [snap(99999, "某减伤", "mitigation")] }))).toMatchObject({ multiplier: 1, partial: true });
  });

  it("Troubadour, Tactician and Shield Samba do not stack; 15% from level 98, 10% below", () => {
    const party = [snap(1934, "行吟", "mitigation"), snap(1951, "策动", "mitigation"), snap(1826, "防守之桑巴", "mitigation")];
    const max = computeMitigation(input({ targetStatuses: party }));
    expect(max.multiplier).toBeCloseTo(0.85);
    expect(max.terms.filter((t) => !t.overlapped)).toHaveLength(1);
    expect(max.terms.filter((t) => t.overlapped).map((t) => t.name)).toEqual(["策动", "防守之桑巴"]);
    expect(max.terms.filter((t) => !termApplies(t))).toHaveLength(2);
    expect(computeMitigation(input({ targetLevel: 90, targetStatuses: party })).multiplier).toBeCloseTo(0.9);
  });

  it("Knight's Resolve: 15% from the PLD's own Holy Sheltron, 10% from Intervention", () => {
    const own = computeMitigation(input({ targetId: "10000001", targetStatuses: [snap(2675, "骑士的坚守", "mitigation")] }));
    expect(own.terms[0]?.percent).toBe(15);
    const given = computeMitigation(input({ targetStatuses: [snap(2675, "骑士的坚守", "mitigation")] }));
    expect(given.terms[0]?.percent).toBe(10);
  });

  it("Intervention: 20% while the PLD has Rampart", () => {
    const intervention = [snap(1174, "干预", "mitigation", { sourceId: "10000001" })];
    expect(computeMitigation(input({ targetStatuses: intervention })).terms[0]?.percent).toBe(10);
    const withRampart = computeMitigation(
      input({ targetStatuses: intervention, casterHas: (caster, ids) => caster === "10000001" && ids.includes(1191) }),
    );
    expect(withRampart.terms[0]?.percent).toBe(20);
  });

  it("shields and other statuses do not count; DoT ticks get no multiplier", () => {
    const r = computeMitigation(input({ targetStatuses: [snap(297, "鼓舞", "shield"), snap(48, "进食", "other")] }));
    expect(r).toEqual({ multiplier: 1, partial: false, terms: [] });
    expect(computeMitigation(input({ kind: "dot", targetStatuses: [snap(1873, "节制", "mitigation")] }))).toEqual({
      multiplier: null,
      partial: false,
      terms: [],
    });
  });
});
