import { describe, expect, it } from "vitest";
import { replayArchive } from "@/core/archive/replay";
import type { ArchiveMeta } from "@/core/archive/types";
import { Engine } from "@/core/engine/engine";
import type { DamageRow, DeathRow, Row } from "@/core/engine/types";
import { findHealEffects, findUnappliedStatuses } from "@/core/logline/effect";
import type { GameEvent } from "@/core/logline/parse";
import { aoeGroups, missingMitigation, type AoeGroup } from "@/core/replay/aoe";
import { buildDeathReplay } from "@/core/replay/deathReplay";
import { ReplayDetail } from "@/core/replay/detail";
import { abilityStats, memberStats } from "@/core/replay/stats";
import type { StatusSnap } from "@/core/status/statusTracker";
import { loadFixture } from "./helpers/fixture";

/** An archive meta for a fixture: the fixture's own header plays the archive's role. */
const fixtureMeta = (over: Partial<ArchiveMeta> = {}): ArchiveMeta => ({
  version: 1,
  id: "e0",
  zoneId: 0,
  zoneName: "",
  start: 0,
  result: "unknown",
  party: [],
  combatants: [],
  summary: { durationMs: 0, deaths: 0, rows: 0 },
  chunkCount: 0,
  bytes: 0,
  pinned: false,
  ...over,
});

/** A fixture replayed the way the review window does it. */
function replayFixture(name: string) {
  const lines = loadFixture(name);
  const replay = replayArchive(fixtureMeta(), lines);
  // No real start to match: take the longest encounter (the alliance fixture opens with a 6 s blip).
  const encounter = replay.engine.encounters.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  const visible = replay.engine.visibility(encounter);
  const rows = encounter.rows.filter((r) => visible(r.target.id, r.target.name));
  return { lines, ...replay, encounter, rows };
}

const hunt = replayFixture("hunt-8p.log.gz");

describe("replayArchive", () => {
  it("finds the archived encounter by its start, and nothing else", () => {
    const lines = loadFixture("hunt-8p.log.gz");
    expect(replayArchive(fixtureMeta({ start: hunt.encounter.start }), lines).encounter?.rows).toHaveLength(hunt.encounter.rows.length);
    expect(replayArchive(fixtureMeta({ start: 1 }), lines).encounter).toBeUndefined();
  });

  it("takes the zone from the archive when the lines have no 01 (an overlay opened mid-session)", () => {
    const lines = loadFixture("hunt-8p.log.gz").filter((l) => l[0] !== "01");
    const r = replayArchive(fixtureMeta({ start: hunt.encounter.start, zoneId: 0x514, zoneName: "护锁刃龙狩猎战" }), lines);
    expect(r.encounter).toMatchObject({ zoneId: 0x514, zoneName: "护锁刃龙狩猎战" });
  });
});

