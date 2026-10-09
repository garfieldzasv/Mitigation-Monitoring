import { describe, expect, it } from "vitest";
import { statusCategory, statusIconId } from "@/core/game/statuses";
import { DEALT_MITIGATION, TAKEN_MITIGATION } from "@/data/mitigation";
import type { GainEffectEvent, LoseEffectEvent } from "@/core/logline/parse";
import { StatusTracker } from "@/core/status/statusTracker";

const gain = (over: Partial<GainEffectEvent>): GainEffectEvent => ({
  type: "gainEffect",
  time: 0,
  effectId: 0x4a9,
  effectName: "雪仇",
  duration: 15,
  sourceId: "10000001",
  sourceName: "P1",
  targetId: "40000001",
  targetName: "Boss",
  stacks: 0,
  ...over,
});

const lose = (over: Partial<LoseEffectEvent>): LoseEffectEvent => ({
  type: "loseEffect",
  time: 0,
  effectId: 0x4a9,
  effectName: "雪仇",
  sourceId: "10000001",
  sourceName: "P1",
  targetId: "40000001",
  targetName: "Boss",
  ...over,
});

const P1 = { id: "10000001", name: "P1" };

describe("StatusTracker", () => {
  it("snapshots remaining time, categorised for the side, and drops statuses on 30 lines", () => {
    const t = new StatusTracker(statusCategory);
    t.gain(gain({ time: 1000 }));
    expect(t.snapshot("40000001", 6000, "source")).toEqual([
      { id: 0x4a9, name: "雪仇", stacks: 0, remainingMs: 10000, sourceId: "10000001", sourceName: "P1", category: "damageDown" },
    ]);
    t.lose(lose({ time: 7000 }));
    expect(t.snapshot("40000001", 7000, "source")).toEqual([]);
  });

  it("keeps the modifier bytes of the line that put it on, whichever came first, through re-sends, not past a new application", () => {
    const t = new StatusTracker(statusCategory);
    const bytes = { first: -10, second: 0 };
    t.paramsFor("40000001", 0x4a9, bytes, 1000, P1);
    t.gain(gain({ time: 1400 }));
    expect(t.snapshot("40000001", 1500, "source")[0]?.params).toEqual(bytes);
    t.gain(gain({ time: 4400, duration: 12 })); // re-sent with the time it had left: the same application
    expect(t.snapshot("40000001", 4500, "source")[0]?.params).toEqual(bytes);
    t.gain(gain({ time: 6000 })); // put on again (full time) with no line of its own: unknown
    expect(t.snapshot("40000001", 6100, "source")[0]?.params).toBeUndefined();

    const late = new StatusTracker(statusCategory);
    late.gain(gain({ time: 1000 }));
    late.paramsFor("40000001", 0x4a9, bytes, 1000, P1); // the 26 line came first, the same moment
    expect(late.snapshot("40000001", 1500, "source")[0]?.params).toEqual(bytes);
  });

  it("a put-on line's bytes do not wait for a 26 line long after (5 s, Triggevent), nor go to another source's", () => {
    const t = new StatusTracker(statusCategory);
    t.paramsFor("40000001", 0x4a9, { first: -10, second: 0 }, 0, P1);
    t.gain(gain({ time: 5100 }));
    expect(t.snapshot("40000001", 5100, "source")[0]?.params).toBeUndefined();
    const other = new StatusTracker(statusCategory);
    other.paramsFor("40000001", 0x4a9, { first: -10, second: 0 }, 0, { id: "10000002", name: "P2" });
    other.gain(gain({ time: 500 }));
    expect(other.snapshot("40000001", 500, "source")[0]?.params).toBeUndefined();
    // A helper actor's line, its boss's 26 line: the same name.
    const helper = new StatusTracker(statusCategory);
    helper.paramsFor("10000001", 0x4a9, { first: 20, second: 0 }, 0, { id: "40000099", name: "Boss" });
    helper.gain(gain({ time: 500, targetId: "10000001", sourceId: "40000001", sourceName: "Boss" }));
    expect(helper.snapshot("10000001", 500, "target")[0]?.params).toEqual({ first: 20, second: 0 });
  });

  it("keeps the same status from two sources apart", () => {
    const t = new StatusTracker(statusCategory);
    t.gain(gain({ sourceId: "10000001" }));
    t.gain(gain({ sourceId: "10000002", sourceName: "P2" }));
    expect(t.snapshot("40000001", 0, "source").map((s) => s.sourceName)).toEqual(["P1", "P2"]);
    t.lose(lose({ time: 0 }));
    expect(t.snapshot("40000001", 0, "source").map((s) => s.sourceName)).toEqual(["P2"]);
  });

  it("keeps a status until its 30 line, past its duration (as Triggevent and cactbot oopsy do): the countdown shows 0", () => {
    const t = new StatusTracker(statusCategory);
    t.gain(gain({ time: 0, duration: 10 }));
    expect(t.snapshot("40000001", 60_000, "source")).toMatchObject([{ id: 0x4a9, remainingMs: 0 }]);
    t.lose(lose({ time: 61_000 }));
    expect(t.snapshot("40000001", 61_000, "source")).toHaveLength(0);
  });

  it("on a player outside the party (whose 30 lines may never come) a status is gone 3 s after its time, as souma keeps them", () => {
    const t = new StatusTracker(statusCategory, undefined, (id) => id !== "10000009");
    t.gain(gain({ time: 0, duration: 10, targetId: "10000009" }));
    expect(t.snapshot("10000009", 12_900, "target")).toHaveLength(1);
    expect(t.snapshot("10000009", 13_100, "target")).toHaveLength(0);
    expect(t.endsAt("10000009", 0, 10_000)).toBe(13_000);
    expect(t.endsAt("40000001", 0, 10_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("treats a duration over 9,000 s as indefinite (Triggevent), and refreshes on re-application", () => {
    const t = new StatusTracker(statusCategory);
    t.gain(gain({ effectId: 0x30, effectName: "进食", duration: 9999, targetId: "10000001" }));
    expect(t.snapshot("10000001", 1e9, "target")[0]?.remainingMs).toBe(Number.POSITIVE_INFINITY);
    t.gain(gain({ time: 0, duration: 10 }));
    t.gain(gain({ time: 5000, duration: 10, stacks: 2 }));
    expect(t.snapshot("40000001", 5000, "source")[0]).toMatchObject({ remainingMs: 10000, stacks: 2 });
  });

  it("keeps what an aura re-sends (a song, 节制) until its 30 line: the game data marks them permanent", () => {
    const t = new StatusTracker(statusCategory);
    const song = (time: number) => gain({ time, effectId: 0x8a8, effectName: "放浪神的小步舞曲", duration: 5, targetId: "10000001" });
    expect(t.gain(song(0))).toBe(true);
    expect(t.gain(song(3000))).toBe(false); // re-sent: not put on again
    expect(t.snapshot("10000001", 20_000, "target")[0]?.remainingMs).toBe(Number.POSITIVE_INFINITY);
    t.lose(lose({ time: 21_000, effectId: 0x8a8, effectName: "放浪神的小步舞曲", targetId: "10000001" }));
    expect(t.snapshot("10000001", 21_000, "target")).toEqual([]);
    const shield = (time: number, duration: number) => gain({ time, effectId: 0x129, effectName: "鼓舞", duration, targetId: "10000002" });
    t.gain(shield(0, 30));
    t.gain(shield(3000, 27)); // absorbed some: re-sent with the time left
    expect(t.snapshot("10000002", 4000, "target")[0]?.remainingMs).toBe(26_000);
  });

  it("treats statuses the game data marks permanent as permanent, whatever the 26 line says", () => {
    // 关心 (Kardion): re-sent every 3 s with 60 s, shown in game without a timer.
    const t = new StatusTracker(statusCategory);
    t.gain(gain({ effectId: 0xa2d, effectName: "关心", duration: 60, targetId: "10000001" }));
    expect(t.snapshot("10000001", 120_000, "target")[0]?.remainingMs).toBe(Number.POSITIVE_INFINITY);
    t.gain(gain({ effectId: 0x129, effectName: "鼓舞", duration: 30, targetId: "10000001" })); // not permanent
    expect(t.snapshot("10000001", 10_000, "target").find((s) => s.name === "鼓舞")?.remainingMs).toBe(20_000);
  });
});

describe("statusCategory", () => {
  it("target side: mitigation, shields, vulnerabilities, invulnerability", () => {
    expect(statusCategory(1191, "target")).toBe("mitigation"); // 铁壁
    expect(statusCategory(1873, "target")).toBe("mitigation"); // 节制
    expect(statusCategory(297, "target")).toBe("shield"); // 鼓舞
    expect(statusCategory(1789, "target")).toBe("vulnerability"); // 受伤加重
    expect(statusCategory(0x52, "target")).toBe("invuln"); // 神圣领域
    expect(statusCategory(0x622, "target")).toBe("invuln"); // 无敌（机制）
    expect(statusCategory(48, "target")).toBe("other"); // 进食
  });

  it("source side: Reprisal-like debuffs and damage-ups; the same buff on a player is irrelevant", () => {
    expect(statusCategory(1193, "source")).toBe("damageDown"); // 雪仇
    expect(statusCategory(1203, "source")).toBe("damageDown"); // 昏乱
    expect(statusCategory(505, "source")).toBe("damageUp"); // 伤害提高
    expect(statusCategory(505, "target")).toBe("other");
    expect(statusCategory(1193, "target")).toBe("other");
  });

  it("stacked statuses use consecutive icons", () => {
    const base = statusIconId(1789, 1);
    expect(base).toBeGreaterThan(0);
    expect(statusIconId(1789, 3)).toBe(statusIconId(1789, 1) + (statusIconId(1789, 3) - base));
    expect(statusIconId(1193, 0)).toBe(213901); // 雪仇
    expect(statusIconId(999999, 1)).toBe(0);
  });

  it("a status with no damage effect has its base icon only (docs/DESIGN.md 8.2)", () => {
    expect(statusIconId(1299, 0)).toBe(213312); // 风花
    expect(statusIconId(304, 3)).toBe(210501); // 以太超流: 3 stacks, still the base icon
    expect(statusIconId(365, 0)).toBe(0); // 部队特效：讨伐经验值提高: not listed
    expect(statusIconId(0x808, 0)).toBe(0); // not shown in the game
  });

  it("every status in the mitigation tables has an icon, even when its description says nothing about damage", () => {
    const ids = [...Object.keys(TAKEN_MITIGATION), ...Object.keys(DEALT_MITIGATION)].map(Number);
    expect(ids.filter((id) => statusIconId(id, 0) === 0)).toEqual([]);
    expect(statusIconId(1858, 0)).toBeGreaterThan(0); // 原初的武猛: its text is mostly about healing; 原初的勇猛's tooltip gives it 10%
    expect(statusCategory(1857, "target")).toBe("other"); // 原初的勇猛 itself: no reduction in the tooltip
  });
});
