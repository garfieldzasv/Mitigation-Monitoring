import type { CombatantInfo } from "../combatants/registry";
import type { EncounterResult } from "../engine/types";
import type { PartyMember, ScopeSnapshot } from "../party/partyState";

/**
 * What an archive holds, by version. 2: the 21/22 lines that put on the statuses running at the pull (their modifier
 * bytes). Version-2 archives made before 2026-10-07 also hold players' positions (261 lines), no longer read.
 */
export const ARCHIVE_VERSION = 2;

/** Finished, unpinned 复盘 (zone visits) kept unless the settings say otherwise (docs/DESIGN.md 6.2). */
export const DEFAULT_KEPT_ENCOUNTERS = 20;

/** Archive ids come from the pull's start, so the monitor can name one without asking the writer. */
export function archiveIdOf(start: number): string {
  return `e${start}`;
}

/**
 * One saved encounter (docs/DESIGN.md 6.2), without its raw lines: those are stored as gzipped
 * chunks next to it, so a flush during the fight appends a chunk instead of rewriting everything.
 */
export interface ArchiveMeta {
  version: number;
  /** `e<start ms>`: sortable, unique per pull. */
  id: string;
  zoneId: number;
  zoneName: string;
  start: number;
  /** Unset while the encounter is being recorded. */
  end?: number;
  result: EncounterResult;
  /**
   * Timestamp of the last line stored. A recording whose overlay was closed mid-pull never gets an
   * `end`; this tells it from one still going, and becomes its end (ArchiveWriter.closeAbandoned).
   */
  lastLineTime?: number;
  self?: { id: string; name: string };
  /** The party when the pull started (OverlayPlugin's PartyChanged, with alliance flags). */
  party: PartyMember[];
  /** Everything the live engine knew at the pull (names, jobs, owners), for an overlay opened mid-session. */
  combatants: CombatantInfo[];
  /** Who is shown, frozen at the end. */
  scope?: ScopeSnapshot;
  summary: ArchiveSummary;
  chunkCount: number;
  /** Stored (compressed) size in bytes. */
  bytes: number;
  /** Pinned encounters are never pruned. Owned by the review window, which pins a 复盘's pulls together; the writer keeps whatever is stored. */
  pinned: boolean;
  /**
   * The 复盘 this pull belongs to (docs/DESIGN.md 6.2): one visit to a zone, every pull from entering it to leaving it
   * (a 24-player duty's bosses), named by the archive id of its first pull. Unset in archives made before 2026-10-08:
   * each is its own.
   */
  session?: string;
  /** What the pull was against, for the list: its main boss (the players' biggest target). */
  title?: string;
  /** Imported from an ACT log file (docs/DESIGN.md 9.5); unset when the monitor recorded it. */
  source?: { kind: "networkLog"; file: string };
}

/** The 复盘 an archive belongs to. */
export function sessionOf(meta: ArchiveMeta): string {
  return meta.session ?? meta.id;
}

/** One 复盘: the pulls of one zone visit. */
export interface ArchiveSession {
  id: string;
  /** Oldest first. */
  pulls: ArchiveMeta[];
  /** Pinned 复盘 are never pruned: one of its pulls is pinned (the review window pins them together). */
  pinned: boolean;
  /** One of its pulls is still being recorded. */
  recording: boolean;
}

/** Archives as 复盘, newest first (by their latest pull). `list` is the store's: newest first. */
export function groupSessions(list: readonly ArchiveMeta[]): ArchiveSession[] {
  const byId = new Map<string, ArchiveSession>();
  for (const meta of list) {
    const id = sessionOf(meta);
    let session = byId.get(id);
    if (!session) byId.set(id, (session = { id, pulls: [], pinned: false, recording: false }));
    session.pulls.unshift(meta);
    if (meta.pinned) session.pinned = true;
    if (meta.end === undefined) session.recording = true;
  }
  return [...byId.values()];
}

/** What the encounter list shows without loading any lines. */
export interface ArchiveSummary {
  durationMs: number;
  deaths: number;
  /** Damage and death rows of players in scope. */
  rows: number;
}

/**
 * Storage port: IndexedDB in the browser, memory in tests. The monitor (writing the recording) and
 * the review window (pinning, deleting, correcting summaries) share it, so every read-modify-write
 * of a meta goes through `update`.
 */
export interface ArchiveStore {
  /** Newest first. */
  list(): Promise<ArchiveMeta[]>;
  get(id: string): Promise<ArchiveMeta | undefined>;
  put(meta: ArchiveMeta): Promise<void>;
  /**
   * Reads the meta and writes what `change` returns, in one transaction, so a write from the other
   * window cannot fall in between. `change` gets undefined when there is no such archive (never
   * written, or deleted) and returns undefined to write nothing. Resolves to what was written.
   */
  update(id: string, change: (current: ArchiveMeta | undefined) => ArchiveMeta | undefined): Promise<ArchiveMeta | undefined>;
  appendChunk(id: string, index: number, data: Blob): Promise<void>;
  /** In index order. */
  chunks(id: string): Promise<Blob[]>;
  remove(id: string): Promise<void>;
}
