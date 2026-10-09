import { DEALT_MITIGATION, resolveEntry, TAKEN_MITIGATION, type MitigationEntry, type MitigationValue } from "@/data/mitigation";
import { statusByte, statusScope, type StatusScope } from "../game/statuses";
import type { DamageType, HitResult } from "../logline/effect";
import type { StatusSnap } from "../status/statusTracker";

/** One factor of a hit's mitigation, for the breakdown on hover and the status column. */
export interface MitigationTerm {
  name: string;
  /**
   * Reductions: percent off (0 when it does not apply to this damage type), null when unknown.
   * Increases: percent up, all stacks together (0 when it does not apply), null when unknown.
   */
  percent: number | null;
  /** A reduction counts toward the mitigation rate; an increase is listed but never counted. */
  effect: "reduction" | "increase";
  side: "target" | "source";
  statusId: number;
  stacks?: number;
  inherited?: boolean;
  /** Does not stack with a stronger status of its group; counted as 0. */
  overlapped?: boolean;
}

export interface MitigationResult {
  /** Π(1 − reduction%) over the known reductions; null when it does not apply (DoT ticks). */
  multiplier: number | null;
  /** Some reduction's value is unknown, so the real mitigation is higher than shown. */
  partial: boolean;
  terms: MitigationTerm[];
}

export interface MitigationInput {
  kind: "hit" | "dot";
  damageType: DamageType;
  /** The damage's element (DamageEffect.element; 0 when unknown). */
  element?: number;
  targetId: string;
  targetLevel: number;
  targetStatuses: readonly StatusSnap[];
  sourceStatuses: readonly StatusSnap[];
  /** Whether a status's caster currently has any of the given statuses (Intervention's bonus). */
  casterHas?: (casterId: string, statusIds: readonly number[]) => boolean;
  /** The hit was blocked or parried: that takes its own share off. */
  result?: HitResult;
  /** How much the block or parry took off, in percent, as the damage effect says (DamageEffect.reduction). */
  reduction?: number;
}

/**
 * Physical damage (attack types 斩 / 突 / 打 / 射) and magic damage take the matching value. Breath (type 6,
 * "special") and damage with no attack type ("unknown"): the game data does not say which defence they meet, so
 * they take only reductions that do not depend on the type; for a split one the value is unknown.
 */
function percentFor(value: MitigationValue, damageType: DamageType): number | null {
  if (damageType === "physical") return value.physical;
  if (damageType === "magical") return value.magical;
  return value.physical === value.magical ? value.physical : null;
}

/**
 * A status no tooltip values (a duty's own vulnerabilities and reductions, which the client data does not have):
 * the damage modifier its put-on line carried (LogGuide: the flags' second byte from the right, signed, -10 for a
 * 10 % reduction), over the damage its description names (StatusScope). Which byte: the LogGuide's, or for a status
 * with other modifiers too, the one of this effect's sign (StatusByte). A vulnerability counts per stack (its bytes
 * never grow with the stacks); a stacked reduction is unknown (nothing says how its stacks count). Unknown too when no
 * line put it on in the log, or no byte of that sign is there (some statuses use them for other data).
 */
function fromLog(s: StatusSnap, effect: MitigationTerm["effect"], input: MitigationInput): number | null {
  const params = s.params;
  if (!params) return null;
  const sign = effect === "reduction" ? -1 : 1;
  const rule = statusByte(s.id);
  const candidates = rule === "first" ? [params.first] : rule === "sign" ? [params.first, params.second].filter((b) => Math.sign(b) === sign) : [];
  const byte = candidates.length === 1 ? candidates[0]! : undefined;
  if (byte === undefined || Math.sign(byte) !== sign) return null;
  let percent: number | null;
  if (effect === "reduction") percent = s.stacks > 1 || byte <= -100 ? null : -byte;
  else percent = byte * Math.max(1, s.stacks);
  return scoped(percent, statusScope(s.id), input);
}

/**
 * A value that covers part of the damage: one type (0 for the other, unknown for breath and damage with no attack
 * type), one element (0 for another, unknown when the hit's is not known), a condition (unknown).
 */
function scoped(percent: number | null, scope: StatusScope, input: MitigationInput): number | null {
  if (percent === null || scope === "all") return percent;
  if (scope === "conditional") return null;
  if (typeof scope === "object") return input.element ? (input.element === scope.element ? percent : 0) : null;
  if (input.damageType === "physical" || input.damageType === "magical") return input.damageType === scope ? percent : 0;
  return null;
}

