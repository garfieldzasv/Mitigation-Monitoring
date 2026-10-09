import { describe, expect, it } from "vitest";
import { replayArchive } from "@/core/archive/replay";
import type { ArchiveMeta } from "@/core/archive/types";
import type { ShieldUsedUp } from "@/core/engine/engine";
import type { PlayerCast, SkillUse } from "@/core/replay/detail";
import { buildPartySkills, partySkillsAt, type PartySkillsPlayer } from "@/core/replay/partySkills";
import { playerSpans, timelinePlayers, type StatusSpan } from "@/core/replay/timeline";
import { loadFixture } from "./helpers/fixture";

const T = 1_000_000;
const at = (sec: number) => T + sec * 1000;
const PLD: PartySkillsPlayer = { id: "10000001", name: "MT", job: 19, level: 100, inParty: true };
const WAR: PartySkillsPlayer = { id: "10000002", name: "ST", job: 21, level: 100, inParty: true };
const WHM: PartySkillsPlayer = { id: "10000003", name: "H1", job: 24, level: 100, inParty: true };
const SCH: PartySkillsPlayer = { id: "10000004", name: "H2", job: 28, level: 100, inParty: true };
const PCT: PartySkillsPlayer = { id: "10000005", name: "D4", job: 42, level: 100, inParty: true };

const use = (sec: number, p: PartySkillsPlayer, id: number): SkillUse => ({ time: at(sec), caster: { id: p.id, name: p.name }, action: { id, name: String(id) } });
const span = (from: number, to: number, p: PartySkillsPlayer, status: number, cast?: { id: number; byPet?: boolean }): StatusSpan => ({
  key: `${p.id}|${status}|${from}`,
  status: { id: status, name: String(status) },
  category: "mitigation",
  caster: { id: p.id, name: p.name },
  start: at(from),
  end: at(to),
  targets: [],
  stacks: 0,
  lane: 0,
  ...(cast ? { cast: { action: { id: cast.id, name: String(cast.id) }, byPet: cast.byPet ?? false } } : {}),
});

const cast = (sec: number, p: PartySkillsPlayer, id: number, applied: number[]): PlayerCast => ({ time: at(sec), caster: { id: p.id, name: p.name }, action: { id, name: String(id) }, applied, sequence: String(sec) });
/** A shield on `p` from `from` that hits used up. */
const usedUp = (sec: number, p: PartySkillsPlayer, statusId: number, from = p): ShieldUsedUp => ({ time: at(sec), targetId: p.id, statusId, sourceId: from.id });

function model(players: PartySkillsPlayer[], uses: SkillUse[], spans: StatusSpan[] = [], resets: number[] = [], casts: PlayerCast[] = [], shieldsUsedUp: ShieldUsedUp[] = []) {
  return buildPartySkills({ players, detail: { skillUses: uses, timerResets: resets, playerCasts: casts, shieldsUsedUp }, spans });
}
const stateOf = (m: ReturnType<typeof model>, sec: number, p: PartySkillsPlayer, name: string) =>
  partySkillsAt(m, at(sec))
    .find((x) => x.player.id === p.id)!
    .skills.find((s) => s.skill.name === name)!;

