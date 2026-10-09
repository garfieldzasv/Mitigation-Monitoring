import type { Engine } from "../engine/engine";
import type { Encounter } from "../engine/types";
import { LineType } from "../logline/fields";
import { isRelevantLineType } from "../logline/parse";
import type { ScopePredicate } from "../party/partyState";
import { archivedForm, encodeLines, withoutHash } from "./codec";
import { PrepullState } from "./prepull";
import { ARCHIVE_VERSION, archiveIdOf, DEFAULT_KEPT_ENCOUNTERS, groupSessions, sessionOf, type ArchiveMeta, type ArchiveStore, type ArchiveSummary } from "./types";

/** A recording that stored nothing for this long is not being written by anyone (flushes are every 10 s). */
const ABANDONED_MS = 60000;

interface Recording {
  meta: ArchiveMeta;
  encounter: Encounter;
  pending: (readonly string[])[];
  nextChunk: number;
  endedAt?: number;
  /** The meta is in the store: from then on, finding it gone means a review window deleted it. */
  stored: boolean;
}

export interface WriterOptions {
  store: ArchiveStore;
  /** Unpinned finished 复盘 (zone visits) kept (docs/DESIGN.md 6.2); a function when it is a setting. */
  maxKept?: number | (() => number);
  /** Whether to save an encounter, asked when it starts (the "skip open-world fights" setting). */
  accept?: (encounter: Encounter) => boolean;
  /** Called after each write, with the archive's id (the monitor broadcasts it to review windows). */
  onUpdate?: (id: string) => void;
  /**
   * Pulls imported from a log file (docs/DESIGN.md 9.5): stored pinned (an old date would have them pruned at once) and
   * marked with the file, each in the 复盘 the scan of the log gave it; the store is not pruned and no recording is
   * closed: the clock is the file's.
   */
  imported?: { file: string; session: (encounter: Encounter) => string };
}

/** What the archive list shows without loading any lines. */
export function summarize(encounter: Encounter, visible: ScopePredicate): ArchiveSummary {
  let rows = 0;
  let deaths = 0;
  for (const r of encounter.rows) {
    if (!visible(r.target.id, r.target.name)) continue;
    rows++;
    if (r.kind === "death") deaths++;
  }
  return { durationMs: (encounter.end ?? encounter.start) - encounter.start, deaths, rows };
}

const lineTime = (line: readonly string[] | undefined) => (line ? Date.parse(line[1] ?? "") || undefined : undefined);

/**
 * Saves every encounter's raw lines (docs/DESIGN.md 3.2, 6.2): the pre-pull state and last 30 s
 * when it starts, every relevant line during it, and after it ends until the next one starts or the zone changes. Lines are flushed as
 * gzipped chunks whenever `flush()` runs (the monitor calls it every 10 s) and when the encounter
 * starts, ends and is sealed. Feed it each line before the engine sees it, so the pull's own line
 * is part of the pre-pull snapshot.
 *
 * The pulls of one zone visit make one 复盘 (`session`, docs/DESIGN.md 6.2): from the first pull after entering a
 * zone until the zone changes. Retention counts 复盘, not pulls.
 *
 * The review window shares the store: it may pin or delete the archive being recorded. The writer
 * keeps the stored `pinned` (a new pull of a pinned 复盘 is pinned too), and stops recording an
 * archive that was deleted.
 */
export class ArchiveWriter {
  private readonly prepull = new PrepullState();
  private rec: Recording | null = null;
  /** The 复盘 of this zone visit: its first pull's archive id, until the zone changes. */
  private session: { id: string; zoneId: number } | undefined;
  private queue: Promise<void> = Promise.resolve();
  /** Encounters not archived: turned down by `accept`, or deleted while being recorded. */
  private readonly notArchived = new WeakSet<Encounter>();

  constructor(
    private readonly engine: Engine,
    private readonly options: WriterOptions,
  ) {
    engine.subscribe((change) => {
      if (change.kind === "encounterStart") this.begin(change.encounter);
      else if (change.kind === "encounterEnd" && this.rec?.encounter === change.encounter) {
        this.rec.endedAt = change.encounter.end;
        void this.flush();
      }
    });
  }

  /** The archive being recorded, if any. */
  get recordingId(): string | undefined {
    return this.rec?.meta.id;
  }

  /** Whether this encounter is (being) archived, as decided when it started. */
  isArchived(encounter: Encounter): boolean {
    return !this.notArchived.has(encounter);
  }

  push(raw: readonly string[]): void {
    if (!isRelevantLineType(raw[0])) return;
    const line = archivedForm(withoutHash(raw));
    if (!line) return;
    const rec = this.rec;
    // After its end, an encounter keeps the lines that can still belong to it (late deaths and results) until the next
    // one starts or the zone changes.
    if (rec && rec.endedAt !== undefined && line[0] === LineType.ChangeZone) void this.seal();
    if (line[0] === LineType.ChangeZone) this.session = undefined;
    this.prepull.push(line);
    if (!this.rec) return;
    this.rec.pending.push(line);
  }

  /** Writes pending lines and the current summary. Resolves when everything queued so far is stored. */
  flush(): Promise<void> {
    if (this.rec) this.write(this.rec);
    return this.queue;
  }

