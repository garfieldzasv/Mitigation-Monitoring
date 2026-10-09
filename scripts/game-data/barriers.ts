/**
 * What a shield holds, from the tooltip of the action that puts it on (docs/DESIGN.md 5.6). The value the game puts
 * on it is a share of the put-on line's heal or of a max HP; the tooltip says which and how much, by job and level.
 *
 * Rules, the same for every action:
 * 1. Every non-PvP action's tooltip is rendered for its job (jobs.ts) at every level from the one it is learnt at to
 *    100 (mitigation.ts renderTooltip).
 * 2. A size is "抵消 … 相当于 / 等同于 <base> N%". The base: 治疗量 / 恢复量 / 恢复力, the heal of the line that puts it
 *    on (均衡诊断's CN text says 恢复力; its global text says "the amount of HP restored"); 目标最大体力, or 最大体力 alone,
 *    the bearer's max HP; 自身 / 施法者 / 骑士自身最大体力, the caster's.
 * 3. Whose it is: under a header "X效果：" with X a status's name, the statuses of that name the action puts on
 *    (鼓舞效果：…, 激励效果：…); under "Y效果量：" with Y an action's name, the shield action Y puts on (中间学派:
 *    吉星相位效果量：…); otherwise, or after a 追加效果 that follows the header, the shield the action itself puts on.
 * 4. Several sizes for the same shield at one level (即兴表演结束 by its stacks) are alternatives, the put-on line's
 *    lowest byte picks one. "若自身处于“A”“B”…状态…每解除一个状态，防护罩的效果量上升N%" adds N% per status listed
 *    (摆脱: 15, 17, 19 or 21 %).
 * 5. By level: the sizes at the lowest level that has any, and each change after it.
 * Two tooltips sizing the same action's shield differently: the action's own wins, and both are reported.
 */
import { actionJob } from "./jobs";
import { renderTooltip } from "./mitigation";
import { cnRows } from "./sources";

/** What a shield is a share of: the put-on line's heal, the bearer's max HP, or the caster's. */
export type BarrierBase = "heal" | "bearer" | "caster";

export interface BarrierSize {
  of: BarrierBase;
  /** Percent; more than one: alternatives (rule 4). */
  percents: number[];
  /** Other percents from these levels up (ascending). */
  levels?: { level: number; percents: number[] }[];
  /** The action whose tooltip says it. */
  tooltip: number;
}

export interface GeneratedBarriers {
  /** By the action that puts the shield on, by status (0: the shield the action puts on that no clause names). */
  byAction: Record<number, Record<number, BarrierSize>>;
  /** Sizes two tooltips give differently, by "action|status": what each said. */
  conflicts: Record<string, string[]>;
}

/** Action sheet raw columns. */
const ACTION_NAME = 0;
const ACTION_CLASS_JOB_LEVEL = 12;
const ACTION_IS_PVP = 56;
const MAX_LEVEL = 100;

const SIZE = /(?:抵消|抵御)[^。：%]{0,30}?(?:相当于|等同于)(治疗量|恢复量|恢复力|目标最大体力|施法者最大体力|骑士自身最大体力|自身最大体力|最大体力)(\d+(?:\.\d+)?)%/g;
const STEPS = /若自身处于((?:“[^”]+”)+)状态[^。]*?每解除一个状态，防护罩的效果量上升(\d+(?:\.\d+)?)%/;
const HEADER = /效果(量)?：/g;

function baseOf(word: string): BarrierBase {
  if (word === "治疗量" || word === "恢复量" || word === "恢复力") return "heal";
  if (word === "目标最大体力" || word === "最大体力") return "bearer";
  return "caster";
}

/** One rendered tooltip's sizes: by owner ("s:<status name>", "a:<action name>", or "" for the action's own), with its base. */
export function tooltipSizes(rendered: string, statusNames: ReadonlySet<string>, actionNames: ReadonlySet<string>): Map<string, { of: BarrierBase; percents: number[] }> {
  const headers: { at: number; owner: string }[] = [];
  for (let m = HEADER.exec(rendered); m; m = HEADER.exec(rendered)) {
    const byAction = m[1] !== undefined;
    const name = nameEndingAt(rendered, m.index, byAction ? actionNames : statusNames);
    if (name && name !== "追加") headers.push({ at: m.index + m[0].length, owner: `${byAction ? "a" : "s"}:${name}` });
  }
  HEADER.lastIndex = 0;
  const out = new Map<string, { of: BarrierBase; percents: number[] }>();
  for (let m = SIZE.exec(rendered); m; m = SIZE.exec(rendered)) {
    const header = headers.filter((h) => h.at <= m!.index).at(-1);
    const owner = header && !rendered.slice(header.at, m.index).includes("追加效果") ? header.owner : "";
    const of = baseOf(m[1]!);
    const had = out.get(owner);
    if (had && had.of !== of) continue; // two kinds for one shield: not one size
    const percents = had?.percents ?? [];
    const p = Number(m[2]);
    if (!percents.includes(p)) percents.push(p);
    out.set(owner, { of, percents });
  }
  SIZE.lastIndex = 0;
  const steps = STEPS.exec(rendered);
  const own = out.get("");
  if (steps && own && own.percents.length === 1) {
    const count = (steps[1]!.match(/“/g) ?? []).length;
    const step = Number(steps[2]);
    own.percents = Array.from({ length: count + 1 }, (_, k) => own.percents[0]! + k * step);
  }
  return out;
}

