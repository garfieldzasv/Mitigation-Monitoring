import { beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "@/core/engine/engine";
import { compileScope } from "@/core/party/partyState";
import type { DamageRow, DeathRow, Encounter } from "@/core/engine/types";
import { loadFixture, runFixture } from "./helpers/fixture";

/**
 * Whole-encounter checks against real (anonymized) logs. Where a count is asserted, it is computed
 * independently from the raw lines, not taken from the engine.
 */

const DAMAGE_TYPES = new Set([0x01, 0x03, 0x05, 0x06]);
const isEmptyOwner = (s: string | undefined) => !s || /^0+$/.test(s);

/** 21/22 lines that should become rows: player target, damage effect, non-player non-pet source. */
function expectedHitLines(lines: readonly (readonly string[])[], from: number, to: number): number {
  const pets = new Set<string>();
  let count = 0;
  for (const l of lines) {
    if (l[0] === "01") pets.clear();
    if (l[0] === "03" && l[6]?.startsWith("10")) pets.add(l[2]!);
    if (l[0] !== "21" && l[0] !== "22") continue;
    const t = Date.parse(l[1]!);
    if (t < from || t > to) continue;
    if (!l[6]!.startsWith("10") || l[2]!.startsWith("10") || pets.has(l[2]!) || !isEmptyOwner(l[47])) continue;
    let damage = false;
    for (let i = 8; i < 24; i += 2) if (DAMAGE_TYPES.has(Number.parseInt(l[i]!, 16) & 0xff)) damage = true;
    if (damage) count++;
  }
  return count;
}

function expectedDotLines(lines: readonly (readonly string[])[], from: number, to: number): number {
  return lines.filter((l) => {
    const t = Date.parse(l[1]!);
    return l[0] === "24" && l[4] === "DoT" && l[2]!.startsWith("10") && t >= from && t <= to;
  }).length;
}

const damageRows = (e: Encounter) => e.rows.filter((r): r is DamageRow => r.kind !== "death");
const deathRows = (e: Encounter) => e.rows.filter((r): r is DeathRow => r.kind === "death");
const share = (part: number, whole: number) => (whole === 0 ? 1 : part / whole);

describe("8-player hunt (护锁刃龙狩猎战, 426 s, 7 deaths)", () => {
  let lines: string[][];
  let engine: Engine;
  let enc: Encounter;
  let elapsedMs: number;

  beforeAll(() => {
    lines = loadFixture("hunt-8p.log.gz");
    const t0 = performance.now();
    engine = runFixture(lines);
    elapsedMs = performance.now() - t0;
    enc = engine.encounters[0]!;
  });

  it("is one cleared encounter in the right zone", () => {
    expect(engine.encounters).toHaveLength(1);
    expect(enc.zoneName).toBe("护锁刃龙狩猎战");
    expect(enc.result).toBe("clear");
    // From the first damage to the victory command (Triggevent ends the encounter there; combat's end comes later).
    expect(Math.round((enc.end! - enc.start) / 1000)).toBe(421);
  });

  it("records every damage-taken line once, and every enemy DoT tick", () => {
    const hits = damageRows(enc).filter((r) => r.kind === "hit");
    const dots = damageRows(enc).filter((r) => r.kind === "dot");
    expect(hits.length).toBe(expectedHitLines(lines, enc.start, enc.end!));
    expect(dots.length).toBe(expectedDotLines(lines, enc.start, enc.end!));
    expect(hits.length).toBeGreaterThan(100);
  });

  it("never records damage from players or their pets", () => {
    const pets = new Set(lines.filter((l) => l[0] === "03" && l[6]?.startsWith("10")).map((l) => l[2]));
    for (const r of damageRows(enc)) {
      expect(r.target.id.startsWith("10")).toBe(true);
      expect(r.source.id.startsWith("10")).toBe(false);
      expect(pets.has(r.source.id)).toBe(false);
    }
  });

  it("an AOE on the whole party makes one row per player, all with the same sequence", () => {
    const bySeq = new Map<string, DamageRow[]>();
    for (const r of damageRows(enc)) if (r.seq) bySeq.set(r.seq, [...(bySeq.get(r.seq) ?? []), r]);
    const raidwides = [...bySeq.values()].filter((g) => g.length === 8);
    expect(raidwides.length).toBeGreaterThan(5);
    for (const g of raidwides) expect(new Set(g.map((r) => r.target.id)).size).toBe(8);
    for (const g of bySeq.values()) expect(g.length).toBeLessThanOrEqual(g[0]!.targetCount!);
  });

  it("names the boss's unnamed auto-attacks (unknown_a94d in the log) 攻击", () => {
    const autos = damageRows(enc).filter((r) => r.autoAttack);
    expect(autos.length).toBeGreaterThan(10);
    expect(autos.every((r) => r.action.name === "攻击")).toBe(true);
    expect(damageRows(enc).some((r) => r.action.name === "unknown_a94d")).toBe(false);
  });

  it("knows every target's job (party from the 11 line, jobs from 03 lines)", () => {
    expect(damageRows(enc).every((r) => r.target.job > 0)).toBe(true);
  });

  it("fills HP-after from the 37 line for nearly every hit", () => {
    const hits = damageRows(enc).filter((r) => r.kind === "hit" && r.result !== "miss");
    expect(share(hits.filter((r) => r.hpAfter !== undefined).length, hits.length)).toBeGreaterThan(0.9);
  });

  it("damage is what reached HP: with a shield up, HP drops by exactly the damage", () => {
    const shielded = damageRows(enc).filter((r) => r.kind === "hit" && r.amount > 0 && (r.shieldAbsorbed ?? 0) > 0 && r.hpAfter !== undefined);
    expect(shielded.length).toBeGreaterThan(20);
    const exact = shielded.filter((r) => r.hpBefore - r.hpAfter! === r.amount);
    expect(share(exact.length, shielded.length)).toBeGreaterThan(0.8);
  });

  it("0-damage hits under a shield are fully absorbed and leave HP unchanged", () => {
    const absorbed = damageRows(enc).filter((r) => r.kind === "hit" && r.fullyAbsorbed);
    expect(absorbed.length).toBeGreaterThan(10);
    expect(absorbed.every((r) => r.amount === 0)).toBe(true);
    const withAfter = absorbed.filter((r) => r.hpAfter !== undefined);
    expect(share(withAfter.filter((r) => r.hpAfter === r.hpBefore).length, withAfter.length)).toBeGreaterThan(0.9);
  });

  it("every player death gets a row; most find their killing blow", () => {
    const deaths = deathRows(enc);
    const deathLines = lines.filter((l) => l[0] === "25" && l[2]!.startsWith("10"));
    expect(deaths).toHaveLength(deathLines.length);
    expect(enc.deaths).toBe(deathLines.length);
    const attributed = deaths.filter((d) => d.killerRowId !== undefined);
    expect(attributed.length).toBeGreaterThanOrEqual(6);
    for (const d of attributed) {
      const blow = enc.rows.find((r) => r.id === d.killerRowId) as DamageRow;
      expect(blow.fatal).toBe(true);
      expect(blow.target.id).toBe(d.target.id);
      expect(d.time - blow.time).toBeGreaterThanOrEqual(0);
      expect(d.time - blow.time).toBeLessThanOrEqual(6000);
    }
  });

  it("rows are numbered and in time order, starting at most 5 s before the pull", () => {
    enc.rows.forEach((r, i) => {
      expect(r.id).toBe(i + 1);
      if (i > 0) expect(r.time).toBeGreaterThanOrEqual(enc.rows[i - 1]!.time);
    });
    expect(enc.rows[0]!.offset).toBeGreaterThanOrEqual(-5000);
  });

  it("hits from the boss's helper actors carry the Reprisal on the boss, marked inherited", () => {
    const covered = damageRows(enc).filter((r) => r.sourceStatuses.some((s) => s.id === 0x4a9));
    expect(covered.length).toBeGreaterThan(10);
    const viaHelpers = covered.filter((r) => r.sourceStatuses.find((s) => s.id === 0x4a9)!.inherited);
    expect(viaHelpers.length).toBeGreaterThan(covered.length / 2);
    for (const r of viaHelpers) expect(r.source.name).toBe("护锁刃龙");
  });

  it("shows the whole party (frozen at the end, though one member left right after), and runs quickly", () => {
    const party = new Set(lines.find((l) => l[0] === "11")!.slice(3, 11));
    expect(party.size).toBe(8);
    const visible = engine.visibility(enc);
    expect(damageRows(enc).every((r) => visible(r.target.id, r.target.name))).toBe(true);
    expect(damageRows(enc).every((r) => party.has(r.target.id))).toBe(true);
    console.log(`hunt-8p: ${lines.length} lines in ${elapsedMs.toFixed(0)} ms`);
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe("24-player alliance raid (水晶塔, 170 s)", () => {
  let engine: Engine;
  let enc: Encounter;

  beforeAll(() => {
    engine = runFixture(loadFixture("alliance-24p.log.gz"));
    enc = engine.encounters.at(-1)!;
  });

  it("records hits on all alliance members", () => {
    const targets = new Set(damageRows(enc).map((r) => r.target.id));
    expect(targets.size).toBeGreaterThan(8);
  });

  it("without CombatData, shows only the player's own party", () => {
    expect(enc.scope?.combatDataNames).toBeNull();
    expect(enc.scope?.partyIds).toHaveLength(8);
    const visible = engine.visibility(enc);
    const shown = new Set(damageRows(enc).filter((r) => visible(r.target.id, r.target.name)).map((r) => r.target.id));
    expect([...shown].every((id) => enc.scope!.partyIds.includes(id))).toBe(true);
    expect(shown.size).toBe(8);
  });

  it("with CombatData listing the whole alliance, shows everyone", () => {
    const names = [...new Set(damageRows(enc).map((r) => r.target.name))];
    const all = compileScope({ ...enc.scope!, combatDataNames: names });
    expect(damageRows(enc).every((r) => all(r.target.id, r.target.name))).toBe(true);
    expect(all("10FFFFFF", "Stranger")).toBe(false);
  });

  it("always shows the player and their party, even when CombatData leaves them out (open world)", () => {
    const selfId = engine.party.selfId!;
    const lonely = compileScope({ ...enc.scope!, combatDataNames: ["Limit Break"] });
    expect(lonely(selfId, "whatever ACT calls the player")).toBe(true);
    expect(enc.scope!.partyIds.every((id) => lonely(id, ""))).toBe(true);
    expect(lonely("10FFFFFF", "Stranger")).toBe(false);
  });

  it("CombatData names only add to the live scope within an encounter", () => {
    engine.setCombatDataNames(["A"]);
    engine.setCombatDataNames(["B"]);
    expect(engine.scope.includes("10000001", "A")).toBe(true);
    expect(engine.scope.includes("10000002", "B")).toBe(true);
  });
});