describe("replay detail rules", () => {
  const P = "10000001";
  function feed(events: GameEvent[]): ReplayDetail {
    const engine = new Engine();
    const detail = new ReplayDetail(engine);
    for (const e of events) {
      detail.handle(e);
      engine.handle(e);
    }
    return detail;
  }

  const shield = (time: number, duration: number, stacks = 0): GameEvent => ({
    type: "gainEffect",
    time,
    effectId: 0xa31,
    effectName: "均衡预后",
    duration,
    sourceId: "10000002",
    sourceName: "H",
    targetId: P,
    targetName: "P",
    stacks,
  });

  it("a 26 line is a refresh only when it extends the duration; one carrying the time left changes nothing", () => {
    // 30 s at 0; re-sent at 10 s with the 20 s left (the shield absorbing damage); recast at 15 s, a full 30 s again.
    const changes = feed([shield(0, 30), shield(10000, 20), shield(15000, 30)]).statusChanges;
    expect(changes.map((c) => [c.time, c.change])).toEqual([
      [0, "gain"],
      [15000, "refresh"],
    ]);
  });

  it("a cast whose shield did not take (effect 0x14) is shown, with what the existing one has left", () => {
    const recast: GameEvent = {
      type: "ability",
      time: 2500,
      sourceId: "10000002",
      sourceName: "H",
      actionId: 0x5ee4,
      actionName: "均衡预后",
      targetId: P,
      targetName: "P",
      targetHp: 100,
      targetMaxHp: 100,
      sourceHp: 100,
      sourceMaxHp: 100,
      sequence: "1",
      targetIndex: 0,
      targetCount: 1,
      unapplied: [{ statusId: 0xa31, onSource: false }],
    };
    const [gain, unapplied] = feed([shield(0, 30), recast]).statusChanges;
    expect(gain?.change).toBe("gain");
    expect(unapplied).toMatchObject({ change: "unapplied", status: { id: 0xa31, name: "均衡预后" }, source: { name: "H" }, durationMs: 27500 });
  });

  it("a status applied again is a refresh while it is on (no 30 line yet, however long ago it ran out), a gain after its 30 line; outside the party, a gain once its time is up", () => {
    const gain = (time: number): GameEvent => ({
      type: "gainEffect",
      time,
      effectId: 0x4c,
      effectName: "鼓舞",
      duration: 5,
      sourceId: "10000002",
      sourceName: "H",
      targetId: P,
      targetName: "P",
      stacks: 0,
    });
    const inParty: GameEvent = { type: "primaryPlayer", time: 0, id: P, name: "P" };
    expect(feed([inParty, gain(0), gain(2000), gain(20000)]).statusChanges.map((c) => c.change)).toEqual(["gain", "refresh", "refresh"]);
    expect(feed([gain(0), gain(2000), gain(20000)]).statusChanges.map((c) => c.change)).toEqual(["gain", "refresh", "gain"]);
    const lose: GameEvent = { type: "loseEffect", time: 8000, effectId: 0x4c, effectName: "鼓舞", sourceId: "10000002", sourceName: "H", targetId: P, targetName: "P" };
    expect(feed([inParty, gain(0), lose, gain(20000)]).statusChanges.map((c) => c.change)).toEqual(["gain", "lose", "gain"]);
  });

  it("a cancel finds its cast past shorter casts started after it", () => {
    const cast = (time: number, actionId: number, castMs: number): GameEvent => ({
      type: "cast",
      time,
      sourceId: "40000001",
      sourceName: "Boss",
      actionId,
      actionName: `a${actionId}`,
      targetId: P,
      targetName: "P",
      castMs,
    });
    const detail = feed([cast(0, 1, 8000), cast(1000, 2, 0), { type: "cancel", time: 4000, sourceId: "40000001", actionId: 1, reason: "Interrupted" }]);
    expect(detail.casts.map((c) => c.cancelled)).toEqual(["Interrupted", undefined]);
  });
});

describe("unapplied statuses", () => {
  it("reads effect 0x14 as a status that did not take, not 0x0E (applied)", () => {
    // From a CN log: 均衡预后 cast twice 2.5 s apart; the second one did not overwrite.
    const line = (flags: string) => ["22", "t", "1", "a", "5EE4", "均衡预后", "10000001", "P", "4", "4120000", flags, "A310000", "1B", "5EE48000"];
    expect(findUnappliedStatuses(line("5C000014"))).toEqual([{ statusId: 0xa31, onSource: false }]);
    expect(findUnappliedStatuses(line("460E"))).toEqual([]);
  });
});

describe("heal effects", () => {
  const line = (flags: string, value: string) => ["21", "t", "1", "a", "1", "b", "1", "c", flags, value];

  it("splits heals between target and source by the value's 0x80 flag, big values included", () => {
    expect(findHealEffects(line("200004", "B6F40000"))).toEqual({ toTarget: 0xb6f4, toSource: 0 });
    expect(findHealEffects(line("104", "057A8000"))).toEqual({ toTarget: 0, toSource: 0x057a });
    expect(findHealEffects(line("200004", "1234C001"))).toEqual({ toTarget: 0, toSource: 0x011234 });
    expect(findHealEffects(line("750003", "1A2B0000"))).toBeUndefined();
  });
});

