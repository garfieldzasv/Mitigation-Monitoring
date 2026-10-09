import { ABILITY_EFFECT_PAIRS, AbilityField } from "./fields";

/** Effect type: the low byte of a flags word in 21/22 lines. */
export const EffectType = {
  Miss: 0x01,
  Damage: 0x03,
  Heal: 0x04,
  BlockedDamage: 0x05,
  ParriedDamage: 0x06,
  /** A status applied to the target / to the source; the value carries its ID, and a 26 line follows. */
  StatusOnTarget: 0x0e,
  StatusOnSource: 0x0f,
  /** A status the action would apply did not take (a weaker shield on a stronger one); the value carries its ID. */
  StatusNoEffect: 0x14,
  /** The target was invulnerable ("'invulnerable' message", LogGuide "Effect Types"). */
  Invulnerable: 0x07,
  /** The next effect is reflected damage, dealt to the source (LogGuide "Reflected Damage"). */
  Reflect: 0x1d,
  /** The target died outright (LogGuide "Effect Types": instant death). */
  InstantDeath: 0x33,
} as const;

export type HitResult = "hit" | "block" | "parry" | "miss";

/**
 * Which mitigation applies: physical (attack types 斩 / 突 / 打 / 射), magical, "special" (breath) or
 * "unknown" (sound, limit break, no attack type): for those two the game data does not say which defence they meet.
 */
export type DamageType = "physical" | "magical" | "special" | "unknown";

export interface DamageEffect {
  result: HitResult;
  /** Damage that reached HP: shield absorption is already taken out (docs/DESIGN.md 2.1). */
  amount: number;
  crit: boolean;
  direct: boolean;
  damageType: DamageType;
  /** The AttackType sheet: 1 斩, 2 突, 3 打, 4 射, 5 魔法, 6 ブレス (breath), 7 音波 (sound), 8 リミットブレイク; 0 none. */
  attackType: number;
  /** 1 fire, 2 ice, 3 wind, 4 earth, 5 lightning, 6 water, 7 unaspected. */
  element: number;
  /**
   * The severity byte's low bits, when set. The LogGuide defines 0x20 (crit) and 0x40 (direct hit) only. In the
   * samples 0x06 goes with a hit reaching 鼓舞 / 激励 / 魔罩; nothing uses it.
   */
  shieldBits?: number;
  /** A block's or parry's own reduction, in percent (LogGuide: the leftmost byte, signed, e.g. 0xEC = -20 %). */
  reduction?: number;
  /** The target was invulnerable to it (an 0x07 effect, no damage effect). */
  invulnerable?: true;
}

const RESULT_BY_TYPE: Readonly<Record<number, HitResult>> = {
  [EffectType.Miss]: "miss",
  [EffectType.Damage]: "hit",
  [EffectType.BlockedDamage]: "block",
  [EffectType.ParriedDamage]: "parry",
};

/**
 * Decodes an effect value written as hex `AABBCCDD`: the amount is `AABB`, or `DDAABB` when `CC`
 * carries the 0x40 big-value flag. Same algorithm as act analysis/heal-audit.js, which was checked
 * against the game's own combat text.
 */
export function decodeEffectValue(hex: string | undefined): number {
  const n = Number.parseInt(hex ?? "", 16);
  if (!Number.isFinite(n)) return 0;
  const aa = (n >>> 24) & 0xff;
  const bb = (n >>> 16) & 0xff;
  const cc = (n >>> 8) & 0xff;
  const dd = n & 0xff;
  return cc & 0x40 ? (dd << 16) | (aa << 8) | bb : (aa << 8) | bb;
}

export function damageTypeOf(attackType: number): DamageType {
  if (attackType >= 1 && attackType <= 4) return "physical";
  if (attackType === 5) return "magical";
  if (attackType === 6) return "special";
  return "unknown";
}

/**
 * Parses one flags word as a damage-taken effect (damage, block, parry or miss).
 * Byte layout `AABBCCDD`: DD effect type, CC hit severity (0x20 crit, 0x40 direct hit — inferred,
 * see docs/DESIGN.md 11.2), BB damage kind (low nibble attack type, high nibble element).
 */
