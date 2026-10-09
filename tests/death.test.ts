import { describe, expect, it } from "vitest";
import { deathSentence } from "@/app/format";
import { DeathCauses } from "@/core/engine/deathCause";
import { Engine } from "@/core/engine/engine";
import { inEffectOrder, type DamageRow, type DeathRow, type Encounter } from "@/core/engine/types";
import type { GameEvent } from "@/core/logline/parse";

const T = 1_000_000;
const P = "100827F3";
const MAX_HP = 123_258;
const at = (sec: number) => T + Math.round(sec * 1000);

const hit = (sec: number, seq: string, amount: number, hp = MAX_HP): GameEvent => ({
  type: "ability",
  time: at(sec),
  sourceId: "4000C86A",
  sourceName: "阿格狄斯提斯",
  actionId: 0x78e4,
  actionName: "攻击",
  targetId: P,
  targetName: "白鳥翔",
  damage: { result: "hit", amount, crit: false, direct: false, damageType: "physical", attackType: 1, element: 0 },
  targetHp: hp,
  targetMaxHp: MAX_HP,
  sourceHp: 1,
  sourceMaxHp: 1,
  sequence: seq,
  targetIndex: 0,
  targetCount: 1,
});
const result = (sec: number, seq: string, hp: number): GameEvent => ({ type: "effectResult", time: at(sec), targetId: P, sequence: seq, currentHp: hp, maxHp: MAX_HP });
/** A 38 line: the player's HP. */
const hp = (sec: number, value: number, id = P): GameEvent => ({ type: "statusList", time: at(sec), targetId: id, currentHp: value, maxHp: MAX_HP, shieldPercent: 0 });
/** A 25 line; no killer named: E0000000 and an empty name. */
const death = (sec: number, killer?: [string, string], id = P): GameEvent => ({
  type: "death",
  time: at(sec),
  targetId: id,
  targetName: id === P ? "白鳥翔" : id,
  sourceId: killer?.[0] ?? "E0000000",
  sourceName: killer?.[1] ?? "",
});

const OTHERS = ["10000001", "10000002", "10000003"];
const BOSS: [string, string] = ["4000C86A", "阿格狄斯提斯"];

function run(events: GameEvent[], end = false) {
  const engine = new Engine();
  engine.handle({ type: "combat", time: T, act: true, game: true, gameChanged: true });
  for (const e of events) engine.handle(e);
  const encounter = engine.current as Encounter;
  if (end) {
    const last = events.reduce((t, e) => Math.max(t, e.time), T);
    engine.handle({ type: "combat", time: last + 1, act: false, game: false, gameChanged: true });
  }
  const rows = encounter.rows;
  return { hits: rows.filter((r): r is DamageRow => r.kind !== "death"), deaths: rows.filter((r): r is DeathRow => r.kind === "death") };
}

/** A zone's lines: cactbot's annotations for it apply. */
function inZone(zoneId: number, events: GameEvent[]) {
  const engine = new Engine();
  engine.handle({ type: "zone", time: T - 1000, zoneId, zoneName: "x" });
  engine.handle({ type: "combat", time: T, act: true, game: true, gameChanged: true });
  for (const e of events) engine.handle(e);
  const rows = engine.current!.rows;
  return { hits: rows.filter((r): r is DamageRow => r.kind !== "death"), deaths: rows.filter((r): r is DeathRow => r.kind === "death") };
}

