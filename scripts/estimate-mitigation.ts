/**
 * Estimates what each status really does to damage from ACT network logs, to check
 * src/data/mitigation.ts (docs/DESIGN.md 5.5, 11.2).
 *
 *   pnpm estimate-mitigation <Network_*.log>... [--min 30]
 *
 * Model, per clean hit (no shield, crit, block, invulnerability):
 *   log(damage) = group effect + player effect + Σ status effects + noise
 * Group and player effects are removed by alternating projections, then the status effects are an
 * ordinary least-squares fit; a coefficient β becomes a reduction of (1 − e^β) × 100 %. The player
 * effect (encounter, player, damage type) absorbs gear defence and the tanks' trait. Two fits:
 *
 * - Target side: the group is one cast (same sequence), so everyone hit by the same AOE is compared
 *   with everyone else; base damage, stack splits and distance cancel out exactly.
 * - Source side: Reprisal and the like are the same for everyone in a cast, so the group is the
 *   ability (zone, action, damage type, number hit) and casts are compared with each other. Debuffs
 *   borrowed from a same-name actor (the boss, for its helpers) get their own coefficient, which
 *   answers whether the game applies them to helpers' damage.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Engine } from "../src/core/engine/engine";
import type { DamageRow } from "../src/core/engine/types";
import { DEALT_MITIGATION, TAKEN_MITIGATION } from "../src/data/mitigation";

interface Sample {
  y: number;
  cast: string;
  ability: string;
  player: string;
  target: string[];
  source: string[];
}

const args = process.argv.slice(2);
const minIndex = args.indexOf("--min");
const MIN_ROWS = minIndex >= 0 ? Number(args[minIndex + 1]) : 30;
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--min");

function clean(r: DamageRow): boolean {
  return (
    r.kind === "hit" &&
    r.result === "hit" &&
    r.amount > 0 &&
    !r.crit &&
    !r.direct &&
    !r.invulnerable &&
    r.hpAfter !== undefined &&
    !r.shieldAbsorbed &&
    !r.fullyAbsorbed &&
    r.damageType !== "unknown" &&
    // a shield up at the hit would hide part of the damage
    !r.targetStatuses.some((s) => s.category === "shield")
  );
}

const key = (side: string, id: number, name: string, stacks: number, type: string) =>
  `${side}|${id}|${name}${stacks > 1 ? `×${stacks}` : ""}|${type}`;

async function collect(): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (const file of files) {
    const engine = new Engine({ maxEncounters: 2 });
    engine.subscribe((change) => {
      if (change.kind !== "encounterEnd") return;
      const e = change.encounter;
      for (const r of e.rows) {
        if (r.kind === "death" || !clean(r)) continue;
        const t = r.damageType;
        samples.push({
          y: Math.log(r.amount),
          cast: `${file}|${e.id}|${r.seq}`,
          ability: `${e.zoneId}|${r.action.id}|${t}|${r.targetCount}`,
          player: `${file}|${e.id}|${r.target.id}|${t}`,
          // Statuses that do not stack with each other are one feature: the group, whichever applies.
          target: [
            ...new Set(
              r.targetStatuses
                .filter((s) => s.category === "mitigation" || s.category === "vulnerability")
                .map((s) => {
                  const group = TAKEN_MITIGATION[s.id]?.group;
                  return group ? key("G", 0, group, 0, t) : key("T", s.id, s.name, s.stacks, t);
                }),
            ),
          ],
          source: [
            ...new Set(
              r.sourceStatuses
                .filter((s) => s.category === "damageDown" || s.category === "damageUp")
                .map((s) => key(s.inherited ? "SI" : "S", s.id, s.name, s.stacks, t)),
            ),
          ],
        });
      }
    });
    for await (const raw of createInterface({ input: createReadStream(file) })) engine.feed(raw.split("|"));
    console.error(`${file}: ${samples.length} clean hits so far`);
  }
  return samples;
}

/** Subtracts group means of `v` for each grouping in turn, until it stops changing. */
function demean(v: Float64Array, groups: { ids: Int32Array; counts: Float64Array }[]): void {
  for (let iter = 0; iter < 100; iter++) {
    let change = 0;
    for (const { ids, counts } of groups) {
      const sums = new Float64Array(counts.length);
      for (let i = 0; i < v.length; i++) sums[ids[i]!]! += v[i]!;
      for (let i = 0; i < v.length; i++) {
        const m = sums[ids[i]!]! / counts[ids[i]!]!;
        v[i]! -= m;
        change += Math.abs(m);
      }
    }
    if (change / v.length < 1e-10) return;
  }
}

/** Solves A x = b by Gauss-Jordan elimination; also returns A⁻¹'s diagonal for standard errors. */
function solve(a: number[][], b: number[]): { x: number[]; invDiag: number[] } {
  const n = b.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)), b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]! || 1e-12;
    for (let k = c; k <= 2 * n; k++) m[c]![k]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      if (f === 0) continue;
      for (let k = c; k <= 2 * n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return { x: m.map((row) => row[2 * n]!), invDiag: m.map((row, i) => row[n + i]!) };
}

function index(keys: string[]): { ids: Int32Array; counts: Float64Array } {
  const map = new Map<string, number>();
  const ids = new Int32Array(keys.length);
  keys.forEach((k, i) => {
    let id = map.get(k);
    if (id === undefined) map.set(k, (id = map.size));
    ids[i] = id;
  });
  const counts = new Float64Array(map.size);
  for (const id of ids) counts[id]!++;
  return { ids, counts };
}

