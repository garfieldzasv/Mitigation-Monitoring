import { isPermanentStatus } from "../game/statuses";
import type { GainEffectEvent, LoseEffectEvent } from "../logline/parse";

/**
 * A status's role in a hit. Target side: mitigation, shield, vulnerability, invuln. Source side:
 * damageDown (Reprisal and the like), damageUp. Everything else is "other".
 */
export type StatusCategory = "mitigation" | "shield" | "vulnerability" | "invuln" | "damageDown" | "damageUp" | "other";

export type StatusSide = "target" | "source";

/** One status on one entity, as of a hit. Kept with the row; later status changes never touch it. */
export interface StatusSnap {
  id: number;
  name: string;
  stacks: number;
  /** Infinity for statuses without a duration. */
  remainingMs: number;
  sourceId: string;
  sourceName: string;
  category: StatusCategory;
  /**
   * Taken from another combatant with the same name (the boss, for a hit from one of its helper
   * actors). The game does apply it to the helper's damage (verified in M3, docs/DESIGN.md 5.4).
   */
  inherited?: true;
  /** The damage modifier bytes its put-on line gave (LogGuide; findAppliedStatusParams): signed percent. */
  params?: StatusParams;
}

export interface StatusParams {
  first: number;
  second: number;
}

interface ActiveStatus {
  id: number;
  name: string;
  stacks: number;
  sourceId: string;
  sourceName: string;
  expiresAt: number;
  /** When its last 26 line came. */
  sentAt: number;
  params?: StatusParams;
}

/**
 * A put-on line's bytes wait this long for the status's 26 line, from the same source (Triggevent's pre-applications:
 * by source, target and status, dropped after 5 s).
 */
const PARAMS_WAIT_MS = 5000;

/** The same source: the same ID, or a helper actor and its boss (the same name). */
const sameSource = (a: { sourceId?: string; id?: string; sourceName?: string; name?: string }, b: { sourceId: string; sourceName: string }) =>
  (a.sourceId ?? a.id) === b.sourceId || (!!(a.sourceName ?? a.name) && (a.sourceName ?? a.name) === b.sourceName);

/**
 * A status on an entity whose 30 lines may never come — a player outside the party: the ACT plugin sees their status
 * list only now and then (a 24-player duty's other alliances) — is gone this long after its time ran out, as souma's
 * 减伤记录 keeps statuses (3 s).
 */
export const UNOBSERVED_GRACE_MS = 3000;

/** A duration this long is "until removed" (Triggevent: over 9,000 s is indefinite; 9999 in the logs). */
const INDEFINITE_DURATION_S = 9000;
/** A refresh adds more than this to the time left (lines carry 0.01 s). */
const EXTENDS_MS = 500;

/**
 * The time a status from a 26 line shows, in ms (the status itself lasts until its 30 line, whatever this says);
 * Infinity, no countdown, for those the game data marks permanent (IsPermanent: shown without a timer — 关心 says
 * 60 s and is re-sent every 3 s; a bard's song, 节制, standing in 野战治疗阵 are re-sent every 3 s with a few seconds
 * while their effect lasts) and indefinite durations (Triggevent's rule).
 */
export function statusDurationMs(durationSeconds: number, statusId: number): number {
  if (durationSeconds > INDEFINITE_DURATION_S || isPermanentStatus(statusId)) return Number.POSITIVE_INFINITY;
  return Math.max(0, durationSeconds) * 1000;
}

/**
 * Statuses on every entity, from 26 / 30 lines, following what the game says rather than modelling
 * its rules (docs/DESIGN.md 5.4, checked against 18 CN logs). A status lasts until its 30 line (the ACT plugin
 * writes one when the entity's status list shows it gone), until the entity is removed (04), or until a wipe or a
 * zone change clears everything — as Triggevent and cactbot oopsy keep them; its duration is only the countdown
 * shown:
 * - a caster's status replacing another caster's (a second Reprisal) comes as a 30 for the old one,
 *   then a 26 with the full duration;
 * - a 26 always carries the duration from then on: full when refreshed, the time left when the game
 *   only re-sends the status (a shield partly absorbed);
 * - a cast that does not overwrite (a weaker shield on a stronger one) sends no 26 at all.
 * Keyed by status and source: a few statuses do coexist from two casters (two white mages'
 * 告解); which one applies is the mitigation model's job.
 */
export class StatusTracker {
  private readonly byEntity = new Map<string, Map<string, ActiveStatus>>();
  /**
   * Bytes from put-on lines whose 26 line has not come yet, by entity and status, with the line's source: the 26 line
   * of the same source takes them — the same ID, or the same name (a duty's helper actor casts what its boss's 26
   * line names).
   */
  private readonly pendingParams = new Map<string, { params: StatusParams; time: number; sourceId: string; sourceName: string }>();

