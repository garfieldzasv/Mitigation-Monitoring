import { effectRank, type DamageRow, type DeathRow, type Row } from "../engine/types";
import { isListedStatus } from "../game/statuses";
import { absorbedTotal } from "./shieldLines";
import type { HealEvent, HpPoint, NpcCast, ReplayDetail, StatusChange } from "./detail";

export type TimelineEntry =
  | { kind: "hit"; time: number; row: DamageRow }
  | { kind: "heal"; time: number; heal: HealEvent }
  | { kind: "status"; time: number; change: StatusChange }
  /** `count` same-name actors starting the same cast together (a boss's helpers) make one entry. */
  | { kind: "cast"; time: number; cast: NpcCast; count: number }
  | { kind: "death"; time: number; row: DeathRow };

export interface DeathReplay {
  death: DeathRow;
  blow: DamageRow | undefined;
  from: number;
  to: number;
  /** Oldest first. */
  entries: TimelineEntry[];
  /** HP and shield from the last point before `from` to the death. */
  hp: HpPoint[];
  maxHp: number;
  /** `shieldUncertain`: some of the shields' figure is a bound or unknown (core/replay/shieldLines.ts). */
  totals: { damage: number; shieldAbsorbed: number; shieldUncertain: boolean; hits: number; healing: number; overheal: number; heals: number };
}

export const DEFAULT_REPLAY_WINDOW_MS = 15000;
/**
 * Casts of one action by same-name actors starting this close together are one line: a boss's
 * helpers start together, a row of adds (the hunt's 惰性水晶) staggered by ~0.5 s.
 */
const SAME_CAST_MS = 1000;

/** Order within one timestamp: what explains the HP first, the death last. */
const ORDER: Record<TimelineEntry["kind"], number> = { cast: 0, status: 1, heal: 2, hit: 3, death: 4 };

/**
 * Everything that happened to one player in the seconds before a death (docs/DESIGN.md 8.3):
 * damage taken, heals received, statuses gained and lost, enemy casts, and the HP curve.
 */
export function buildDeathReplay(
  death: DeathRow,
  rows: readonly Row[],
  detail: ReplayDetail,
  windowMs = DEFAULT_REPLAY_WINDOW_MS,
): DeathReplay {
  const id = death.target.id;
  const to = death.time;
  const from = to - windowMs;
  const inWindow = (t: number) => t >= from && t <= to;
  const entries: TimelineEntry[] = [];

  for (const r of rows) {
    if (r.kind !== "death" && r.target.id === id && inWindow(r.time)) entries.push({ kind: "hit", time: r.time, row: r });
  }
  for (const h of detail.heals) if (h.target.id === id && inWindow(h.time)) entries.push({ kind: "heal", time: h.time, heal: h });
  for (const c of detail.statusChanges) {
    if (c.target.id === id && inWindow(c.time) && isListedStatus(c.status.id)) entries.push({ kind: "status", time: c.time, change: c });
  }
  const casts = detail.enemyCasts();
  const lastCast = new Map<string, Extract<TimelineEntry, { kind: "cast" }>>();
  for (const c of casts) {
    if (!inWindow(c.time)) continue;
    const key = `${c.action.id}:${c.source.name}`;
    const prev = lastCast.get(key);
    if (prev && c.time - prev.time <= SAME_CAST_MS) {
      prev.count++;
      continue;
    }
    const entry = { kind: "cast" as const, time: c.time, cast: c, count: 1 };
    lastCast.set(key, entry);
    entries.push(entry);
  }
  entries.push({ kind: "death", time: death.time, row: death });
  // Hits locked in together took effect in the order of their own 37 lines (docs/DESIGN.md 5.6).
  entries.sort((a, b) => a.time - b.time || ORDER[a.kind] - ORDER[b.kind] || (a.kind === "hit" && b.kind === "hit" ? effectRank(a.row) - effectRank(b.row) : 0));

  const all = detail.hpOf(id);
  const hp: HpPoint[] = [];
  for (let i = 0; i < all.length; i++) {
    const p = all[i]!;
    if (p.time > to) break;
    if (p.time >= from) hp.push(p);
    else if (all[i + 1] === undefined || all[i + 1]!.time >= from) hp.push({ ...p, time: from });
  }

  const blowRow = rows.find((r) => r.id === death.killerRowId);
  const blow = blowRow && blowRow.kind !== "death" ? blowRow : undefined;
  const totals = { damage: 0, shieldAbsorbed: 0, shieldUncertain: false, hits: 0, healing: 0, overheal: 0, heals: 0 };
  const landed: DamageRow[] = [];
  for (const e of entries) {
    if (e.kind === "hit") {
      if (e.row.noEffect) continue; // not damage taken (5.6)
      totals.hits++;
      totals.damage += e.row.amount;
      landed.push(e.row);
    } else if (e.kind === "heal") {
      totals.heals++;
      totals.healing += e.heal.amount - e.heal.overheal;
      totals.overheal += e.heal.overheal;
    }
  }
  // The shields' figure for the groups these hits are in, each once: a group reaching back before the window counts whole.
  const shields = absorbedTotal(landed);
  totals.shieldAbsorbed = shields.total;
  totals.shieldUncertain = shields.uncertain;
  const maxHp = blow?.maxHp || hp.reduce((m, p) => Math.max(m, p.maxHp), 0);
  return { death, blow, from, to, entries, hp, maxHp, totals };
}
