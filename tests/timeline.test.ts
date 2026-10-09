import { describe, expect, it } from "vitest";
import { replayArchive } from "@/core/archive/replay";
import type { ArchiveMeta } from "@/core/archive/types";
import { derivePhases } from "@/core/engine/phases";
import type { DamageRow, Row } from "@/core/engine/types";
import type { NpcCast, PlayerCast, ReplayDetail, StatusChange } from "@/core/replay/detail";
import { buildTimeline, statusIntervals, timelinePlayers, type TimelinePlayer } from "@/core/replay/timeline";
import type { StatusCategory } from "@/core/status/statusTracker";
import { loadFixture } from "./helpers/fixture";

const T = 1_000_000;
const at = (sec: number) => T + sec * 1000;
const PLD = { id: "10000001", name: "MT", job: 19, inParty: true };
const SCH = { id: "10000002", name: "H1", job: 28, inParty: true };
const BRD = { id: "10000003", name: "D1", job: 23, inParty: true };
const BOSS = { id: "40000001", name: "Boss" };

function change(
  sec: number,
  kind: StatusChange["change"],
  target: { id: string; name: string },
  status: number,
  category: StatusCategory,
  source: StatusChange["source"],
  durationSec = 0,
  name = `s${status}`,
): StatusChange {
  return { time: at(sec), target, status: { id: status, name }, stacks: 0, source, change: kind, durationMs: durationSec * 1000, category };
}

const playerCast = (sec: number, caster: { id: string; name: string }, applied: number[]): PlayerCast => ({
  time: at(sec),
  caster: { id: caster.id, name: caster.name },
  action: { id: 1, name: "a" },
  applied,
  sequence: String(sec),
});

function fakeDetail(over: { status?: StatusChange[]; enemy?: StatusChange[]; casts?: NpcCast[]; playerCasts?: PlayerCast[] }): ReplayDetail {
  return {
    statusChanges: over.status ?? [],
    enemyStatusChanges: over.enemy ?? [],
    playerCasts: over.playerCasts ?? [],
    casts: over.casts ?? [],
    enemyCasts: () => over.casts ?? [],
    hpOf: () => [],
  } as unknown as ReplayDetail;
}

const build = (detail: ReplayDetail, rows: Row[] = [], players: TimelinePlayer[] = [PLD, SCH, BRD]) =>
  buildTimeline({ start: at(0), end: at(300), rows, detail, phases: [], players });

