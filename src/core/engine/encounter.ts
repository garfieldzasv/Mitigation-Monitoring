import { isPlayerId } from "../combatants/registry";
import type { GameEvent } from "../logline/parse";
import type { PartyState } from "../party/partyState";
import type { EncounterResult } from "./types";

export type EncounterBoundary =
  | { kind: "start"; time: number }
  | { kind: "end"; time: number; result: EncounterResult }
  /** The encounter that just ended turned out a clear or a wipe: its 33 line came after the 260 line ended it. */
  | { kind: "result"; time: number; result: EncounterResult };

/** No new encounter starts this soon after one ended: belated lines of a wipe (cactbot oopsy: 5 s). */
const RESTART_MS = 5000;

/** Who "we" are: the player and their own party (not the rest of an alliance, not the players around). */
export interface OurSide {
  /** The player's own id, once known. */
  readonly selfId: string | undefined;
  /** The player or a member of their own party. */
  has(id: string): boolean;
}

/** The player and their own party as the engine knows them (OverlayPlugin events, or 02 / 11 lines). */
export function ourSide(party: PartyState): OurSide {
  return {
    get selfId() {
      return party.selfId;
    },
    has: (id) => id === party.selfId || party.get(id)?.inParty === true,
  };
}

/**
 * Splits the event stream into encounters (docs/DESIGN.md 5.3): the fights of the player and their party, as cactbot
 * does (oopsy and raidboss follow the game's own combat state, `inGameCombat`). Independent of the rest of the engine
 * so a log file can be cut into encounters with the same rules (9.5).
 *
 * ACT's combat state starts nothing: it "may include other people around you and not yourself" (LogGuide, 260), and
 * in the open world other players' fights would start encounters as soon as the player arrives. Nor does another
 * player's damage.
 *
 * - start: the game says the player is in combat (260), or the first damage between the player or a member of their
 *   party and an enemy, whichever comes first (oopsy starts on the first attack line); not within RESTART_MS of an end.
 * - end: the game says the player left combat (260, its game state changed to out), unless the player is dead — a
 *   dead player's combat state says nothing about the party's fight; or both ACT and the game are out of combat (a
 *   fight of the party the player never joined); a victory or wipe (33); a zone change. A 260 line can come after lines
 *   stamped later than it (the ACT plugin writes it late): one stamped before the pull started says how things stood
 *   before it, and ends nothing.
 * - result: a victory command makes it a clear, a wipe command a wipe; one after an encounter ended by combat dropping
 *   (out of combat can come before the victory: Triggevent) decides its result too, until the next one starts or the
 *   zone changes.
 */
export class EncounterTracker {
  private active = false;
  private startedAt = Number.NEGATIVE_INFINITY;
  private lastEnd = Number.NEGATIVE_INFINITY;
  /** A replay: the archived pull starts on the first event at this time; nothing starts before it. */
  private archivedStart: number | undefined;
  /** The encounter that ended last, while its result can still change. */
  private ended: { time: number; result: EncounterResult } | undefined;
  /** The player is dead: a 25 line for them, and no HP above 0 since. */
  private selfDead = false;

  /** `side`: who "we" are; without one (a log file cut without its party), the player and every other player. */
  constructor(private readonly side?: OurSide) {}

  /** Returns the boundary this event crosses, if any. */
  onEvent(e: GameEvent): EncounterBoundary | undefined {
    this.observe(e);
    if (this.archivedStart !== undefined) {
      if (e.time < this.archivedStart) return undefined;
      const time = this.archivedStart;
      this.archivedStart = undefined;
      // The archive holds the line its pull started on; without one there (a broken archive) none is made up.
      if (e.time === time) return this.start(time);
    }
    switch (e.type) {
      case "combat":
        if (e.game) return this.maybeStart(e.time);
        if (!this.active || e.time < this.startedAt) return undefined;
        if ((e.gameChanged && !this.selfDead) || !e.act) return this.end(e.time, "unknown");
        return undefined;
      case "ability":
        return e.damage && this.ourFight(e.sourceId, e.targetId) ? this.maybeStart(e.time) : undefined;
      case "victory":
        return this.active ? this.end(e.time, "clear") : this.late(e.time, "clear");
      case "wipe":
        return this.active ? this.end(e.time, "wipe") : this.late(e.time, "wipe");
      case "zone": {
        const boundary = this.active ? this.end(e.time, "unknown") : undefined;
        this.ended = undefined;
        return boundary;
      }
      default:
        return undefined;
    }
  }

  /**
   * A replay of an archived pull: it starts on its first line at the archived start, whatever the rules say there (the
   * archive may come from older rules, and the monitor's suppression of restarts is not in its lines); its earlier
   * lines only set the state. From then on the rules apply as live.
   */
  startAt(time: number): void {
    this.archivedStart = time;
  }

  /** Whether the player is dead: their 25 line, until an HP reading above 0 (raised) or a zone change. */
  private observe(e: GameEvent): void {
    const self = this.side?.selfId;
    switch (e.type) {
      case "death":
        if (e.targetId === self) this.selfDead = true;
        break;
      case "effectResult":
        if (e.targetId === self && e.currentHp > 0) this.selfDead = false;
        break;
      case "statusList":
        if (e.targetId === self && e.maxHp > 0 && e.currentHp > 0) this.selfDead = false;
        break;
      case "hp":
        if (e.id === self && e.hp > 0) this.selfDead = false;
        break;
      case "zone":
        this.selfDead = false;
        break;
      default:
        break;
    }
  }

  /** Damage between the player or their party and an enemy (any player, without a side). */
  private ourFight(sourceId: string, targetId: string): boolean {
    const ours = (id: string) => (this.side ? this.side.has(id) : isPlayerId(id));
    return (ours(sourceId) && !isPlayerId(targetId)) || (ours(targetId) && !isPlayerId(sourceId));
  }

  private maybeStart(time: number): EncounterBoundary | undefined {
    if (this.active || time - this.lastEnd < RESTART_MS) return undefined;
    return this.start(time);
  }

  private start(time: number): EncounterBoundary {
    this.active = true;
    this.startedAt = time;
    this.ended = undefined;
    return { kind: "start", time };
  }

  private end(time: number, result: EncounterResult): EncounterBoundary {
    this.active = false;
    this.lastEnd = time;
    this.ended = { time, result };
    return { kind: "end", time, result };
  }

  private late(time: number, result: EncounterResult): EncounterBoundary | undefined {
    const ended = this.ended;
    if (!ended || ended.result !== "unknown") return undefined;
    ended.result = result;
    return { kind: "result", time, result };
  }
}