interface Estimate {
  feature: string;
  rows: number;
  est: number;
  lo: number;
  hi: number;
}

/** Two-way fixed effects (group, player) + OLS on the features kept by `pick`. */
function fit(all: Sample[], groupOf: (s: Sample) => string, featuresOf: (s: Sample) => string[]): { estimates: Estimate[]; n: number; sigma: number } {
  let samples = all;
  // Drop groups with a single sample, repeatedly: they carry no comparison.
  for (let pass = 0; pass < 4; pass++) {
    const g = new Map<string, number>();
    const p = new Map<string, number>();
    for (const s of samples) {
      g.set(groupOf(s), (g.get(groupOf(s)) ?? 0) + 1);
      p.set(s.player, (p.get(s.player) ?? 0) + 1);
    }
    samples = samples.filter((s) => g.get(groupOf(s))! > 1 && p.get(s.player)! > 1);
  }
  const freq = new Map<string, number>();
  for (const s of samples) for (const f of featuresOf(s)) freq.set(f, (freq.get(f) ?? 0) + 1);
  const keep = [...freq].filter(([, n]) => n >= MIN_ROWS).map(([f]) => f);
  const col = new Map(keep.map((f, i) => [f, i]));
  const n = samples.length;
  const groups = [index(samples.map(groupOf)), index(samples.map((s) => s.player))];

  const y = Float64Array.from(samples.map((s) => s.y));
  demean(y, groups);
  const x = keep.map(() => new Float64Array(n));
  samples.forEach((s, i) => {
    for (const f of featuresOf(s)) {
      const c = col.get(f);
      if (c !== undefined) x[c]![i] = 1;
    }
  });
  x.forEach((column) => demean(column, groups));
  // Columns that the fixed effects explain completely (a status present for a whole encounter) are dropped.
  const live = keep.map((_, c) => x[c]!.some((v) => Math.abs(v) > 1e-6));
  const cols = keep.map((_, c) => c).filter((c) => live[c]);

  const xtx = cols.map((a) => cols.map((b) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += x[a]![i]! * x[b]![i]!;
    return sum + (a === b ? 1e-9 : 0);
  }));
  const xty = cols.map((a) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += x[a]![i]! * y[i]!;
    return sum;
  });
  const { x: beta, invDiag } = solve(xtx, xty);
  let rss = 0;
  for (let i = 0; i < n; i++) {
    let f = 0;
    cols.forEach((c, j) => (f += x[c]![i]! * beta[j]!));
    rss += (y[i]! - f) ** 2;
  }
  const dof = Math.max(1, n - cols.length - groups[0]!.counts.length - groups[1]!.counts.length);
  const sigma2 = rss / dof;
  const pct = (b: number) => (1 - Math.exp(b)) * 100;
  const estimates = cols.map((c, j) => {
    const se = Math.sqrt(Math.max(0, sigma2 * invDiag[j]!));
    return { feature: keep[c]!, rows: freq.get(keep[c]!)!, est: pct(beta[j]!), lo: pct(beta[j]! + 1.96 * se), hi: pct(beta[j]! - 1.96 * se) };
  });
  return { estimates: estimates.sort((a, b) => a.feature.localeCompare(b.feature)), n, sigma: Math.sqrt(sigma2) };
}

function tableValue(feature: string): number | undefined {
  const [side, id, name, type] = feature.split("|");
  const entry =
    side === "G"
      ? (() => {
          const e = Object.values(TAKEN_MITIGATION).find((x) => x.group === name);
          return e?.levels?.at(-1) ?? e;
        })()
      : (side === "T" ? TAKEN_MITIGATION : DEALT_MITIGATION)[Number(id)];
  if (!entry) return undefined;
  if (type === "physical") return entry.physical;
  if (type === "magical") return entry.magical;
  return entry.physical === entry.magical ? entry.physical : undefined;
}

function print(title: string, result: { estimates: Estimate[]; n: number; sigma: number }, sides: string[]): void {
  console.log(`\n## ${title}: ${result.n} hits, residual σ ≈ ${(result.sigma * 100).toFixed(1)}% (the game's own spread is ±5%)\n`);
  console.log("| 侧 | ID | 状态 | 伤害类型 | 样本 | 估计减伤 % | 95% 区间 | 表中 % | |");
  console.log("|---|---|---|---|---:|---:|---|---:|---|");
  for (const e of result.estimates) {
    const [side, id, name, type] = e.feature.split("|");
    if (!sides.includes(side!)) continue;
    const table = tableValue(e.feature);
    const flag = table !== undefined && (table < e.lo - 1 || table > e.hi + 1) ? "⚠ 不一致" : "";
    console.log(
      `| ${side} | ${Number(id).toString(16).toUpperCase()} | ${name} | ${type} | ${e.rows} | ${e.est.toFixed(1)} | ${e.lo.toFixed(1)} ~ ${e.hi.toFixed(1)} | ${table ?? "—"} | ${flag} |`,
    );
  }
}

async function main(): Promise<void> {
  if (files.length === 0) throw new Error("Usage: estimate-mitigation <Network_*.log>... [--min 30]");
  const samples = await collect();
  print("受击者身上的状态（同一次施放内比较）", fit(samples, (s) => s.cast, (s) => s.target), ["T", "G"]);
  print("来源身上的状态（同一技能、同样命中人数，跨次比较）", fit(samples, (s) => s.ability, (s) => [...s.target, ...s.source]), ["S", "SI"]);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
