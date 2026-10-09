import { isPlayerId } from "../combatants/registry";
import { isDamageTaken } from "../engine/damageRecorder";
import type { Engine, ShieldUsedUp } from "../engine/engine";
import { defensiveTimerOf } from "../game/defensives";
import { effectiveStacks, statusCategory } from "../game/statuses";
import type { AbilityEvent, GameEvent, TickEvent } from "../logline/parse";
import { statusDurationMs, type StatusCategory } from "../status/statusTracker";

export interface Actor {
  id: string;
  name: string;
}

/** HP restored to a player (docs/DESIGN.md 5.8). */
export interface HealEvent {
  kind: "heal" | "hot";
  time: number;
  target: Actor;
  /** Empty for HoT ticks: the 24 line's source names the target itself or a random player (5.8). */
  source: Actor & { ownerName?: string };
  /** A HoT tick names its status only when the game says which one ticked (rarely). */
  action: { id: number; name: string };
  amount: number;
  /** HP when the heal snapshotted. */
  hpBefore: number;
  maxHp: number;
  /** Beyond what the player was missing at the snapshot: an estimate, HP moves in between. */
  overheal: number;
}

/**
 * What happened to a status on a player (docs/DESIGN.md 5.4):
 * - gain: it was not on; refresh: it was, and the duration was extended;
 * - stacks: re-sent with a new stack count, the duration unchanged;
 * - unapplied: a cast meant to apply it did not take, as a weaker shield on a stronger one (the
 *   existing one keeps its duration);
 * - lose: removed.
 * A 26 line that changes neither duration nor stacks (the game re-sending a shield as it absorbs
 * damage) is no change and is not recorded.
 */
export interface StatusChange {
  time: number;
  target: Actor;
  status: { id: number; name: string };
  stacks: number;
  /** `ownerId`: the player a pet or summon that applied it belongs to (炽天使's 炽天的幕帘 is the scholar's). */
  source: Actor & { ownerId?: string };
  change: "gain" | "refresh" | "stacks" | "unapplied" | "lose";
  /** The duration from then on (Infinity: until removed); for "unapplied", what the existing one has left; 0 when lost. */
  durationMs: number;
  /** On a player, what the status does to damage they take; on an enemy, to damage it deals. */
  category: StatusCategory;
}

/** A 26 line extends a status when its duration beats the time left by more than this (lines carry 0.01 s). */
const EXTENDED_MS = 500;

/** A non-player cast bar (20 lines; archives from before M5 have none). */
export interface NpcCast {
  time: number;
  source: Actor;
  action: { id: number; name: string };
  target: Actor;
  castMs: number;
  /** A 23 line ended it early ("Interrupted", "Cancelled"). */
  cancelled?: string;
}

/**
 * A player's action that applied statuses (or their pet's), once per 21/22 sequence: where the
 * timeline's spans start (docs/DESIGN.md 8.6). Actions applying nothing are not kept.
 */
export interface PlayerCast {
  time: number;
  /** The player: a pet's owner. */
  caster: Actor;
  action: { id: number; name: string };
  /** Statuses it applied (0x0E / 0x0F), on any of its targets. */
  applied: number[];
  /** The 21/22 sequence. */
  sequence: string;
  /** A pet cast it (the fairy's 异想的幻光 after the scholar's command). */
  byPet?: true;
  /**
   * Its caster's own 37 line of the same sequence (LogGuide: a 37 line is the action actually happening, matched by
   * sequence and target): when it came, and the statuses it lists. Beyond what the 21/22 line applied, the effect an
   * aura then keeps re-sending (节制's line applies the healer's 1872, its 37 also lists the party's 1873), but also
   * statuses the caster already had (docs/DESIGN.md 8.6).
   */
  synced?: { time: number; ids: number[] };
}

/**
 * A player's use of an action that spends a mitigation skill's recast timer (docs/DESIGN.md 8.2), whatever it applied:
 * once per 21/22 sequence. The player's own line: a pet's action follows its owner's command (the scholar's 异想的幻光,
 * then the fairy's), and the command is what spends the timer.
 */
export interface SkillUse {
  time: number;
  caster: Actor;
  action: { id: number; name: string };
}

export interface HpPoint {
  time: number;
  hp: number;
  maxHp: number;
  /** Shield in % of max HP: the last 37 line's, carried forward. */
  shieldPercent: number;
}

