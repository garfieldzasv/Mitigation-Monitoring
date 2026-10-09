/**
 * Checks the shield ledger's absorption against the raw lines (docs/DESIGN.md 5.6).
 *
 *   pnpm validate-shields <Network_*.log>... [--show <ability>] [--list <n>]
 *
 * Runs whole ACT network logs through the engine, then, independently of the ledger's code, walks
 * each player's shield reports (full 37 lines and 38 lines; reports within 10 ms are one moment)
 * and checks every stretch the reports alone can decide: hits that took effect inside it (at their
 * own 37 line, DoT ticks at the tick) and nothing else changing the shield (no shield put on in it
 * or just before, none removed except by those hits, none running out, no hit without its 37 line,
 * no hit that a report between its line and its 37 line may already show). Such a hit is checked over
 * the stretches it may fall in, together: from the last report before its line to its 37 line.
 * Their absorption must sum to what the two reports allow: before − after within one 1 % step each
 * way, or the whole shield before when a hit got damage through and the report after is 0.
 *
 * Also prints how many shielded hits got an absorption, and the implied unmitigated damage
 * ((damage + absorbed) ÷ multiplier) against the same ability's median on unshielded hits — a rough
 * plausibility check only: one ability's damage varies by target. `--show` prints the rows of an
 * ability's first casts; `--list` how many misfits to print (default 25).
 */
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { Engine } from "../src/core/engine/engine";
import type { DamageRow } from "../src/core/engine/types";
import { statusCategory } from "../src/core/game/statuses";
import { isRelevantLineType, parseLogLine } from "../src/core/logline/parse";

const args = process.argv.slice(2);
const option = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const show = option("--show");
const listed = Number(option("--list") ?? 25);
const files = args;

/** Reports this close together are one moment (shieldLedger.ts BURST_MS). */
const MOMENT_MS = 10;
/** A hit's own 37 line within this of its line (damageRecorder.ts RESULT_TIMEOUT_MS). */
const RESULT_MS = 5000;

const quantile = (xs: readonly number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(p * (s.length - 1))]! : Number.NaN;
};
const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

const tally = { rows: 0, shielded: 0, shieldedValued: 0, zero: 0, zeroValued: 0, flagged: 0, single: 0, singleIn: 0, multi: 0, multiIn: 0, merged: 0, mergedIn: 0 };
const ratios = { absorbed: [] as number[], brokeThrough: [] as number[] };
const misfits: string[] = [];