describe("party mitigation skills at a moment", () => {
  it("everything is ready until used; a use puts it on cooldown for its recast", () => {
    const m = model([PLD], [use(10, PLD, 7531)]);
    expect(stateOf(m, 5, PLD, "铁壁").state).toBe("ready");
    expect(stateOf(m, 40, PLD, "铁壁")).toMatchObject({ state: "cooldown", charges: 0, recharge: { from: at(10), at: at(100) } });
    expect(stateOf(m, 100, PLD, "铁壁").state).toBe("ready");
    expect(stateOf(m, 40, PLD, "雪仇").state).toBe("ready");
  });

  it("in effect while a span of its cast runs, with how long it has left", () => {
    const m = model([PLD], [use(10, PLD, 7531)], [span(10, 30, PLD, 1191, { id: 7531 })]);
    expect(stateOf(m, 20, PLD, "铁壁")).toMatchObject({ state: "active", activeUntil: at(30) });
    expect(stateOf(m, 30, PLD, "铁壁").state).toBe("cooldown");
  });

  it("charges: each use spends one, they come back one recast apart", () => {
    const m = model([WHM], [use(10, WHM, 7432), use(15, WHM, 7432)]);
    expect(stateOf(m, 20, WHM, "神祝祷")).toMatchObject({ state: "cooldown", charges: 0, recharge: { from: at(10), at: at(40) } });
    expect(stateOf(m, 41, WHM, "神祝祷")).toMatchObject({ state: "ready", charges: 1, recharge: { from: at(40), at: at(70) } });
    expect(stateOf(m, 71, WHM, "神祝祷")).toMatchObject({ state: "ready", charges: 2 });
    expect(stateOf(m, 71, WHM, "神祝祷").recharge).toBeUndefined();
  });

  it("a use when none was left restarts the recovery (the earlier one came before the archive)", () => {
    const m = model([PLD], [use(10, PLD, 7531), use(50, PLD, 7531)]);
    expect(stateOf(m, 120, PLD, "铁壁")).toMatchObject({ state: "cooldown", recharge: { from: at(50), at: at(140) } });
  });

  it("a shared recast group: using one puts the other on cooldown too", () => {
    const m = model([WAR], [use(10, WAR, 16464)]); // 原初的勇猛
    expect(stateOf(m, 20, WAR, "原初的血气")).toMatchObject({ state: "cooldown", recharge: { at: at(35) } });
  });

  it("a wipe or zone change makes every recast ready again", () => {
    const m = model([PLD], [use(10, PLD, 7531)], [], [at(50)]);
    expect(stateOf(m, 40, PLD, "铁壁").state).toBe("cooldown");
    expect(stateOf(m, 60, PLD, "铁壁").state).toBe("ready");
  });

  it("a pet's cast is the command just before it: the fairy's 异想的幻光 after the scholar's", () => {
    const m = model([SCH], [use(10, SCH, 16538), use(10.5, SCH, 188)], [span(11, 31, SCH, 317, { id: 805, byPet: true })]);
    expect(stateOf(m, 20, SCH, "异想的幻光").state).toBe("active");
    expect(stateOf(m, 20, SCH, "野战治疗阵").state).toBe("cooldown");
  });

  it("the player's own cast of another action is no skill's (鼓舞激励之策's shield is not 展开战术's)", () => {
    const m = model([SCH], [use(10, SCH, 3585)], [span(10.5, 40, SCH, 297, { id: 185 })]);
    expect(stateOf(m, 20, SCH, "展开战术").state).toBe("cooldown");
  });

  it("an upgrade's tiers are one skill: the learnt tier's icon, either tier's use", () => {
    const m = model([PLD], [use(10, PLD, 17)]);
    const s = stateOf(m, 20, PLD, "极致防御");
    expect(s.state).toBe("cooldown");
  });
});

describe("a recast cut short when a shield of it breaks (坦培拉涂层's tooltip, docs/DESIGN.md 8.2)", () => {
  const COAT = 34685;
  const GRASSA = 34686;

  it("its own shield broken: 60 s off", () => {
    const m = model([PCT], [use(10, PCT, COAT)], [], [], [cast(10, PCT, COAT, [3686])], [usedUp(13, PCT, 3686)]);
    expect(stateOf(m, 60, PCT, "坦培拉涂层")).toMatchObject({ state: "cooldown", recharge: { at: at(70) } });
    expect(stateOf(m, 70, PCT, "坦培拉涂层").state).toBe("ready");
  });

  it("lifted by 油性坦培拉涂层 putting its own on: nothing off; the painter's own 油性 broken: 30 s off", () => {
    const casts = [cast(10, PCT, COAT, [3686]), cast(13, PCT, GRASSA, [3687])];
    const m = model([PCT], [use(10, PCT, COAT)], [], [], casts, [usedUp(13, PCT, 3686), usedUp(14, PCT, 3687)]);
    expect(stateOf(m, 60, PCT, "坦培拉涂层")).toMatchObject({ state: "cooldown", recharge: { at: at(100) } });
  });

  it("油性坦培拉涂层 pressed but putting nothing on (坦培拉涂层 broke just before): 60 s off", () => {
    const m = model([PCT], [use(10, PCT, COAT)], [], [], [cast(10, PCT, COAT, [3686])], [usedUp(13, PCT, 3686)]);
    expect(stateOf(m, 75, PCT, "坦培拉涂层").state).toBe("ready");
  });

  it("only the painter's own shield, and nothing for a skill that is ready", () => {
    const casts = [cast(10, PCT, COAT, [3686]), cast(13, PCT, GRASSA, [3687])];
    const m = model([PCT, WHM], [use(10, PCT, COAT)], [], [], casts, [usedUp(13, PCT, 3686), usedUp(14, WHM, 3687, PCT)]);
    expect(stateOf(m, 60, PCT, "坦培拉涂层")).toMatchObject({ state: "cooldown", recharge: { at: at(130) } });
    const ready = model([PCT], [], [], [], [cast(10, PCT, COAT, [3686])], [usedUp(13, PCT, 3686)]);
    expect(stateOf(ready, 15, PCT, "坦培拉涂层")).toMatchObject({ state: "ready", charges: 1 });
  });
});