/** A cast's own 37 line comes this soon after its 21/22 line (0.6 s for 节制 and 野战治疗阵). */
const SYNC_MS = 3000;

/** The 22 lines of one AOE come together; past this they are another cast. */
const SAME_CAST_LINES_MS = 1000;

/** A 23 line ends the cast it names: the latest of that action by that source, if it was still being cast (its own 20 line gives how long). */

/**
 * What the review needs beyond damage rows (docs/DESIGN.md 5.8, the "full mode"): heals, status
 * changes and HP of players, and enemy casts. Fed each event right BEFORE the engine handles it, so
 * the engine's state is the state the event applies to: a 26 line is a refresh when the engine
 * still has that status. Only the review builds one; the monitor never pays for it.
 */
export class ReplayDetail {
  readonly heals: HealEvent[] = [];
  /** On players. */
  readonly statusChanges: StatusChange[] = [];
  /**
   * On enemies, the ones that change the damage they deal: players' debuffs (雪仇, 昏乱…) and their
   * own damage-ups. For the timeline (docs/DESIGN.md 8.6); the same rules as on players.
   */
  readonly enemyStatusChanges: StatusChange[] = [];
  /** Every non-player cast bar; `enemyCasts()` keeps the hostile ones. */
  readonly casts: NpcCast[] = [];
  /** In time order. */
  readonly playerCasts: PlayerCast[] = [];
  /** In line order: the pre-pull snapshot's put-on lines come first, older than the last seconds before the pull. */
  readonly skillUses: SkillUse[] = [];
  /** When every recast timer resets: a wipe (33), a zone change. */
  readonly timerResets: number[] = [];
  /** Shields on players that hits used up, as the engine's shield account decides (docs/DESIGN.md 8.2 refunds). */
  readonly shieldsUsedUp: ShieldUsedUp[] = [];
  private readonly usedSequences = new Set<string>();
  private readonly hpByPlayer = new Map<string, HpPoint[]>();
  private readonly shield = new Map<string, number>();
  /** Names of non-players that damaged a player. */
  private readonly hostile = new Set<string>();

  constructor(private readonly engine: Engine) {
    engine.onShieldUsedUp = (lost) => this.shieldsUsedUp.push(lost);
  }

  /** The player's HP and shield over time, in time order. */
  hpOf(playerId: string): readonly HpPoint[] {
    return this.hpByPlayer.get(playerId) ?? [];
  }

  /**
   * Casts by whoever dealt damage taken (isDamageTaken) at some point, matched by name so a boss's
   * invisible helpers count with it. Owners cannot tell sides: chocobos and trust NPCs are owned by
   * the player, and so are the enemies spawned for them in the open world.
   */
  enemyCasts(): NpcCast[] {
    return this.casts.filter((c) => this.hostile.has(c.source.name));
  }