describe("status spans: one per cast", () => {
  it("a cast on several players is one span from the cast, as long as the action lasts, however soon they lose it", () => {
    // 摆脱: the 21 line applies it to everyone; one player's goes early, the span does not.
    const casts = [playerCast(10, PLD, [1457])];
    const status = [PLD, SCH, BRD].map((p, i) => change(10 + i * 0.1, "gain", p, 1457, "mitigation", PLD, 30));
    status.push(change(12, "lose", BRD, 1457, "mitigation", PLD));
    const [line] = build(fakeDetail({ status, playerCasts: casts })).casters[0]!.lines;
    expect(line!.spans.map((x) => [x.start, x.end, x.targets.length])).toEqual([[at(10), at(40), 3]]);
  });

  /**
   * 节制 as the logs have it: the line puts 1872 (20 s) on the healer; with its 37 line 0.6 s later the healer and the
   * party gain the permanent 1873, re-sent every 3 s; a player walks in later.
   */
  const aura = (ids: number[], onCaster: [number, number, string][] = [[1872, 20, "节制"]], more: { casts?: PlayerCast[]; status?: StatusChange[] } = {}) => {
    const casts = [{ ...playerCast(0, SCH, onCaster.map(([id]) => id)), synced: { time: at(0.6), ids } }, ...(more.casts ?? [])];
    const status = onCaster.map(([id, durationSec, name]) => change(0.6, "gain", SCH, id, "other", SCH, durationSec, name));
    for (const p of [SCH, PLD]) status.push(change(0.6, "gain", p, 1873, "mitigation", SCH, Infinity, "节制"));
    status.push(change(6.6, "gain", BRD, 1873, "mitigation", SCH, Infinity, "节制"));
    for (const p of [PLD, BRD, SCH]) status.push(change(17, "lose", p, 1873, "mitigation", SCH, 0, "节制"));
    status.push(...(more.status ?? []));
    return build(fakeDetail({ status, playerCasts: casts })).casters[1]!.lines[0]!.spans;
  };

  it("an aura's effect belongs to the cast whose own 37 line lists it; it lasts the cast's time on its caster, re-sends and walk-ins joining", () => {
    expect(aura([1872, 1873]).map((x) => [x.start, x.end, x.targets.length, x.lengthUnknown ?? false])).toEqual([[at(0), at(20), 3, false]]);
  });

  it("a status on the caster that some action needs to be used is not the cast's time (节制's 神爱抚预备 for 神爱抚)", () => {
    const spans = aura([1872, 1873, 3881], [[1872, 20, "节制"], [3881, 30, "神爱抚预备"]]);
    expect(spans.map((x) => [x.start, x.end])).toEqual([[at(0), at(20)]]);
  });

  it("names play no part: the caster's status may be called anything", () => {
    expect(aura([4000, 1873], [[4000, 15, "别的名字"]]).map((x) => [x.start, x.end])).toEqual([[at(0), at(15)]]);
  });

  it("two statuses on the caster that could be the cast's time: not guessed, the span is the cast alone", () => {
    const spans = aura([1872, 1873, 4000], [[1872, 20, "节制"], [4000, 20, "别的状态"]]);
    expect(spans.map((x) => [x.start, x.end, x.targets.length, x.lengthUnknown ?? false])).toEqual([[at(0), at(0), 3, true]]);
  });

  it("a status the caster already had, which another cast's 37 line lists too, was not brought by that cast", () => {
    // During 节制 the healer casts something else; its 37 lists the 1873 the healer has; a player steps out and back in.
    const spans = aura([1872, 1873], undefined, {
      casts: [{ ...playerCast(10, SCH, [5000]), synced: { time: at(10.6), ids: [5000, 1873] } }],
      status: [
        change(10.6, "gain", SCH, 5000, "other", SCH, 10, "别的技能"),
        change(9, "lose", PLD, 1873, "mitigation", SCH, 0, "节制"),
        change(10.8, "gain", PLD, 1873, "mitigation", SCH, Infinity, "节制"),
      ],
    });
    expect(spans.map((x) => [x.start, x.end, x.cast?.action.id])).toEqual([[at(0), at(20), 1]]);
  });

  it("an effect no cast's 37 line lists does not go to a cast nearby", () => {
    const spans = aura([1872]);
    expect(spans[0]).toMatchObject({ start: at(0.6), end: at(17) });
    expect(spans[0]!.cast).toBeUndefined();
  });

  it("a permanent status with no cast to go by lasts until it was lost, not to the end of the fight", () => {
    const status = [change(50, "gain", PLD, 299, "mitigation", SCH, Infinity, "野战治疗阵"), change(62, "lose", PLD, 299, "mitigation", SCH, 0, "野战治疗阵")];
    const spans = build(fakeDetail({ status })).casters[1]!.lines[0]!.spans;
    expect(spans.map((x) => [x.start, x.end])).toEqual([[at(50), at(62)]]);
  });

  it("a recast on the same target ends the running span there; casts on other targets at the same time take a second line", () => {
    const casts = [playerCast(0, PLD, [1997]), playerCast(10, PLD, [1997]), playerCast(50, SCH, [1218]), playerCast(52, SCH, [1218])];
    const status = [
      change(0, "gain", PLD, 1997, "shield", PLD, 30),
      change(10, "refresh", PLD, 1997, "shield", PLD, 30),
      change(50, "gain", PLD, 1218, "shield", SCH, 15),
      change(52, "gain", BRD, 1218, "shield", SCH, 15),
    ];
    const t = build(fakeDetail({ status, playerCasts: casts }));
    expect(t.casters[0]!.lines[0]!.spans.map((x) => [(x.start - T) / 1000, (x.end - T) / 1000, x.lane])).toEqual([
      [0, 10, 0],
      [10, 40, 0],
    ]);
    const line = t.casters[1]!.lines[0]!;
    expect(line.spans.map((x) => [(x.start - T) / 1000, (x.end - T) / 1000, x.lane])).toEqual([
      [50, 65, 0],
      [52, 67, 1],
    ]);
    expect(line.lanes).toBe(2);
  });

  it("with no cast to go by (it began before the archive), from the gain for its duration", () => {
    const t = build(fakeDetail({ status: [change(5, "gain", PLD, 1191, "mitigation", PLD, 10)] }));
    expect(t.casters[0]!.lines[0]!.spans.map((x) => [x.start, x.end])).toEqual([[at(5), at(15)]]);
  });

  it("a pet's cast belongs to its owner; a debuff on an enemy starts at the cast, before the 26 line", () => {
    const fairy = { id: "40001000", name: "炽天使", ownerId: SCH.id };
    const t = build(
      fakeDetail({
        status: [change(5, "gain", BRD, 1917, "mitigation", fairy, 20)],
        enemy: [change(8, "gain", BOSS, 1193, "damageDown", PLD, 15)],
        playerCasts: [playerCast(4.8, SCH, [1917]), playerCast(7.4, PLD, [1193])],
      }),
    );
    expect(t.casters[1]!.lines[0]!.spans.map((x) => [x.start, x.end])).toEqual([[at(4.8), at(24.8)]]);
    expect(t.casters[0]!.lines[0]).toMatchObject({ category: "damageDown", spans: [{ start: at(7.4), end: at(22.4), targets: [BOSS] }] });
  });

  it("a debuff on a boss and its same-name helpers is on one target", () => {
    const enemies = [BOSS, { id: "40000002", name: "Boss" }, { id: "40000003", name: "Boss" }, { id: "40000009", name: "Add" }];
    const t = build(fakeDetail({ enemy: enemies.map((e) => change(8, "gain", e, 1193, "damageDown", PLD, 15)), playerCasts: [playerCast(7.4, PLD, [1193])] }));
    expect(t.casters[0]!.lines[0]!.spans[0]!.targets.map((x) => x.name)).toEqual(["Boss", "Add"]);
  });

  it("a cast that did not take shows on the caster's line; vulnerabilities go to the player hit, not to a caster", () => {
    const status = [
      change(0, "gain", BRD, 297, "shield", SCH, 30),
      change(5, "unapplied", BRD, 297, "shield", SCH, 25),
      change(6, "gain", BRD, 638, "vulnerability", BOSS, 10),
      change(7, "gain", BRD, 49, "other", SCH, 15),
    ];
    const t = build(fakeDetail({ status }));
    expect(t.casters[1]!.lines).toHaveLength(1);
    expect(t.casters[1]!.lines[0]!.unapplied.map((u) => u.time)).toEqual([at(5)]);
    expect(t.members[2]!.vulnerabilities.map((v) => [v.start, v.end])).toEqual([[at(6), at(16)]]);
    expect(t.casters.flatMap((c) => c.lines).some((l) => l.category === "vulnerability" || l.category === "other")).toBe(false);
  });

  it("a cast that took on some and not on others is one span naming those it did not take on, with no mark of its own", () => {
    const casts = [playerCast(10, SCH, [297])];
    const status = [change(10.1, "gain", PLD, 297, "shield", SCH, 30), change(10, "unapplied", BRD, 297, "shield", SCH, 25), change(10, "unapplied", SCH, 297, "shield", SCH, 20)];
    const [line] = build(fakeDetail({ status, playerCasts: casts })).casters[1]!.lines;
    expect(line!.spans.map((s) => [s.start, s.targets.map((t) => t.name), (s.refused ?? []).map((t) => t.name)])).toEqual([[at(10), ["MT"], ["D1", "H1"]]]);
    expect(line!.unapplied).toEqual([]);
  });

  it("intervals (vulnerabilities, enemies' own buffs) pair per target, status and source; still on at the end, it ends with the encounter", () => {
    const i = statusIntervals([change(0, "gain", PLD, 1, "invuln", PLD, Infinity), change(1, "gain", SCH, 1, "invuln", PLD, Infinity), change(4, "lose", SCH, 1, "invuln", PLD)], at(60));
    expect(i.map((x) => [x.target.id, (x.end - T) / 1000])).toEqual([
      [PLD.id, 60],
      [SCH.id, 4],
    ]);
  });
});

