import { isPlayerId } from "../combatants/registry";
import type { AbilityEvent } from "../logline/parse";
import type { Encounter, UntargetableWindow } from "./types";

/**
 * Phases (docs/DESIGN.md 5.9), from the stretches when the players had nothing to hit — found as xivanalysis finds
 * downtime: the enemies the players have targeted (each counts from when a player's action first lands on it, or
 * from when it became targetable before that), each targetable or not as its 34 lines say, and untargetable once
 * dead (25) or gone (04); back in the scene (03 after a 04) it counts afresh. A window opens when every one of them is
 * untargetable and closes when one is targetable again (or a new one is targeted); changes at one moment settle
 * together. No shortest window, no HP threshold: neither xivanalysis nor cactbot uses one. Fights split at the
 * windows into stretches 在场 and 离场.
 * Not numbered: a duty's P1, P2… are what its community guides call them, which need not follow these windows. A
 * stretch is named by its time in the encounter (00:00–03:13, 离场 03:13–03:40).
 */

export interface Phase {
  /** 0-based, in time order. */
  index: number;
  kind: "fight" | "intermission";
  /** Its time in the encounter: `00:00–03:13` for a fight, `离场 03:13–03:40` for a window; `… 起` while it lasts. */
  label: string;
  start: number;
  /** Unset for the phase still going. */
  end?: number;
  /** Main boss HP % as the phase started and ended (as far as known). */
  hpStart?: number;
  hpEnd?: number;
}

/** The phases of an encounter at `now` (its end once finished): fights between the windows (a window still open counts). */
export function derivePhases(encounter: Encounter, now: number): Phase[] {
  const end = encounter.end ?? now;
  const phases: Phase[] = [];
  const span = (start: number, until: number | undefined) =>
    until === undefined ? `${clock(start - encounter.start)} 起` : `${clock(start - encounter.start)}–${clock(until - encounter.start)}`;
  let from = encounter.start;
  let hpFrom: number | undefined = 100;
  for (const w of encounter.untargetable) {
    if (w.start > end) break;
    phases.push({
      index: phases.length,
      kind: "fight",
      label: span(from, w.start),
      start: from,
      end: w.start,
      ...(hpFrom !== undefined ? { hpStart: hpFrom } : {}),
      hpEnd: w.hpBefore,
    });
    phases.push({
      index: phases.length,
      kind: "intermission",
      label: `离场 ${span(w.start, w.end)}`,
      start: w.start,
      ...(w.end !== undefined ? { end: w.end } : {}),
      hpStart: w.hpBefore,
      ...(w.hpAfter !== undefined ? { hpEnd: w.hpAfter } : {}),
    });
    if (w.end === undefined) return phases;
    from = w.end;
    hpFrom = w.hpAfter;
  }
  phases.push({
    index: phases.length,
    kind: "fight",
    label: span(from, encounter.end),
    start: from,
    ...(encounter.end !== undefined ? { end: encounter.end } : {}),
    ...(hpFrom !== undefined ? { hpStart: hpFrom } : {}),
    ...(encounter.boss ? { hpEnd: encounter.boss.hpPercent } : {}),
  });
  return phases;
}

