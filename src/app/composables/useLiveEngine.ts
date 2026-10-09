import { effectScope, readonly, ref, watch } from "vue";
import { archivedForm, withoutHash } from "@/core/archive/codec";
import { ArchiveWriter } from "@/core/archive/writer";
import { Engine } from "@/core/engine/engine";
import type { Encounter } from "@/core/engine/types";
import { readCombatants, type OverlayCombatant } from "@/core/overlay/combatants";
import { addOverlayListener, requestOverlayHandler } from "@/core/overlay/overlayApi";
import { archivesEncounter } from "@/core/settings/settings";
import { archiveStore, openArchiveChannel, type ArchiveMessage } from "../archive";
import { useSettings } from "./useSettings";

/**
 * The monitor's engine, fed by OverlayPlugin, and the archive writer next to it (docs/DESIGN.md
 * 3.2, 3.3). One per page, created on first use and never torn down with a component. The engine
 * itself is plain TS; Vue only sees a version counter, bumped at most once per animation frame
 * however many lines arrive.
 */
const engine = new Engine();
const version = ref(0);
let writer: ArchiveWriter | undefined;
let scheduled = false;

/** Pending archive lines are written this often during a fight. */
const FLUSH_MS = 10000;

function bump(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    version.value++;
  });
}

function start(): ArchiveWriter {
  engine.subscribe(bump);

  const channel = openArchiveChannel();
  const { settings } = useSettings();
  const w = new ArchiveWriter(engine, {
    store: archiveStore(),
    maxKept: () => settings.value.keepEncounters,
    accept: (encounter) => archivesEncounter(settings.value, encounter),
    onUpdate: (id) => channel?.postMessage({ type: "archive", id } satisfies ArchiveMessage),
  });
  void w.closeAbandoned(Date.now());
  // The writer outlives any component, so its watcher must not belong to the first caller's scope.
  effectScope(true).run(() => {
    // Fewer encounters to keep: drop the extra ones now, not at the next seal.
    watch(() => settings.value.keepEncounters, () => void w.prune());
  });
  window.setInterval(() => void w.flush(), FLUSH_MS);
  window.addEventListener("pagehide", () => void w.flush());

  addOverlayListener("LogLine", (e) => {
    // The writer first: a pull's own line belongs to its pre-pull snapshot.
    w.push(e.line);
    // The engine reads the lines as archived, so the review replays exactly what the monitor saw.
    const line = archivedForm(withoutHash(e.line));
    if (line) engine.feed(line);
  });
  addOverlayListener("PartyChanged", (e) => {
    engine.setParty(
      e.party.map((m) => ({ id: m.id.toUpperCase(), name: m.name, job: m.job, level: m.level, inParty: m.inParty })),
    );
    bump();
  });
  addOverlayListener("ChangePrimaryPlayer", (e) => {
    engine.setSelf(e.charID.toString(16).toUpperCase(), e.charName);
    bump();
  });
  // Cached by OverlayPlugin and replayed to late listeners: the zone of an overlay opened
  // mid-session, before any 01 line (the zone name, and whether its fights are archived).
  addOverlayListener("ChangeZone", (e) => {
    engine.setZone(e.zoneID, e.zoneName ?? "");
    bump();
  });
  addOverlayListener("CombatData", (e) => {
    if (e.Combatant) engine.setCombatDataNames(Object.keys(e.Combatant));
  });
  // Opened mid-session: fill in the player, the party and jobs that no event or line has given yet.
  void requestOverlayHandler<{ combatants?: OverlayCombatant[] }>({ call: "getCombatants" }, 15000).then((reply) => {
    if (!reply?.combatants) return;
    engine.bootstrap(readCombatants(reply.combatants));
    bump();
  });
  return w;
}

export function useLiveEngine() {
  const w = (writer ??= start());
  return {
    engine,
    version: readonly(version),
    /** Whether an encounter is (being) archived; false when the settings or a deletion left it out. */
    isArchived: (encounter: Encounter) => w.isArchived(encounter),
  };
}
