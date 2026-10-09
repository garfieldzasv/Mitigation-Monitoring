/**
 * How many player deaths find their killing blow (docs/DESIGN.md 5.7; the M5 acceptance check).
 *
 *   pnpm death-attribution <Network_*.log>...
 *
 * Runs whole ACT network logs through the engine and counts, per encounter, the death rows of
 * players in the party (log files carry no CombatData, so the scope is the party) and how many have
 * a killing blow, and of the rest what else the log says killed (地形杀, an instant death, a mechanic cactbot
 * annotates). Prints the others — a killer named, no damage line — to see why. `--all`
 * counts every player instead (other parties in 24-player duties too), as the sample statistics of DESIGN.md
 * 2.1 did.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Engine } from "../src/core/engine/engine";
import type { DamageRow, DeathRow, Encounter } from "../src/core/engine/types";
import { isRelevantLineType, parseLogLine } from "../src/core/logline/parse";

interface Tally {
  deaths: number;
  attributed: number;
  /** No killing blow to find: 地形杀, an instant death, a mechanic cactbot annotates. */
  terrain: number;
  instant: number;
  other: number;
  /** Unattributed deaths with any hit on the player in the 10 s before. */
  hitBefore: number;
}

const everyone = process.argv.includes("--all");

function count(encounter: Encounter, engine: Engine, tally: Tally, misses: string[]): void {
  const visible = everyone ? () => true : engine.visibility(encounter);
  for (const r of encounter.rows) {
    if (r.kind !== "death" || !visible(r.target.id, r.target.name)) continue;
    tally.deaths++;
    if (r.killerRowId !== undefined) {
      tally.attributed++;
      continue;
    }
    if (r.cause) {
      tally[r.cause]++;
      continue;
    }
    const last = lastHit(encounter, r);
    if (last && r.time - last.time <= 10000) tally.hitBefore++;
    const clock = new Date(r.time).toISOString().slice(11, 19);
    const lastText = last ? `last hit ${((r.time - last.time) / 1000).toFixed(1)} s before: ${last.action.name} ${last.amount}` : "no hit before";
    misses.push(`  ${clock}Z  ${encounter.zoneName}  ${r.target.name} ← ${r.sourceName || "?"}  (${lastText})`);
  }
}

function lastHit(encounter: Encounter, death: DeathRow): DamageRow | undefined {
  for (let i = encounter.rows.length - 1; i >= 0; i--) {
    const r = encounter.rows[i]!;
    if (r.kind !== "death" && r.target.id === death.target.id && r.time <= death.time) return r;
  }
  return undefined;
}

async function main(): Promise<void> {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (files.length === 0) throw new Error("Usage: death-attribution [--all] <Network_*.log>...");
  const total: Tally = { deaths: 0, attributed: 0, terrain: 0, instant: 0, other: 0, hitBefore: 0 };
  const misses: string[] = [];
  for (const file of files) {
    const engine = new Engine({ maxEncounters: 2 });
    const tally: Tally = { deaths: 0, attributed: 0, terrain: 0, instant: 0, other: 0, hitBefore: 0 };
    // An encounter is complete once the next one starts (late death lines included).
    engine.subscribe((change) => {
      if (change.kind !== "encounterStart") return;
      const previous = engine.encounters.at(-2);
      if (previous) count(previous, engine, tally, misses);
    });
    for await (const raw of createInterface({ input: createReadStream(file) })) {
      const line = raw.split("|");
      if (!isRelevantLineType(line[0])) continue;
      const event = parseLogLine(line);
      if (!event) continue;
      engine.handle(event);
    }
    const last = engine.encounters.at(-1);
    if (last) count(last, engine, tally, misses);
    console.log(`${file.split(/[\\/]/).pop()}: ${tally.attributed}/${tally.deaths}, 地形杀 ${tally.terrain}, instant ${tally.instant}, annotated ${tally.other}`);
    for (const k of ["deaths", "attributed", "terrain", "instant", "other", "hitBefore"] as const) total[k] += tally[k];
  }
  const rate = total.deaths > 0 ? ((total.attributed / total.deaths) * 100).toFixed(1) : "-";
  console.log(`\ntotal: ${total.attributed}/${total.deaths} deaths have a killing blow (${rate}%), 地形杀 ${total.terrain}, instant death ${total.instant}, annotated mechanic ${total.other}`);
  if (misses.length > 0) {
    console.log(`a killer named, no damage line: ${misses.length} (${total.hitBefore} had some hit in the 10 s before)`);
    for (const m of misses) console.log(m);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
