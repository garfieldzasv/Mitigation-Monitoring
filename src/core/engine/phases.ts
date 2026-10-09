import { isPlayerId } from "../combatants/registry";
import type { AbilityEvent } from "../logline/parse";
import type { Encounter, UntargetableWindow } from "./types";

/**
 * Phases (docs/DESIGN.md 5.9), from the stretches when the players had nothing to hit — found as xivanalysis finds
 * downtime: the enemies the players have targeted (each counts from when a player's action first lands on it), each
 * targetable or not as its 34 lines say, and untargetable once dead (25) or gone (04). A window opens when every one
 * of them is untargetable and closes when one is targetable again (or a new one is targeted). No shortest window, no
 * HP threshold: neither xivanalysis nor cactbot uses one. Fights split at the windows into stretches 在场 and 离场.
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
 * Follows the running encounter: its main boss (the players' biggest target) and its HP, and the windows during
 * which every enemy the players targeted was untargetable. Writes them onto the encounter (`boss`, `untargetable`),
 * which keeps them in archives' replays too.
 */
export class PhaseTracker {
  private encounter: Encounter | null = null;
  /** The enemies the players have targeted, and whether each can be targeted now. */
  private readonly engaged = new Map<string, boolean>();

  start(encounter: Encounter): void {
    this.encounter = encounter;
    this.engaged.clear();
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

  /** A player's action on an enemy: the main boss and its HP; the enemy counts from now on. Returns whether anything changed. */
  onAbility(e: AbilityEvent): boolean {
    const enc = this.encounter;
    if (!enc || !isPlayerId(e.sourceId) || isPlayerId(e.targetId) || e.targetMaxHp <= 0) return false;
    let changed = false;
    if (!enc.boss || e.targetMaxHp > enc.boss.maxHp) {
      enc.boss = { id: e.targetId, name: e.targetName, maxHp: e.targetMaxHp, hpPercent: (e.targetHp / e.targetMaxHp) * 100 };
      changed = true;
    }
    if (e.targetId === enc.boss.id) enc.boss.hpPercent = (e.targetHp / e.targetMaxHp) * 100;
    if (!this.engaged.has(e.targetId)) {
      this.engaged.set(e.targetId, true);
      changed = this.update(e.time) || changed;
    }
    return changed;
  }

  /** A 34 line. Returns whether a window opened or closed. */
  onTargetable(id: string, targetable: boolean, time: number): boolean {
    if (!this.encounter || !this.engaged.has(id)) return false;
    this.engaged.set(id, targetable);
    return this.update(time);
  }

  /** An enemy died (25): it can no longer be targeted. */
  onDeath(id: string, time: number): boolean {
    if (!this.encounter || !this.engaged.has(id)) return false;
    this.engaged.set(id, false);
    return this.update(time);
  }

  /** A combatant gone (04): no longer one to target. */
  onRemove(id: string, time: number): boolean {
    return this.onDeath(id, time);
  }

  /** Opens a window when nothing engaged can be targeted, closes it when something can. */
  private update(time: number): boolean {
    const enc = this.encounter;
    if (!enc) return false;
    const open = enc.untargetable.at(-1)?.end === undefined ? enc.untargetable.at(-1) : undefined;
    const anyTargetable = [...this.engaged.values()].some(Boolean);
    const hp = enc.boss?.hpPercent ?? 100;
    if (!open && this.engaged.size > 0 && !anyTargetable) {
      enc.untargetable.push({ start: time, hpBefore: hp } satisfies UntargetableWindow);
      return true;
    }
    if (open && anyTargetable) {
      open.end = time;
      open.hpAfter = hp;
      return true;
    }
    return false;
  }
}
