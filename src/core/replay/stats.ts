import type { DamageRow, Row, RowTarget } from "../engine/types";
import { absorbedTotal } from "./shieldLines";

/** Damage taken by one player over an encounter (docs/DESIGN.md 8.5). */
export interface MemberStats {
  target: RowTarget;
  hits: number;
  /** All damage rows' amounts, DoT ticks included. */
  total: number;
  dotTotal: number;
  /** What shields took, by shield group (core/replay/shieldLines.ts); `shieldUncertain`: some of it is a bound or unknown. */
  shieldAbsorbed: number;
  shieldUncertain: boolean;
  biggest: DamageRow | undefined;
  deaths: number;
  avgMitigation: number | null;
}

/** One ability (by name and source) over an encounter. */
export interface AbilityStats {
  action: string;
  source: string;
  /** Distinct casts (21/22 sequences); DoT ticks count one each. */
  casts: number;
  hits: number;
  total: number;
  avg: number;
  max: number;
  avgMitigation: number | null;
  /** Hits that killed. */
  fatal: number;
}

/** Mean reduction (0.28 for 28%) over the rows whose mitigation is known; null when none is. */
export function meanReduction(rows: readonly DamageRow[]): number | null {
  const known = rows.filter((r) => r.multiplier !== null);
  return known.length > 0 ? known.reduce((s, r) => s + (1 - r.multiplier!), 0) / known.length : null;
}

/** Per player, most damage taken first. */
export function memberStats(rows: readonly Row[]): MemberStats[] {
  const byId = new Map<string, { target: RowTarget; damage: DamageRow[]; deaths: number }>();
  for (const r of rows) {
    let m = byId.get(r.target.id);
    if (!m) {
      m = { target: r.target, damage: [], deaths: 0 };
      byId.set(r.target.id, m);
    }
    if (r.kind === "death") m.deaths++;
    else m.damage.push(r);
  }
  return [...byId.values()]
    .map(({ target, damage, deaths }) => {
      // Hits that did not take effect are not damage taken (5.6).
      const landed = damage.filter((r) => !r.noEffect);
      let biggest: DamageRow | undefined;
      for (const r of landed) if (r.kind === "hit" && (!biggest || r.amount > biggest.amount)) biggest = r;
      const shields = absorbedTotal(landed);
      return {
        target,
        hits: landed.filter((r) => r.kind === "hit").length,
        total: landed.reduce((s, r) => s + r.amount, 0),
        dotTotal: landed.filter((r) => r.kind === "dot").reduce((s, r) => s + r.amount, 0),
        shieldAbsorbed: shields.total,
        shieldUncertain: shields.uncertain,
        biggest,
        deaths,
        avgMitigation: meanReduction(landed.filter((r) => r.kind === "hit")),
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** Per ability and source, most damage first. */
export function abilityStats(rows: readonly Row[]): AbilityStats[] {
  const byKey = new Map<string, { action: string; source: string; rows: DamageRow[]; casts: Set<string> }>();
  for (const r of rows) {
    if (r.kind === "death") continue;
    const key = `${r.action.name}\u0000${r.source.name}`;
    let a = byKey.get(key);
    if (!a) {
      a = { action: r.action.name, source: r.source.name, rows: [], casts: new Set() };
      byKey.set(key, a);
    }
    a.rows.push(r);
    a.casts.add(r.seq ?? `row${r.id}`);
  }
  return [...byKey.values()]
    .map(({ action, source, rows, casts }) => {
      const hits = rows.filter((r) => !r.noEffect);
      const total = hits.reduce((s, r) => s + r.amount, 0);
      return {
        action,
        source,
        casts: casts.size,
        hits: hits.length,
        total,
        avg: hits.length > 0 ? Math.round(total / hits.length) : 0,
        max: Math.max(0, ...hits.map((r) => r.amount)),
        avgMitigation: meanReduction(hits),
        fatal: hits.filter((r) => r.fatal).length,
      };
    })
    .sort((a, b) => b.total - a.total);
}