export function parseDamageFlags(flagsHex: string | undefined, valueHex: string | undefined): DamageEffect | undefined {
  const flags = Number.parseInt(flagsHex ?? "", 16);
  if (!Number.isFinite(flags)) return undefined;
  const result = RESULT_BY_TYPE[flags & 0xff];
  if (!result) return undefined;
  const severity = (flags >>> 8) & 0xff;
  const kind = (flags >>> 16) & 0xff;
  const attackType = kind & 0x0f;
  const shieldBits = severity & 0x07;
  // LogGuide: for blocks and parries the leftmost byte "indicates the reduction (treat it as an 8-bit signed integer), e.g. 0xEC => -20%".
  const reduction = result === "block" || result === "parry" ? -(((flags >>> 24) & 0xff) << 24 >> 24) : 0;
  // A reduction of 100 % or more is no block's: not a value to divide by.
  return {
    result,
    amount: result === "miss" ? 0 : decodeEffectValue(valueHex),
    crit: (severity & 0x20) !== 0,
    direct: (severity & 0x40) !== 0,
    damageType: damageTypeOf(attackType),
    attackType,
    element: kind >>> 4,
    ...(shieldBits ? { shieldBits } : {}),
    ...(reduction > 0 && reduction < 100 ? { reduction } : {}),
  };
}

/**
 * The first damage-taken effect among the 8 flag/value pairs of a 21/22 line, if any. Not one dealt back to the
 * source: reflected damage (preceded by a 0x1D effect, LogGuide "Reflected Damage") or one flagged for the source
 * (EFFECT_ON_SOURCE). With none, a hit the target was invulnerable to (0x07) is one of 0 damage.
 */
export function findDamageEffect(line: readonly string[]): DamageEffect | undefined {
  let invulnerable = false;
  for (let i = 0; i < ABILITY_EFFECT_PAIRS; i++) {
    const at = AbilityField.firstFlags + i * 2;
    const type = Number.parseInt(line[at] ?? "", 16) & 0xff;
    if (type === EffectType.Invulnerable) invulnerable = true;
    const effect = parseDamageFlags(line[at], line[at + 1]);
    if (!effect) continue;
    const reflected = i > 0 && (Number.parseInt(line[at - 2] ?? "", 16) & 0xff) === EffectType.Reflect;
    const onSource = ((Number.parseInt(line[at + 1] ?? "", 16) >>> 8) & EFFECT_ON_SOURCE) !== 0;
    if (!reflected && !onSource) return effect;
  }
  return invulnerable ? { result: "hit", amount: 0, crit: false, direct: false, damageType: "unknown", attackType: 0, element: 0, invulnerable: true } : undefined;
}

/** Whether a 21/22 line killed its target outright (an 0x33 effect). */
export function hasInstantDeath(line: readonly string[]): boolean {
  for (let i = 0; i < ABILITY_EFFECT_PAIRS; i++) {
    if ((Number.parseInt(line[AbilityField.firstFlags + i * 2] ?? "", 16) & 0xff) === EffectType.InstantDeath) return true;
  }
  return false;
}

/** HP healed by one 21/22 line, split by who receives it. */
export interface HealEffect {
  toTarget: number;
  /** Heals riding on an attack go to the attacker (Bloodbath, Bloodwhetting, drains). */
  toSource: number;
}

/**
 * The value's third byte is the game's effect flags: 0x40 big value (see decodeEffectValue), 0x80
 * the effect lands on the source (the ACT plugin's IsSourceEntry). A heal's crit is 0x20 in the flags'
 * third byte (LogGuide "Effect Types": 0x200004 is a crit heal; the ACT plugin reads it so); nothing here
 * needs it: a shield is a share of the heal as logged, crit or not (core/game/barriers.ts).
 */
const EFFECT_ON_SOURCE = 0x80;

/** A status an action did not manage to apply (docs/DESIGN.md 5.4). */
export interface UnappliedStatus {
  statusId: number;
  /** It was meant for the source rather than the target. */
  onSource: boolean;
}

/**
 * Statuses a 21/22 line tried and failed to apply. A shield cast on a target whose shield of the
 * same kind is bigger does not overwrite it: instead of 0x0E (applied, followed by a 26 line) the
 * effect is 0x14 with the status ID in the value's upper half, and no 26 line comes. Seen 591 times
 * on shields in our samples (鼓舞, 均衡诊断, 均衡预后…).
 */
