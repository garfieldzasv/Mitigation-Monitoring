import barriers from "@/data/generated/barriers.json";

/** What a shield is a share of: the put-on line's heal, the bearer's max HP, or the caster's. */
export type BarrierBase = "heal" | "bearer" | "caster";

export interface BarrierShares {
  of: BarrierBase;
  /** Percent; several: alternatives, of which the put-on line's lowest byte picks one (摆脱 by the statuses it removed). */
  percents: number[];
}

interface Entry {
  of: BarrierBase;
  percents: number[];
  levels?: { level: number; percents: number[] }[];
}

const BY_ACTION = barriers.byAction as unknown as Readonly<Record<string, Readonly<Record<string, Entry>>>>;

/**
 * What a shield an action puts on holds, as the action's tooltip says at the caster's level
 * (scripts/game-data/barriers.ts): by the status when the tooltip names it (鼓舞激励之策: 鼓舞, 激励), else the shield the
 * action puts on. The caster's level unknown (0): every percent the tooltip gives at some level, as alternatives.
 */
export function barrierShares(actionId: number, statusId: number, casterLevel: number): BarrierShares | undefined {
  const byStatus = BY_ACTION[actionId];
  const e = byStatus?.[statusId] ?? byStatus?.[0];
  if (!e) return undefined;
  if (casterLevel > 0) {
    let percents = e.percents;
    for (const l of e.levels ?? []) if (casterLevel >= l.level) percents = l.percents;
    return { of: e.of, percents };
  }
  return { of: e.of, percents: [...new Set([...e.percents, ...(e.levels ?? []).flatMap((l) => l.percents)])] };
}
