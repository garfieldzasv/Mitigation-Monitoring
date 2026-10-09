import { describe, expect, it } from "vitest";
import { Engine } from "@/core/engine/engine";
import { derivePhases, phaseAt } from "@/core/engine/phases";
import type { GameEvent } from "@/core/logline/parse";
import { loadFixture, runFixture } from "./helpers/fixture";

const s = (offset: number, start: number) => Math.round((offset - start) / 1000);

describe("phases of real pulls", () => {
  it("格莱杨拉波尔: every stretch with nothing to hit splits the fight — the three 6 s jumps, and the transition around its adds", () => {
    const engine = runFixture(loadFixture("trial-phases.log.gz"));
    const enc = engine.encounters.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    expect(enc.boss).toMatchObject({ name: "格莱杨拉波尔" });
    const phases = derivePhases(enc, enc.end!);
    // Named by their time, not numbered (a duty's P1, P2… are its guides' names).
    expect(phases.map((p) => `${p.label}[${s(p.start, enc.start)}-${s(p.end!, enc.start)}]`)).toEqual([
      "00:00–00:47[0-47]",
      "离场 00:47–00:52[47-53]",
      "00:52–01:56[53-117]",
      "离场 01:56–02:02[117-122]",
      "02:02–02:54[122-175]",
      "离场 02:54–03:00[175-181]",
      "03:00–03:13[181-194]",
      // The boss left for its transition; the adds it brought can be hit, and the boss came back after them.
      "离场 03:13–03:20[194-201]",
      "03:20–03:59[201-239]",
      "离场 03:59–04:10[239-251]",
      "04:10–06:45[251-405]",
    ]);
    expect(phases[0]).toMatchObject({ hpStart: 100 });
    expect(phases[0]!.hpEnd).toBeCloseTo(phases[1]!.hpStart!, 5);
    expect(phases.at(-1)!.hpEnd).toBeLessThan(1);
    // Rows fall in the phase of their time.
    const firstRow = enc.rows[0]!;
    expect(phaseAt(phases, firstRow.time)?.label).toBe("00:00–00:47");
    expect(phaseAt(phases, enc.end!)?.label).toBe("04:10–06:45");
  });

  it("护锁刃龙: never leaves, a single phase", () => {
    const engine = runFixture(loadFixture("hunt-8p.log.gz"));
    const enc = engine.encounters.at(-1)!;
    expect(enc.untargetable).toEqual([]);
    expect(derivePhases(enc, enc.end!).map((p) => p.label)).toEqual(["00:00–07:00"]);
  });
});