describe("death attribution", () => {
  it("a 25 line naming no killer (E0000000), with no blow shown to kill, is 地形杀 (souma) — not the hit before", () => {
    // Full HP, a 21,067 auto-attack, then the death (10-06 炼净之狱3: fell 48 yalms).
    const { hits, deaths } = run([hit(1.9, "A", 21_067), death(4.4)]);
    expect(deaths[0]).toMatchObject({ cause: "terrain" });
    expect(deaths[0]!.killerRowId).toBeUndefined();
    expect(hits[0]!.fatal).toBeUndefined();
    expect(deathSentence(deaths[0]!, undefined)).toBe("白鳥翔死亡（地形杀）");
    // A hit the 37 line shows was survived: the same.
    const survived = run([hit(1, "A", 115_000), result(1.6, "A", MAX_HP - 115_000), death(4)], true);
    expect(survived.deaths[0]).toMatchObject({ cause: "terrain" });
  });

  it("with no killer named, a blow whose own 37 line shows HP 0 killed; one with no 37 line is not taken", () => {
    const shown = run([hit(1, "A", 30_000, 28_000), result(1.5, "A", 0), death(3.5)]);
    expect(shown.deaths[0]!.killerRowId).toBe(shown.hits[0]!.id);
    expect(shown.hits[0]!.fatal).toBe(true);
    expect(shown.deaths[0]!.cause).toBeUndefined();
    const unshown = run([hp(0.5, 28_000), hit(1, "A", 30_000, 28_000), death(3.5)]);
    expect(unshown.deaths[0]!.killerRowId).toBeUndefined();
    expect(unshown.deaths[0]).toMatchObject({ cause: "terrain" });
  });

  it("cactbot's annotation of the zone: knocked into the wall (FRU 9CC2) is 地形杀, whoever the 25 line names; damage after it cancels it", () => {
    const knock = { ...(hit(1, "K", 0) as Extract<GameEvent, { type: "ability" }>), actionId: 0x9cc2, actionName: "击退" };
    const walled = inZone(1238, [knock, death(3, BOSS)]);
    expect(walled.deaths[0]).toMatchObject({ cause: "terrain" });
    expect(walled.deaths[0]!.causeText).toBeUndefined();
    expect(walled.deaths[0]!.killerRowId).toBeUndefined();
    expect(deathSentence(walled.deaths[0]!, undefined)).toBe("白鳥翔死亡（地形杀）");
    // Damage after it: what killed is that, not the annotation.
    const hitAfter = inZone(1238, [knock, hit(2, "A", 200_000), death(3, BOSS)]);
    expect(hitAfter.deaths[0]!.cause).toBeUndefined();
    expect(hitAfter.deaths[0]!.killerRowId).toBe(hitAfter.hits[1]!.id);
    // Another zone: no annotation; the 25 line names a killer and no damage line came.
    const elsewhere = run([knock, death(3, BOSS)]);
    expect(elsewhere.deaths[0]!.cause).toBeUndefined();
    expect(deathSentence(elsewhere.deaths[0]!, undefined)).toBe("白鳥翔被「阿格狄斯提斯」击倒，没有伤害记录");
  });

  it("a mechanic cactbot annotates is the cause, in its own words (没解死宣)", () => {
    const doom: GameEvent = { type: "gainEffect", time: at(1), effectId: 910, effectName: "死亡宣告", duration: 10, sourceId: BOSS[0], sourceName: BOSS[1], targetId: P, targetName: "白鳥翔", stacks: 0 };
    const { deaths } = inZone(694, [doom, death(11, BOSS)]);
    expect(deaths[0]).toMatchObject({ cause: "other", causeText: "没解死宣" });
    expect(deathSentence(deaths[0]!, undefined)).toBe("白鳥翔死亡（没解死宣）");
  });

  it("a killer the 25 line names keeps the last hit that took effect, lethal or not", () => {
    const { hits, deaths } = run([hit(1, "A", 21_067), result(1.6, "A", 0), death(4, BOSS)]);
    expect(deaths[0]!.killerRowId).toBe(hits[0]!.id);
    expect(deaths[0]!.cause).toBeUndefined();
  });

  it("each death on its own lines: others dying at the same moment (a wipe is a result, not a cause) change nothing", () => {
    const others = OTHERS.flatMap((id, i) => [
      { ...(hit(20, `O${i}`, 90_000) as Extract<GameEvent, { type: "ability" }>), targetId: id, targetName: id },
      death(21, BOSS, id),
    ]);
    const { deaths } = run([...others, death(21)], true);
    expect(deaths.find((d) => d.target.id === P)!.cause).toBe("terrain");
    expect(deaths.filter((d) => d.target.id !== P).map((d) => [d.cause, d.killerRowId !== undefined])).toEqual([
      [undefined, true],
      [undefined, true],
      [undefined, true],
    ]);
  });

  it("of the blows of one moment whose 37 lines show 0, the first killed", () => {
    const { hits, deaths } = run([hit(1, "A", 50_000, 40_000), hit(1, "B", 20_000, 40_000), result(1.5, "A", 0), result(1.5, "B", 0), death(3.5, ["4000C86A", "阿格狄斯提斯"])]);
    expect(deaths[0]!.killerRowId).toBe(hits[0]!.id);
  });

  it("an action whose effect is instant death (0x33) is the cause", () => {
    const kill: GameEvent = { ...(hit(1, "K", 0) as Extract<GameEvent, { type: "ability" }>), actionName: "死亡宣告", damage: undefined, instantDeath: true };
    const { deaths } = run([hit(0.5, "A", 21_067), result(0.9, "A", MAX_HP - 21_067), kill, death(3)]);
    expect(deaths[0]).toMatchObject({ cause: "instant", causeAction: "死亡宣告" });
    expect(deaths[0]!.killerRowId).toBeUndefined();
    expect(deathSentence(deaths[0]!, undefined)).toBe("白鳥翔被「死亡宣告」即死");
  });

  it("keeps when HP went to 0 (not the 0s reported while dead) and the last HP above 0 before it; no window", () => {
    const c = new DeathCauses();
    c.hp(P, 1000, 5000);
    c.hp(P, 2000, 0);
    c.hp(P, 5000, 0);
    c.hp(P, 6500, 0);
    expect(c.zeroBefore(P, 4000)).toEqual({ at: 2000, aliveBefore: 1000 });
    expect(c.zeroBefore(P, 60_000)?.at).toBe(2000);
    expect(c.zeroBefore(P, 1500)).toBeUndefined();
    // That 0 belonged to the death before.
    c.died(P, 3000);
    expect(c.zeroBefore(P, 60_000)).toBeUndefined();
  });

  it("a 25 line coming after its encounter ended (combat dropped first) belongs to the pull the player died in", () => {
    const engine = new Engine();
    engine.handle({ type: "combat", time: T, act: true, game: true, gameChanged: true });
    engine.handle(hit(1, "A", 50_000));
    engine.handle(result(1.4, "A", 0));
    engine.handle({ type: "combat", time: at(1.6), act: false, game: false, gameChanged: true });
    engine.handle(death(3.4, ["4000C86A", "阿格狄斯提斯"]));
    expect(engine.encounters).toHaveLength(1);
    expect(engine.encounters[0]!.rows.filter((r) => r.kind === "death")).toHaveLength(1);
  });
});

