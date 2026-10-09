/**
 * Cuts one encounter out of an ACT Network_*.log into an anonymized, gzipped test fixture.
 *
 *   pnpm make-fixture <Network_*.log> --list
 *   pnpm make-fixture <Network_*.log> --start 2026-09-20T00:25:23 --out tests/fixtures/<name>.log.gz
 *
 * The fixture holds only the line types the engine reads, without the trailing hash field. It
 * starts with the pre-pull state (zone, player, combatants, party, running statuses, the last 30 s)
 * and runs until 10 s after the encounter ends, so late death lines are included. Player names
 * become P1, P2, ... in order of appearance; enemy names stay.
 */
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { archivedForm } from "../src/core/archive/codec";
import { PrepullState } from "../src/core/archive/prepull";
import { EncounterTracker, ourSide } from "../src/core/engine/encounter";
import { isRelevantLineType, parseLogLine, type GameEvent } from "../src/core/logline/parse";
import { PartyState } from "../src/core/party/partyState";

const TAIL_MS = 10000;

/** [id field, name field] pairs naming an actor, per line type. */
const ACTOR_FIELDS: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  "02": [[2, 3]],
  "03": [[2, 3]],
  "04": [[2, 3]],
  "21": [[2, 3], [6, 7]],
  "22": [[2, 3], [6, 7]],
  "24": [[2, 3]],
  "25": [[2, 3], [4, 5]],
  "26": [[5, 6], [7, 8]],
  "30": [[5, 6], [7, 8]],
  "38": [[2, 3]],
};

function parseArgs(argv: string[]) {
  const file = argv[0];
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { file, list: argv.includes("--list"), start: get("--start"), out: get("--out") };
}

/** The encounter rules with the party a log file names (02 and 11 lines), as the engine has them. */
function trackerOfLog(): (event: GameEvent) => ReturnType<EncounterTracker["onEvent"]> {
  const party = new PartyState();
  const tracker = new EncounterTracker(ourSide(party));
  return (event) => {
    if (event.type === "primaryPlayer") party.setSelf(event.id, event.name);
    if (event.type === "partyList") party.setParty(event.ids.map((id) => ({ id, name: "", job: 0, level: 0, inParty: true })));
    return tracker.onEvent(event);
  };
}

async function* relevantLines(file: string): AsyncGenerator<string[]> {
  for await (const raw of createInterface({ input: createReadStream(file) })) {
    const line = raw.split("|");
    if (!isRelevantLineType(line[0])) continue;
    line.pop(); // trailing hash
    const kept = archivedForm(line);
    if (kept) yield [...kept];
  }
}

async function list(file: string): Promise<void> {
  const boundaryOf = trackerOfLog();
  let zone = "";
  let current: { start: string; lines: number; deaths: number } | undefined;
  for await (const line of relevantLines(file)) {
    const event = parseLogLine(line);
    if (!event) continue;
    if (event.type === "zone") zone = event.zoneName;
    const boundary = boundaryOf(event);
    if (current) {
      current.lines++;
      if (event.type === "death" && event.targetId.startsWith("10")) current.deaths++;
    }
    if (boundary?.kind === "start") current = { start: line[1] ?? "", lines: 0, deaths: 0 };
    if (boundary?.kind === "end" && current) {
      const seconds = Math.round((boundary.time - Date.parse(current.start)) / 1000);
      if (seconds >= 30) {
        console.log(`${current.start.slice(0, 19)}  ${String(seconds).padStart(4)}s  ${String(current.lines).padStart(6)} lines  ${current.deaths} deaths  ${boundary.result.padEnd(7)}  ${zone}`);
      }
      current = undefined;
    }
  }
}

async function cut(file: string, start: string): Promise<string[][]> {
  const boundaryOf = trackerOfLog();
  const prepull = new PrepullState();
  let out: string[][] | undefined;
  let endedAt: number | undefined;
  for await (const line of relevantLines(file)) {
    prepull.push(line);
    const event = parseLogLine(line);
    const boundary = event && boundaryOf(event);
    if (out) {
      const time = Date.parse(line[1] ?? "");
      if (endedAt !== undefined && time - endedAt > TAIL_MS) break;
      out.push(line);
      if (boundary?.kind === "end" && endedAt === undefined) endedAt = boundary.time;
    } else if (boundary?.kind === "start" && (line[1] ?? "").startsWith(start)) {
      out = prepull.snapshot(boundary.time).map((l) => [...l]);
    }
  }
  if (!out) throw new Error(`No encounter starts at ${start}. Use --list to see the encounters.`);
  return out;
}

/** Replaces player names with P1, P2, ... and returns the original names for a leak check. */
function anonymize(lines: string[][]): string[] {
  const alias = new Map<string, string>();
  for (const line of lines) {
    for (const [idField, nameField] of ACTOR_FIELDS[line[0] ?? ""] ?? []) {
      const id = line[idField] ?? "";
      const name = line[nameField] ?? "";
      if (id.startsWith("10") && name && !alias.has(name)) alias.set(name, `P${alias.size + 1}`);
    }
  }
  for (const line of lines) {
    for (let i = 2; i < line.length; i++) {
      const replacement = alias.get(line[i]!);
      if (replacement) line[i] = replacement;
    }
  }
  return [...alias.keys()];
}

async function main(): Promise<void> {
  const { file, list: listOnly, start, out } = parseArgs(process.argv.slice(2));
  if (!file) throw new Error("Usage: make-fixture <Network_*.log> (--list | --start <time> --out <path>)");
  if (listOnly) return list(file);
  if (!start || !out) throw new Error("--start and --out are required");

  const lines = await cut(file, start);
  const names = anonymize(lines);
  const text = lines.map((l) => l.join("|")).join("\n");
  const leaks = names.filter((n) => n.length >= 2 && text.includes(n));
  if (leaks.length > 0) throw new Error(`Player names still present after anonymizing: ${leaks.length}`);

  const gz = gzipSync(text);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, gz);
  console.log(`${out}: ${lines.length} lines, ${names.length} players, ${(text.length / 1048576).toFixed(2)} MB → ${(gz.length / 1048576).toFixed(2)} MB gzip`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