describe("坦培拉涂层 in a real pull (hunt fixture)", () => {
  const lines = loadFixture("hunt-8p.log.gz");
  const meta = { version: 1, id: "e0", zoneId: 0, zoneName: "", start: 0, result: "unknown", party: [], combatants: [], summary: { durationMs: 0, deaths: 0, rows: 0 }, chunkCount: 0, bytes: 0, pinned: false } as ArchiveMeta;
  const replay = replayArchive(meta, lines);
  const encounter = replay.engine.encounters.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  const players = timelinePlayers(encounter.rows, replay.engine.party.list()).map((p) => ({ ...p, level: 0 }));
  const m = buildPartySkills({ players, detail: replay.detail, spans: playerSpans(replay.detail, new Set(players.map((p) => p.id)), encounter.end!) });
  const pct = players.find((p) => p.name === "P2")!;
  const coat = (iso: string) => partySkillsAt(m, Date.parse(iso)).find((x) => x.player.id === pct.id)!.skills.find((s) => s.skill.name === "坦培拉涂层")!;

  it("used at 00:27:12, its 油性 broken at 00:27:16 (30 s off): ready from 00:28:42, used again at 00:28:58", () => {
    const own = replay.detail.shieldsUsedUp.filter((x) => x.targetId === pct.id && x.sourceId === pct.id);
    expect(own.map((x) => [x.statusId, new Date(x.time).toISOString()])).toContainEqual([3687, "2026-09-19T16:27:16.869Z"]);
    expect(coat("2026-09-20T00:28:40+08:00")).toMatchObject({ state: "cooldown", recharge: { at: Date.parse("2026-09-20T00:28:42.818+08:00") } });
    expect(coat("2026-09-20T00:28:50+08:00").state).toBe("ready");
  });
});

describe("a real pull (24-player fixture)", () => {
  const lines = loadFixture("alliance-24p.log.gz");
  const meta = { version: 1, id: "e0", zoneId: 0, zoneName: "", start: 0, result: "unknown", party: [], combatants: [], summary: { durationMs: 0, deaths: 0, rows: 0 }, chunkCount: 0, bytes: 0, pinned: false } as ArchiveMeta;
  const replay = replayArchive(meta, lines);
  const encounter = replay.engine.encounters.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  const players = timelinePlayers(encounter.rows, replay.engine.party.list()).map((p) => ({ ...p, level: 0 }));
  const m = buildPartySkills({ players, detail: replay.detail, spans: playerSpans(replay.detail, new Set(players.map((p) => p.id)), encounter.end!) });
  const sch = players.find((p) => p.name === "P13")!;
  const fey = Date.parse("2026-09-20T20:10:20.189+08:00");

  it("takes the scholar's command once, not the fairy's line", () => {
    const uses = replay.detail.skillUses.filter((u) => u.caster.id === sch.id);
    expect(uses.filter((u) => u.action.name === "异想的幻光").map((u) => u.time)).toEqual([fey]);
    expect(replay.detail.skillUses.every((u) => u.caster.id.startsWith("10"))).toBe(true);
  });

  it("an AOE's lines are one use (野战治疗阵 twice, each a 22 line per target)", () => {
    expect(replay.detail.skillUses.filter((u) => u.caster.id === sch.id && u.action.name === "野战治疗阵")).toHaveLength(2);
  });

  it("the fairy's 异想的幻光 puts the scholar's skill in effect, then it waits out its recast", () => {
    const at = (ms: number) => partySkillsAt(m, ms).find((x) => x.player.id === sch.id)!.skills.find((s) => s.skill.name === "异想的幻光")!;
    expect(at(fey - 1000).state).toBe("ready");
    expect(at(fey + 5000).state).toBe("active");
    expect(at(fey + 60000)).toMatchObject({ state: "cooldown", recharge: { at: fey + 120000 } });
  });
});
