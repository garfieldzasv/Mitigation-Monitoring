import { deathReasonOf } from "../game/deathReasons";
import { effectiveStacks, statusCategory } from "../game/statuses";
import { CombatantRegistry, isPlayerId } from "../combatants/registry";
import { isRelevantLineType, parseLogLine, type DeathEvent, type GameEvent } from "../logline/parse";
import type { CombatantSnapshot } from "../overlay/combatants";
import { compileScope, DisplayScope, PartyState, type PartyMember, type ScopePredicate } from "../party/partyState";
import { StatusTracker, statusDurationMs } from "../status/statusTracker";
import { DamageRecorder } from "./damageRecorder";
import { DeathCauses } from "./deathCause";
import { findKillingBlow, overkillOf } from "./deathResolver";
import { EncounterTracker, ourSide, type EncounterBoundary } from "./encounter";
import { PhaseTracker } from "./phases";
import { ShieldAccount } from "./shieldGroups";
import type { DamageRow, DeathRow, Encounter } from "./types";

export type EngineChange =
  | { kind: "encounterStart"; encounter: Encounter }
  | { kind: "encounterEnd"; encounter: Encounter }
  /** Rows were appended. */
  | { kind: "rows"; encounter: Encounter }
  /** A row already in the encounter changed (HP-after, shield, fatal). */
  | { kind: "rowUpdate"; encounter: Encounter; row: DamageRow | DeathRow }
  /** The main boss changed, or it left or came back (phases, core/engine/phases.ts). */
  | { kind: "phase"; encounter: Encounter };

/** A shield gone from a player that hits used up (ShieldAccount.shieldLost). */
export interface ShieldUsedUp {
  time: number;
  targetId: string;
  statusId: number;
  sourceId: string;
}

export interface EngineOptions {
  /** Encounters kept in memory; older ones live only in the archive. */
  maxEncounters?: number;
}

/**
 * Incremental engine: log lines in, encounters with damage and death rows out. The monitor feeds it
 * live; the review window replays an archived encounter's raw lines through the same code.
 *
 * The party and the player come from the log itself (11 and 02 lines) and, live, also from
 * OverlayPlugin's PartyChanged / ChangePrimaryPlayer via setParty / setSelf; whichever came last
 * wins. Neither source alone is enough: log files have no OverlayPlugin events, and an overlay
 * opened mid-session sees no 11 / 02 lines until the next zone change.
 */
export class Engine {
  readonly registry = new CombatantRegistry();
  readonly party = new PartyState();
  readonly scope = new DisplayScope(this.party);
  /** Statuses last until their 30 line on enemies and the party; a player outside it, until their time (statusTracker.ts). */
  readonly statuses = new StatusTracker(statusCategory, effectiveStacks, (id) => !isPlayerId(id) || id === this.party.selfId || this.party.get(id)?.inParty === true);
  /** Oldest first, at most `maxEncounters`. */
  readonly encounters: Encounter[] = [];
  current: Encounter | null = null;

  /** The fights of the player and their party (docs/DESIGN.md 5.3). */
  private readonly tracker = new EncounterTracker(ourSide(this.party));
  private readonly phases = new PhaseTracker();
  private readonly recorder: DamageRecorder;
  /** What shields took off the hits (docs/DESIGN.md 5.6). */
  private readonly shields: ShieldAccount;
  private readonly listeners = new Set<(change: EngineChange) => void>();
  /** Hits used up a shield on a player: the review cuts a recast on it (docs/DESIGN.md 8.2 refunds). The monitor sets none. */
  onShieldUsedUp?: (lost: ShieldUsedUp) => void;
  private readonly options: { maxEncounters: number };
  private zone = { id: 0, name: "" };
  /** Lines handled: where a 37 line came (DamageRow.effectOrder). */
  private lineNo = 0;
  /**
   * Each player's HP as the log tells it, for the HP before a hit or a tick (docs/DESIGN.md 5.6): the last update (37,
   * 38, 39: the only lines whose HP is an update, LogGuide), less the DoT and plus the HoT ticks since (24: its amount is
   * what the tick applied; its HP figure is read from memory, may be stale, and is not used).
   */
  private readonly lastHp = new Map<string, number>();
  private nextEncounterId = 1;
  /** What killed a player when no blow did, and when HP went to 0 (docs/DESIGN.md 5.7). */
  private readonly causes = new DeathCauses();
  /** The last zone change: deaths after it belong to no encounter that ended before it. */
  private zoneChangedAt = Number.NEGATIVE_INFINITY;
  /** Rows made while no encounter runs: the one that starts an encounter joins it. */
  private idleRows: DamageRow[] = [];

