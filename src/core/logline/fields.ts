/**
 * Network log line field indexes. The same arrays come from OverlayPlugin's `LogLine` event
 * (`line`) and from an ACT Network_*.log line split on "|". Index 0 is the line type, 1 the
 * timestamp. Reference: cactbot resources/netlog_defs.ts; every index used here was checked
 * against CN logs (docs/DESIGN.md sections 2 and 4.3).
 */
export const LineType = {
  ChangeZone: "01",
  ChangePrimaryPlayer: "02",
  AddCombatant: "03",
  RemoveCombatant: "04",
  PartyList: "11",
  /** Enemy casts: review only (the death replay; later the timeline's boss lane). */
  StartsCasting: "20",
  Ability: "21",
  AOEAbility: "22",
  CancelAbility: "23",
  DoTHoT: "24",
  Death: "25",
  GainsEffect: "26",
  LosesEffect: "30",
  ActorControl: "33",
  /** Targetable or not: the boss leaving and coming back marks phases. */
  NameToggle: "34",
  EffectResult: "37",
  /** A combatant's status list, with HP and shield: players' only, for shields (docs/DESIGN.md 5.6). */
  StatusList: "38",
  /** Periodic HP: review only (HP curves). */
  UpdateHp: "39",
  InCombat: "260",
  /** Combatant memory: a player's height (PosZ in its Change lines) says they fell off the arena. */
} as const;

export const TimestampField = 1;

export const ZoneField = { id: 2, name: 3 } as const;

export const PrimaryPlayerField = { id: 2, name: 3 } as const;

/** 03 / 04. `job` and `level` are hex; `ownerId` is "0000" when the combatant has no owner. */
export const CombatantField = { id: 2, name: 3, job: 4, level: 5, ownerId: 6, maxHp: 12 } as const;

/** 11: member count, then that many IDs. */
export const PartyListField = { count: 2, firstId: 3 } as const;

/** 21 / 22: one line per target. Fields 8..23 are 8 pairs of flags + value. */
export const AbilityField = {
  sourceId: 2,
  source: 3,
  id: 4,
  ability: 5,
  targetId: 6,
  target: 7,
  firstFlags: 8,
  targetHp: 24,
  targetMaxHp: 25,
  sourceHp: 34,
  sourceMaxHp: 35,
  sequence: 44,
  targetIndex: 45,
  targetCount: 46,
  ownerId: 47,
} as const;

export const ABILITY_EFFECT_PAIRS = 8;

/** 20: `castTime` in seconds ("1.477"). */
export const CastField = { sourceId: 2, source: 3, id: 4, ability: 5, targetId: 6, target: 7, castTime: 8 } as const;

/** 23: `reason` is "Cancelled", "Interrupted", ... */
export const CancelField = { sourceId: 2, id: 4, reason: 6 } as const;

/** 39 (checked against CN logs: `39|t|100187CF|P1|190729|190729|10000|10000|...`). */
export const UpdateHpField = { id: 2, name: 3, currentHp: 4, maxHp: 5 } as const;

/** 24: `targetHp` is the HP before the tick. `sourceId` is usually E0000000 (unknown). */
export const DoTField = {
  targetId: 2,
  target: 3,
  kind: 4,
  effectId: 5,
  value: 6,
  targetHp: 7,
  targetMaxHp: 8,
  sourceId: 17,
  source: 18,
} as const;

export const DeathField = { targetId: 2, target: 3, sourceId: 4, source: 5 } as const;

/** 26 / 30 (30 has the same fields; its duration is 0). `count` (stacks) is hex. */
export const EffectField = {
  effectId: 2,
  effect: 3,
  duration: 4,
  sourceId: 5,
  source: 6,
  targetId: 7,
  target: 8,
  count: 9,
} as const;

export const ActorControlField = { command: 3 } as const;

/** 34 (checked against CN logs: `34|t|40015E80|野蛮恨心|40015E80|野蛮恨心|00`): "01" targetable, "00" not. */
export const NameToggleField = { id: 2, name: 3, toggle: 6 } as const;

/**
 * 37: HP after the effect landed; `shieldPercent` is the remaining shield in % of max HP. A short
 * form carries the current HP only, every other field empty (17 % of the 37 lines on players).
 */
/**
 * 37 lines: after the shield, a count (field 18) of status entries of 4 fields each: slot << 24 | status
 * ID (the slot is the status' place in the 38 line's list; ID 0: the slot was cleared, a shield broken),
 * stacks, duration (float bits), source.
 */
export const EffectResultField = { targetId: 2, sequence: 4, currentHp: 5, maxHp: 6, shieldPercent: 9, statusCount: 18 } as const;

/** 38 lines: the status list after these is never read (codec.ts keeps fields up to the shield). */
export const StatusListField = { targetId: 2, currentHp: 5, maxHp: 6, shieldPercent: 9 } as const;

export const InCombatField = { inACTCombat: 2, inGameCombat: 3, isACTChanged: 4, isGameChanged: 5 } as const;

/** 261: "Add" / "Change" / "Remove", the combatant, then name / value pairs (a Change line has only what changed). */

/**
 * ActorControl (33) commands of a wipe (LogGuide "Line 33"): fade out 40000005, fade in 4000000F (6.2 on; always
 * with barrier up), 40000010 (before 6.2). Some old fights send none.
 */
export const WIPE_COMMANDS: ReadonlySet<string> = new Set(["40000005", "4000000F", "40000010"]);

/** ActorControl (33) commands of a clear (LogGuide "Line 33"): victory 40000003, and the variant/criterion one 40000002. */
export const VICTORY_COMMANDS: ReadonlySet<string> = new Set(["40000003", "40000002"]);