  constructor(
    private readonly categoryOf: (statusId: number, side: StatusSide) => StatusCategory,
    /** Maps a 26 line's count field to real stacks (it carries other data for non-stacking statuses). */
    private readonly stacksOf: (statusId: number, count: number) => number = (_, count) => count,
    /** Whether an entity's statuses last until their 30 line (the party, enemies); else until their time and UNOBSERVED_GRACE_MS. */
    private readonly observed: (entityId: string) => boolean = () => true,
  ) {}

  /** Returns whether the status was put on (new, or extended): a re-send that only carries the time left (a shield absorbing) or a stack change is not. */
  gain(e: GainEffectEvent): boolean {
    let statuses = this.byEntity.get(e.targetId);
    if (!statuses) {
      statuses = new Map();
      this.byEntity.set(e.targetId, statuses);
    }
    const key = `${e.effectId}:${e.sourceId}`;
    const before = statuses.get(key);
    const durationMs = statusDurationMs(e.duration, e.effectId);
    const putOn = !before || before.expiresAt <= e.time || durationMs > before.expiresAt - e.time + EXTENDS_MS;
    // The bytes of the line that put it on. A re-send (a shield absorbing, a stack change, a permanent status re-sent)
    // keeps the ones it had; put on again with no such line, its value is unknown — another action may have put it on.
    const pending = this.pendingParams.get(`${e.targetId}|${e.effectId}`);
    const waiting = pending && sameSource(pending, e) && e.time - pending.time <= PARAMS_WAIT_MS ? pending : undefined;
    if (waiting) this.pendingParams.delete(`${e.targetId}|${e.effectId}`);
    const params = waiting ? waiting.params : putOn ? undefined : before?.params;
    statuses.set(key, {
      id: e.effectId,
      name: e.effectName,
      stacks: this.stacksOf(e.effectId, e.stacks),
      sourceId: e.sourceId,
      sourceName: e.sourceName,
      expiresAt: e.time + durationMs,
      sentAt: e.time,
      ...(params ? { params } : {}),
    });
    return putOn;
  }

  /** A 21/22 line of `source` put this status on (0x0E / 0x0F) with these bytes: its 26 line follows. */
  paramsFor(entityId: string, statusId: number, params: StatusParams, time: number, source: { id: string; name: string }): void {
    for (const [k, v] of this.pendingParams) if (time - v.time > PARAMS_WAIT_MS) this.pendingParams.delete(k);
    this.pendingParams.set(`${entityId}|${statusId}`, { params, time, sourceId: source.id, sourceName: source.name });
    // A 26 line of the same source that came first (the same moment) takes them now: the latest one sent.
    let latest: ActiveStatus | undefined;
    for (const active of this.byEntity.get(entityId)?.values() ?? []) {
      if (active.id === statusId && sameSource(source, active) && Math.abs(active.sentAt - time) <= PARAMS_WAIT_MS && (!latest || active.sentAt > latest.sentAt)) latest = active;
    }
    if (latest) latest.params = params;
  }

  lose(e: LoseEffectEvent): void {
    this.byEntity.get(e.targetId)?.delete(`${e.effectId}:${e.sourceId}`);
  }

  /** This status from this source on `entityId` at `now`, if it is still on (no 30 line yet). */
  active(entityId: string, statusId: number, sourceId: string, now: number): { remainingMs: number; stacks: number } | undefined {
    const s = this.byEntity.get(entityId)?.get(`${statusId}:${sourceId}`);
    if (!s || this.gone(entityId, s, now)) return undefined;
    return { remainingMs: Math.max(0, s.expiresAt - now), stacks: s.stacks };
  }

  /** Gone without its 30 line: only on an entity whose 30 lines may never come. */
  private gone(entityId: string, s: ActiveStatus, now: number): boolean {
    return s.expiresAt + UNOBSERVED_GRACE_MS < now && !this.observed(entityId);
  }

  /** When a status from this 26 line is gone without a 30 line: never, on an entity whose 30 lines come. */
  endsAt(entityId: string, startedAt: number, durationMs: number): number {
    return this.observed(entityId) ? Number.POSITIVE_INFINITY : startedAt + durationMs + UNOBSERVED_GRACE_MS;
  }

  removeEntity(id: string): void {
    this.byEntity.delete(id);
  }

  clear(): void {
    this.byEntity.clear();
    this.pendingParams.clear();
  }

  /** Statuses on `entityId` at `now`, categorised for the side of the hit the entity is on. */
  snapshot(entityId: string, now: number, side: StatusSide): StatusSnap[] {
    const statuses = this.byEntity.get(entityId);
    if (!statuses) return [];
    const snaps: StatusSnap[] = [];
    for (const [key, s] of statuses) {
      if (this.gone(entityId, s, now)) {
        statuses.delete(key);
        continue;
      }
      snaps.push({
        id: s.id,
        name: s.name,
        stacks: s.stacks,
        remainingMs: Math.max(0, s.expiresAt - now),
        sourceId: s.sourceId,
        sourceName: s.sourceName,
        category: this.categoryOf(s.id, side),
        ...(s.params ? { params: s.params } : {}),
      });
    }
    return snaps;
  }
}
