import { describe, expect, it } from "vitest";
import { absorbedText, formatUnmitigated, hpAfterOf, shieldAfterOf, shieldBreakthrough } from "@/app/format";
import { Engine } from "@/core/engine/engine";
import { damageTaken, type DamageRow, type Row } from "@/core/engine/types";
import type { GameEvent } from "@/core/logline/parse";
import { groupLabel, groupRow, inSharedGroup } from "@/core/replay/shieldLines";

const T = 1_000_000;
const P = "10000001";
const Q = "10000002";
const HEALER = "10000009";
const MAX_HP = 100_000;
/** Shield statuses (categorised "shield" by the game data). */
const GALVANIZE = 297;
const PANHAIMA = 2613;
const EXCOGITATION = 1918;

const at = (sec: number) => T + Math.round(sec * 1000);
const nameOf = (id: string) => (id === P ? "P1" : "P2");

interface HitOptions {
  target?: string;
  amount?: number;
  action?: [number, string];
  result?: "hit" | "miss";
}
const hit = (sec: number, seq: string, { target = P, amount = 0, action = [1, "以太税"], result = "hit" }: HitOptions = {}): GameEvent => ({
  type: "ability",
  time: at(sec),
  sourceId: "40000001",
  sourceName: "Boss",
  actionId: action[0],
  actionName: action[1],
  targetId: target,
  targetName: nameOf(target),
  damage: { result, amount, crit: false, direct: false, damageType: "magical", attackType: 5, element: 7 },
  targetHp: MAX_HP,
  targetMaxHp: MAX_HP,
  sourceHp: 1,
  sourceMaxHp: 1,
  sequence: seq,
  targetIndex: 0,
  targetCount: 1,
});
/** A 37 line; without `shield`, the short form that carries the HP only. */
const result = (sec: number, seq: string, shield?: number, target = P, hp = MAX_HP): GameEvent => ({
  type: "effectResult",
  time: at(sec),
  targetId: target,
  sequence: seq,
  currentHp: hp,
  maxHp: shield === undefined ? 0 : MAX_HP,
  ...(shield === undefined ? {} : { shieldPercent: shield }),
});
/** A 38 line: the player's statuses changed; it carries HP and the shield too. */
const statusList = (sec: number, shield: number, target = P, hp = MAX_HP): GameEvent => ({ type: "statusList", time: at(sec), targetId: target, currentHp: hp, maxHp: MAX_HP, shieldPercent: shield });
const gain = (sec: number, id = GALVANIZE, target = P, duration = 30): GameEvent => ({
  type: "gainEffect",
  time: at(sec),
  effectId: id,
  effectName: "盾",
  duration,
  sourceId: HEALER,
  sourceName: "H",
  targetId: target,
  targetName: nameOf(target),
  stacks: 0,
});
const lose = (sec: number, id = GALVANIZE, target = P): GameEvent => ({
  type: "loseEffect",
  time: at(sec),
  effectId: id,
  effectName: "盾",
  sourceId: HEALER,
  sourceName: "H",
  targetId: target,
  targetName: nameOf(target),
});
const dot = (sec: number, amount: number): GameEvent => ({
  type: "tick",
  time: at(sec),
  kind: "dot",
  targetId: P,
  targetName: "P1",
  effectId: 0,
  amount,
  targetHp: MAX_HP,
  targetMaxHp: MAX_HP,
});
/** A shield put on P (or `target`), and its cast's report showing it. */
const shieldUp = (sec: number, percent: number, target = P, id = GALVANIZE, duration = 30): GameEvent[] => [gain(sec, id, target, duration), result(sec, `S${sec}${target}`, percent, target)];

function run(events: GameEvent[]): DamageRow[] {
  const engine = new Engine();
  engine.handle({ type: "combat", time: T, act: true, game: true, gameChanged: true });
  for (const e of events) engine.handle(e);
  engine.flush();
  return engine.current!.rows.filter((r): r is DamageRow => r.kind !== "death");
}
const bySeq = (list: DamageRow[], seq: string) => list.find((r) => r.seq === seq)!;

