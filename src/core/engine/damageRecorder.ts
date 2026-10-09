import { isPlayerId, type CombatantRegistry } from "../combatants/registry";
import { displayActionName, isAutoAttack } from "../game/actions";
import { isDamageOverTimeStatus, negatesDamage } from "../game/statuses";
import type { DamageEffect } from "../logline/effect";
import type { AbilityEvent, EffectResultEvent, TickEvent } from "../logline/parse";
import { computeMitigation } from "../mitigation/multiplier";
import type { PartyState } from "../party/partyState";
import type { StatusSnap, StatusTracker } from "../status/statusTracker";
import type { DamageRow, RowTarget } from "./types";

/** A hit with no 37 line of its own within this took no effect (Triggevent: unresolved for 10 s is a ghost). */
export const RESULT_TIMEOUT_MS = 10000;

export interface RecorderDeps {
  registry: CombatantRegistry;
  party: PartyState;
  statuses: StatusTracker;
}

const resultKey = (seq: string, targetId: string) => `${seq}:${targetId}`;

/**
 * Damage taken (docs/DESIGN.md 5.1): a damage effect on a player from anything that is not a
 * player. The source's owner is not consulted: enemies spawned for one player in the open world
 * (the 护领… mobs of FATEs and quests) carry that player as their owner, and no player's pet ever
 * damages a player in PvE — all 31 owned sources hitting players across our 18 sample logs were
 * enemies. The one place this rule lives; the review's enemy casts follow it too.
 */
export function isDamageTaken(e: AbilityEvent): e is AbilityEvent & { damage: DamageEffect } {
  return e.damage !== undefined && isPlayerId(e.targetId) && !isPlayerId(e.sourceId);
}

/**
 * Turns 21/22 and 24 lines into damage rows, and fills each row's HP-after
 * when its 37 line arrives (docs/DESIGN.md 5.1, 5.6). Rows come back with id 0 and offset 0; the
 * engine numbers them when it files them under an encounter.
 */
export class DamageRecorder {
  /** Rows waiting for their 37 line, by sequence and target (a multi-hit action has several). */
  private readonly pending = new Map<string, DamageRow[]>();
  /** Enemies a player's action has landed on: players can only target what can be targeted, so these are real combatants, not helper actors. */
  private readonly hitByPlayers = new Set<string>();

  constructor(private readonly deps: RecorderDeps) {}

  /** A row when the line is damage taken (isDamageTaken). */
  fromAbility(e: AbilityEvent): DamageRow | undefined {
    if (isPlayerId(e.sourceId) && !isPlayerId(e.targetId)) this.hitByPlayers.add(e.targetId);
    if (!isDamageTaken(e)) return undefined;
    const damage = e.damage;
    const targetStatuses = this.deps.statuses.snapshot(e.targetId, e.time, "target");
    const sourceStatuses = this.sourceStatuses(e.sourceId, e.sourceName, e.time);
    const target = this.target(e.targetId, e.targetName);
    const mitigation = computeMitigation({
      kind: "hit",
      damageType: damage.damageType,
      element: damage.element,
      result: damage.result,
      ...(damage.reduction !== undefined ? { reduction: damage.reduction } : {}),
      targetId: e.targetId,
      targetLevel: this.deps.party.get(e.targetId)?.level || this.deps.registry.get(e.targetId)?.level || 0,
      targetStatuses,
      sourceStatuses,
      casterHas: (casterId, ids) => this.deps.statuses.snapshot(casterId, e.time, "target").some((s) => ids.includes(s.id)),
    });
    const row: DamageRow = {
      kind: "hit",
      id: 0,
      time: e.time,
      offset: 0,
      seq: e.sequence,
      targetCount: e.targetCount,
      target,
      source: { id: e.sourceId, name: e.sourceName },
      action: { id: e.actionId, name: displayActionName(e.actionId, e.actionName) },
      autoAttack: isAutoAttack(e.actionId, e.actionName),
      amount: damage.amount,
      fullyAbsorbed: damage.amount === 0 && damage.result !== "miss" && targetStatuses.some((s) => s.category === "shield"),
      damageType: damage.damageType,
      attackType: damage.attackType,
      element: damage.element,
      ...(damage.shieldBits ? { shieldBits: damage.shieldBits } : {}),
      result: damage.result,
      crit: damage.crit,
      direct: damage.direct,
      invulnerable: damage.invulnerable === true || targetStatuses.some((s) => s.category === "invuln" && negatesDamage(s.id)),
      hpBefore: e.targetHp,
      maxHp: e.targetMaxHp,
      multiplier: mitigation.multiplier,
      multiplierPartial: mitigation.partial,
      mitigation: mitigation.terms,
      targetStatuses,
      sourceStatuses,
    };
    this.expire(e.time);
    if (row.seq) {
      const key = resultKey(row.seq, row.target.id);
      const rows = this.pending.get(key);
      if (rows) rows.push(row);
      else this.pending.set(key, [row]);
    }
    return row;
  }

