import { describe, expect, it } from "vitest";
import { Engine } from "@/core/engine/engine";
import type { DamageRow } from "@/core/engine/types";
import { ReplayDetail } from "@/core/replay/detail";
import { isRelevantLineType, parseLogLine } from "@/core/logline/parse";

/**
 * Open-world fights (docs/DESIGN.md 5.1): enemies spawned for one player — FATE and quest mobs, the
 * 护领… enemies of Dawntrail — carry that player as their owner, in their 03 line and in field 47 of
 * every 21 line. Seen in CN logs: 125 hits on the player in one fight, all of them once dropped as
 * "a pet's damage".
 */
const at = (s: number) => new Date(Date.UTC(2026, 8, 28, 3, 4, s)).toISOString();
const ME = "10000001";

function combatant(s: number, id: string, name: string, job: string, owner: string): string[] {
  return ["03", at(s), id, name, job, "64", owner, "00", "", "0", "0", "100000", "100000"];
}

function hit(s: number, sourceId: string, source: string, owner: string): string[] {
  const line = Array<string>(49).fill("");
  line[0] = "21";
  line[1] = at(s);
  line[2] = sourceId;
  line[3] = source;
  line[4] = "368";
  line[5] = "攻击";
  line[6] = ME;
  line[7] = "Me";
  line[8] = "710003"; // damage, slashing
  line[9] = "1A2B0000";
  for (let i = 10; i <= 23; i++) line[i] = "0";
  line[24] = "90000";
  line[25] = "100000";
  line[44] = `0000${s}`;
  line[45] = "0";
  line[46] = "1";
  line[47] = owner;
  line[48] = owner === ME ? "Me" : "";
  return line;
}

function cast(s: number, sourceId: string, source: string): string[] {
  return ["20", at(s), sourceId, source, "AB51", "龙闪", ME, "Me", "2.000"];
}

const LOG: string[][] = [
  ["01", at(0), "4A4", "克扎玛乌卡湿地"],
  ["02", at(0), ME, "Me"],
  combatant(0, ME, "Me", "23", "0000"),
  combatant(1, "40000AAA", "护领树林人", "00", ME),
  combatant(1, "40000BBB", "咕咕鸡", "00", ME),
  ["260", at(2), "1", "1", "1", "1"],
  cast(3, "40000BBB", "咕咕鸡"),
  cast(3, "40000AAA", "护领树林人"),
  hit(5, "40000AAA", "护领树林人", ME),
  hit(7, "40000AAA", "护领树林人", ME),
  ["260", at(12), "0", "0", "1", "1"],
];

function run() {
  const engine = new Engine();
  const detail = new ReplayDetail(engine);
  for (const line of LOG) {
    if (!isRelevantLineType(line[0])) continue;
    const e = parseLogLine(line);
    if (!e) continue;
    detail.handle(e); // before the engine, as in replayArchive
    engine.handle(e);
  }
  return { engine, detail };
}

describe("open world: enemies owned by the player", () => {
  it("their hits are damage taken, shown for the player even with no party and no CombatData", () => {
    const { engine } = run();
    const enc = engine.encounters.at(-1)!;
    expect(enc.zoneName).toBe("克扎玛乌卡湿地");
    const hits = enc.rows.filter((r): r is DamageRow => r.kind === "hit");
    expect(hits.map((r) => [r.source.name, r.target.id, r.amount])).toEqual([
      ["护领树林人", ME, 0x1a2b],
      ["护领树林人", ME, 0x1a2b],
    ]);
    const visible = engine.visibility(enc);
    expect(hits.every((r) => visible(r.target.id, r.target.name))).toBe(true);
  });

  it("an owned companion's cast is not an enemy cast; the owned enemy's is", () => {
    const { detail } = run();
    expect(detail.casts.map((c) => c.source.name)).toEqual(["咕咕鸡", "护领树林人"]);
    expect(detail.enemyCasts().map((c) => c.source.name)).toEqual(["护领树林人"]);
  });
});