describe("shields: what the reports before and after a hit say (docs/DESIGN.md 5.6)", () => {
  it("a fully absorbed hit took the report before it less its own result's: 25 % → 16 %", () => {
    const [row] = run([...shieldUp(0, 25), hit(1, "B"), result(1.5, "B", 16)]);
    expect(row).toMatchObject({ shieldAbsorbed: 9000, shieldBefore: 25000, fullyAbsorbed: true, hpAfter: MAX_HP });
    expect(row!.shieldGroup).toMatchObject({ closed: true, before: 25000, after: 16000, absorbed: 9000 });
    expect(shieldAfterOf(row!)).toBe(16000);
    expect(shieldBreakthrough(row!)).toBe(0);
    expect(absorbedText(row!)).toBe("≈9,000");
  });

  it("damage got through: the hit took all there was; with no shield, no shield figures", () => {
    const [through] = run([...shieldUp(0, 20), hit(1, "B", { amount: 5000 }), result(1.5, "B", 0)]);
    expect(through).toMatchObject({ shieldAbsorbed: 20000, fullyAbsorbed: false });
    expect(shieldAfterOf(through!)).toBe(0);
    expect(shieldBreakthrough(through!)).toBe(5000);
    const [bare] = run([hit(1, "B", { amount: 7000 }), result(1.5, "B", 0, P, MAX_HP - 7000)]);
    expect(bare!.shieldGroup).toBeUndefined();
    expect(absorbedText(bare!)).toBe("");
    expect(shieldBreakthrough(bare!)).toBeUndefined();
  });

  it("a report between a hit's line and its result may not show it yet: the hit's own result settles it", () => {
    const [row] = run([...shieldUp(0, 25), hit(1, "B"), result(1.2, "C", 25), result(1.3, "D"), result(1.5, "B", 16)]);
    expect(row!.shieldAbsorbed).toBe(9000);
  });

  it("a hit whose own 37 line is the short form is settled by the next report", () => {
    const [row] = run([...shieldUp(0, 25), hit(1, "B"), result(1.5, "B"), result(2, "D", 16)]);
    expect(row).toMatchObject({ shieldAbsorbed: 9000, hpAfter: MAX_HP });
  });

  it("hits no report tells apart are one group: only their total is known", () => {
    const list = run([...shieldUp(0, 30), hit(1, "A"), hit(1, "B"), result(1.5, "A", 10), result(1.6, "B", 10)]);
    const [a, b] = [bySeq(list, "A"), bySeq(list, "B")];
    expect(a.shieldGroup).toBe(b.shieldGroup);
    expect(a.shieldGroup).toMatchObject({ absorbed: 20000, before: 30000, after: 10000 });
    expect(a.shieldAbsorbed).toBeUndefined();
    expect(absorbedText(a)).toBe("共≈20,000");
    // Each hit keeps its own line; the detail panel sums the group up: 以太税 ×2, the group's figure.
    expect(inSharedGroup(a) && inSharedGroup(b)).toBe(true);
    const line = groupRow(a.shieldGroup!, a.shieldGroup!.rows);
    expect(line.action.name).toBe("以太税 ×2");
    expect(absorbedText(line)).toBe("≈20,000");
    // A report after the first one took effect splits them.
    const apart = run([...shieldUp(0, 30), hit(1, "A"), result(1.5, "A", 20), hit(2, "B"), result(2.5, "B", 10)]);
    expect(bySeq(apart, "A").shieldAbsorbed).toBe(10000);
    expect(bySeq(apart, "B").shieldAbsorbed).toBe(10000);
  });

  it("a DoT tick takes effect at the tick; ticks and hits no report tells apart are one group (护龙威压 ×3 + 咆哮)", () => {
    const [tick] = run([...shieldUp(0, 20), dot(1, 0), statusList(1.5, 18)]);
    expect(tick).toMatchObject({ shieldAbsorbed: 2000, fullyAbsorbed: true });
    const list = run([...shieldUp(0, 20), dot(1, 0), dot(2, 0), dot(3, 0), hit(3.5, "R", { amount: 9000, action: [2, "咆哮"] }), result(4, "R", 0, P, MAX_HP - 9000)]);
    expect(new Set(list.map((r) => r.shieldGroup)).size).toBe(1);
    expect(list[0]!.shieldGroup).toMatchObject({ absorbed: 20000 });
    expect(groupLabel(list)).toBe("持续伤害 ×3 + 咆哮");
  });

  it("a shield put on between the report and the hit counts with its size when its put-on line's byte confirms it", () => {
    const TBN = 0x49a;
    // 至黑之夜: 25 % of the bearer's max HP; 25,000 = 0x61A8, the line's byte 0xA8.
    const putOn: GameEvent = {
      type: "ability",
      time: at(0.5),
      sourceId: HEALER,
      sourceName: "H",
      actionId: 0x1ce1,
      actionName: "至黑之夜",
      targetId: P,
      targetName: "P1",
      appliedBytes: [{ id: TBN, byte: 0xa8 }],
      targetHp: MAX_HP,
      targetMaxHp: MAX_HP,
      sourceHp: MAX_HP,
      sourceMaxHp: MAX_HP,
      sequence: "T1",
      targetIndex: 0,
      targetCount: 1,
    };
    const [row] = run([...shieldUp(0, 10), putOn, gain(0.5, TBN), hit(1, "A"), result(1.5, "A", 30)]);
    // 10,000 + 25,000 − 30,000
    expect(row).toMatchObject({ shieldAbsorbed: 5000, shieldBefore: 35000 });
    // A shield whose size nothing confirms: only a lower bound.
    const [unsized] = run([...shieldUp(0, 10), gain(0.5, EXCOGITATION), hit(1, "A"), result(1.5, "A", 5)]);
    expect(unsized!.shieldGroup).toMatchObject({ absorbed: 5000, bound: "atLeast" });
    expect(unsized!.shieldAbsorbed).toBeUndefined();
    expect(absorbedText(unsized!)).toBe("≥5,000");
  });

  it("a heal's shield is its action's tooltip share of the line's heal, at the caster's level (均衡预后: 230 % below 85, 320 % from 85)", () => {
    const EUKRASIAN_PROGNOSIS = 2609;
    // A heal of 10,000: 32,000 (0x7D00, byte 0x00) at level 90, 23,000 (0x59D8, byte 0xD8) at level 80.
    const cast = (level: number, byte: number): GameEvent[] => [
      { type: "addCombatant", time: at(0), id: HEALER, name: "H", job: 40, level, maxHp: MAX_HP },
      statusList(0.5, 0),
      {
        type: "ability",
        time: at(1),
        sourceId: HEALER,
        sourceName: "H",
        actionId: 24292,
        actionName: "均衡预后",
        targetId: P,
        targetName: "P1",
        heal: { toTarget: 10_000, toSource: 0 },
        appliedBytes: [{ id: EUKRASIAN_PROGNOSIS, byte }],
        targetHp: MAX_HP,
        targetMaxHp: MAX_HP,
        sourceHp: MAX_HP,
        sourceMaxHp: MAX_HP,
        sequence: "E1",
        targetIndex: 0,
        targetCount: 1,
      },
      gain(1.1, EUKRASIAN_PROGNOSIS),
      hit(2, "A"),
      result(2.5, "A", 20),
    ];
    expect(run(cast(90, 0x00))[0]!.shieldAbsorbed).toBe(12_000);
    expect(run(cast(80, 0xd8))[0]!.shieldAbsorbed).toBe(3_000);
  });

  it("a shield that ran out (its 30 line at or after its time) left an unknown amount: only an upper bound", () => {
    const [row] = run([...shieldUp(0, 20, P, GALVANIZE, 1), lose(1.2), hit(2, "A"), result(2.5, "A", 0)]);
    expect(row!.shieldGroup).toMatchObject({ absorbed: 20000, bound: "atMost" });
    expect(absorbedText(row!)).toBe("≤20,000");
  });

  it("a shield broken early in the moment of the report after a hit: that report already shows it gone", () => {
    const list = run([...shieldUp(0, 20), hit(1, "A", { amount: 3000 }), result(1.5, "A", 0, P, MAX_HP - 3000), lose(1.5), ...shieldUp(2.5, 10), hit(3, "B"), result(3.5, "B", 4)]);
    expect(bySeq(list, "A").shieldAbsorbed).toBe(20000);
    expect(bySeq(list, "B").shieldAbsorbed).toBe(6000);
  });

  it("a 26 line for a shield already on whose end did not move (its parameter changed) puts on nothing new", () => {
    const [row] = run([...shieldUp(0, 25), gain(0.5, GALVANIZE, P, 29.5), hit(1, "B"), result(1.5, "B", 16)]);
    expect(row).toMatchObject({ shieldAbsorbed: 9000 });
  });

  it("泛输血: the next layer, put on in the result of the hit that broke the last one, holds what the first did", () => {
    const list = run([
      ...shieldUp(0, 8, P, PANHAIMA, 15),
      // Got through: everything (8 %) went; the 8 % after is the next layer alone — that is its size. (The ACT plugin
      // logs a layer put on again only when its end moved by more than 2 s.)
      hit(5, "A", { amount: 5000 }),
      result(5.5, "A", 8, P, MAX_HP - 5000),
      gain(5.5, PANHAIMA, P, 15),
      // Fully absorbed, breaking that layer too: 8 % + the next 8 % − 4 %.
      hit(10, "B"),
      result(10.5, "B", 4),
      gain(10.5, PANHAIMA, P, 15),
    ]);
    expect(bySeq(list, "A").shieldAbsorbed).toBe(8000);
    expect(bySeq(list, "B").shieldAbsorbed).toBe(12000);
  });

  it("a group whose last hit got through took everything on until then; a shield put on after does not count", () => {
    const list = run([...shieldUp(0, 20), hit(1, "A"), hit(1.1, "B", { amount: 3000 }), result(1.5, "A", 0), result(1.6, "B", 7, P, MAX_HP - 3000), gain(1.6, EXCOGITATION)]);
    expect(bySeq(list, "A").shieldGroup).toMatchObject({ absorbed: 20000 });
    expect(bySeq(list, "A").shieldGroup!.bound).toBeUndefined();
  });

  it("a group takes no hit after one that got through with no shield put on since: those met no shield", () => {
    // A stream of hits (a pack on a tank): no report ever comes after every earlier hit took effect.
    const list = run([
      ...shieldUp(0, 20),
      hit(1, "A"),
      hit(1.3, "B", { amount: 2000 }),
      hit(1.6, "C", { amount: 3000 }),
      result(1.8, "A", 10),
      hit(1.9, "D", { amount: 3000 }),
      result(2.1, "B", 0, P, MAX_HP - 2000),
      hit(2.2, "E", { amount: 3000 }),
      result(2.4, "C", 0, P, MAX_HP - 5000),
      result(2.7, "D", 0, P, MAX_HP - 8000),
      result(3, "E", 0, P, MAX_HP - 11000),
    ]);
    const group = bySeq(list, "A").shieldGroup!;
    expect(group.rows.map((r) => r.seq)).toEqual(["A", "B"]);
    // Everything on until B, which got through; nothing after it.
    expect(group).toMatchObject({ closed: true, absorbed: 20000 });
    expect(group.bound).toBeUndefined();
    expect(shieldAfterOf(bySeq(list, "B"))).toBeUndefined(); // shares its group
    for (const seq of ["C", "D", "E"]) {
      expect(bySeq(list, seq).shieldGroup).toBeUndefined();
      expect(absorbedText(bySeq(list, seq))).toBe("");
    }
  });

  it("…unless a shield went on after that hit: a later hit may have met it", () => {
    const list = run([...shieldUp(0, 20), hit(1, "A", { amount: 2000 }), gain(1.2, EXCOGITATION), hit(1.4, "B"), result(1.6, "A", 0, P, MAX_HP - 2000), result(1.8, "B", 5)]);
    expect(bySeq(list, "A").shieldGroup).toBe(bySeq(list, "B").shieldGroup);
  });

  it("after a group closed at a hit that got through, the next shield's group starts from none", () => {
    const list = run([
      ...shieldUp(0, 20),
      hit(1, "A", { amount: 2000 }),
      hit(1.3, "B", { amount: 3000 }),
      // The shield's 30 line comes late: it was used up, nothing was left in it.
      lose(1.4),
      result(1.6, "A", 0, P, MAX_HP - 2000),
      result(1.8, "B", 0, P, MAX_HP - 5000),
      ...shieldUp(3, 15),
      hit(4, "C"),
      result(4.5, "C", 9),
    ]);
    expect(bySeq(list, "A").shieldGroup).toMatchObject({ absorbed: 20000 });
    expect(bySeq(list, "B").shieldGroup).toBeUndefined();
    expect(bySeq(list, "C").shieldGroup).toMatchObject({ before: 15000, absorbed: 6000 });
    expect(bySeq(list, "C").shieldGroup!.bound).toBeUndefined();
  });

  it("a report before the hits of a group closed that way took effect is not the latest word", () => {
    const list = run([
      ...shieldUp(0, 20),
      hit(1, "A", { amount: 2000 }),
      hit(1.2, "B", { amount: 3000 }),
      // A heal's report while A has yet to take effect: it may still show the shield A used up.
      result(1.3, "H", 20),
      hit(1.5, "B2", { amount: 3000 }),
      result(1.7, "A", 0, P, MAX_HP - 2000),
      result(1.8, "B", 0, P, MAX_HP - 5000),
      result(1.9, "B2", 0, P, MAX_HP - 8000),
      // The same shield again: the old one was used up, nothing of it was lost.
      ...shieldUp(3, 10),
      hit(4, "C"),
      result(4.5, "C", 4),
    ]);
    expect(bySeq(list, "B2").shieldGroup).toBeUndefined();
    expect(bySeq(list, "C").shieldGroup).toMatchObject({ before: 10000, absorbed: 6000 });
    expect(bySeq(list, "C").shieldGroup!.bound).toBeUndefined();
  });

  it("a multi-hit action: every row of one sequence takes effect with its 37 line", () => {
    const list = run([...shieldUp(0, 30), hit(1, "M"), hit(1, "M"), result(1.5, "M", 12)]);
    expect(list).toHaveLength(2);
    expect(list.every((r) => r.settledAt === at(1.5))).toBe(true);
    expect(list[0]!.shieldGroup).toMatchObject({ absorbed: 18000 });
  });

  it("a fully absorbed hit with no 37 line of its own took effect: the next report after it is decided settles it", () => {
    const list = run([...shieldUp(0, 20), hit(1, "X"), statusList(3, 12), statusList(12, 12)]);
    const x = bySeq(list, "X");
    expect(x.noEffect).toBeUndefined();
    expect(x.shieldAbsorbed).toBe(8000);
  });

  it("a group line: its hits' damage summed, a range of unmitigated estimates when their mitigation differs", () => {
    const list = run([...shieldUp(0, 30), hit(1, "A", { amount: 1000 }), hit(1, "B", { amount: 2000 }), result(1.5, "A", 0, P, MAX_HP - 3000), result(1.6, "B", 0, P, MAX_HP - 3000)]);
    const line = groupRow(list[0]!.shieldGroup!, list);
    expect(line.amount).toBe(3000);
    expect(line.shieldAbsorbed).toBe(30000);
    expect(formatUnmitigated(line)).toBe("33,000");
    const mixed = { ...line, members: [{ ...list[0]!, multiplier: 0.5 }, list[1]!] };
    expect(formatUnmitigated(mixed)).toBe("34,000–64,000");
  });
});

