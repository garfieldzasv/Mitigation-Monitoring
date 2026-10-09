import { findAppliedStatusBytes, findAppliedStatusParams, findAppliedStatuses, findDamageEffect, findHealEffects, findUnappliedStatuses, hasInstantDeath, type AppliedStatusParams, type DamageEffect, type HealEffect, type UnappliedStatus } from "./effect";
import {
  AbilityField,
  ActorControlField,
  CancelField,
  CastField,
  CombatantField,
  ContentFinderField,
  DeathField,
  DoTField,
  EffectField,
  EffectResultField,
  StatusListField,
  InCombatField,
  LineType,
  NameToggleField,
  PartyListField,
  PrimaryPlayerField,
  TimestampField,
  UpdateHpField,
  VICTORY_COMMANDS,
  WIPE_COMMANDS,
  ZoneField,
} from "./fields";

/** Structured game events; downstream modules never index raw log arrays. */
export type GameEvent =
  | { type: "zone"; time: number; zoneId: number; zoneName: string }
  | { type: "primaryPlayer"; time: number; id: string; name: string }
  | { type: "addCombatant"; time: number; id: string; name: string; job: number; level: number; ownerId?: string; maxHp: number }
  | { type: "removeCombatant"; time: number; id: string }
  | { type: "partyList"; time: number; ids: string[] }
  | AbilityEvent
  | TickEvent
  | DeathEvent
  | GainEffectEvent
  | LoseEffectEvent
  | EffectResultEvent
  | StatusListEvent
  | CastEvent
  | { type: "cancel"; time: number; sourceId: string; actionId: number; reason: string }
  | { type: "hp"; time: number; id: string; hp: number; maxHp: number }
  | { type: "targetable"; time: number; id: string; name: string; targetable: boolean }
  | { type: "wipe"; time: number }
  | { type: "victory"; time: number }
  /**
   * 260 (LogGuide): `game`, whether the game says the player is in combat; `act`, whether ACT does — which "may include
   * other people around you and not yourself"; `gameChanged`, the game's state changed since the last 260 line.
   */
  | { type: "combat"; time: number; act: boolean; game: boolean; gameChanged: boolean }
  /** 265 (LogGuide): the Content Finder settings the zone was entered with; `unrestricted`, 解除限制. */
  | { type: "contentFinder"; time: number; zoneId: number; unrestricted: boolean };

/** 20: a cast bar starts. */
export interface CastEvent {
  type: "cast";
  time: number;
  sourceId: string;
  sourceName: string;
  actionId: number;
  actionName: string;
  targetId: string;
  targetName: string;
  castMs: number;
}

export interface AbilityEvent {
  type: "ability";
  time: number;
  sourceId: string;
  sourceName: string;
  actionId: number;
  actionName: string;
  targetId: string;
  targetName: string;
  /** Owner of the source when the line names one (pets, Earthly Star). */
  ownerId?: string;
  /** The damage-taken effect, if this line carries one. */
  damage?: DamageEffect;
  /** Healing on this line, if any (the review's death replay). */
  heal?: HealEffect;
  /** Statuses this action applied, by ID (the review's timeline ties them to the cast). */
  applied?: number[];
  /** Statuses this action put on its target, each with the byte that for a shield is the lowest byte of what it holds (the shield ledger). */
  appliedBytes?: { id: number; byte: number }[];
  /** Statuses it put on, with their damage modifier bytes (LogGuide; findAppliedStatusParams). */
  appliedParams?: AppliedStatusParams[];
  /** It killed its target outright (an 0x33 effect). */
  instantDeath?: true;
  /** Statuses this action failed to apply, if any (a weaker shield; the review's death replay). */
  unapplied?: UnappliedStatus[];
  /** Target HP when the action snapshotted, before the damage lands. */
  targetHp: number;
  targetMaxHp: number;
  /** Source HP at the same moment (for heals that land on the source). */
  sourceHp: number;
  sourceMaxHp: number;
  /** Shared by every target of one action; 37 lines carry it too. */
  sequence: string;
  targetIndex: number;
  targetCount: number;
}

