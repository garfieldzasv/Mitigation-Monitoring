import type { DamageType, HitResult } from "../logline/effect";
import type { DamageRow, Row } from "../engine/types";
import { getRoleGroup } from "../game/jobs";

/** What a row's verdict column says; "absorbed" is a hit fully eaten by a shield, "noEffect" one that did not take effect. */
export type Verdict = HitResult | "absorbed" | "noEffect";

/**
 * Rows to hide. Stored as exclusions rather than inclusions, so new party members, abilities and
 * sources show up by default and a filter saved in one encounter never empties the next.
 */
export interface RowFilter {
  hiddenMembers: string[];
  hiddenActions: string[];
  hiddenSources: string[];
  hiddenDamageTypes: DamageType[];
  hiddenVerdicts: Verdict[];
  /**
   * Labels of the stretches 在场 hidden (00:00–03:13…, core/engine/phases.ts); only those are offered. With any hidden,
   * the rows of the 离场 windows are hidden too: the filter shows the stretches 在场 ticked. Labels are one pull's times:
   * the review clears them when another encounter loads.
   */
  hiddenPhases: string[];
  hideAutoAttacks: boolean;
  hideZero: boolean;
  hideDots: boolean;
  /** Rows below this amount are hidden; 0 shows everything. */
  minAmount: number;
}

export const EMPTY_FILTER: Readonly<RowFilter> = Object.freeze({
  hiddenMembers: [],
  hiddenActions: [],
  hiddenSources: [],
  hiddenDamageTypes: [],
  hiddenVerdicts: [],
  hiddenPhases: [],
  hideAutoAttacks: false,
  hideZero: false,
  hideDots: false,
  minAmount: 0,
});

/** A DoT tick's source is unknown, so "来源" filtering uses this label for it. */
export const UNKNOWN_SOURCE = "未知";

export function verdictOf(row: DamageRow): Verdict {
  return row.noEffect ? "noEffect" : row.fullyAbsorbed ? "absorbed" : row.result;
}

export function sourceLabel(row: DamageRow): string {
  return row.source.name || UNKNOWN_SOURCE;
}

/** A row's phase: its label, and whether it is a stretch 在场 (the ones the phase filter offers) or a 离场 window. */
export interface RowPhase {
  label: string;
  inPlay: boolean;
}

/**
 * Death rows follow only the member and phase filters: hiding an ability or a source must never
 * hide who died (docs/DESIGN.md 7.2), hiding a phase hides everything in it. `phase` is the row's
 * phase, when the caller knows the phases.
 */
export function matchesRow(row: Row, f: RowFilter, phase?: RowPhase): boolean {
  if (f.hiddenMembers.includes(row.target.id)) return false;
  if (phase && f.hiddenPhases.length > 0 && (!phase.inPlay || f.hiddenPhases.includes(phase.label))) return false;
  if (row.kind === "death") return true;
  if (f.hideDots && row.kind === "dot") return false;
  if (f.hideAutoAttacks && row.autoAttack) return false;
  if (f.hideZero && row.amount === 0) return false;
  if (f.minAmount > 0 && row.amount < f.minAmount) return false;
  if (f.hiddenActions.includes(row.action.name)) return false;
  if (f.hiddenSources.includes(sourceLabel(row))) return false;
  if (f.hiddenDamageTypes.includes(row.damageType)) return false;
  if (f.hiddenVerdicts.includes(verdictOf(row))) return false;
  return true;
}

/** How many conditions are on, for the badge on the filter button. */
export function activeConditionCount(f: RowFilter): number {
  return (
    (f.hiddenMembers.length > 0 ? 1 : 0) +
    (f.hiddenActions.length > 0 ? 1 : 0) +
    (f.hiddenSources.length > 0 ? 1 : 0) +
    (f.hiddenDamageTypes.length > 0 ? 1 : 0) +
    (f.hiddenVerdicts.length > 0 ? 1 : 0) +
    (f.hiddenPhases.length > 0 ? 1 : 0) +
    (f.hideAutoAttacks ? 1 : 0) +
    (f.hideZero ? 1 : 0) +
    (f.hideDots ? 1 : 0) +
    (f.minAmount > 0 ? 1 : 0)
  );
}

export interface FilterOption {
  key: string;
  label: string;
  /** Rows carrying this value in the encounter. */
  count: number;
  job?: number;
}

export interface FilterOptions {
  members: FilterOption[];
  actions: FilterOption[];
  sources: FilterOption[];
  /** The stretches 在场, in time order; empty unless the caller gave the rows' phases. */
  phases: FilterOption[];
}

const ROLE_ORDER: Record<string, number> = { tank: 0, healer: 1, dps: 2 };
const roleRank = (job: number | undefined) => ROLE_ORDER[getRoleGroup(job ?? 0) ?? ""] ?? 3;

/**
 * Values present in the encounter's rows: abilities and sources most frequent first, members by
 * role (tank, healer, DPS) like the party list, then in order of appearance; the stretches 在场 (when
 * `phaseOf` gives each row's phase) in time order — not the 离场 windows.
 */
export function filterOptions(rows: readonly Row[], phaseOf?: (row: Row) => RowPhase | undefined): FilterOptions {
  const members = new Map<string, FilterOption>();
  const actions = new Map<string, FilterOption>();
  const sources = new Map<string, FilterOption>();
  const phases = new Map<string, FilterOption>();
  const bump = (map: Map<string, FilterOption>, key: string, label: string, job?: number) => {
    const option = map.get(key);
    if (option) option.count++;
    else map.set(key, { key, label, count: 1, ...(job ? { job } : {}) });
  };
  for (const row of rows) {
    bump(members, row.target.id, row.target.name, row.target.job);
    const phase = phaseOf?.(row);
    if (phase?.inPlay) bump(phases, phase.label, phase.label);
    if (row.kind === "death") continue;
    bump(actions, row.action.name, row.action.name);
    const source = sourceLabel(row);
    bump(sources, source, source);
  }
  const byCount = (a: FilterOption, b: FilterOption) => b.count - a.count || a.label.localeCompare(b.label);
  return {
    members: [...members.values()].sort((a, b) => roleRank(a.job) - roleRank(b.job)),
    actions: [...actions.values()].sort(byCount),
    sources: [...sources.values()].sort(byCount),
    phases: [...phases.values()],
  };
}

/** Accepts anything (a stored value from an older version, a hand-edited one) and returns a valid filter. */
export function normalizeFilter(value: unknown): RowFilter {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof RowFilter, unknown>>;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return {
    hiddenMembers: strings(v.hiddenMembers),
    hiddenActions: strings(v.hiddenActions),
    hiddenSources: strings(v.hiddenSources),
    hiddenDamageTypes: strings(v.hiddenDamageTypes) as DamageType[],
    hiddenVerdicts: strings(v.hiddenVerdicts) as Verdict[],
    hiddenPhases: strings(v.hiddenPhases),
    hideAutoAttacks: v.hideAutoAttacks === true,
    hideZero: v.hideZero === true,
    hideDots: v.hideDots === true,
    minAmount: typeof v.minAmount === "number" && v.minAmount > 0 ? Math.floor(v.minAmount) : 0,
  };
}
