import { describe, expect, it } from "vitest";
import { replayArchive } from "@/core/archive/replay";
import type { ArchiveMeta } from "@/core/archive/types";
import { displayActionName, isAutoAttack } from "@/core/game/actions";
import { buildTimeline, timelinePlayers } from "@/core/replay/timeline";
import { loadFixture } from "./helpers/fixture";

describe("auto-attacks: the game data's and cactbot's annotations", () => {
  it("an action the game data marks (ActionCategory 1), or one named 攻击", () => {
    expect(isAutoAttack(0x368, "")).toBe(true);
    expect(isAutoAttack(0x1, "攻击")).toBe(true);
  });

  it("one cactbot's timeline annotates (doomtrain: # B25E --sync--: Autoattack): shown as 攻击", () => {
    expect(isAutoAttack(0xb25e, "unknown_b25e")).toBe(true);
    expect(displayActionName(0xb25e, "unknown_b25e")).toBe("攻击");
  });

  it("an unnamed action nothing annotates is no auto-attack, however it is used", () => {
    expect(isAutoAttack(0x9868, "unknown_9868")).toBe(false);
    expect(displayActionName(0x9868, "unknown_9868")).toBe("unknown_9868");
  });
});

describe("in a real pull", () => {
  it("格莱杨拉波尔's B25E goes to the auto-attack lane, out of the party damage", () => {
    const meta = { version: 1, id: "e0", zoneId: 0, zoneName: "", start: 0, result: "unknown", party: [], combatants: [], summary: { durationMs: 0, deaths: 0, rows: 0 }, chunkCount: 0, bytes: 0, pinned: false } as ArchiveMeta;
    const replay = replayArchive(meta, loadFixture("trial-phases.log.gz"));
    const encounter = replay.engine.encounters.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    const visible = replay.engine.visibility(encounter);
    const rows = encounter.rows.filter((r) => visible(r.target.id, r.target.name));
    const t = buildTimeline({ start: encounter.start, end: encounter.end!, rows, detail: replay.detail, phases: [], players: timelinePlayers(rows, []) });
    const b25e = rows.filter((r) => r.kind === "hit" && r.action.id === 0xb25e);
    expect(b25e.length).toBeGreaterThan(30);
    expect(b25e.every((r) => r.kind === "hit" && r.autoAttack && r.action.name === "攻击")).toBe(true);
    expect(t.autoAttacks.flatMap((d) => d.rows).filter((r) => r.action.id === 0xb25e)).toHaveLength(b25e.length);
    expect(t.damage.some((d) => d.rows.some((r) => r.action.id === 0xb25e))).toBe(false);
  });
});
