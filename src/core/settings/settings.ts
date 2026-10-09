import { DEFAULT_KEPT_ENCOUNTERS } from "../archive/types";
import type { Encounter } from "../engine/types";
import { isNoCombatZone } from "../game/zones";
import { zoneSkipped } from "./zoneSkip";

/**
 * User settings (docs/DESIGN.md 7.3), shared by the monitor, the review window and the settings
 * window through localStorage. Plain data with a validator; the app layer keeps it reactive.
 */
export interface Settings {
  /** Archive: zones whose encounters are not saved, as keys of the zone tree (core/settings/zoneSkip.ts). By default all but the duties. */
  skipZones: string[];
  /** Archive: fights in a duty entered with 解除限制 are not saved. */
  skipUnrestricted: boolean;
  /** Archive: finished, unpinned 复盘 (zone visits, all their pulls) kept. */
  keepEncounters: number;
  /** Monitor: row height in px. */
  rowHeight: number;
  /** Monitor: font size in px. */
  fontSize: number;
  /** Monitor: background opacity, 0.3 ~ 1. */
  opacity: number;
  /** Monitor: tint the player's own rows. */
  highlightSelf: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  skipZones: ["field", "special"],
  skipUnrestricted: true,
  keepEncounters: DEFAULT_KEPT_ENCOUNTERS,
  rowHeight: 22,
  fontSize: 12,
  opacity: 0.86,
  highlightSelf: true,
});

/** Status icons are 21 px tall with their colour bar, so rows start at 22. */
export const ROW_HEIGHTS: readonly number[] = [22, 24, 26, 28];
/** Column widths are fixed for 475 px; past 13 px the numbers no longer fit. */
export const FONT_SIZES: readonly number[] = [11, 12, 13];
export const KEEP_RANGE = { min: 5, max: 100 } as const;
export const OPACITY_RANGE = { min: 0.3, max: 1 } as const;

/**
 * Whether encounters in this zone are archived (docs/DESIGN.md 6.2): unless the settings skip it, or no fight happens
 * there (a town, an inn, housing: not in the settings' tree). A zone the game data does not know yet is archived.
 */
export function archivesZone(settings: { readonly skipZones: readonly string[] }, zoneId: number): boolean {
  return !isNoCombatZone(zoneId) && !zoneSkipped(settings.skipZones, zoneId);
}

/**
 * Whether an encounter is archived (docs/DESIGN.md 6.2): its zone is, and it is not in a duty entered with 解除限制 while
 * the settings skip those. Settings the log does not tell (no 265 line for the zone) count as not 解除限制.
 */
export function archivesEncounter(
  settings: { readonly skipZones: readonly string[]; readonly skipUnrestricted: boolean },
  encounter: Pick<Encounter, "zoneId" | "unrestricted">,
): boolean {
  return archivesZone(settings, encounter.zoneId) && !(settings.skipUnrestricted && encounter.unrestricted);
}

/** Keys stored at most; the tree has fewer nodes than this. */
const MAX_SKIP_KEYS = 2000;

/** The stored keys; settings from before this one existed (the yes/no "不保存非副本内的战斗") get the default. */
function skipZonesOf(v: Partial<Record<string, unknown>>): string[] {
  if (Array.isArray(v.skipZones)) return [...new Set(v.skipZones.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length < 64))].slice(0, MAX_SKIP_KEYS);
  return [...DEFAULT_SETTINGS.skipZones];
}

/** Accepts anything (a stored value from an older version, a hand-edited one) and returns valid settings. */
export function normalizeSettings(value: unknown): Settings {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof Settings, unknown>>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const oneOf = (x: unknown, list: readonly number[], fallback: number) => {
    const n = num(x);
    return n !== undefined && list.includes(n) ? n : fallback;
  };
  const clamp = (x: unknown, min: number, max: number, fallback: number) => {
    const n = num(x);
    return n === undefined ? fallback : Math.min(max, Math.max(min, n));
  };
  return {
    skipZones: skipZonesOf(v),
    skipUnrestricted: typeof v.skipUnrestricted === "boolean" ? v.skipUnrestricted : DEFAULT_SETTINGS.skipUnrestricted,
    keepEncounters: Math.round(clamp(v.keepEncounters, KEEP_RANGE.min, KEEP_RANGE.max, DEFAULT_SETTINGS.keepEncounters)),
    rowHeight: oneOf(v.rowHeight, ROW_HEIGHTS, DEFAULT_SETTINGS.rowHeight),
    fontSize: oneOf(v.fontSize, FONT_SIZES, DEFAULT_SETTINGS.fontSize),
    opacity: Math.round(clamp(v.opacity, OPACITY_RANGE.min, OPACITY_RANGE.max, DEFAULT_SETTINGS.opacity) * 100) / 100,
    highlightSelf: typeof v.highlightSelf === "boolean" ? v.highlightSelf : DEFAULT_SETTINGS.highlightSelf,
  };
}
