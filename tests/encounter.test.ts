import { describe, expect, it } from "vitest";
import { EncounterTracker, type OurSide } from "@/core/engine/encounter";
import type { GameEvent } from "@/core/logline/parse";

const S = 1000;
const SELF = "10000001";
const MATE = "10000002";
const STRANGER = "10000009";
const ENEMY = "40000001";
/** The player and one party member; STRANGER is another player around (or another alliance's). */
const side: OurSide = { selfId: SELF, has: (id) => id === SELF || id === MATE };

/** A 260 line; `gameChanged` defaults to "the game's state is what changed". */
const combat = (sec: number, act: boolean, game: boolean, gameChanged = true): GameEvent => ({ type: "combat", time: sec * S, act, game, gameChanged });
const victory = (sec: number): GameEvent => ({ type: "victory", time: sec * S });
const wipe = (sec: number): GameEvent => ({ type: "wipe", time: sec * S });
const death = (sec: number, id: string): GameEvent => ({ type: "death", time: sec * S, targetId: id, targetName: "", sourceId: ENEMY, sourceName: "" });
const hpOf = (sec: number, id: string, hp: number): GameEvent => ({ type: "hp", time: sec * S, id, hp, maxHp: 100000 });
/** A damage line between `source` and `target`. */
const hit = (sec: number, sourceId: string, targetId: string): GameEvent =>
  ({
    type: "ability",
    time: sec * S,
    sourceId,
    sourceName: "",
    targetId,
    targetName: "",
    actionId: 1,
    actionName: "",
    damage: { result: "hit", amount: 100, crit: false, direct: false, damageType: "magical", attackType: 5, element: 7 },
  }) as unknown as GameEvent;