/** The longest known name that ends at `end` (12 characters at most). */
function nameEndingAt(text: string, end: number, names: ReadonlySet<string>): string | undefined {
  for (let k = Math.min(12, end); k >= 1; k--) {
    const candidate = text.slice(end - k, end);
    if (names.has(candidate)) return candidate;
  }
  return undefined;
}

export function barriersFromTooltips(actionCsv: string, transientCsv: string, statusCsv: string, shieldIds: ReadonlySet<number>, categories: ReadonlyMap<number, readonly number[]>): GeneratedBarriers {
  const statusIdsByName = new Map<string, number[]>();
  for (const [id, cells] of cnRows(statusCsv)) {
    const name = cells[1];
    if (!name) continue;
    const ids = statusIdsByName.get(name);
    if (ids) ids.push(id);
    else statusIdsByName.set(name, [id]);
  }
  const tooltips = new Map<number, string>();
  for (const [id, cells] of cnRows(transientCsv)) if (cells[1]) tooltips.set(id, cells[1]);
  // Non-PvP actions by name (several share one: the job's own and a duty's).
  const actions = new Map<number, { name: string; job: number; minLevel: number }>();
  const actionIdsByName = new Map<string, number[]>();
  for (const [id, cells] of cnRows(actionCsv)) {
    const name = cells[ACTION_NAME + 1];
    if (!name || cells[ACTION_IS_PVP + 1] === "True") continue;
    actions.set(id, { name, job: actionJob(cells, categories), minLevel: Number(cells[ACTION_CLASS_JOB_LEVEL + 1]) || 0 });
    const ids = actionIdsByName.get(name);
    if (ids) ids.push(id);
    else actionIdsByName.set(name, [id]);
  }
  const statusNames = new Set(statusIdsByName.keys());
  const actionNames = new Set(actionIdsByName.keys());

  // "target action|status" → the tooltip it came from → percents by level.
  const found = new Map<string, Map<number, { of: BarrierBase; byLevel: (number[] | undefined)[] }>>();
  for (const [id, a] of actions) {
    const tooltip = tooltips.get(id);
    if (!tooltip || !/抵消|抵御/.test(tooltip)) continue;
    for (let level = Math.max(1, a.minLevel); level <= MAX_LEVEL; level++) {
      for (const [owner, size] of tooltipSizes(renderTooltip(tooltip, a.job, level), statusNames, actionNames)) {
        const targets: [number, number][] = owner.startsWith("s:")
          ? (statusIdsByName.get(owner.slice(2)) ?? []).filter((s) => shieldIds.has(s)).map((s) => [id, s])
          : owner.startsWith("a:")
            ? (actionIdsByName.get(owner.slice(2)) ?? []).filter((x) => actions.get(x)!.job === a.job).map((x) => [x, 0])
            : [[id, 0]];
        for (const [target, status] of targets) {
          const key = `${target}|${status}`;
          let bySource = found.get(key);
          if (!bySource) found.set(key, (bySource = new Map()));
          let entry = bySource.get(id);
          if (!entry) bySource.set(id, (entry = { of: size.of, byLevel: [] }));
          if (entry.of === size.of) entry.byLevel[level] = size.percents;
        }
      }
    }
  }

  const out: GeneratedBarriers = { byAction: {}, conflicts: {} };
  for (const [key, bySource] of found) {
    const [target, status] = key.split("|").map(Number) as [number, number];
    const sizes = [...bySource].map(([tooltip, e]) => ({ tooltip, ...e, steps: steps(e.byLevel) })).filter((s) => s.steps);
    if (sizes.length === 0) continue;
    const chosen = sizes.find((s) => s.tooltip === target) ?? sizes[0]!;
    const shown = new Set(sizes.map((s) => JSON.stringify([s.of, s.steps])));
    if (shown.size > 1) out.conflicts[key] = sizes.map((s) => `${s.tooltip}: ${s.of} ${JSON.stringify(s.steps)}`);
    (out.byAction[target] ??= {})[status] = { of: chosen.of, ...chosen.steps!, tooltip: chosen.tooltip };
  }
  return out;
}

/** Percents by level → those at the lowest level that has any, and each change after it. */
function steps(byLevel: readonly (number[] | undefined)[]): { percents: number[]; levels?: { level: number; percents: number[] }[] } | undefined {
  let first: number[] | undefined;
  let last: number[] | undefined;
  const levels: { level: number; percents: number[] }[] = [];
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const v = byLevel[level];
    if (!v) continue;
    if (!first) first = v;
    else if (last && JSON.stringify(v) !== JSON.stringify(last)) levels.push({ level, percents: v });
    last = v;
  }
  return first ? { percents: first, ...(levels.length ? { levels } : {}) } : undefined;
}