describe("replay detail of the hunt", () => {
  const { lines, detail, rows } = hunt;

  it("collects heals on players, HoT ticks counted straight from the raw lines", () => {
    const hotLines = lines.filter((l) => l[0] === "24" && l[4] === "HoT" && l[2]!.startsWith("10"));
    expect(detail.heals.filter((h) => h.kind === "hot")).toHaveLength(hotLines.length);
    const heals = detail.heals.filter((h) => h.kind === "heal");
    expect(heals.length).toBeGreaterThan(200);
    for (const h of detail.heals) {
      expect(h.target.id.startsWith("10")).toBe(true);
      expect(h.amount).toBeGreaterThan(0);
      expect(h.overheal).toBeGreaterThanOrEqual(0);
      expect(h.overheal).toBeLessThanOrEqual(h.amount);
    }
    // HoT sources are unreliable and left out.
    expect(detail.heals.filter((h) => h.kind === "hot").every((h) => h.source.id === "")).toBe(true);
  });

  it("collects non-player casts; enemy casts are those of whoever damaged a player", () => {
    const castLines = lines.filter((l) => l[0] === "20" && l[2]!.startsWith("40"));
    expect(detail.casts).toHaveLength(castLines.length);
    const hostile = new Set(rows.flatMap((r) => (r.kind === "death" ? [] : [r.source.name])));
    const enemy = detail.enemyCasts();
    expect(enemy.length).toBeGreaterThan(0);
    expect(enemy.every((c) => hostile.has(c.source.name))).toBe(true);
    expect(enemy.some((c) => c.source.name === "护锁刃龙" && c.castMs > 0)).toBe(true);
  });

  it("tracks status gains, refreshes, losses and casts that did not take, on players", () => {
    const changes = detail.statusChanges;
    expect(changes.every((c) => c.target.id.startsWith("10"))).toBe(true);
    // Every gain / refresh / stack change is a 26 line; re-sent lines that change nothing are left out.
    const gainLines = new Set(lines.filter((l) => l[0] === "26" && l[7]!.startsWith("10")).map((l) => `${Date.parse(l[1]!)}|${l[7]}|${parseInt(l[2]!, 16)}`));
    const fromLines = changes.filter((c) => c.change === "gain" || c.change === "refresh" || c.change === "stacks");
    expect(fromLines.every((c) => gainLines.has(`${c.time}|${c.target.id}|${c.status.id}`))).toBe(true);
    expect(fromLines.length).toBeLessThan(gainLines.size);
    expect(changes.filter((c) => c.change === "lose")).toHaveLength(lines.filter((l) => l[0] === "30" && l[7]!.startsWith("10")).length);
    // Casts whose status did not take: effect 0x14 on a player, counted straight from the lines.
    const noEffect = lines.filter((l) => (l[0] === "21" || l[0] === "22") && l[6]!.startsWith("10")).reduce((n, l) => {
      for (let i = 8; i <= 22; i += 2) if ((parseInt(l[i] ?? "", 16) & 0xff) === 0x14 && parseInt(l[i + 1] ?? "", 16) >>> 16 > 0) n++;
      return n;
    }, 0);
    expect(changes.filter((c) => c.change === "unapplied")).toHaveLength(noEffect);
    expect(noEffect).toBeGreaterThan(0);
    expect(changes.some((c) => c.change === "refresh")).toBe(true);
    expect(changes.some((c) => c.category === "mitigation" && c.change === "gain")).toBe(true);
  });

  it("collects players' casts that applied statuses, once per sequence, a pet's under its owner", () => {
    // Straight from the lines: 21/22 from a player with a 0x0E / 0x0F effect, one per sequence.
    const applying = (l: string[]) => [0, 1, 2, 3, 4, 5, 6, 7].some((k) => [0x0e, 0x0f].includes(parseInt(l[8 + k * 2] ?? "", 16) & 0xff) && parseInt(l[9 + k * 2] ?? "", 16) >>> 16 > 0);
    const playerSeqs = new Set(lines.filter((l) => (l[0] === "21" || l[0] === "22") && l[2]!.startsWith("10") && applying(l)).map((l) => `${l[2]}|${l[44]}`));
    const casts = detail.playerCasts;
    expect(casts.every((c) => c.caster.id.startsWith("10") && c.applied.length > 0)).toBe(true);
    expect(new Set(casts.map((c) => `${c.caster.id}|${c.sequence}`)).size).toBe(casts.length);
    const fromPlayers = casts.filter((c) => playerSeqs.has(`${c.caster.id}|${c.sequence}`));
    expect(fromPlayers).toHaveLength(playerSeqs.size);
    expect(casts.length).toBeGreaterThanOrEqual(playerSeqs.size); // pets' casts on top, under their owners
  });

  it("ends each dead player's HP curve at 0 at the death", () => {
    for (const d of rows.filter((r): r is DeathRow => r.kind === "death")) {
      const points = detail.hpOf(d.target.id).filter((p) => p.time <= d.time);
      expect(points.at(-1)).toMatchObject({ time: d.time, hp: 0, shieldPercent: 0 });
    }
  });
});

