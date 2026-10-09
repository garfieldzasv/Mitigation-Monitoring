import statuses from "@/data/generated/statuses.json";
import { DEALT_MITIGATION, TAKEN_MITIGATION } from "@/data/mitigation";
import type { StatusCategory, StatusSide } from "../status/statusTracker";

/**
 * What a status does to damage, read from its description by scripts/import-game-data.ts. Which
 * side it matters on is decided here: "dealtUp" on a boss is a damage increase, on a player it is
 * irrelevant to damage taken.
 */
export type StatusEffectKind = "takenDown" | "takenUp" | "dealtDown" | "dealtUp" | "shield" | "invuln" | "hpFloor";

/**
 * Which damage a status's effect covers, by its description (scripts/game-data/statusEffects.ts): all, one damage
 * type, one element (the log's element numbers: 1 fire … 6 water), or a condition the log cannot check.
 */
export type StatusScope = "all" | "physical" | "magical" | "conditional" | { element: number };

/** Which put-on byte is the status's value (scripts/game-data/statusEffects.ts ByteRule). */
export type StatusByte = "first" | "sign" | "none";

interface StatusInfo {
  icon: number;
  maxStacks: number;
  kind: StatusEffectKind;
  scope: StatusScope;
  byte: StatusByte;
}

const ELEMENTS: Readonly<Record<string, number>> = { fire: 1, ice: 2, wind: 3, earth: 4, lightning: 5, water: 6 };

function scopeOf(scope: string): StatusScope {
  if (scope === "physical" || scope === "magical" || scope === "conditional") return scope;
  const element = ELEMENTS[scope];
  return element ? { element } : "all";
}

/** Shown without a timer in the game, whatever duration their 26 lines carry (import-game-data.ts). */
const PERMANENT: ReadonlySet<number> = new Set(statuses.permanent);

export function isPermanentStatus(id: number): boolean {
  return PERMANENT.has(id);
}

/** Statuses some action needs to be used (神爱抚预备 for 神爱抚; import-game-data.ts). */
const ENABLERS: ReadonlySet<number> = new Set((statuses as { enablers?: number[] }).enablers ?? []);

export function isActionEnabler(id: number): boolean {
  return ENABLERS.has(id);
}

/**
 * Not listed in the review (docs/DESIGN.md 8.2): statuses the game does not show — no name, no icon; 808 carries a VFX,
 * others mark a boss's stance or a scripted move — and free company buffs (import-game-data.ts).
 */
const UNLISTED: ReadonlySet<number> = new Set([...statuses.unshown, ...statuses.fcBuffs]);

export function isListedStatus(id: number): boolean {
  return !UNLISTED.has(id);
}

/** Debuffs that take HP over time (中暑, 中毒, 出血…; import-game-data.ts). */
const DAMAGE_OVER_TIME: ReadonlySet<number> = new Set(statuses.dots);

export function isDamageOverTimeStatus(id: number): boolean {
  return DAMAGE_OVER_TIME.has(id);
}

const BY_ID: ReadonlyMap<number, StatusInfo> = new Map(
  (statuses.rows as [number, number, number, StatusEffectKind, string, string][]).map(([id, icon, maxStacks, kind, scope, byte]) => [
    id,
    { icon, maxStacks, kind, scope: scopeOf(scope), byte: byte === "sign" || byte === "none" ? byte : "first" },
  ]),
);

/** The base icon of a listed status with no damage effect (import-game-data.ts): no icon per stack (docs/DESIGN.md 8.2). */
const OTHER_ICONS: ReadonlyMap<number, number> = new Map(statuses.icons as [number, number][]);

/**
 * A status's role in a hit. On the target only damage-taken effects matter (mitigation, shields,
 * vulnerabilities, invulnerability); on the source only damage-dealt ones (Reprisal and the like,
 * damage-up buffs). A boss's 伤害提高 matters; a player's does not.
 */
export function statusCategory(id: number, side: StatusSide): StatusCategory {
  const kind = BY_ID.get(id)?.kind;
  if (side === "target") {
    if (TAKEN_MITIGATION[id]) return "mitigation";
    if (kind === "invuln" || kind === "hpFloor") return "invuln";
    if (kind === "takenDown") return "mitigation";
    if (kind === "takenUp") return "vulnerability";
    if (kind === "shield") return "shield";
    return "other";
  }
  if (DEALT_MITIGATION[id] || kind === "dealtDown") return "damageDown";
  if (kind === "dealtUp") return "damageUp";
  return "other";
}

/** Which damage the status's effect covers (import-game-data.ts: its description); "all" when unknown. */
export function statusScope(id: number): StatusScope {
  return BY_ID.get(id)?.scope ?? "all";
}

/** Which of its put-on line's bytes is the status's value. */
export function statusByte(id: number): StatusByte {
  return BY_ID.get(id)?.byte ?? "first";
}

/**
 * Whether the status makes damage come to nothing. An HP floor (死斗, 行尸走肉) is shown as an invulnerability too,
 * but the damage lands in full and shields absorb it.
 */
export function negatesDamage(id: number): boolean {
  return BY_ID.get(id)?.kind === "invuln";
}

/**
 * The stack count that means something. A 26 line's count field carries other data for statuses
 * that do not stack (告解 shows 65526), so it only counts when the status has stacks.
 */
export function effectiveStacks(id: number, stacks: number): number {
  const max = BY_ID.get(id)?.maxStacks ?? 0;
  return max > 1 ? Math.min(stacks, max) : 0;
}

/** The game icon for a status at a stack count: stacked statuses use consecutive icons. */
export function statusIconId(id: number, stacks: number): number {
  const info = BY_ID.get(id);
  if (!info) return OTHER_ICONS.get(id) ?? 0;
  if (info.icon <= 0) return 0;
  return info.maxStacks > 1 && stacks > 1 ? info.icon + Math.min(stacks, info.maxStacks) - 1 : info.icon;
}

/** Every icon a status can show, for scripts/copy-icons.ts: a classified one's per stack, the others' base icon. */
export function allStatusIconIds(): number[] {
  const ids: number[] = [];
  for (const { icon, maxStacks } of BY_ID.values()) {
    for (let s = 0; s < Math.max(1, maxStacks); s++) if (icon > 0) ids.push(icon + s);
  }
  return [...ids, ...OTHER_ICONS.values()];
}