  constructor(options: EngineOptions = {}) {
    this.options = { maxEncounters: options.maxEncounters ?? 5 };
    this.recorder = new DamageRecorder({ registry: this.registry, party: this.party, statuses: this.statuses });
    this.shields = new ShieldAccount((id) => this.party.get(id)?.level || this.registry.get(id)?.level || 0);
  }


  /** The encounter shown when nothing runs: the last one. */
  get latest(): Encounter | undefined {
    return this.encounters.at(-1);
  }

  /** OverlayPlugin PartyChanged. */
  setParty(members: readonly PartyMember[]): void {
    this.party.setParty(members);
    this.scope.partyChanged();
  }

  /** OverlayPlugin ChangePrimaryPlayer (02 lines set it too). */
  setSelf(id: string, name: string): void {
    this.party.setSelf(id, name);
  }

  /**
   * The current zone without a 01 line: OverlayPlugin's ChangeZone for an overlay opened
   * mid-session, the archive's zone for a replay. Unlike a 01 line it clears nothing.
   */
  setZone(id: number, name: string): void {
    this.zone = { id, name };
  }

  /**
   * Fills in what neither OverlayPlugin events nor log lines have provided yet, from a
   * `getCombatants` reply: an overlay opened mid-session sees no 03 / 11 / 02 lines, and OverlayPlugin
   * has no cached PartyChanged if the party never changed since ACT started. Never overrides.
   */
  bootstrap(snapshot: CombatantSnapshot): void {
    for (const c of snapshot.combatants) if (!this.registry.get(c.id)) this.registry.add(c);
    if (!this.party.selfId && snapshot.selfId) this.party.setSelf(snapshot.selfId, snapshot.selfName ?? "");
    if (this.party.list().length === 0 && snapshot.party.length > 0) this.setParty(snapshot.party);
  }

  /** Keys of OverlayPlugin CombatData.Combatant: who ACT parses (docs/DESIGN.md 5.2). */
  setCombatDataNames(names: Iterable<string>): void {
    this.scope.setCombatDataNames(names);
  }

  /** Whose rows an encounter shows: its frozen scope once ended, the live scope while running. */
  visibility(encounter: Encounter): ScopePredicate {
    return encounter.scope ? compileScope(encounter.scope) : (id, name) => this.scope.includes(id, name);
  }

