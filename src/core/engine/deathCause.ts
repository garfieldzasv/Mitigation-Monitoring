import type { DeathReason } from "../game/deathReasons";

/**
 * What killed a player when no blow did (docs/DESIGN.md 5.7), from what the log says of it: an action whose 21/22
 * line carries the instant-death effect (0x33, LogGuide "Effect Types"), or a death reason cactbot annotates for the
 * zone (an ability that knocks off the arena or into its wall, a status). A 25 line naming no killer (E0000000) with
 * no blow shown to kill is 地形杀, as souma's 减伤记录 has it (engine.ts).
 */

/** An annotated death reason holds this long (oopsy's death report window). */
const REASON_WINDOW_MS = 20000;

/** A death reason cactbot annotates, as it happened to a player: when, cactbot's kind and text. */
export interface AnnotatedReason extends DeathReason {
  time: number;
}

/** An action whose effect on a player was instant death. */
export interface InstantKill {
  time: number;
  actionName: string;
  sourceName: string;
}

/** When a player's HP went to 0 (from above), and their last HP update above 0 before that. */
export interface HpZero {
  at: number;
  aliveBefore?: number;
}

export class DeathCauses {
  /** When each player's HP went to 0 (from above), latest last. */
  private readonly zeros = new Map<string, HpZero[]>();
  private readonly lastHp = new Map<string, number>();
  /** Each player's last HP update above 0. */
  private readonly alive = new Map<string, number>();
  /** Each player's last death (25 line). */
  private readonly deaths = new Map<string, number>();
  private readonly kills = new Map<string, InstantKill[]>();
  /** Each player's last cactbot-annotated death reason, until damage comes after it. */
  private readonly reasons = new Map<string, AnnotatedReason>();

  /** A player's HP (37, 38, 39 lines: updates, never stale). */
  hp(id: string, time: number, hp: number): void {
    const before = this.lastHp.get(id);
    this.lastHp.set(id, hp);
    if (hp > 0) {
      this.alive.set(id, time);
      return;
    }
    if (before === 0) return;
    const zero: HpZero = { at: time, ...(this.alive.has(id) ? { aliveBefore: this.alive.get(id)! } : {}) };
    const list = this.zeros.get(id);
    if (!list) this.zeros.set(id, [zero]);
    else {
      list.push(zero);
      if (list.length > 8) list.shift();
    }
  }

  /** The player's HP going to 0 behind a 25 line: the last time it did, at or before the line, since the last death. */
  zeroBefore(id: string, time: number): HpZero | undefined {
    const list = this.zeros.get(id) ?? [];
    const since = this.deaths.get(id) ?? Number.NEGATIVE_INFINITY;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.at <= time) return list[i]!.at > since ? list[i] : undefined;
    return undefined;
  }

  /** A player died (25 line): what came before belongs to that death. */
  died(id: string, time: number): void {
    this.deaths.set(id, time);
  }

  /**
   * cactbot annotates what just happened to a player as a death reason (an ability that knocks off the arena, a status):
   * a death within REASON_WINDOW_MS is that, unless damage came after it (oopsy's death report).
   */
  annotate(id: string, reason: AnnotatedReason): void {
    this.reasons.set(id, reason);
  }

  /** An ability's damage reached the player: an annotated reason before it no longer says what killed. */
  damaged(id: string): void {
    this.reasons.delete(id);
  }

  /** The annotated reason behind a 25 line, if one holds. */
  annotatedReason(id: string, deathTime: number): AnnotatedReason | undefined {
    const r = this.reasons.get(id);
    return r && r.time <= deathTime && deathTime - r.time <= REASON_WINDOW_MS ? r : undefined;
  }

  /** An action's effect on a player was instant death (0x33). */
  instantKill(targetId: string, kill: InstantKill): void {
    const list = this.kills.get(targetId) ?? [];
    list.push(kill);
    while (list.length > 4) list.shift();
    this.kills.set(targetId, list);
  }

  /** The instant-death action behind a 25 line: the last one on the player at or before it, since their last death. */
  killedOutright(id: string, deathTime: number): InstantKill | undefined {
    const list = this.kills.get(id) ?? [];
    const since = this.deaths.get(id) ?? Number.NEGATIVE_INFINITY;
    for (let i = list.length - 1; i >= 0; i--) {
      const k = list[i]!;
      if (k.time <= deathTime) return k.time > since ? k : undefined;
    }
    return undefined;
  }

  /** Nothing is kept from before (a new zone). */
  clear(): void {
    this.zeros.clear();
    this.lastHp.clear();
    this.alive.clear();
    this.deaths.clear();
    this.kills.clear();
    this.reasons.clear();
  }
}