export interface TickEvent {
  type: "tick";
  time: number;
  kind: "dot" | "hot";
  targetId: string;
  targetName: string;
  /** 0 for almost every enemy DoT: the game does not say which status ticked. */
  effectId: number;
  amount: number;
  /** HP before the tick. */
  targetHp: number;
  targetMaxHp: number;
  sourceId?: string;
  sourceName?: string;
}

export interface DeathEvent {
  type: "death";
  time: number;
  targetId: string;
  targetName: string;
  sourceId: string;
  sourceName: string;
}

export interface GainEffectEvent {
  type: "gainEffect";
  time: number;
  effectId: number;
  effectName: string;
  /** Seconds; 0 or 9999 mean "until removed". */
  duration: number;
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  stacks: number;
}

export interface LoseEffectEvent {
  type: "loseEffect";
  time: number;
  effectId: number;
  effectName: string;
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
}

export interface EffectResultEvent {
  type: "effectResult";
  time: number;
  targetId: string;
  sequence: string;
  currentHp: number;
  /** 0 when the line does not say (the short form). */
  maxHp: number;
  /** The shield left, % of max HP; unset when the line does not say — unknown, not 0. */
  shieldPercent?: number;
  /**
   * Statuses the effect touched, as they now are: mostly what the target already had, with its time
   * left; a status put on again shows its full duration (泛输血's next layer, often without a 26 line).
   */
  statuses?: EffectStatus[];
}

export interface EffectStatus {
  id: number;
  /** Seconds left. */
  duration: number;
  sourceId: string;
  stacks: number;
}

/** 38: a combatant's statuses changed; the line also carries its HP and shield. */
export interface StatusListEvent {
  type: "statusList";
  time: number;
  targetId: string;
  currentHp: number;
  maxHp: number;
  /** The shield, % of max HP rounded down; unset when the line does not say. */
  shieldPercent?: number;
}

export type GameEventType = GameEvent["type"];

const RELEVANT_LINE_TYPES: ReadonlySet<string> = new Set(Object.values(LineType));

/**
 * Cheap pre-check so callers skip lines nobody consumes (most lines in a raid). Also decides which
 * raw lines the encounter archive keeps.
 */
export function isRelevantLineType(lineType: string | undefined): boolean {
  return lineType !== undefined && RELEVANT_LINE_TYPES.has(lineType);
}

const hex = (s: string | undefined) => (s ? Number.parseInt(s, 16) : Number.NaN);

const floatBits = new DataView(new ArrayBuffer(4));
/** A float written as its 32 bits in hex (37 lines' status durations). */
const float = (s: string | undefined) => {
  floatBits.setUint32(0, hex(s) >>> 0);
  return floatBits.getFloat32(0);
};

/** A 37 line's status entries (EffectResultField.statusCount). */
function effectStatuses(line: readonly string[]): { statuses?: EffectStatus[] } {
  const count = hex(line[EffectResultField.statusCount]);
  if (!(count > 0)) return {};
  const statuses: EffectStatus[] = [];
  for (let k = 0, at = EffectResultField.statusCount + 1; k < count; k++, at += 4) {
    const info = hex(line[at]);
    const sourceId = line[at + 3];
    if (!Number.isFinite(info) || !sourceId) break;
    if ((info & 0xffff) === 0) continue; // a result flag, no status
    const duration = float(line[at + 2]);
    statuses.push({ id: info & 0xffff, duration: Number.isFinite(duration) ? duration : 0, sourceId: id(sourceId), stacks: hex(line[at + 1]) || 0 });
  }
  return statuses.length > 0 ? { statuses } : {};
}
const int = (s: string | undefined) => {
  const n = Number.parseInt(s ?? "", 10);
  return Number.isFinite(n) ? n : 0;
};
const id = (s: string | undefined) => (s ?? "").toUpperCase();
const time = (s: string | undefined) => {
  const t = s ? Date.parse(s) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
};
/** Owner fields are "0", "00" or "0000" when empty. */
const owner = (s: string | undefined) => (s && !/^0+$/.test(s) ? id(s) : undefined);