  subscribe(listener: (change: EngineChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One raw log line (OverlayPlugin `LogLine.line`, or a log file line split on "|"). */
  feed(line: readonly string[]): void {
    if (!isRelevantLineType(line[0])) return;
    const event = parseLogLine(line);
    if (event) this.handle(event);
  }

  /** A replay of an archived pull: it starts at the archived start, none before (encounter.ts startAt). */
  startArchivedPullAt(time: number): void {
    this.tracker.startAt(time);
  }

  /** No more lines (the end of a replay): settles the shields still open. */
  flush(): void {
    for (const row of this.shields.flush()) this.emitRowUpdate(row);
  }

  handle(e: GameEvent): void {
    this.lineNo++;
    // A report's message ends at the first line not its own; hits that waited long enough for their result are decided.
    for (const row of this.shields.advance(e)) this.emitRowUpdate(row);
    const boundary = this.tracker.onEvent(e);
    if (boundary?.kind === "end") this.endEncounter(boundary);
    if (boundary?.kind === "result") this.lateResult(boundary.result);

    switch (e.type) {
      case "zone":
        this.zone = { id: e.zoneId, name: e.zoneName };
        this.lastHp.clear();
        this.registry.clear();
        this.statuses.clear();
        this.recorder.clear();
        for (const row of this.shields.flush()) this.emitRowUpdate(row);
        this.shields.clear();
        this.causes.clear();
        this.idleRows = [];
        this.zoneChangedAt = e.time;
        break;
      case "wipe":
        // Everything resets at a wipe: statuses are cleared (as Triggevent, cactbot oopsy and souma do), hits still
        // waiting for their result are decided, the shield groups closed.
        this.statuses.clear();
        for (const row of this.shields.flush()) this.emitRowUpdate(row);
        this.shields.clear();
        break;
      case "primaryPlayer":
        this.party.setSelf(e.id, e.name);
        break;
      case "addCombatant":
        this.registry.add({ id: e.id, name: e.name, job: e.job, level: e.level, ownerId: e.ownerId, maxHp: e.maxHp });
        this.party.fill(e);
        break;
      case "removeCombatant":
        this.registry.remove(e.id);
        this.statuses.removeEntity(e.id);
        if (this.phases.onRemove(e.id, e.time)) this.emitPhase();
        break;
      case "partyList":
        this.party.setFromPartyList(e.ids, this.registry);
        this.scope.partyChanged();
        break;
      case "gainEffect":
        if (isPlayerId(e.targetId)) {
          const reason = deathReasonOf(this.zone.id, "status", e.effectId);
          if (reason) this.causes.annotate(e.targetId, { ...reason, time: e.time });
        }
        if (this.statuses.gain(e) && this.isShieldOnPlayer(e.targetId, e.effectId)) this.shields.shieldGained(e.targetId, e.effectId, e.sourceId, e.time, statusDurationMs(e.duration, e.effectId));
        break;
      case "loseEffect":
        if (this.isShieldOnPlayer(e.targetId, e.effectId) && this.shields.shieldLost(e.targetId, e.effectId, e.sourceId, e.time)) {
          this.onShieldUsedUp?.({ time: e.time, targetId: e.targetId, statusId: e.effectId, sourceId: e.sourceId });
        }
        this.statuses.lose(e);
        break;
      case "ability":
        if (this.phases.onAbility(e)) this.emitPhase();
        this.addRow(this.recorder.fromAbility(e));
        if (e.heal && e.heal.toTarget > 0 && isPlayerId(e.targetId)) this.shields.healed(e.targetId, e.time);
        if (e.heal && e.heal.toSource > 0 && isPlayerId(e.sourceId)) this.shields.healed(e.sourceId, e.time);
        // cactbot's death reasons: damage after one cancels it; the annotated ability (its own damage included) sets it.
        if (e.damage && e.damage.amount > 0 && isPlayerId(e.targetId)) this.causes.damaged(e.targetId);
        if (isPlayerId(e.targetId)) {
          const reason = deathReasonOf(this.zone.id, "ability", e.actionId);
          if (reason) this.causes.annotate(e.targetId, { ...reason, time: e.time });
        }
        for (const p of e.appliedParams ?? []) this.statuses.paramsFor(p.onSource ? e.sourceId : e.targetId, p.id, { first: p.first, second: p.second }, e.time, { id: e.sourceId, name: e.sourceName });
        if (e.instantDeath && isPlayerId(e.targetId)) this.causes.instantKill(e.targetId, { time: e.time, actionName: e.actionName, sourceName: e.sourceName });
        // A shield's put-on line: the lowest byte of what it holds, and the heal it is sized from.
        for (const s of e.appliedBytes ?? [])
          if (this.isShieldOnPlayer(e.targetId, s.id)) this.shields.shieldPutOn(e.targetId, s.id, e.actionId, e.sourceId, s.byte, e.heal?.toTarget ?? 0, e.targetMaxHp, e.sourceMaxHp, e.time);
        break;
      case "targetable":
        if (this.phases.onTargetable(e.id, e.targetable, e.time)) this.emitPhase();
        break;
      case "tick":
        this.addRow(this.recorder.fromTick(e));
        if (e.kind === "hot" && e.amount > 0 && isPlayerId(e.targetId)) this.shields.healed(e.targetId, e.time);
        if (isPlayerId(e.targetId)) {
          const hp = this.lastHp.get(e.targetId);
          if (hp !== undefined) this.lastHp.set(e.targetId, e.kind === "dot" ? Math.max(0, hp - e.amount) : Math.min(e.targetMaxHp > 0 ? e.targetMaxHp : Number.POSITIVE_INFINITY, hp + e.amount));
        }
        break;
      case "effectResult": {
        const own = this.recorder.onEffectResult(e);
        // The hits it is the result of took effect now, from the HP the last update gave (docs/DESIGN.md 5.6).
        const before = this.lastHp.get(e.targetId);
        for (const row of own) {
          row.effectOrder = this.lineNo;
          if (before !== undefined) row.hpBefore = before;
        }
        if (isPlayerId(e.targetId)) {
          this.lastHp.set(e.targetId, e.currentHp);
          this.shields.hpReading(e.targetId, e.time, e.currentHp);
          if (e.maxHp > 0) this.causes.hp(e.targetId, e.time, e.currentHp);
          this.shields.result(e.targetId, e.time, e.sequence, own, e.maxHp > 0 ? e.shieldPercent : undefined, e.maxHp);
        }
        for (const row of own) this.emitRowUpdate(row);
        break;
      }
      case "hp":
        if (isPlayerId(e.id) && e.maxHp > 0) {
          this.lastHp.set(e.id, e.hp);
          this.shields.hpReading(e.id, e.time, e.hp);
          this.causes.hp(e.id, e.time, e.hp);
        }
        break;
      case "statusList":
        if (!isPlayerId(e.targetId)) break;
        if (e.maxHp > 0) {
          this.lastHp.set(e.targetId, e.currentHp);
          this.shields.hpReading(e.targetId, e.time, e.currentHp);
          this.causes.hp(e.targetId, e.time, e.currentHp);
        }
        if (e.shieldPercent !== undefined && e.maxHp > 0) this.shields.report(e.targetId, e.time, e.shieldPercent, e.maxHp);
        break;
      case "death": {
        // The killing blow first: one the HP updates show could have killed counts as landed though its 37 line has not
        // come (LogGuide: those HP values are never stale). Hits on or from the dead still waiting for their result
        // line took no effect (Triggevent drops them).
        if (!isPlayerId(e.targetId) && this.phases.onDeath(e.targetId, e.time)) this.emitPhase();
        const blow = this.addDeath(e);
        for (const row of this.shields.died(e.targetId, blow)) this.emitRowUpdate(row);
        break;
      }
      default:
        break;
    }

    if (boundary?.kind === "start") this.startEncounter(boundary.time);
  }

  private addRow(row: DamageRow | undefined): void {
    if (!row) return;
    // The HP before a hit or a tick: as the log tells it (lastHp), not the figure its line read from memory (5.6).
    const last = this.lastHp.get(row.target.id);
    if (last !== undefined) row.hpBefore = last;
    // A group whose last hit got through closes as this one comes (shieldGroups.ts).
    for (const closed of this.shields.hit(row)) this.emitRowUpdate(closed);
    const encounter = this.current;
    if (!encounter) {
      this.idleRows = [row];
      return;
    }
    this.file(encounter, row);
    this.emit({ kind: "rows", encounter });
  }

  private emitRowUpdate(row: DamageRow): void {
    const encounter = this.encounterOf(row);
    if (encounter) this.emit({ kind: "rowUpdate", encounter, row });
  }

  private isShieldOnPlayer(targetId: string, statusId: number): boolean {
    return isPlayerId(targetId) && statusCategory(statusId, "target") === "shield";
  }

  /**
   * The encounter a 25 line belongs to: the one the player's HP went to 0 in (the 25 line may come after the next pull
   * started), which may have ended since — until the next one starts, or the zone changes.
   */
  private deathEncounter(e: DeathEvent): Encounter | undefined {
    const at = this.causes.zeroBefore(e.targetId, e.time)?.at ?? e.time;
    for (let i = this.encounters.length - 1; i >= 0; i--) {
      const enc = this.encounters[i]!;
      if (enc.start > at) continue;
      if (enc.end !== undefined && this.zoneChangedAt > enc.end && at >= this.zoneChangedAt) return undefined;
      return enc;
    }
    return undefined;
  }

  /** Files a player's death; returns its killing blow, if one was found. */
  private addDeath(e: DeathEvent): DamageRow | undefined {
    if (!isPlayerId(e.targetId)) return undefined;
    const encounter = this.deathEncounter(e);
    if (!encounter) return undefined;
    // What killed (docs/DESIGN.md 5.7), each death on its own lines: an instant-death effect; cactbot's annotation of
    // the zone (damage after it cancels it); a blow — for a 25 line naming no killer (E0000000), only one whose own 37
    // line shows HP 0, else it is 地形杀 (souma's 减伤记录).
    const unnamed = !e.sourceName || e.sourceId === "E0000000";
    const outright = this.causes.killedOutright(e.targetId, e.time);
    const annotated = outright ? undefined : this.causes.annotatedReason(e.targetId, e.time);
    const found = annotated ? undefined : findKillingBlow(encounter.rows, e.targetId, e.time, unnamed, this.causes.zeroBefore(e.targetId, e.time)?.aliveBefore);
    this.causes.died(e.targetId, e.time);
    // The log's own instant death wins over a blow before it.
    const instant = outright && (!found || found.time <= outright.time) ? outright : undefined;
    const blow = instant ? undefined : found;
    const terrain = !instant && !blow && (annotated ? annotated.kind !== "other" : unnamed);
    const row: DeathRow = {
      kind: "death",
      id: 0,
      time: e.time,
      offset: 0,
      target: { id: e.targetId, name: e.targetName, job: this.party.get(e.targetId)?.job || this.registry.get(e.targetId)?.job || 0 },
      sourceName: e.sourceName,
      ...(terrain ? { cause: "terrain" as const } : {}),
      ...(instant ? { cause: "instant" as const, causeAction: instant.actionName } : {}),
      ...(annotated?.kind === "other" ? { cause: "other" as const, causeText: annotated.text } : {}),
    };
    if (blow) {
      blow.fatal = true;
      row.killerRowId = blow.id;
      const overkill = overkillOf(blow);
      if (overkill !== undefined) row.overkill = overkill;
      this.emit({ kind: "rowUpdate", encounter, row: blow });
    }
    this.file(encounter, row);
    encounter.deaths++;
    this.emit({ kind: "rows", encounter });
    return blow;
  }

  /** Numbers a row and appends it to the encounter. */
  private file(encounter: Encounter, row: DamageRow | DeathRow): void {
    row.id = (encounter.rows.at(-1)?.id ?? 0) + 1;
    row.offset = row.time - encounter.start;
    encounter.rows.push(row);
  }

  private startEncounter(time: number): void {
    // Each encounter's shields are sized from its own lines only: what the review replays from the archive.
    this.shields.forgetSizes();
    const encounter: Encounter = {
      id: this.nextEncounterId++,
      zoneId: this.zone.id,
      zoneName: this.zone.name,
      start: time,
      result: "unknown",
      rows: [],
      deaths: 0,
      untargetable: [],
    };
    this.scope.reset();
    this.phases.start(encounter);
    for (const row of this.idleRows) if (row.time >= time) this.file(encounter, row);
    this.idleRows = [];
    this.current = encounter;
    this.encounters.push(encounter);
    if (this.encounters.length > this.options.maxEncounters) this.encounters.shift();
    this.emit({ kind: "encounterStart", encounter });
  }

  /** The last encounter's result, known after it ended. */
  private lateResult(result: Encounter["result"]): void {
    const encounter = this.latest;
    if (!encounter || encounter.end === undefined) return;
    encounter.result = result;
    this.emit({ kind: "encounterEnd", encounter });
  }

  private endEncounter(boundary: Extract<EncounterBoundary, { kind: "end" }>): void {
    const encounter = this.current;
    if (!encounter) return;
    encounter.end = boundary.time;
    encounter.result = boundary.result;
    encounter.scope = this.scope.snapshot();
    this.phases.end();
    this.current = null;
    this.emit({ kind: "encounterEnd", encounter });
  }

  /** The encounter a filed row belongs to: the latest one that started before it (rows are in time order). */
  private encounterOf(row: DamageRow): Encounter | undefined {
    if (row.id === 0) return undefined; // still waiting in idleRows
    for (let i = this.encounters.length - 1; i >= 0; i--) {
      const encounter = this.encounters[i]!;
      if (row.time >= encounter.start) return encounter;
    }
    return undefined;
  }

  private emitPhase(): void {
    if (this.current) this.emit({ kind: "phase", encounter: this.current });
  }

  private emit(change: EngineChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        console.error("[engine] listener failed", err);
      }
    }
  }
}