  handle(e: GameEvent): void {
    switch (e.type) {
      case "ability":
        if (isDamageTaken(e)) this.hostile.add(e.sourceName);
        if (e.heal) this.onHeal(e);
        if (e.unapplied) this.onUnapplied(e);
        if (e.applied) this.onApplied(e);
        if (isPlayerId(e.sourceId) && defensiveTimerOf(e.actionId)) this.onSkillUse(e);
        break;
      case "tick":
        this.onTick(e);
        break;
      case "gainEffect": {
        const into = this.statusList(e.targetId, e.effectId);
        if (!into) break;
        const before = this.engine.statuses.active(e.targetId, e.effectId, e.sourceId, e.time);
        const durationMs = statusDurationMs(e.duration, e.effectId);
        const stacks = effectiveStacks(e.effectId, e.stacks);
        const change: StatusChange["change"] | undefined = !before
          ? "gain"
          : durationMs > before.remainingMs + EXTENDED_MS
            ? "refresh"
            : stacks !== before.stacks
              ? "stacks"
              : undefined;
        if (!change) break; // re-sent, nothing changed
        into.list.push({
          time: e.time,
          target: { id: e.targetId, name: e.targetName },
          status: { id: e.effectId, name: e.effectName },
          stacks,
          source: this.statusSource(e.sourceId, e.sourceName),
          change,
          durationMs,
          category: into.category,
        });
        break;
      }
      case "loseEffect": {
        const into = this.statusList(e.targetId, e.effectId);
        if (!into) break;
        into.list.push({
          time: e.time,
          target: { id: e.targetId, name: e.targetName },
          status: { id: e.effectId, name: e.effectName },
          stacks: 0,
          source: this.statusSource(e.sourceId, e.sourceName),
          change: "lose",
          durationMs: 0,
          category: into.category,
        });
        break;
      }
      case "cast":
        if (isPlayerId(e.sourceId)) break;
        this.casts.push({
          time: e.time,
          source: { id: e.sourceId, name: e.sourceName },
          action: { id: e.actionId, name: e.actionName },
          target: { id: e.targetId, name: e.targetName },
          castMs: e.castMs,
        });
        break;
      case "cancel": {
        // The latest cast of this action by this source, however many shorter casts came after it.
        for (let i = this.casts.length - 1; i >= 0; i--) {
          const c = this.casts[i]!;
          if (c.source.id === e.sourceId && c.action.id === e.actionId) {
            if (e.time <= c.time + c.castMs + 1000) c.cancelled = e.reason || "Cancelled";
            break;
          }
        }
        break;
      }
      case "effectResult":
        if (!isPlayerId(e.targetId)) break;
        if (e.statuses?.length) this.onSynced(e.time, e.targetId, e.sequence, e.statuses.map((x) => x.id));
        // The short form of the line has the HP only: the shield and max HP stay as last known.
        if (e.shieldPercent !== undefined) this.shield.set(e.targetId, e.shieldPercent);
        this.point(e.targetId, e.time, e.currentHp, e.maxHp || (this.hpOf(e.targetId).at(-1)?.maxHp ?? 0));
        break;
      case "hp":
        if (isPlayerId(e.id)) this.point(e.id, e.time, e.hp, e.maxHp);
        break;
      case "death":
        if (!isPlayerId(e.targetId)) break;
        this.shield.set(e.targetId, 0);
        this.point(e.targetId, e.time, 0, this.hpOf(e.targetId).at(-1)?.maxHp ?? 0);
        break;
      case "zone":
        this.shield.clear();
        this.timerResets.push(e.time);
        break;
      case "wipe":
        this.timerResets.push(e.time);
        break;
      default:
        break;
    }
  }

/** A player's (or pet's) action that applied statuses; the lines of one AOE (one sequence) make one cast. */
  private onApplied(e: AbilityEvent): void {
    const source = this.statusSource(e.sourceId, e.sourceName, e.ownerId);
    if (!isPlayerId(source.ownerId ?? source.id)) return;
    const caster = source.ownerId ? { id: source.ownerId, name: this.engine.registry.get(source.ownerId)?.name ?? "" } : { id: source.id, name: source.name };
    for (let i = this.playerCasts.length - 1; i >= 0 && e.time - this.playerCasts[i]!.time <= SAME_CAST_LINES_MS; i--) {
      const c = this.playerCasts[i]!;
      if (c.sequence !== e.sequence || c.caster.id !== caster.id) continue;
      for (const id of e.applied!) if (!c.applied.includes(id)) c.applied.push(id);
      return;
    }
    this.playerCasts.push({ time: e.time, caster, action: { id: e.actionId, name: e.actionName }, applied: [...e.applied!], sequence: e.sequence, ...(source.ownerId ? { byPet: true as const } : {}) });
  }

  /** A player's own 37 line of one of their casts: the statuses it lists belong to that cast. */
  private onSynced(time: number, playerId: string, sequence: string, ids: readonly number[]): void {
    for (let i = this.playerCasts.length - 1; i >= 0 && time - this.playerCasts[i]!.time <= SYNC_MS; i--) {
      const c = this.playerCasts[i]!;
      if (c.sequence !== sequence || c.caster.id !== playerId) continue;
      c.synced = { time: c.synced?.time ?? time, ids: [...new Set([...(c.synced?.ids ?? []), ...ids.filter((id) => id > 0)])] };
      return;
    }
  }

  private onSkillUse(e: AbilityEvent): void {
    const key = `${e.sourceId}|${e.sequence}`;
    if (this.usedSequences.has(key)) return; // an AOE's other targets
    this.usedSequences.add(key);
    this.skillUses.push({ time: e.time, caster: { id: e.sourceId, name: e.sourceName }, action: { id: e.actionId, name: e.actionName } });
  }

