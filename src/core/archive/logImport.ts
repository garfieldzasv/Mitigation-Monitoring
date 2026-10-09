import { Engine } from "../engine/engine";
import type { Encounter } from "../engine/types";
import { LineType } from "../logline/fields";
import { isRelevantLineType } from "../logline/parse";
import { archivedForm, withoutHash } from "./codec";
import { archiveIdOf, type ArchiveMeta, type ArchiveStore } from "./types";
import { ArchiveWriter, summarize } from "./writer";

/**
 * Importing an ACT log file (Network_*.log) into the archive (docs/DESIGN.md 9.5): the pulls it holds, cut as the
 * monitor cuts them, then the chosen ones archived as the monitor archives them — the same engine and the same writer,
 * fed the file's lines in place of OverlayPlugin's. A log file has no PartyChanged or CombatData: the party is its 11
 * and 03 lines, the player its 02 line, and the players shown are the party. The file is read twice, in batches of
 * lines, never whole.
 */

/** A fresh pass over the file each call: batches of its lines, each split on "|", in file order. */
export type LogBatches = () => AsyncIterable<readonly (readonly string[])[]>;

export interface LogPull {
  /** The archive it becomes (archiveIdOf(start)): the monitor's own archive of the same pull has the same id. */
  id: string;
  /** Its 复盘: the first pull of its visit to the zone, as the monitor groups them (docs/DESIGN.md 6.2). */
  session: string;
  start: number;
  /** Unset when the file ends during the pull. */
  end?: number;
  zoneId: number;
  zoneName: string;
  /** The main boss. */
  title?: string;
  result: Encounter["result"];
  summary: ArchiveMeta["summary"];
}

/** Every pull in the file, in order. */
export async function scanLog(read: LogBatches, signal?: AbortSignal): Promise<LogPull[]> {
  const engine = new Engine();
  const pulls: LogPull[] = [];
  let session: string | undefined;
  /** The pull whose lines are still coming: late deaths and results belong to it until the next starts or the zone changes. */
  let open: { pull: LogPull; encounter: Encounter } | undefined;
  const settle = () => {
    if (!open) return;
    const { pull, encounter } = open;
    if (encounter.end !== undefined) pull.end = encounter.end;
    if (encounter.boss) pull.title = encounter.boss.name;
    pull.result = encounter.result;
    pull.summary = summarize(encounter, engine.visibility(encounter));
    open = undefined;
  };
  engine.subscribe((change) => {
    if (change.kind !== "encounterStart") return;
    settle();
    const e = change.encounter;
    session ??= archiveIdOf(e.start);
    const pull: LogPull = { id: archiveIdOf(e.start), session, start: e.start, zoneId: e.zoneId, zoneName: e.zoneName, result: e.result, summary: { durationMs: 0, deaths: 0, rows: 0 } };
    pulls.push(pull);
    open = { pull, encounter: e };
  });
  for await (const batch of read()) {
    signal?.throwIfAborted();
    for (const raw of batch) {
      if (!isRelevantLineType(raw[0])) continue;
      const line = archivedForm(withoutHash(raw));
      if (!line) continue;
      if (line[0] === LineType.ChangeZone) {
        settle();
        session = undefined;
      }
      engine.feed(line);
    }
  }
  engine.flush();
  settle();
  return pulls;
}

/**
 * Archives the chosen pulls of the file (from scanLog), each in its 复盘, pinned and marked with the file; ones already
 * archived (the monitor recorded them, or an earlier import) are left alone. Reads until the last chosen pull's lines
 * end. Resolves to the ids written, in order.
 */
export async function importLog(
  read: LogBatches,
  chosen: readonly LogPull[],
  store: ArchiveStore,
  options: { file: string; signal?: AbortSignal },
): Promise<string[]> {
  const existing = new Set((await store.list()).map((m) => m.id));
  const wanted = new Map(chosen.filter((p) => !existing.has(p.id)).map((p) => [p.id, p]));
  if (wanted.size === 0) return [];
  const last = Math.max(...[...wanted.values()].map((p) => p.start));

  const engine = new Engine();
  const written: string[] = [];
  const writer = new ArchiveWriter(engine, {
    store,
    accept: (e) => {
      const ok = wanted.has(archiveIdOf(e.start));
      if (ok) written.push(archiveIdOf(e.start));
      return ok;
    },
    imported: { file: options.file, session: (e) => wanted.get(archiveIdOf(e.start))!.session },
  });
  /**
   * The last chosen pull, once started. Its archive takes lines until the next pull starts, or the zone changes after it
   * ended (the writer seals it there; a zone change during the pull is one of its lines).
   */
  let lastPull: Encounter | undefined;
  let done = false;
  engine.subscribe((change) => {
    if (change.kind !== "encounterStart") return;
    if (change.encounter.start === last) lastPull = change.encounter;
    else if (lastPull) done = true;
  });

  reading: for await (const batch of read()) {
    options.signal?.throwIfAborted();
    for (const raw of batch) {
      if (!isRelevantLineType(raw[0])) continue;
      if (lastPull?.end !== undefined && raw[0] === LineType.ChangeZone) break reading;
      // As the monitor feeds them (useLiveEngine): the writer first, so a pull's own line is in its pre-pull snapshot.
      writer.push(raw);
      const line = archivedForm(withoutHash(raw));
      if (line) engine.feed(line);
      if (done) break reading;
    }
    await writer.flush();
  }
  engine.flush();
  await writer.seal();
  return written;
}