  /** Finishes the current archive (its tail ended, or a new pull started) and prunes old ones. */
  seal(): Promise<void> {
    const rec = this.rec;
    if (!rec) return this.queue;
    this.rec = null;
    this.write(rec);
    return this.options.imported ? this.queue : this.prune();
  }

  /** Removes the oldest unpinned finished 复盘 beyond `maxKept`, every pull of them; never the zone visit going on. */
  prune(): Promise<void> {
    const { maxKept = DEFAULT_KEPT_ENCOUNTERS } = this.options;
    const keep = typeof maxKept === "function" ? maxKept() : maxKept;
    return this.enqueue("prune", async () => {
      const current = this.rec?.meta.session ?? this.session?.id;
      const finished = groupSessions(await this.options.store.list()).filter((s) => !s.recording && !s.pinned && s.id !== current);
      for (const old of finished.slice(keep)) for (const pull of old.pulls) await this.options.store.remove(pull.id);
    });
  }

  /**
   * Ends recordings left behind when an overlay closed mid-pull: they never got an `end`, so they
   * would show as recording forever and never be pruned. Their last stored line becomes the end.
   * The monitor runs this once when it starts; `now` is the current time.
   */
  closeAbandoned(now: number): Promise<void> {
    return this.enqueue("close abandoned", async () => {
      for (const m of await this.options.store.list()) {
        if (m.end !== undefined || m.id === this.rec?.meta.id) continue;
        const last = m.lastLineTime ?? m.start;
        if (now - last < ABANDONED_MS) continue;
        await this.options.store.update(m.id, (current) =>
          current && current.end === undefined ? { ...current, end: last, summary: { ...current.summary, durationMs: last - current.start } } : undefined,
        );
        this.options.onUpdate?.(m.id);
      }
    });
  }

  private begin(encounter: Encounter): void {
    if (this.rec) void this.seal();
    const { imported } = this.options;
    // Recordings an earlier overlay left (reloaded mid-pull) end now, not only at the next start-up.
    if (!imported) void this.closeAbandoned(encounter.start);
    if (this.options.accept && !this.options.accept(encounter)) {
      this.notArchived.add(encounter);
      return;
    }
    if (imported) this.session = { id: imported.session(encounter), zoneId: encounter.zoneId };
    else if (!this.session || this.session.zoneId !== encounter.zoneId) this.session = { id: archiveIdOf(encounter.start), zoneId: encounter.zoneId };
    const party = this.engine.party;
    const meta: ArchiveMeta = {
      version: ARCHIVE_VERSION,
      id: archiveIdOf(encounter.start),
      zoneId: encounter.zoneId,
      zoneName: encounter.zoneName,
      start: encounter.start,
      result: "unknown",
      ...(party.selfId ? { self: { id: party.selfId, name: party.selfName ?? "" } } : {}),
      party: party.list().map((m) => ({ ...m })),
      combatants: this.engine.registry.all().map((c) => ({ ...c })),
      summary: { durationMs: 0, deaths: 0, rows: 0 },
      chunkCount: 0,
      bytes: 0,
      pinned: imported !== undefined,
      session: this.session.id,
      ...(imported ? { source: { kind: "networkLog" as const, file: imported.file } } : {}),
    };
    this.rec = { meta, encounter, pending: this.prepull.snapshot(encounter.start), nextChunk: 0, stored: false };
    void this.flush();
  }

  private write(rec: Recording): void {
    const lines = rec.pending;
    rec.pending = [];
    const index = lines.length > 0 ? rec.nextChunk++ : -1;
    const { store, onUpdate } = this.options;
    this.enqueue("write", async () => {
      const meta = rec.meta;
      if (index >= 0) {
        const blob = await encodeLines(lines);
        await store.appendChunk(meta.id, index, blob);
        meta.bytes += blob.size;
        meta.chunkCount = index + 1;
        meta.lastLineTime = lineTime(lines.at(-1)) ?? meta.lastLineTime;
      }
      // A new pull of a pinned 复盘 is pinned too.
      if (!rec.stored && !this.options.imported) meta.pinned = (await store.list()).some((m) => sessionOf(m) === meta.session && m.pinned);
      const e = rec.encounter;
      if (e.end !== undefined) meta.end = e.end;
      if (e.boss) meta.title = e.boss.name;
      meta.result = e.result;
      // Who the monitor shows, kept current while recording: a review opened mid-pull shows the same players.
      meta.scope = e.scope ?? this.engine.scope.snapshot();
      meta.summary = summarize(e, this.engine.visibility(e));
      const written = await store.update(meta.id, (current) => {
        if (!current && rec.stored) return undefined; // deleted by a review window
        return { ...structuredClone(meta), pinned: current?.pinned ?? meta.pinned };
      });
      if (!written) {
        this.abandon(rec);
        await store.remove(meta.id); // the chunk just appended
        return;
      }
      rec.stored = true;
      onUpdate?.(meta.id);
    });
  }

  /** Stops recording an archive a review window deleted (with its 复盘: the next pull starts a new one). */
  private abandon(rec: Recording): void {
    this.notArchived.add(rec.encounter);
    if (this.rec === rec) this.rec = null;
    if (this.session?.id === rec.meta.session) this.session = undefined;
  }

  private enqueue(what: string, task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((err: unknown) => console.error(`[archive] ${what} failed`, err));
    return this.queue;
  }
}