describe("EncounterTracker: the fights of the player and their party (docs/DESIGN.md 5.3)", () => {
  it("starts when the game puts the player in combat and ends when it takes them out", () => {
    const t = new EncounterTracker(side);
    expect(t.onEvent(combat(1, false, true))).toEqual({ kind: "start", time: 1 * S });
    expect(t.onEvent(combat(2, true, true, false))).toBeUndefined();
    expect(t.onEvent(combat(3, true, false))).toEqual({ kind: "end", time: 3 * S, result: "unknown" });
    expect(t.onEvent(combat(4, false, false, false))).toBeUndefined();
  });

  it("ACT's combat state starts nothing: it may be other people's fights around the player (LogGuide)", () => {
    const t = new EncounterTracker(side);
    expect(t.onEvent(combat(1, true, false, false))).toBeUndefined();
    expect(t.onEvent(combat(9, false, false, false))).toBeUndefined();
  });

  it("other players' fights start nothing; the player's or a party member's damage with an enemy does", () => {
    const t = new EncounterTracker(side);
    expect(t.onEvent(hit(1, ENEMY, "40000002"))).toBeUndefined(); // enemy on enemy
    expect(t.onEvent(hit(2, STRANGER, ENEMY))).toBeUndefined();
    expect(t.onEvent(hit(3, ENEMY, STRANGER))).toBeUndefined();
    expect(t.onEvent(hit(4, MATE, SELF))).toBeUndefined(); // player on player
    expect(t.onEvent(hit(5, ENEMY, MATE))).toEqual({ kind: "start", time: 5 * S });
    expect(t.onEvent(combat(5.5, true, true))).toBeUndefined();
  });

  it("the player's own first blow starts it too, ahead of the 260 line", () => {
    const t = new EncounterTracker(side);
    expect(t.onEvent(hit(2, SELF, ENEMY))).toEqual({ kind: "start", time: 2 * S });
  });

  it("ACT staying in combat (others fighting around) does not keep the player's fight going", () => {
    const t = new EncounterTracker(side);
    t.onEvent(combat(1, true, true));
    expect(t.onEvent(combat(30, true, false))).toEqual({ kind: "end", time: 30 * S, result: "unknown" });
  });

  it("a fight of the party the player never joined ends when ACT and the game are both out of combat", () => {
    const t = new EncounterTracker(side);
    expect(t.onEvent(hit(1, ENEMY, MATE))).toMatchObject({ kind: "start" });
    expect(t.onEvent(combat(1.2, true, false, false))).toBeUndefined(); // ACT came in; the game did not change
    expect(t.onEvent(combat(8, false, false, false))).toEqual({ kind: "end", time: 8 * S, result: "unknown" });
  });

  it("a 260 line stamped before the pull started (written late) ends nothing: the party fights on without the player", () => {
    const t = new EncounterTracker(side);
    expect(t.onEvent(hit(13.856, MATE, ENEMY))).toMatchObject({ kind: "start" });
    expect(t.onEvent(combat(13.8, true, false))).toBeUndefined();
    expect(t.onEvent(combat(19.272, false, false, false))).toEqual({ kind: "end", time: 19.272 * S, result: "unknown" });
  });

  it("the player's combat state dropping while they are dead does not end the party's fight", () => {
    const t = new EncounterTracker(side);
    t.onEvent(combat(1, true, true));
    t.onEvent(death(20, SELF));
    expect(t.onEvent(combat(21, true, false))).toBeUndefined();
    t.onEvent(hpOf(40, SELF, 30000)); // raised
    expect(t.onEvent(combat(41, true, true))).toBeUndefined();
    expect(t.onEvent(victory(90))).toEqual({ kind: "end", time: 90 * S, result: "clear" });
  });

  it("dead when the fight is over: ends once ACT is out of combat too", () => {
    const t = new EncounterTracker(side);
    t.onEvent(combat(1, true, true));
    t.onEvent(death(20, SELF));
    expect(t.onEvent(combat(21, true, false))).toBeUndefined();
    expect(t.onEvent(combat(26, false, false, false))).toEqual({ kind: "end", time: 26 * S, result: "unknown" });
  });

  it("another member's death does not hold the end", () => {
    const t = new EncounterTracker(side);
    t.onEvent(combat(1, true, true));
    t.onEvent(death(20, MATE));
    expect(t.onEvent(combat(21, true, false))).toMatchObject({ kind: "end" });
  });

  it("a victory ends the encounter at once (Triggevent), as a wipe or a zone change does", () => {
    const t = new EncounterTracker(side);
    t.onEvent(combat(1, true, true));
    expect(t.onEvent(victory(60))).toEqual({ kind: "end", time: 60 * S, result: "clear" });
    t.onEvent(combat(100, true, true));
    expect(t.onEvent(wipe(150))).toEqual({ kind: "end", time: 150 * S, result: "wipe" });
    t.onEvent(combat(200, true, true));
    expect(t.onEvent({ type: "zone", time: 260 * S, zoneId: 1, zoneName: "x" })).toEqual({ kind: "end", time: 260 * S, result: "unknown" });
  });

  it("no new encounter within 5 s of the last end: a wipe's belated lines", () => {
    const t = new EncounterTracker(side);
    t.onEvent(combat(1, true, true));
    t.onEvent(wipe(10));
    expect(t.onEvent(hit(12, ENEMY, SELF))).toBeUndefined();
    expect(t.onEvent(combat(14, true, true, false))).toBeUndefined();
    expect(t.onEvent(combat(16, true, true, false))).toEqual({ kind: "start", time: 16 * S });
  });

  it("a victory or wipe line after an encounter ended by combat dropping decides its result, until the next starts or the zone changes", () => {
    const t = new EncounterTracker(side);
    t.onEvent(combat(1, true, true));
    expect(t.onEvent(combat(2, true, false))).toMatchObject({ kind: "end", result: "unknown" });
    expect(t.onEvent(victory(5))).toEqual({ kind: "result", time: 5 * S, result: "clear" });
    expect(t.onEvent(victory(6))).toBeUndefined();
    t.onEvent(combat(20, true, true));
    t.onEvent(combat(21, true, false));
    expect(t.onEvent(wipe(24))).toEqual({ kind: "result", time: 24 * S, result: "wipe" });
    t.onEvent(combat(40, true, true));
    t.onEvent(combat(41, true, false));
    expect(t.onEvent(victory(52))).toEqual({ kind: "result", time: 52 * S, result: "clear" });
    t.onEvent(combat(60, true, true));
    t.onEvent(combat(61, true, false));
    t.onEvent({ type: "zone", time: 62 * S, zoneId: 1, zoneName: "x" });
    expect(t.onEvent(victory(63))).toBeUndefined();
  });

  it("a replay starts the archived pull where the archive says, whatever its first line is; earlier lines are state only", () => {
    const t = new EncounterTracker(side);
    t.startAt(30 * S);
    expect(t.onEvent(hit(10, ENEMY, SELF))).toBeUndefined();
    expect(t.onEvent(combat(29, true, true))).toBeUndefined();
    // An archive from older rules: its pull started on ACT's combat state.
    expect(t.onEvent(combat(30, true, false, false))).toEqual({ kind: "start", time: 30 * S });
    expect(t.onEvent(combat(40, true, false))).toMatchObject({ kind: "end" });
  });

  it("victory outside an encounter is ignored", () => {
    const t = new EncounterTracker(side);
    t.onEvent(victory(1));
    t.onEvent(combat(2, true, true));
    expect(t.onEvent(combat(3, true, false))).toMatchObject({ result: "unknown" });
  });

  it("without a side (a log file cut without its party), any player's fight counts", () => {
    const t = new EncounterTracker();
    expect(t.onEvent(hit(1, STRANGER, ENEMY))).toEqual({ kind: "start", time: 1 * S });
  });
});
