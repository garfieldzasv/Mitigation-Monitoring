import type { DamageRow, Row } from "../engine/types";
import { meanReduction } from "./stats";

/** One cast that hit several players: every hit row sharing a 21/22 sequence (docs/DESIGN.md 8.4). */
export interface AoeGroup {
  seq: string;
  time: number;
  offset: number;
  action: string;
  source: string;
  rows: DamageRow[];
  total: number;
  avg: number;
  min: number;
  max: number;
  deaths: number;
  /** meanReduction of the hits. */
  avgMitigation: number | null;
}

export const DEFAULT_AOE_MIN_TARGETS = 4;

/** Casts that hit at least `minTargets` of the given rows' players, in time order. */
export function aoeGroups(rows: readonly Row[], minTargets = DEFAULT_AOE_MIN_TARGETS): AoeGroup[] {
  const bySeq = new Map<string, DamageRow[]>();
  for (const r of rows) {
    if (r.kind !== "hit" || !r.seq) continue;
    let group = bySeq.get(r.seq);
    if (!group) {
      group = [];
      bySeq.set(r.seq, group);
    }
    group.push(r);
  }
  const groups: AoeGroup[] = [];
  for (const [seq, hits] of bySeq) {
    if (hits.length < minTargets) continue;
    const first = hits[0]!;
    // A hit that did not take effect is shown, but is not damage taken (5.6).
    const landed = hits.filter((r) => !r.noEffect);
    const amounts = landed.length > 0 ? landed.map((r) => r.amount) : [0];
    const total = amounts.reduce((a, b) => a + b, 0);
    groups.push({
      seq,
      time: first.time,
      offset: first.offset,
      action: first.action.name,
      source: first.source.name,
      rows: hits,
      total,
      avg: Math.round(total / amounts.length),
      min: Math.min(...amounts),
      max: Math.max(...amounts),
      deaths: hits.filter((r) => r.fatal).length,
      avgMitigation: meanReduction(landed),
    });
  }
  return groups.sort((a, b) => a.time - b.time);
}

/**
 * Who went without what the others had: for each hit, the mitigation and shield statuses that most
 * of the other players hit by the same cast carried but this one did not (a party mitigation it was
 * out of range for, a shield that missed it). Personal cooldowns never qualify, they are on one player.
 */
export function missingMitigation(group: Pick<AoeGroup, "rows">): Map<number, { id: number; name: string }[]> {
  const holders = new Map<number, { name: string; rows: Set<number> }>();
  for (const r of group.rows) {
    for (const s of r.targetStatuses) {
      if (s.category !== "mitigation" && s.category !== "shield") continue;
      let h = holders.get(s.id);
      if (!h) {
        h = { name: s.name, rows: new Set() };
        holders.set(s.id, h);
      }
      h.rows.add(r.id);
    }
  }
  const missing = new Map<number, { id: number; name: string }[]>();
  for (const r of group.rows) {
    const others = group.rows.length - 1;
    const list: { id: number; name: string }[] = [];
    for (const [id, h] of holders) {
      if (h.rows.has(r.id)) continue;
      if (others > 0 && h.rows.size * 2 > others) list.push({ id, name: h.name });
    }
    if (list.length > 0) missing.set(r.id, list);
  }
  return missing;
}