describe("casts and damage", () => {
  const cast = (sec: number, action: string, source = "Boss", castSec = 3, id = "40000001"): NpcCast => ({
    time: at(sec),
    source: { id, name: source },
    action: { id: action.length, name: action },
    target: { id, name: source },
    castMs: castSec * 1000,
  });

  it("same-name enemies casting the same thing together are one bar; overlapping bars take separate lines; unnamed casts have no bar", () => {
    const t = build(fakeDetail({ casts: [cast(10, "陨石雨", "分身", 5, "40000002"), cast(10.5, "陨石雨", "分身", 5, "40000003"), cast(12, "凝视"), cast(14, "unknown_b476", "Boss", 40), cast(20, "圣光")] }));
    expect(t.casts.map((c) => [c.action, c.count, c.line])).toEqual([
      ["陨石雨", 2, 0],
      ["凝视", 1, 1],
      ["圣光", 1, 0],
    ]);
    expect(t.castLines).toBe(2);
  });

  const hit = (id: number, sec: number, seq: string, amount: number, multiplier: number | null, over: Partial<DamageRow> = {}): DamageRow =>
    ({
      kind: "hit",
      id,
      time: at(sec),
      offset: sec * 1000,
      seq,
      target: { id: `1000000${id}`, name: `P${id}`, job: 19 },
      source: { id: BOSS.id, name: BOSS.name },
      action: { id: 1, name: "a" },
      amount,
      multiplier,
      autoAttack: false,
      fatal: false,
      ...over,
    }) as unknown as DamageRow;

  it("one bar per cast, auto-attacks in a list of their own, DoT ticks left out; mitigation averaged, the hardest hit kept", () => {
    const rows = [
      hit(1, 10, "A", 30000, 0.8),
      hit(2, 10, "A", 50000, 0.6, { fatal: true }),
      hit(3, 12, "B", 9000, 1, { autoAttack: true }),
      hit(4, 14, "", 1000, null, { kind: "dot" }),
    ];
    const t = build(fakeDetail({}), rows);
    expect(t.damage).toHaveLength(1);
    expect(t.damage[0]).toMatchObject({ key: "A", total: 80000, deaths: 1 });
    expect(t.damage[0]!.avgMitigation).toBeCloseTo(0.3, 5);
    expect(t.damage[0]!.biggest.id).toBe(2);
    expect(t.autoAttacks.map((d) => d.key)).toEqual(["B"]);
  });
});