describe("hits locked in together on one player (docs/DESIGN.md 5.6)", () => {
  // 狂热糖潮's 飞针, 09-05: three needles lock in at one moment on a player at full HP; two get their 37 lines (the first
  // leaves 57,957, the second 0), the third none.
  const FULL = 175_438;
  const needle = (seq: string, amount: number): GameEvent => ({ ...(hit(1, seq, amount, FULL) as Extract<GameEvent, { type: "ability" }>), targetMaxHp: FULL });
  const res = (seq: string, value: number): GameEvent => ({ type: "effectResult", time: at(1.18), targetId: P, sequence: seq, currentHp: value, maxHp: FULL });
  const update = (sec: number, value: number): GameEvent => ({ type: "statusList", time: at(sec), targetId: P, currentHp: value, maxHp: FULL, shieldPercent: 0 });

  it("take effect in the order of their 37 lines, each from the HP the last update gave; one the others left nothing for took none", () => {
    const { hits, deaths } = run([update(0.7, FULL), needle("9F10", 96_685), needle("9F12", 117_481), needle("9F13", 133_872), res("9F12", 57_957), res("9F13", 0), update(1.18, 0), death(3.2, BOSS)]);
    const [a, b, c] = hits;
    expect([b!.hpBefore, b!.hpAfter]).toEqual([FULL, 57_957]);
    expect([c!.hpBefore, c!.hpAfter]).toEqual([57_957, 0]);
    expect(a!.noEffect).toBe(true);
    expect(deaths[0]).toMatchObject({ killerRowId: c!.id, overkill: 133_872 - 57_957 });
    expect(inEffectOrder(hits).map((r) => r.seq)).toEqual(["9F12", "9F13", "9F10"]);
  });

  it("a hit with no 37 line still took effect when the HP went down beyond what the others' 37 lines account for", () => {
    // 9F10 came off between: the next 37 line shows it on top of 9F12's own damage.
    const { hits } = run([update(0.7, FULL), needle("9F10", 30_000), needle("9F12", 100_000), res("9F12", FULL - 30_000 - 100_000), death(9, BOSS)]);
    expect(hits[0]!.noEffect).toBeUndefined();
  });
});

describe("the HP before a hit or a tick (docs/DESIGN.md 5.6)", () => {
  const tick = (sec: number, kind: "dot" | "hot", amount: number, memoryHp: number): GameEvent => ({ type: "tick", time: at(sec), kind, targetId: P, targetName: "白鳥翔", effectId: 0, amount, targetHp: memoryHp, targetMaxHp: MAX_HP });

  it("is the last HP update with the DoT and HoT ticks since; the lines' own HP figures (read from memory) are not used", () => {
    // 38: 100,000; a DoT tick of 5,000 whose line still reads 100,000; a hit locked in reading 100,000 too.
    const { hits } = run([hp(0, 100_000), tick(0.5, "dot", 5_000, 100_000), hit(1, "A", 20_000, 100_000), result(1.2, "A", 75_000)]);
    const [dot, a] = hits;
    expect(dot!.hpBefore).toBe(100_000);
    expect([a!.hpBefore, a!.hpAfter]).toEqual([95_000, 75_000]);
  });

  it("a HoT tick adds up to max HP", () => {
    const { hits } = run([hp(0, MAX_HP - 1_000), tick(0.5, "hot", 5_000, MAX_HP - 1_000), hit(1, "A", 20_000), result(1.2, "A", MAX_HP - 20_000)]);
    expect(hits[0]!.hpBefore).toBe(MAX_HP);
  });
});