describe("hits without their own 37 line (docs/DESIGN.md 5.6)", () => {
  const settled = (events: GameEvent[]) => run([...events, statusList(20, 0, Q)]);

  it("took effect unless the HP updates show the damage never came off", () => {
    const none = settled([statusList(0.5, 0, P, MAX_HP), hit(1, "X", { amount: 5000 }), statusList(3, 0, P, MAX_HP)]);
    expect(bySeq(none, "X")).toMatchObject({ noEffect: true });
    expect(damageTaken(bySeq(none, "X"))).toBe(0);
    const landed = settled([statusList(0.5, 0, P, MAX_HP), hit(1, "X", { amount: 5000 }), statusList(3, 0, P, MAX_HP - 5000)]);
    expect(bySeq(landed, "X").noEffect).toBeUndefined();
    // No HP update after it, or a heal in between: nothing says it did not land.
    expect(bySeq(settled([statusList(0.5, 0, P, MAX_HP), hit(1, "X", { amount: 5000 })]), "X").noEffect).toBeUndefined();
    const healed: GameEvent = { ...(hit(2, "H") as Extract<GameEvent, { type: "ability" }>), sourceId: HEALER, damage: undefined, heal: { toTarget: 5000, toSource: 0 } };
    expect(bySeq(settled([statusList(0.5, 0, P, MAX_HP), hit(1, "X", { amount: 5000 }), healed, statusList(3, 0, P, MAX_HP)]), "X").noEffect).toBeUndefined();
  });

  it("HP after is its own result's; without one it is unknown", () => {
    const list = settled([hit(1, "X", { amount: 5000 }), hit(2, "Y", { amount: 5000 }), result(2.5, "Y", 0, P, MAX_HP - 10000)]);
    expect(hpAfterOf(bySeq(list, "X"))).toBeUndefined();
    expect(hpAfterOf(bySeq(list, "Y"))).toBe(MAX_HP - 10000);
  });

  it("a hit still waiting when its target dies is decided by the HP updates: the killing blow took effect", () => {
    const engine = new Engine();
    engine.handle({ type: "combat", time: T, act: true, game: true, gameChanged: true });
    for (const e of [statusList(0.5, 0, P, 4000), hit(1, "K", { amount: 9000 }), statusList(1.4, 0, P, 0)]) engine.handle(e);
    engine.handle({ type: "death", time: at(3), targetId: P, targetName: "P1", sourceId: "40000001", sourceName: "Boss" });
    const rows = engine.current!.rows as Row[];
    const k = rows.find((r): r is DamageRow => r.kind !== "death" && r.seq === "K")!;
    expect(k.noEffect).toBeUndefined();
    expect(rows.find((r) => r.kind === "death")).toMatchObject({ killerRowId: k.id });
  });
});