  /**
   * A row for an enemy DoT tick on a player. The game rarely says which status ticked, and the
   * source field is unreliable: in our fixtures it names the target itself or another player far
   * more often than an enemy, so a player source is dropped.
   */
  fromTick(e: TickEvent): DamageRow | undefined {
    if (e.kind !== "dot" || !isPlayerId(e.targetId)) return undefined;
    const targetStatuses = this.deps.statuses.snapshot(e.targetId, e.time, "target");
    const knownSource = e.sourceId !== undefined && !isPlayerId(e.sourceId);
    const ticked = tickedStatus(e, targetStatuses);
    return {
      kind: "dot",
      id: 0,
      time: e.time,
      offset: 0,
      target: this.target(e.targetId, e.targetName),
      // A debuff the arena itself applied (护龙威压's 26 line names no one, E0000000) leaves the source unknown.
      source: knownSource ? { id: e.sourceId!, name: e.sourceName ?? "" } : ticked?.sourceName ? { id: ticked.sourceId, name: ticked.sourceName } : { id: "", name: "" },
      action: { id: e.effectId, name: ticked?.name || "持续伤害" },
      autoAttack: false,
      amount: e.amount,
      fullyAbsorbed: e.amount === 0 && targetStatuses.some((s) => s.category === "shield"),
      damageType: "unknown",
      result: "hit",
      crit: false,
      direct: false,
      invulnerable: targetStatuses.some((s) => s.category === "invuln" && negatesDamage(s.id)),
      hpBefore: e.targetHp,
      maxHp: e.targetMaxHp,
      // A DoT's mitigation was fixed when it landed, not at the tick.
      multiplier: null,
      multiplierPartial: false,
      mitigation: [],
      targetStatuses,
      sourceStatuses: [],
    };
  }

  /** A 37 line: fills HP-after (after the whole action) on the rows it belongs to, and returns them. Shields are the ledger's (shieldLedger.ts). */
  onEffectResult(e: EffectResultEvent): DamageRow[] {
    if (!isPlayerId(e.targetId)) return []; // rows are players' only
    const key = resultKey(e.sequence, e.targetId);
    const rows = this.pending.get(key) ?? [];
    this.pending.delete(key);
    for (const row of rows) row.hpAfter = e.currentHp;
    return rows;
  }

  /** Zone change: pending rows belong to the old zone. */
  clear(): void {
    this.pending.clear();
    this.hitByPlayers.clear();
  }

  private expire(now: number): void {
    for (const [key, rows] of this.pending) {
      if (now - rows[0]!.time > RESULT_TIMEOUT_MS) this.pending.delete(key);
    }
  }

  /**
   * Statuses on the source, plus, for a helper actor, those on the combatants with its name that players have hit.
   * Boss mechanics are mostly cast by invisible helper actors that share the boss's name, while Reprisal and the
   * like land on the boss itself (in the hunt fixture, 8 actors named 护锁刃龙 deal the damage and only one carries
   * Reprisal). A source players have hit is a combatant of its own (one of several same-named adds): only its own
   * statuses. Borrowed statuses are marked `inherited`.
   */
  private sourceStatuses(sourceId: string, sourceName: string, now: number): StatusSnap[] {
    const own = this.deps.statuses.snapshot(sourceId, now, "source");
    if (this.hitByPlayers.has(sourceId)) return own;
    const seen = new Set(own.map((s) => `${s.id}:${s.sourceId}`));
    for (const otherId of this.deps.registry.idsNamed(sourceName)) {
      if (otherId === sourceId || !this.hitByPlayers.has(otherId)) continue;
      for (const s of this.deps.statuses.snapshot(otherId, now, "source")) {
        const key = `${s.id}:${s.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        own.push({ ...s, inherited: true });
      }
    }
    return own;
  }

  private target(id: string, name: string): RowTarget {
    const job = this.deps.party.get(id)?.job || this.deps.registry.get(id)?.job || 0;
    return { id, name, job };
  }
}

/**
 * The status a DoT tick came from (docs/DESIGN.md 5.1). The 24 line names it for under 1 % of enemy
 * ticks; otherwise it is the target's damage-over-time debuff from an enemy (中暑, 中毒, 出血…) when
 * there is one by name — 94 % of the ticks on players in 18 logs; several same-name ones (two 猛毒)
 * are still that status. Two different ones, or none: unknown.
 */
function tickedStatus(e: TickEvent, statuses: readonly StatusSnap[]): StatusSnap | undefined {
  if (e.effectId) return statuses.find((s) => s.id === e.effectId);
  const dots = statuses.filter((s) => isDamageOverTimeStatus(s.id) && !isPlayerId(s.sourceId));
  return dots.length > 0 && dots.every((s) => s.name === dots[0]!.name) ? dots[0] : undefined;
}