describe("phase rules", () => {
  const BOSS = "40000001";
  const t0 = Date.UTC(2026, 9, 5, 12, 0, 0);
  const at = (sec: number) => t0 + sec * 1000;
  const hit = (sec: number, hp: number, target = BOSS, maxHp = 1_000_000): GameEvent => ({
    type: "ability",
    time: at(sec),
    sourceId: "10000001",
    sourceName: "P1",
    actionId: 1,
    actionName: "a",
    targetId: target,
    targetName: target === BOSS ? "Boss" : "Add",
    targetHp: hp,
    targetMaxHp: maxHp,
    sourceHp: 1,
    sourceMaxHp: 1,
    sequence: String(sec),
    targetIndex: 0,
    targetCount: 1,
  });
  const toggle = (sec: number, targetable: boolean, id = BOSS): GameEvent => ({ type: "targetable", time: at(sec), id, name: "x", targetable });
  const dies = (sec: number, id: string): GameEvent => ({ type: "death", time: at(sec), targetId: id, targetName: "Add", sourceId: "10000001", sourceName: "P1" });
  const removed = (sec: number, id = BOSS): GameEvent => ({ type: "removeCombatant", time: at(sec), id });
  const added = (sec: number, id = BOSS): GameEvent => ({ type: "addCombatant", time: at(sec), id, name: "x", job: 0, level: 0, maxHp: 1_000_000 });
  const run = (events: GameEvent[]) => {
    const engine = new Engine();
    engine.handle({ type: "combat", time: at(0), act: true, game: true, gameChanged: true });
    for (const e of events) engine.handle(e);
    return engine.current!;
  };
  const windows = (enc: { untargetable: { start: number; end?: number }[] }) =>
    enc.untargetable.map((w) => [(w.start - t0) / 1000, w.end === undefined ? "open" : (w.end - t0) / 1000]);

  it("a window opens as soon as every enemy the players targeted is untargetable, whatever its length", () => {
    const enc = run([hit(1, 900_000), toggle(20, false), toggle(22, true)]);
    expect(derivePhases(enc, at(30)).map((p) => [p.label, (p.start - t0) / 1000])).toEqual([
      ["00:00–00:20", 0],
      ["离场 00:20–00:22", 20],
      ["00:22 起", 22],
    ]);
  });

  it("an add the players hit keeps the fight going while it can be targeted; enemies nobody targeted do not count", () => {
    const enc = run([hit(1, 900_000), hit(2, 20_000, "40000002", 30_000), toggle(5, false, "40000099"), toggle(10, false)]);
    expect(enc.untargetable).toEqual([]);
    // The add dies: nothing left to hit.
    const engine = new Engine();
    engine.handle({ type: "combat", time: at(0), act: true, game: true, gameChanged: true });
    for (const e of [hit(1, 900_000), hit(2, 20_000, "40000002", 30_000), toggle(10, false)]) engine.handle(e);
    engine.handle({ type: "death", time: at(15), targetId: "40000002", targetName: "Add", sourceId: "10000001", sourceName: "P1" });
    expect(derivePhases(engine.current!, at(20)).map((p) => [p.label, (p.start - t0) / 1000])).toEqual([
      ["00:00–00:15", 0],
      ["离场 00:15 起", 15],
    ]);
  });

  it("an enemy the players hit counts from when it became targetable: no window while the next wave waits to be hit", () => {
    // 永远之暗: the boss away, its hands come in waves, each targetable a moment before anyone hits it.
    const A1 = "40000002", A2 = "40000003";
    const wave = [hit(1, 900_000), toggle(9, true, A1), toggle(10, false), hit(10.5, 80_000, A1, 80_000), toggle(19, true, A2), dies(20, A1)];
    const engine = new Engine();
    engine.handle({ type: "combat", time: at(0), act: true, game: true, gameChanged: true });
    for (const e of wave) engine.handle(e);
    // Nobody has hit the second wave yet: nothing to hit, as far as is known.
    expect(windows(engine.current!)).toEqual([[20, "open"]]);
    // Its first hit shows it could be hit since 19: no window after all.
    engine.handle(hit(21, 80_000, A2, 80_000));
    expect(windows(engine.current!)).toEqual([]);
    for (const e of [dies(30, A2), toggle(40, true)]) engine.handle(e);
    expect(windows(engine.current!)).toEqual([[30, 40]]);
    // Enemies nobody hit still do not count, targetable or not.
    expect(windows(run([hit(1, 900_000), toggle(10, false), toggle(12, true, "40000099"), toggle(20, true)]))).toEqual([[10, 20]]);
  });

  it("an enemy gone from the scene (04) and back (03) counts afresh: from its next hit, or when it becomes targetable", () => {
    // 瓯博讷修道院 / 永远之暗: the boss leaves, is removed and added back, and is fought again with no 34 line.
    expect(windows(run([hit(1, 900_000), toggle(10, false), removed(12), added(20), hit(21, 800_000), toggle(30, false)]))).toEqual([
      [10, 21],
      [30, "open"],
    ]);
    expect(windows(run([hit(1, 900_000), toggle(10, false), removed(12), added(20), toggle(25, true)]))).toEqual([[10, 25]]);
    // An 03 with no 04 before it (LogGuide: also when it comes into view) leaves it as it was.
    expect(windows(run([hit(1, 900_000), added(5), hit(6, 890_000), toggle(10, false)]))).toEqual([[10, "open"]]);
  });

  it("changes at one moment settle together: no stretch, 在场 or 离场, of no length", () => {
    // 朱雀: an add the players hit earlier shows its nameplate and hides it again in the same millisecond.
    const BIRD = "40000002";
    expect(windows(run([hit(1, 900_000), hit(2, 50_000, BIRD, 50_000), toggle(3, false, BIRD), toggle(10, false), toggle(15, true, BIRD), toggle(15, false, BIRD), toggle(30, true)]))).toEqual([[10, 30]]);
    // The last add dies the moment the boss comes back.
    expect(windows(run([hit(1, 900_000), hit(2, 50_000, BIRD, 50_000), toggle(8, false), dies(10, BIRD), toggle(10, true)]))).toEqual([]);
  });

  it("a boss that never comes back ended the fight: a window while it runs, gone once it ends", () => {
    // 温达斯：第三巡行: 恶魔香托托 left near 0% HP and the pull ended 14 s later, the boss still away.
    const engine = new Engine();
    engine.handle({ type: "combat", time: at(0), act: true, game: true, gameChanged: true });
    for (const e of [hit(1, 900_000), toggle(20, false), toggle(60, true), hit(70, 4_000), toggle(80, false)]) engine.handle(e);
    const enc = engine.current!;
    expect(derivePhases(enc, at(94)).map((p) => p.label)).toEqual(["00:00–00:20", "离场 00:20–01:00", "01:00–01:20", "离场 01:20 起"]);
    engine.handle({ type: "combat", time: at(94), act: false, game: false, gameChanged: true });
    expect(enc.untargetable).toHaveLength(1);
    expect(derivePhases(enc, enc.end!).map((p) => [p.label, (p.start - t0) / 1000, (p.end! - t0) / 1000])).toEqual([
      ["00:00–00:20", 0, 20],
      ["离场 00:20–01:00", 20, 60],
      ["01:00–01:34", 60, 94],
    ]);
  });
});