/** `mm:ss` from the encounter's start. */
function clock(offsetMs: number): string {
  const total = Math.floor(Math.max(0, offsetMs) / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** The phase `time` falls in: before the first, the first; after the last, the last. */
export function phaseAt(phases: readonly Phase[], time: number): Phase | undefined {
  let found = phases[0];
  for (const p of phases) {
    if (p.start > time) break;
    found = p;
  }
  return found;
}

/**
 * What the windows are worked out from, in the order the lines came; `hp` is the main boss's HP % at that line.
 * `gone`: dead (25) or, `removed`, gone from the scene (04). `added`: back in the scene (03) after a 04.
 */
type PhaseInput =
  | { kind: "hit"; id: string; time: number; hp: number }
  | { kind: "targetable"; id: string; targetable: boolean; time: number; hp: number }
  | { kind: "gone"; id: string; removed: boolean; time: number; hp: number }
  | { kind: "added"; id: string; time: number; hp: number };

/**
 * The windows during which every enemy that counts was untargetable (docs/DESIGN.md 5.9). An enemy counts once the
 * players' action first lands on it, or from its first 34 "targetable" if the players hit it at some point (`hit`:
 * the enemies they hit so far) — xivanalysis' FIRST_TARGETED and TARGETABLE checks; only those the players hit,
 * the log having no friend-or-foe mark. After that its 34 lines say whether it can be targeted, and it cannot once
 * dead (25) or gone (04). Gone and then back (03 after its 04, LogGuide: added to the scene) it is a new one, counting
 * afresh. Changes at one moment settle together: a window closing the moment it opened was none, and one opening the
 * moment the last closed carries it on (xivanalysis merges downtime windows that touch).
 */
function untargetableWindows(inputs: readonly PhaseInput[], hit: ReadonlySet<string>): UntargetableWindow[] {
  const counted = new Map<string, boolean>();
  const removed = new Set<string>();
  let targetable = 0;
  const set = (id: string, can: boolean) => {
    const was = counted.get(id);
    if (was === true && !can) targetable--;
    if (was !== true && can) targetable++;
    counted.set(id, can);
  };
  const windows: UntargetableWindow[] = [];
  let open: UntargetableWindow | undefined;
  for (const e of inputs) {
    if (e.kind === "hit") {
      if (counted.has(e.id)) continue;
      set(e.id, true);
    } else if (e.kind === "targetable") {
      if (counted.has(e.id)) set(e.id, e.targetable);
      else if (e.targetable && hit.has(e.id)) set(e.id, true);
      else continue;
    } else if (e.kind === "gone") {
      if (!counted.has(e.id)) continue;
      set(e.id, false);
      if (e.removed) removed.add(e.id);
    } else {
      if (!removed.delete(e.id)) continue;
      set(e.id, false);
      counted.delete(e.id);
    }
    if (!open && counted.size > 0 && targetable === 0) {
      open = { start: e.time, hpBefore: e.hp };
      windows.push(open);
    } else if (open && targetable > 0) {
      open.end = e.time;
      open.hpAfter = e.hp;
      open = undefined;
    }
  }
  const settled: UntargetableWindow[] = [];
  for (const w of windows) {
    if (w.end === w.start) continue;
    const last = settled.at(-1);
    if (last && last.end === w.start) settled[settled.length - 1] = { ...w, start: last.start, hpBefore: last.hpBefore };
    else settled.push(w);
  }
  return settled;
}

/**
 * Follows the running encounter: its main boss (the players' biggest target) and its HP, and the windows during
 * which every enemy that counts was untargetable. Writes them onto the encounter (`boss`, `untargetable`), which
 * keeps them in archives' replays too. The windows are worked out afresh from the lines that bear on them: an enemy's
 * first hit can move windows already past (it counted from when it became targetable).
 */
export class PhaseTracker {
  private encounter: Encounter | null = null;
  private inputs: PhaseInput[] = [];
  /** The enemies the players have hit. */
  private readonly hit = new Set<string>();
  /** Enemies with a hit or 34 line kept: their deaths, removals and returns are kept too. */
  private readonly known = new Set<string>();
  /** Known enemies gone from the scene (04), until they are back (03). */
  private readonly removed = new Set<string>();
  /** Hit enemies back in the scene: their next hit is kept (they count afresh). */
  private readonly returned = new Set<string>();

  start(encounter: Encounter): void {
    this.encounter = encounter;
    this.inputs = [];
    this.hit.clear();
    this.known.clear();
    this.removed.clear();
    this.returned.clear();
  }

  /**
   * Encounter end. A window still open is dropped: nothing came back, so that was how the fight ended (the boss
   * defeated, or killed in a cutscene; a wipe), not a stretch between phases.
   */
  end(): void {
    const open = this.encounter?.untargetable.at(-1);
    if (open && open.end === undefined) this.encounter!.untargetable.pop();
    this.encounter = null;
  }

  /** A player's action on an enemy: the main boss and its HP; the enemy counts. Returns whether anything changed. */
  onAbility(e: AbilityEvent): boolean {
    const enc = this.encounter;
    if (!enc || !isPlayerId(e.sourceId) || isPlayerId(e.targetId) || e.targetMaxHp <= 0) return false;
    let changed = false;
    if (!enc.boss || e.targetMaxHp > enc.boss.maxHp) {
      enc.boss = { id: e.targetId, name: e.targetName, maxHp: e.targetMaxHp, hpPercent: (e.targetHp / e.targetMaxHp) * 100 };
      changed = true;
    }
    if (e.targetId === enc.boss.id) enc.boss.hpPercent = (e.targetHp / e.targetMaxHp) * 100;
    if (this.hit.has(e.targetId) && !this.returned.delete(e.targetId)) return changed;
    this.hit.add(e.targetId);
    this.known.add(e.targetId);
    return this.keep({ kind: "hit", id: e.targetId, time: e.time, hp: this.hp() }) || changed;
  }

  /** A 34 line. Returns whether the windows changed. */
  onTargetable(id: string, targetable: boolean, time: number): boolean {
    if (!this.encounter || isPlayerId(id)) return false;
    this.known.add(id);
    return this.keep({ kind: "targetable", id, targetable, time, hp: this.hp() });
  }

  /** An enemy died (25): it can no longer be targeted. */
  onDeath(id: string, time: number): boolean {
    if (!this.encounter || !this.known.has(id)) return false;
    return this.keep({ kind: "gone", id, removed: false, time, hp: this.hp() });
  }

  /** A combatant gone from the scene (04): no longer one to target. */
  onRemove(id: string, time: number): boolean {
    if (!this.encounter || !this.known.has(id)) return false;
    this.removed.add(id);
    return this.keep({ kind: "gone", id, removed: true, time, hp: this.hp() });
  }

  /** A combatant added to the scene (03): one gone before (04) is back, a new one to count. */
  onAdd(id: string, time: number): boolean {
    if (!this.encounter || !this.removed.delete(id)) return false;
    if (this.hit.has(id)) this.returned.add(id);
    return this.keep({ kind: "added", id, time, hp: this.hp() });
  }

  private hp(): number {
    return this.encounter?.boss?.hpPercent ?? 100;
  }

  /** Keeps a line and, if it is about an enemy the players hit, works the windows out again. Returns whether they changed. */
  private keep(input: PhaseInput): boolean {
    const enc = this.encounter;
    if (!enc) return false;
    this.inputs.push(input);
    if (!this.hit.has(input.id)) return false;
    const next = untargetableWindows(this.inputs, this.hit);
    const same =
      next.length === enc.untargetable.length &&
      next.every((w, i) => {
        const was = enc.untargetable[i]!;
        return w.start === was.start && w.end === was.end && w.hpBefore === was.hpBefore && w.hpAfter === was.hpAfter;
      });
    if (same) return false;
    enc.untargetable.splice(0, enc.untargetable.length, ...next);
    return true;
  }
}