/**
 * The mitigation rate counts reductions only (docs/DESIGN.md 5.5): mitigation on the target and
 * Reprisal-like debuffs on the source, including those borrowed from the boss for its helper
 * actors (the logs show the game applies them). Statuses that do not stack count once (the
 * strongest of a group); a reduction that does not cover this damage type counts 0. A blocked or
 * parried hit counts that as a reduction too (it is this hit's, like a status's). The tanks'
 * passive trait is left out. Vulnerabilities and damage-ups are listed but never counted (the rate is
 * mitigation; a vulnerability's value, when known, goes into the unmitigated estimate instead). Values come
 * from the tooltips (data/mitigation.ts), else from the log (fromLog); a blocked or parried hit's from its damage effect. Shields do not count either; they are
 * measured separately. DoT ticks are skipped: their mitigation was fixed when the DoT landed.
 */
export function computeMitigation(input: MitigationInput): MitigationResult {
  if (input.kind === "dot") return { multiplier: null, partial: false, terms: [] };
  const terms: MitigationTerm[] = [];
  const seen = new Set<string>();
  /** Strongest term per non-stacking group. */
  const groupBest = new Map<string, MitigationTerm>();

  const valueOf = (entry: MitigationEntry, s: StatusSnap) =>
    percentFor(
      resolveEntry(entry, {
        level: input.targetLevel,
        selfApplied: s.sourceId === input.targetId,
        casterHas: (ids) => input.casterHas?.(s.sourceId, ids) ?? false,
      }),
      input.damageType,
    );

  const add = (s: StatusSnap, side: "target" | "source", effect: MitigationTerm["effect"], entry?: MitigationEntry) => {
    const key = `${side}:${s.id}`;
    if (seen.has(key)) return; // the same status from two players does not stack
    seen.add(key);
    const term: MitigationTerm = {
      name: s.name,
      percent: entry ? valueOf(entry, s) : fromLog(s, effect, input),
      effect,
      side,
      statusId: s.id,
      ...(s.stacks > 1 ? { stacks: s.stacks } : {}),
      ...(s.inherited ? { inherited: true } : {}),
    };
    terms.push(term);
    if (entry?.group && term.percent !== null) {
      const best = groupBest.get(entry.group);
      if (!best || (best.percent ?? 0) < term.percent) {
        if (best) best.overlapped = true;
        groupBest.set(entry.group, term);
      } else {
        term.overlapped = true;
      }
    }
  };

  for (const s of input.targetStatuses) {
    if (s.category === "mitigation") add(s, "target", "reduction", TAKEN_MITIGATION[s.id]);
    else if (s.category === "vulnerability") add(s, "target", "increase");
  }
  // Own statuses before borrowed ones, so a direct Reprisal wins over an inherited copy.
  const source = [...input.sourceStatuses].sort((a, b) => Number(a.inherited === true) - Number(b.inherited === true));
  for (const s of source) {
    if (s.category === "damageDown") add(s, "source", "reduction", DEALT_MITIGATION[s.id]);
    else if (s.category === "damageUp") add(s, "source", "increase");
  }

  if (input.result === "block" || input.result === "parry") {
    terms.push({ name: input.result === "block" ? "格挡" : "招架", percent: input.reduction ?? null, effect: "reduction", side: "target", statusId: 0 });
  }

  let multiplier = 1;
  let partial = false;
  for (const t of terms) {
    if (t.effect !== "reduction" || t.overlapped) continue;
    if (t.percent === null) partial = true;
    else multiplier *= 1 - t.percent / 100;
  }
  return { multiplier, partial, terms };
}

/** The vulnerability terms on the player hit (increases on the target side). */
export function vulnerabilityTerms(terms: readonly MitigationTerm[]): MitigationTerm[] {
  return terms.filter((t) => t.effect === "increase" && t.side === "target");
}

/** Damage taken up by the vulnerabilities whose value is known (×1.2 for one stack of a 20 % one); 1 with none. */
export function vulnerabilityFactor(terms: readonly MitigationTerm[]): number {
  return vulnerabilityTerms(terms).reduce((x, t) => (t.percent === null ? x : x * (1 + t.percent / 100)), 1);
}

/** Whether a status shown for a hit takes part in its mitigation (the status column greys out the rest). */
export function termApplies(term: MitigationTerm | undefined): boolean {
  return !term || (!term.overlapped && term.percent !== 0);
}
