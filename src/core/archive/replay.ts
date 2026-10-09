import { Engine } from "../engine/engine";
import type { Encounter } from "../engine/types";
import { isRelevantLineType, parseLogLine } from "../logline/parse";
import { compileScope, type ScopePredicate } from "../party/partyState";
import { ReplayDetail } from "../replay/detail";
import type { ArchiveMeta } from "./types";

export interface ReplayResult {
  engine: Engine;
  /** The archived encounter, rebuilt; undefined if the lines never start it (a broken archive). */
  encounter: Encounter | undefined;
  /** Whose rows are shown: the scope frozen with the archive, or the replay's own while recording. */
  visible: ScopePredicate;
  /** Heals, status changes, HP and enemy casts (docs/DESIGN.md 5.8). */
  detail: ReplayDetail;
}

/**
 * Rebuilds an archived encounter with the same engine the monitor runs (docs/DESIGN.md 3.2): the
 * zone, party, player and known combatants as they were at the pull, then every raw line. Each
 * event also goes to a ReplayDetail, which the monitor does without.
 *
 * Once, line by line, as the monitor took them: the review shows what the monitor showed (docs/DESIGN.md 3.2).
 */
export function replayArchive(meta: ArchiveMeta, lines: readonly (readonly string[])[]): ReplayResult {
  const engine = new Engine({ maxEncounters: 4 });
  const detail = new ReplayDetail(engine);
  run(engine, meta, lines, detail);
  // The lines reproduce the pull's first line, so the encounter starts exactly when the archive's did.
  const encounter = engine.encounters.find((e) => e.start === meta.start);
  const visible = meta.scope ? compileScope(meta.scope) : encounter ? engine.visibility(encounter) : () => false;
  return { engine, encounter, visible, detail };
}

function run(engine: Engine, meta: ArchiveMeta, lines: readonly (readonly string[])[], detail?: ReplayDetail): void {
  // An archive of an overlay opened mid-session has no 01 line before the pull.
  engine.setZone(meta.zoneId, meta.zoneName);
  // The lines before the pull are state only: the monitor did not start an encounter in them. The pull starts where
  // the archive says, whatever today's rules make of its first line.
  engine.startArchivedPullAt(meta.start);
  engine.bootstrap({
    combatants: meta.combatants,
    party: meta.party,
    ...(meta.self ? { selfId: meta.self.id, selfName: meta.self.name } : {}),
  });
  for (const line of lines) {
    if (!isRelevantLineType(line[0])) continue;
    const event = parseLogLine(line);
    if (!event) continue;
    detail?.handle(event); // before the engine: it reads the state the event applies to
    engine.handle(event);
  }
  engine.flush();
}
