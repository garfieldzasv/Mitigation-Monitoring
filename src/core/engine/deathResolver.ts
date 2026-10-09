import { effectRank, type DamageRow, type Row } from "./types";

/**
 * The killing blow for a 25 line (docs/DESIGN.md 5.7), from the hits' results, back from the death:
 * - the blow whose own 37 line took the target to 0 (37 / 38 / 39 HP values are updates, never stale: LogGuide); of
 *   several in a row showing 0 (lines of one moment), the first whose 37 line came — those after it hit a body
 *   already at 0;
 * - a 37 line showing HP left ends the search: nothing before it killed;
 * - with none showing 0, a 25 line naming its killer: the last hit that took effect after the target's last HP update
 *   above 0 (`aliveBefore`), its own result or not; one naming no killer (`unnamed`): none — 地形杀 (engine.ts).
 * The player's earlier death ends the search too. Hits that did not take effect, or did no damage, are not blows.
 */
export function findKillingBlow(rows: readonly Row[], targetId: string, deathTime: number, unnamed = false, aliveBefore?: number): DamageRow | undefined {
  let zero: DamageRow | undefined;
  let last: DamageRow | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.target.id !== targetId || row.time > deathTime) continue;
    if (row.kind === "death") {
      if (row.time < deathTime) break;
      continue;
    }
    if (row.amount <= 0 || row.noEffect) continue;
    if (row.hpAfter === 0) {
      if (!zero || effectRank(row) <= effectRank(zero)) zero = row;
      continue;
    }
    if (zero || row.hpAfter !== undefined) break;
    if (aliveBefore !== undefined && (row.settledAt ?? row.time) <= aliveBefore) break;
    last ??= row;
  }
  return zero ?? (unnamed ? undefined : last);
}

/** Damage beyond the HP the target had when the blow snapshotted. */
export function overkillOf(blow: DamageRow): number | undefined {
  const over = blow.amount - blow.hpBefore;
  return over > 0 ? over : undefined;
}