/** Parses one log line. Returns undefined for irrelevant or malformed lines. */
export function parseLogLine(line: readonly string[]): GameEvent | undefined {
  const t = time(line[TimestampField]);
  switch (line[0]) {
    case LineType.ChangeZone:
      return { type: "zone", time: t, zoneId: hex(line[ZoneField.id]) || 0, zoneName: line[ZoneField.name] ?? "" };
    case LineType.ChangePrimaryPlayer:
      return { type: "primaryPlayer", time: t, id: id(line[PrimaryPlayerField.id]), name: line[PrimaryPlayerField.name] ?? "" };
    case LineType.AddCombatant: {
      const ownerId = owner(line[CombatantField.ownerId]);
      return {
        type: "addCombatant",
        time: t,
        id: id(line[CombatantField.id]),
        name: line[CombatantField.name] ?? "",
        job: hex(line[CombatantField.job]) || 0,
        level: hex(line[CombatantField.level]) || 0,
        ...(ownerId ? { ownerId } : {}),
        maxHp: int(line[CombatantField.maxHp]),
      };
    }
    case LineType.RemoveCombatant:
      return { type: "removeCombatant", time: t, id: id(line[CombatantField.id]) };
    case LineType.PartyList: {
      const count = int(line[PartyListField.count]);
      const ids = line.slice(PartyListField.firstId, PartyListField.firstId + count).map(id);
      return { type: "partyList", time: t, ids };
    }
    case LineType.Ability:
    case LineType.AOEAbility: {
      const actionId = hex(line[AbilityField.id]);
      if (!Number.isFinite(actionId)) return undefined;
      const ownerId = owner(line[AbilityField.ownerId]);
      const damage = findDamageEffect(line);
      const heal = findHealEffects(line);
      const applied = findAppliedStatuses(line);
      const appliedBytes = findAppliedStatusBytes(line);
      const appliedParams = findAppliedStatusParams(line);
      const unapplied = findUnappliedStatuses(line);
      return {
        type: "ability",
        time: t,
        sourceId: id(line[AbilityField.sourceId]),
        sourceName: line[AbilityField.source] ?? "",
        actionId,
        actionName: line[AbilityField.ability] ?? "",
        targetId: id(line[AbilityField.targetId]),
        targetName: line[AbilityField.target] ?? "",
        ...(ownerId ? { ownerId } : {}),
        ...(damage ? { damage } : {}),
        ...(heal ? { heal } : {}),
        ...(applied.length > 0 ? { applied } : {}),
        ...(appliedBytes.length > 0 ? { appliedBytes } : {}),
        ...(appliedParams.length > 0 ? { appliedParams } : {}),
        ...(hasInstantDeath(line) ? { instantDeath: true as const } : {}),
        ...(unapplied.length > 0 ? { unapplied } : {}),
        targetHp: int(line[AbilityField.targetHp]),
        targetMaxHp: int(line[AbilityField.targetMaxHp]),
        sourceHp: int(line[AbilityField.sourceHp]),
        sourceMaxHp: int(line[AbilityField.sourceMaxHp]),
        sequence: line[AbilityField.sequence] ?? "",
        targetIndex: int(line[AbilityField.targetIndex]),
        targetCount: int(line[AbilityField.targetCount]) || 1,
      };
    }
    case LineType.DoTHoT: {
      const kind = line[DoTField.kind];
      if (kind !== "DoT" && kind !== "HoT") return undefined;
      const sourceId = id(line[DoTField.sourceId]);
      const known = sourceId && sourceId !== "E0000000";
      return {
        type: "tick",
        time: t,
        kind: kind === "DoT" ? "dot" : "hot",
        targetId: id(line[DoTField.targetId]),
        targetName: line[DoTField.target] ?? "",
        effectId: hex(line[DoTField.effectId]) || 0,
        amount: hex(line[DoTField.value]) || 0,
        targetHp: int(line[DoTField.targetHp]),
        targetMaxHp: int(line[DoTField.targetMaxHp]),
        ...(known ? { sourceId, sourceName: line[DoTField.source] ?? "" } : {}),
      };
    }
    case LineType.Death:
      return {
        type: "death",
        time: t,
        targetId: id(line[DeathField.targetId]),
        targetName: line[DeathField.target] ?? "",
        sourceId: id(line[DeathField.sourceId]),
        sourceName: line[DeathField.source] ?? "",
      };
    case LineType.GainsEffect:
    case LineType.LosesEffect: {
      const effectId = hex(line[EffectField.effectId]);
      if (!Number.isFinite(effectId)) return undefined;
      const sourceId = id(line[EffectField.sourceId]);
      const targetId = id(line[EffectField.targetId]);
      if (line[0] === LineType.LosesEffect) {
        return {
          type: "loseEffect",
          time: t,
          effectId,
          effectName: line[EffectField.effect] ?? "",
          sourceId,
          sourceName: line[EffectField.source] ?? "",
          targetId,
          targetName: line[EffectField.target] ?? "",
        };
      }
      return {
        type: "gainEffect",
        time: t,
        effectId,
        effectName: line[EffectField.effect] ?? "",
        duration: Number.parseFloat(line[EffectField.duration] ?? "0") || 0,
        sourceId,
        sourceName: line[EffectField.source] ?? "",
        targetId,
        targetName: line[EffectField.target] ?? "",
        stacks: hex(line[EffectField.count]) || 0,
      };
    }
    case LineType.ActorControl: {
      const command = line[ActorControlField.command] ?? "";
      if (WIPE_COMMANDS.has(command)) return { type: "wipe", time: t };
      if (VICTORY_COMMANDS.has(command)) return { type: "victory", time: t };
      return undefined;
    }
    case LineType.EffectResult: {
      const shield = line[EffectResultField.shieldPercent];
      return {
        type: "effectResult",
        time: t,
        targetId: id(line[EffectResultField.targetId]),
        sequence: line[EffectResultField.sequence] ?? "",
        currentHp: int(line[EffectResultField.currentHp]),
        maxHp: int(line[EffectResultField.maxHp]),
        ...(shield ? { shieldPercent: int(shield) } : {}),
        ...effectStatuses(line),
      };
    }
    case LineType.StatusList: {
      const shield = line[StatusListField.shieldPercent];
      return {
        type: "statusList",
        time: t,
        targetId: id(line[StatusListField.targetId]),
        currentHp: int(line[StatusListField.currentHp]),
        maxHp: int(line[StatusListField.maxHp]),
        ...(shield ? { shieldPercent: int(shield) } : {}),
      };
    }
    case LineType.StartsCasting: {
      const actionId = hex(line[CastField.id]);
      if (!Number.isFinite(actionId)) return undefined;
      return {
        type: "cast",
        time: t,
        sourceId: id(line[CastField.sourceId]),
        sourceName: line[CastField.source] ?? "",
        actionId,
        actionName: line[CastField.ability] ?? "",
        targetId: id(line[CastField.targetId]),
        targetName: line[CastField.target] ?? "",
        castMs: Math.round((Number.parseFloat(line[CastField.castTime] ?? "0") || 0) * 1000),
      };
    }
    case LineType.CancelAbility:
      return {
        type: "cancel",
        time: t,
        sourceId: id(line[CancelField.sourceId]),
        actionId: hex(line[CancelField.id]) || 0,
        reason: line[CancelField.reason] ?? "",
      };
    case LineType.NameToggle:
      return {
        type: "targetable",
        time: t,
        id: id(line[NameToggleField.id]),
        name: line[NameToggleField.name] ?? "",
        targetable: line[NameToggleField.toggle] === "01",
      };
    case LineType.UpdateHp:
      return {
        type: "hp",
        time: t,
        id: id(line[UpdateHpField.id]),
        hp: int(line[UpdateHpField.currentHp]),
        maxHp: int(line[UpdateHpField.maxHp]),
      };
    case LineType.InCombat:
      return {
        type: "combat",
        time: t,
        act: line[InCombatField.inACTCombat] === "1",
        game: line[InCombatField.inGameCombat] === "1",
        gameChanged: line[InCombatField.isGameChanged] === "1",
      };
    case LineType.ContentFinderSettings:
      return {
        type: "contentFinder",
        time: t,
        zoneId: hex(line[ContentFinderField.zoneId]) || 0,
        unrestricted: line[ContentFinderField.unrestrictedParty] === "1",
      };
    default:
      return undefined;
  }
}