describe("death replay", () => {
  const { rows, detail } = hunt;
  const deaths = rows.filter((r): r is DeathRow => r.kind === "death");

  it("gathers the 15 s before each death, in time order, ending with the death", () => {
    expect(deaths).toHaveLength(7);
    for (const d of deaths) {
      const replay = buildDeathReplay(d, rows, detail);
      expect(replay.entries.at(-1)).toMatchObject({ kind: "death", row: d });
      expect(replay.entries.every((e, i, all) => i === 0 || all[i - 1]!.time <= e.time)).toBe(true);
      expect(replay.entries.every((e) => e.time >= d.time - 15000 && e.time <= d.time)).toBe(true);
      const hits = rows.filter((r): r is DamageRow => r.kind !== "death" && r.target.id === d.target.id && r.time >= d.time - 15000 && r.time <= d.time);
      expect(replay.totals.hits).toBe(hits.length);
      expect(replay.totals.damage).toBe(hits.reduce((s, r) => s + r.amount, 0));
      if (d.killerRowId !== undefined) {
        expect(replay.blow?.id).toBe(d.killerRowId);
        expect(replay.entries.some((e) => e.kind === "hit" && e.row.id === d.killerRowId)).toBe(true);
      }
      expect(replay.hp.length).toBeGreaterThan(0);
      expect(replay.hp[0]!.time).toBeGreaterThanOrEqual(replay.from);
      expect(replay.maxHp).toBeGreaterThan(0);
    }
  });

  it("merges a cast started together by a boss's same-name helpers into one entry", () => {
    for (const d of deaths) {
      const casts = buildDeathReplay(d, rows, detail).entries.filter((e) => e.kind === "cast");
      const keys = casts.map((e) => (e.kind === "cast" ? `${e.cast.action.id}:${e.cast.source.name}:${Math.round(e.time / 1000)}` : ""));
      expect(new Set(keys).size).toBe(keys.length);
    }
    const all = deaths.flatMap((d) => buildDeathReplay(d, rows, detail).entries);
    expect(all.some((e) => e.kind === "cast" && e.count > 1)).toBe(true);
  });

  it("a shorter window keeps fewer entries", () => {
    const d = deaths[0]!;
    expect(buildDeathReplay(d, rows, detail, 5000).entries.length).toBeLessThan(buildDeathReplay(d, rows, detail, 15000).entries.length);
  });
});

describe("AOE comparison", () => {
  it("groups hits of one cast that reached at least 4 players", () => {
    const groups = aoeGroups(hunt.rows);
    expect(groups.length).toBeGreaterThan(10);
    for (const g of groups) {
      expect(g.rows.length).toBeGreaterThanOrEqual(4);
      expect(new Set(g.rows.map((r) => r.seq))).toEqual(new Set([g.seq]));
      expect(g.min).toBeLessThanOrEqual(g.avg);
      expect(g.avg).toBeLessThanOrEqual(g.max);
    }
    expect(groups.every((g, i) => i === 0 || groups[i - 1]!.time <= g.time)).toBe(true);
  });

  it("in a 24-player duty, counts only the players shown", () => {
    const alliance = replayFixture("alliance-24p.log.gz");
    const shown = new Set(alliance.rows.map((r) => r.target.id)).size;
    const groups = aoeGroups(alliance.rows);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g.rows.length <= shown)).toBe(true);
  });

  it("flags a party mitigation most others had, never a personal one", () => {
    const status = (id: number, name: string): StatusSnap => ({
      id,
      name,
      stacks: 0,
      remainingMs: 5000,
      sourceId: "10000009",
      sourceName: "H",
      category: "mitigation",
    });
    const temperance = status(1873, "节制");
    const rampart = status(1191, "铁壁");
    const hit = (id: number, statuses: StatusSnap[]) => ({ id, targetStatuses: statuses }) as unknown as DamageRow;
    const group = { rows: [hit(1, [temperance, rampart]), hit(2, [temperance]), hit(3, [temperance]), hit(4, [])] } as AoeGroup;
    const missing = missingMitigation(group);
    expect(missing.get(4)).toEqual([{ id: 1873, name: "节制" }]);
    expect([...missing.keys()]).toEqual([4]);
  });
});

describe("statistics", () => {
  // One hit that did not take effect (the ledger decides those from the log; here, one for sure).
  const skipped = hunt.rows.find((r): r is DamageRow => r.kind !== "death" && r.amount > 0 && !r.fatal && !r.noEffect)!;
  const rows = hunt.rows.map((r): Row => (r === skipped ? { ...skipped, noEffect: true as const } : r));
  const damage = rows.filter((r): r is DamageRow => r.kind !== "death");

  it("per member and per ability add up to the table, without the hits that did not take effect", () => {
    const landed = damage.filter((r) => !r.noEffect);
    expect(landed.length).toBeLessThan(damage.length);
    const members = memberStats(rows);
    expect(members.reduce((s, m) => s + m.total, 0)).toBe(landed.reduce((s, r) => s + r.amount, 0));
    expect(members.reduce((s, m) => s + m.deaths, 0)).toBe(7);
    expect(members.every((m, i) => i === 0 || members[i - 1]!.total >= m.total)).toBe(true);
    const abilities = abilityStats(rows);
    expect(abilities.reduce((s, a) => s + a.hits, 0)).toBe(landed.length);
    expect(abilities.reduce((s, a) => s + a.fatal, 0)).toBe(damage.filter((r) => r.fatal).length);
  });
});