for (const file of files) {
  const engine = new Engine({ maxEncounters: Number.MAX_SAFE_INTEGER });
  const reports = new Map<string, { t: number; p: number; maxHp: number }[]>();
  const own37 = new Map<string, number[]>();
  const added = new Map<string, number[]>();
  const removed = new Map<string, number[]>();
  const runOut = new Map<string, number[]>();
  for await (const raw of createInterface({ input: createReadStream(file) })) {
    const l = raw.split("|");
    const t = Date.parse(l[1] ?? "");
    if ((l[0] === "37" || l[0] === "38") && l[2]?.startsWith("10")) {
      if (l[0] === "37") push(own37, `${l[4]}|${l[2]}`, t);
      if (l[9] !== "") push(reports, l[2]!, { t, p: Number(l[9]), maxHp: Number(l[6]) });
    } else if ((l[0] === "26" || l[0] === "30") && l[7]?.startsWith("10") && statusCategory(Number.parseInt(l[2]!, 16), "target") === "shield") {
      push(l[0] === "26" ? added : removed, l[7]!, t);
      const seconds = Number(l[4]);
      if (l[0] === "26" && seconds > 0 && seconds < 9000) push(runOut, l[7]!, t + seconds * 1000 + 1000);
    }
    if (!isRelevantLineType(l[0])) continue;
    const e = parseLogLine(l);
    if (e) engine.handle(e);
  }
  engine.flush();

  const rows = engine.encounters.flatMap((enc) => enc.rows.filter((r): r is DamageRow => r.kind !== "death"));
  const ownResult = (r: DamageRow) => (r.seq ? own37.get(`${r.seq}|${r.target.id}`)?.find((t) => t >= r.time && t - r.time <= RESULT_MS) : undefined);
  const tookEffect = (r: DamageRow) => (r.kind === "dot" ? r.time : ownResult(r));
  const reaches = (r: DamageRow) => r.result !== "miss" && !r.invulnerable;
  const byTarget = new Map<string, DamageRow[]>();
  const unshielded = new Map<string, number[]>();
  for (const r of rows) {
    push(byTarget, r.target.id, r);
    tally.rows++;
    const shielded = r.targetStatuses.some((s) => s.category === "shield");
    if (r.fullyAbsorbed && !r.shieldAbsorbed) tally.flagged++;
    if (shielded && reaches(r)) {
      tally.shielded++;
      if (r.shieldAbsorbed) tally.shieldedValued++;
      if (r.amount === 0) {
        tally.zero++;
        if (r.shieldAbsorbed) tally.zeroValued++;
      }
    }
    if (!shielded && reaches(r) && r.amount > 0 && r.multiplier) push(unshielded, `${r.source.name}|${r.action.name}`, r.amount / r.multiplier);
  }
  for (const r of rows) {
    const base = unshielded.get(`${r.source.name}|${r.action.name}`);
    if (!r.shieldAbsorbed || !r.multiplier || !base || base.length < 3) continue;
    (r.amount > 0 ? ratios.brokeThrough : ratios.absorbed).push((r.amount + r.shieldAbsorbed) / r.multiplier / quantile(base, 0.5));
  }

  for (const [target, all] of reports) {
    const mine = byTarget.get(target) ?? [];
    const moments = all.filter((r, i) => !(all[i + 1] && all[i + 1]!.t - r.t <= MOMENT_MS));
    // A report between a hit's line and its own 37 line may already show it: its stretch is not certain.
    const unsure = mine
      .map((r) => ({ from: r.time, to: tookEffect(r) }))
      .filter((w) => w.to !== undefined && moments.some((m) => m.t > w.from && m.t < w.to! - MOMENT_MS));
    /** Checks the hits that took effect in (a, b]; `merged`: a hit there may have shown at a report in between. */
    const check = (a: (typeof moments)[number], b: (typeof moments)[number], merged: boolean) => {
      const inside = (t: number | undefined) => t !== undefined && t > a.t && t <= b.t;
      const hits = mine.filter((r) => inside(tookEffect(r)));
      if (hits.length === 0) return;
      // Only what the reports alone decide.
      if ((added.get(target) ?? []).some((t) => t > a.t - 1500 && t <= b.t)) return;
      const brokenBy = (t: number) => hits.some((h) => tookEffect(h) === t || (merged && t > h.time && t <= tookEffect(h)!));
      if ((removed.get(target) ?? []).some((t) => inside(t) && !brokenBy(t))) return;
      if ((runOut.get(target) ?? []).some(inside)) return;
      if (mine.some((r) => r.seq && ownResult(r) === undefined && r.time > a.t - RESULT_MS && r.time <= b.t)) return;
      // A hit that may have shown before a: not certain to be here.
      if (unsure.some((w) => w.from < b.t && w.to! > a.t && (merged ? w.from < a.t : true))) return;
      const step = b.maxHp / 100;
      const sum = hits.reduce((s, h) => s + (h.shieldAbsorbed ?? 0), 0);
      const brokeThrough = b.p === 0 && hits.some((h) => h.amount > 0 && reaches(h));
      const lo = brokeThrough ? a.p * step : Math.max(0, (a.p - b.p - 1) * step);
      const hi = brokeThrough ? (a.p + 1) * step : (a.p - b.p + 1) * step;
      const ok = sum >= lo - 2 && sum <= hi + 2;
      if (merged) {
        tally.merged++;
        if (ok) tally.mergedIn++;
      } else if (hits.length === 1) {
        tally.single++;
        if (ok) tally.singleIn++;
      } else {
        tally.multi++;
        if (ok) tally.multiIn++;
      }
      if (!ok) {
        const list = hits.map((h) => `${h.action.name} ${h.amount}/${h.shieldAbsorbed ?? 0}`).join(", ");
        misfits.push(`${basename(file)} ${new Date(b.t).toISOString()} ${hits[0]!.target.name} ${a.p}% → ${b.p}%${merged ? " (merged)" : ""}: ${list}; absorbed ${sum}, reports allow ${Math.round(lo)}~${Math.round(hi)}`);
      }
    };
    for (let i = 1; i < moments.length; i++) {
      const a = moments[i - 1]!;
      const b = moments[i]!;
      if (!unsure.some((w) => w.from < b.t && w.to! > a.t)) check(a, b, false);
    }
    const seen = new Set<string>();
    for (const w of unsure) {
      const a = [...moments].reverse().find((m) => m.t <= w.from);
      const b = moments.find((m) => m.t >= w.to! - MOMENT_MS);
      if (!a || !b || seen.has(`${a.t}|${b.t}`)) continue;
      seen.add(`${a.t}|${b.t}`);
      check(a, b, true);
    }
  }

  if (show) {
    const group = rows.filter((r) => r.action.name === show);
    for (const seq of [...new Set(group.map((r) => r.seq))].slice(0, 3)) {
      const cast = group.filter((r) => r.seq === seq);
      console.log(`== ${basename(file)} ${show} ${new Date(cast[0]!.time).toISOString()}`);
      for (const r of cast) {
        const raw = r.multiplier ? Math.round((r.amount + (r.shieldAbsorbed ?? 0)) / r.multiplier) : "-";
        console.log(`  ${r.target.name.padEnd(12)} damage ${r.amount}  absorbed ${r.shieldAbsorbed ?? 0}  fully ${r.fullyAbsorbed}  HP ${r.hpBefore}→${r.hpAfter ?? "-"}  unmitigated ${raw}`);
      }
    }
  }
}

const share = (a: number, b: number) => `${a}/${b} (${((100 * a) / Math.max(1, b)).toFixed(1)}%)`;
const spread = (xs: number[]) => `n ${xs.length}, p10 ${quantile(xs, 0.1).toFixed(2)}, p25 ${quantile(xs, 0.25).toFixed(2)}, median ${quantile(xs, 0.5).toFixed(2)}, p75 ${quantile(xs, 0.75).toFixed(2)}, p90 ${quantile(xs, 0.9).toFixed(2)}`;
console.log(`damage rows                                  ${tally.rows}`);
console.log(`shielded hits with an absorption             ${share(tally.shieldedValued, tally.shielded)}`);
console.log(`  of them 0-damage hits                      ${share(tally.zeroValued, tally.zero)}`);
console.log(`fully absorbed without an absorption         ${tally.flagged}`);
console.log(`single-hit stretches within their reports    ${share(tally.singleIn, tally.single)}`);
console.log(`multi-hit stretches within their reports     ${share(tally.multiIn, tally.multi)}`);
console.log(`hits shown early or not, over their stretches ${share(tally.mergedIn, tally.merged)}`);
console.log(`implied unmitigated ÷ unshielded median, fully absorbed  ${spread(ratios.absorbed)}`);
console.log(`implied unmitigated ÷ unshielded median, broke through   ${spread(ratios.brokeThrough)}`);
for (const m of misfits.slice(0, listed)) console.log(`  misfit: ${m}`);
if (misfits.length > listed) console.log(`  … ${misfits.length - listed} more`);