  /** Where a status change on this entity goes, and its category there; undefined when it is not collected. */
  private statusList(targetId: string, statusId: number): { list: StatusChange[]; category: StatusCategory } | undefined {
    if (isPlayerId(targetId)) return { list: this.statusChanges, category: statusCategory(statusId, "target") };
    const category = statusCategory(statusId, "source");
    return category === "other" ? undefined : { list: this.enemyStatusChanges, category };
  }

  /** A 21/22 line names the owner itself (`lineOwnerId`); 26/30 lines do not, the registry knows it from the 03 line. */
  private statusSource(id: string, name: string, lineOwnerId?: string): StatusChange["source"] {
    const ownerId = isPlayerId(id) ? undefined : this.engine.registry.ownerOf(id, lineOwnerId);
    return ownerId && isPlayerId(ownerId) ? { id, name, ownerId } : { id, name };
  }

  private onHeal(e: AbilityEvent): void {
    const heal = e.heal!;
    const ownerId = this.engine.registry.ownerOf(e.sourceId, e.ownerId);
    const ownerName = ownerId && ownerId !== e.sourceId ? this.engine.registry.get(ownerId)?.name : undefined;
    const source = { id: e.sourceId, name: e.sourceName, ...(ownerName ? { ownerName } : {}) };
    const action = { id: e.actionId, name: e.actionName };
    if (heal.toTarget > 0 && isPlayerId(e.targetId)) {
      this.heals.push(healEvent("heal", e.time, { id: e.targetId, name: e.targetName }, source, action, heal.toTarget, e.targetHp, e.targetMaxHp));
    }
    if (heal.toSource > 0 && isPlayerId(e.sourceId)) {
      this.heals.push(healEvent("heal", e.time, { id: e.sourceId, name: e.sourceName }, source, action, heal.toSource, e.sourceHp, e.sourceMaxHp));
    }
  }

  /** A cast whose status did not take: named after the status already on the player that kept it out. */
  private onUnapplied(e: AbilityEvent): void {
    for (const u of e.unapplied!) {
      const recipient = u.onSource ? { id: e.sourceId, name: e.sourceName } : { id: e.targetId, name: e.targetName };
      if (!isPlayerId(recipient.id)) continue;
      const existing = this.engine.statuses.snapshot(recipient.id, e.time, "target").find((s) => s.id === u.statusId);
      this.statusChanges.push({
        time: e.time,
        target: recipient,
        status: { id: u.statusId, name: existing?.name ?? e.actionName },
        stacks: 0,
        source: this.statusSource(e.sourceId, e.sourceName, e.ownerId),
        change: "unapplied",
        durationMs: existing?.remainingMs ?? 0,
        category: statusCategory(u.statusId, "target"),
      });
    }
  }

  private onTick(e: TickEvent): void {
    if (!isPlayerId(e.targetId)) return;
    const target = { id: e.targetId, name: e.targetName };
    if (e.kind === "hot") {
      const status = e.effectId ? this.engine.statuses.snapshot(e.targetId, e.time, "target").find((s) => s.id === e.effectId) : undefined;
      const action = { id: e.effectId, name: status?.name || "持续治疗" };
      this.heals.push(healEvent("hot", e.time, target, { id: "", name: "" }, action, e.amount, e.targetHp, e.targetMaxHp));
      this.point(e.targetId, e.time, e.targetHp, e.targetMaxHp);
      this.point(e.targetId, e.time, Math.min(e.targetMaxHp, e.targetHp + e.amount), e.targetMaxHp);
    } else {
      this.point(e.targetId, e.time, e.targetHp, e.targetMaxHp);
      this.point(e.targetId, e.time, Math.max(0, e.targetHp - e.amount), e.targetMaxHp);
    }
  }

  private point(playerId: string, time: number, hp: number, maxHp: number): void {
    if (maxHp <= 0) return;
    let points = this.hpByPlayer.get(playerId);
    if (!points) {
      points = [];
      this.hpByPlayer.set(playerId, points);
    }
    points.push({ time, hp, maxHp, shieldPercent: this.shield.get(playerId) ?? 0 });
  }
}

function healEvent(
  kind: HealEvent["kind"],
  time: number,
  target: Actor,
  source: HealEvent["source"],
  action: HealEvent["action"],
  amount: number,
  hpBefore: number,
  maxHp: number,
): HealEvent {
  const missing = Math.max(0, maxHp - hpBefore);
  return { kind, time, target, source, action, amount, hpBefore, maxHp, overheal: Math.max(0, amount - missing) };
}