describe("players", () => {
  it("tanks, healers, then DPS, in party order within each; the rows' players beyond the party too", () => {
    const party = [
      { ...BRD, level: 100 },
      { ...SCH, level: 100 },
      { ...PLD, level: 100 },
    ];
    const other = { kind: "death", target: { id: "10000009", name: "Other", job: 24 } } as unknown as Row;
    expect(timelinePlayers([other], party).map((p) => [p.name, p.inParty])).toEqual([
      ["MT", true],
      ["H1", true],
      ["Other", false],
      ["D1", true],
    ]);
  });

  it("a party member known by ID only (an 11 line before their 03 line) takes name and job from their rows", () => {
    const party = [{ id: PLD.id, name: "", job: 0, level: 100, inParty: true }, { ...SCH, level: 100 }];
    const hit = { kind: "hit", target: { id: PLD.id, name: "MT", job: 19 } } as unknown as Row;
    expect(timelinePlayers([hit], party).map((p) => [p.name, p.job, p.inParty])).toEqual([
      ["MT", 19, true],
      ["H1", 28, true],
    ]);
  });
});

describe("a real pull", () => {
  const lines = loadFixture("hunt-8p.log.gz");
  const meta = { version: 1, id: "e0", zoneId: 0, zoneName: "", start: 0, result: "unknown", party: [], combatants: [], summary: { durationMs: 0, deaths: 0, rows: 0 }, chunkCount: 0, bytes: 0, pinned: false } as ArchiveMeta;
  const replay = replayArchive(meta, lines);
  const encounter = replay.engine.encounters.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  const visible = replay.engine.visibility(encounter);
  const rows = encounter.rows.filter((r) => visible(r.target.id, r.target.name));
  const players = timelinePlayers(rows, []);
  const t = buildTimeline({ start: encounter.start, end: encounter.end!, rows, detail: replay.detail, phases: derivePhases(encounter, encounter.end!), players });

  it("has every shown player, and each cast that hit someone (auto-attacks aside) once", () => {
    expect(players).toHaveLength(8);
    const seqs = new Set(rows.filter((r): r is DamageRow => r.kind === "hit" && !r.autoAttack && !!r.seq).map((r) => r.seq));
    expect(t.damage).toHaveLength(seqs.size);
    expect(t.damage.reduce((s, d) => s + d.rows.length, 0)).toBe(rows.filter((r) => r.kind === "hit" && !r.autoAttack && r.seq).length);
    expect(t.autoAttacks.length).toBe(rows.filter((r) => r.kind === "hit" && r.autoAttack && r.seq).length);
    expect(t.autoAttacks.length).toBeGreaterThan(0);
  });

  it("shows party mitigation once per cast with its targets, and debuffs on the boss", () => {
    const lines = t.casters.flatMap((c) => c.lines);
    const spans = lines.flatMap((l) => l.spans);
    expect(spans.length).toBeGreaterThan(20);
    expect(spans.every((s) => s.start <= s.end && s.end > t.from && s.start < t.to)).toBe(true);
    expect(spans.some((s) => s.targets.length >= 4 && (s.category === "mitigation" || s.category === "shield"))).toBe(true);
    expect(lines.some((l) => l.category === "damageDown" && l.spans.every((s) => s.targets.every((x) => x.id.startsWith("40"))))).toBe(true);
  });
});