export function findUnappliedStatuses(line: readonly string[]): UnappliedStatus[] {
  const out: UnappliedStatus[] = [];
  for (let i = 0; i < ABILITY_EFFECT_PAIRS; i++) {
    const at = AbilityField.firstFlags + i * 2;
    const flags = Number.parseInt(line[at] ?? "", 16);
    if (!Number.isFinite(flags) || (flags & 0xff) !== EffectType.StatusNoEffect) continue;
    const value = Number.parseInt(line[at + 1] ?? "", 16);
    if (!Number.isFinite(value) || value >>> 16 === 0) continue;
    out.push({ statusId: value >>> 16, onSource: ((value >>> 8) & 0xff & EFFECT_ON_SOURCE) !== 0 });
  }
  return out;
}

/**
 * Statuses a 21/22 line applied, by ID: 0x0E on the target (摆脱, 雪仇), 0x0F on the source (残暴弹, and
 * the marker a ground or aura effect puts on its caster: 节制's 20 s, 野战治疗阵's 15 s).
 */
export function findAppliedStatuses(line: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ABILITY_EFFECT_PAIRS; i++) {
    const at = AbilityField.firstFlags + i * 2;
    const type = Number.parseInt(line[at] ?? "", 16) & 0xff;
    if (type !== EffectType.StatusOnTarget && type !== EffectType.StatusOnSource) continue;
    const id = Number.parseInt(line[at + 1] ?? "", 16) >>> 16;
    if (id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Statuses a 21/22 line put on its target (0x0E), each with its flags' second byte: for a shield, the
 * lowest byte of what it holds (LogGuide: "the effects will contain the least significant byte of the
 * real shield value"; 2,622 of 2,622 shields sized from max HP agree).
 */
export function findAppliedStatusBytes(line: readonly string[]): { id: number; byte: number }[] {
  const out: { id: number; byte: number }[] = [];
  for (let i = 0; i < ABILITY_EFFECT_PAIRS; i++) {
    const at = AbilityField.firstFlags + i * 2;
    const flags = Number.parseInt(line[at] ?? "", 16);
    if (!Number.isFinite(flags) || (flags & 0xff) !== EffectType.StatusOnTarget) continue;
    const id = Number.parseInt(line[at + 1] ?? "", 16) >>> 16;
    if (id > 0) out.push({ id, byte: (flags >>> 8) & 0xff });
  }
  return out;
}

/**
 * A status a 21/22 line put on (0x0E on the target, 0x0F on the source) with its flags' two middle bytes, signed.
 * LogGuide: "For damage dealt/taken modifiers, the second byte from the right in the flags is a damage taken
 * modifier (e.g. a 10% mit will come as -10 …). Statuses with two effects, such as Addle/Feint with their magical
 * and physical reduction, will use one field for each. You can examine these to find damage down and
 * vulnerability percentages." Which byte means what is the status's own (异想的幻光: healing, then magic damage).
 */
export interface AppliedStatusParams {
  id: number;
  onSource: boolean;
  /** The flags' second byte from the right. */
  first: number;
  /** The third. */
  second: number;
}

export function findAppliedStatusParams(line: readonly string[]): AppliedStatusParams[] {
  const out: AppliedStatusParams[] = [];
  for (let i = 0; i < ABILITY_EFFECT_PAIRS; i++) {
    const at = AbilityField.firstFlags + i * 2;
    const flags = Number.parseInt(line[at] ?? "", 16);
    if (!Number.isFinite(flags)) continue;
    const type = flags & 0xff;
    if (type !== EffectType.StatusOnTarget && type !== EffectType.StatusOnSource) continue;
    const id = Number.parseInt(line[at + 1] ?? "", 16) >>> 16;
    if (id > 0) out.push({ id, onSource: type === EffectType.StatusOnSource, first: ((flags >>> 8) & 0xff) << 24 >> 24, second: ((flags >>> 16) & 0xff) << 24 >> 24 });
  }
  return out;
}

export function findHealEffects(line: readonly string[]): HealEffect | undefined {
  let toTarget = 0;
  let toSource = 0;
  for (let i = 0; i < ABILITY_EFFECT_PAIRS; i++) {
    const at = AbilityField.firstFlags + i * 2;
    const flags = Number.parseInt(line[at] ?? "", 16);
    if (!Number.isFinite(flags) || (flags & 0xff) !== EffectType.Heal) continue;
    const raw = Number.parseInt(line[at + 1] ?? "", 16);
    const amount = decodeEffectValue(line[at + 1]);
    if (Number.isFinite(raw) && ((raw >>> 8) & 0xff & EFFECT_ON_SOURCE) !== 0) toSource += amount;
    else toTarget += amount;
  }
  return toTarget > 0 || toSource > 0 ? { toTarget, toSource } : undefined;
}
