/**
 * Damage reductions from the action tooltips (docs/DESIGN.md 5.5): the game data gives no numbers on the statuses
 * (their descriptions say only 受到的伤害减轻, ParamModifier disagrees with the tooltips), but every action that
 * grants one says how much in its tooltip (ActionTransient). Read for every status, not only those seen in logs.
 *
 * Rules, in order:
 * 1. A tooltip is rendered for its job (jobs.ts: ClassJob, else the one its ClassJobCategory lists) at every level
 *    1~100: `<If(Equal(PlayerParameter(68),job))>`, `<If(GreaterThanOrEqualTo(PlayerParameter(72),level))>` are
 *    evaluated, the colour tags dropped.
 * 2. It is cut into clauses. "X效果：…" up to the next header or 追加效果 is status X's; everything else is the status
 *    of the action's own name (追加效果 with no name included: 白牛清汁, 整体论). An action whose name is no status
 *    gives it to the status it grants (追加效果：X, 附加X状态: 全大赦 → 告解).
 * 3. In a clause: 物理伤害减轻A%、魔法伤害减轻B% (either alone: the other is 0); else …伤害(会)减轻A% for both. On the
 *    enemy: 物理攻击造成的伤害降低A%，魔法攻击造成的伤害降低B%; else 造成的 / 攻击伤害降低A%.
 * 4. 无法与…共存 puts the named statuses in one group (only the strongest counts).
 * 5. Of the actions that mention a status, the job's own (with a level to learn it at) win over role actions (the
 *    same), those over the rest (duty actions: Bozja, Eureka…; old PvP versions), those over PvP actions. A status
 *    the best of them mention without a reduction has none (原初的勇猛: its old PvP version had one).
 * A status two tooltips value differently is reported (骑士的坚守: 15% from 圣盾阵, 10% from 干预) and left to the
 * hand-kept table, as are statuses no tooltip values (a duty's own mechanics: the value is server-side only).
 */
import { actionJob } from "./jobs";
import { cnRows } from "./sources";

export interface ReductionValue {
  physical: number;
  magical: number;
}

export interface GeneratedReduction extends ReductionValue {
  /** Different values from these levels up (ascending). */
  levels?: (ReductionValue & { level: number })[];
  group?: string;
  /** The action whose tooltip said it. */
  action: number;
}

export interface GeneratedMitigation {
  taken: Record<number, GeneratedReduction>;
  dealt: Record<number, GeneratedReduction>;
  /** Statuses two tooltips value differently: by status, the values seen. */
  conflicts: Record<number, string[]>;
}

/** Action sheet raw columns (SaintCoinach numbering, as cnRows gives them minus the key). */
const ACTION_NAME = 0;
const ACTION_CLASS_JOB_LEVEL = 12;
const ACTION_IS_ROLE = 13;
const ACTION_IS_PVP = 56;

const MAX_LEVEL = 100;

/**
 * The tooltip as a player of `job` at `level` sees it: conditions evaluated, tags dropped. A condition on another
 * player parameter (108: the phantom job level of 新月岛, which no log line carries) comes out as `others`.
 */
export function renderTooltip(text: string, job: number, level: number, others = false): string {
  const param = (n: number) => (n === 68 ? job : n === 72 ? level : Number.NaN);
  const condition = (c: string): boolean => {
    const m = /^(Equal|GreaterThanOrEqualTo|GreaterThan|LessThan|LessThanOrEqualTo|NotEqual)\(PlayerParameter\((\d+)\),(-?\d+)\)$/.exec(c);
    if (!m) return false;
    const v = param(Number(m[2]));
    if (Number.isNaN(v)) return others;
    const n = Number(m[3]);
    switch (m[1]) {
      case "Equal":
        return v === n;
      case "NotEqual":
        return v !== n;
      case "GreaterThanOrEqualTo":
        return v >= n;
      case "GreaterThan":
        return v > n;
      case "LessThan":
        return v < n;
      default:
        return v <= n;
    }
  };
  // Innermost first: an If with no If inside.
  let s = text;
  const inner = /<If\(([^()]*(?:\([^()]*(?:\([^()]*\))?[^()]*\))?[^()]*)\)>((?:(?!<If\()[\s\S])*?)<\/If>/;
  for (let guard = 0; guard < 1000; guard++) {
    const m = inner.exec(s);
    if (!m) break;
    const [yes, no = ""] = m[2]!.split("<Else/>");
    s = s.slice(0, m.index) + (condition(m[1]!) ? yes! : no) + s.slice(m.index + m[0].length);
  }
  return s
    .replace(/<UIForeground>[^<]*<\/UIForeground>|<UIGlow>[^<]*<\/UIGlow>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, "")
    // full-width digits and ％, as some tooltips write them (魔强力守护: 20％)
    .replace(/[０-９．％]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

const PERCENT = String.raw`(\d+(?:\.\d+)?)%`;
const TAKEN_SPLIT = new RegExp(String.raw`物理(?:攻击)?(?:的)?伤害减轻${PERCENT}[，、,]?(?:所受到的|受到的)?魔法(?:攻击)?(?:的)?伤害减轻${PERCENT}`);
const TAKEN_SPLIT_REVERSED = new RegExp(String.raw`魔法(?:攻击)?(?:的)?伤害减轻${PERCENT}[，、,]?(?:所受到的|受到的)?物理(?:攻击)?(?:的)?伤害减轻${PERCENT}`);
const TAKEN_MAGICAL = new RegExp(String.raw`魔法(?:攻击)?(?:的)?伤害(?:会)?减轻${PERCENT}`);
const TAKEN_PHYSICAL = new RegExp(String.raw`物理(?:攻击)?(?:的)?伤害(?:会)?减轻${PERCENT}`);
const TAKEN_ALL = new RegExp(String.raw`伤害(?:会)?减轻${PERCENT}`);
const DEALT_SPLIT = new RegExp(String.raw`物理攻击造成的伤害降低${PERCENT}[，、,]?魔法攻击造成的伤害降低${PERCENT}`);
const DEALT_SPLIT_REVERSED = new RegExp(String.raw`魔法攻击造成的伤害降低${PERCENT}[，、,]?物理攻击造成的伤害降低${PERCENT}`);
const DEALT_ALL = new RegExp(String.raw`(?:造成的|攻击)伤害降低${PERCENT}`);

/** What one clause says a status does to damage taken (or, `dealt`, to damage the enemy deals). */
export function clauseValue(clause: string, dealt: boolean): ReductionValue | undefined {
  const n = (s: string | undefined) => Number(s);
  if (dealt) {
    let m = DEALT_SPLIT.exec(clause);
    if (m) return { physical: n(m[1]), magical: n(m[2]) };
    m = DEALT_SPLIT_REVERSED.exec(clause);
    if (m) return { physical: n(m[2]), magical: n(m[1]) };
    m = DEALT_ALL.exec(clause);
    return m ? { physical: n(m[1]), magical: n(m[1]) } : undefined;
  }
  let m = TAKEN_SPLIT.exec(clause);
  if (m) return { physical: n(m[1]), magical: n(m[2]) };
  m = TAKEN_SPLIT_REVERSED.exec(clause);
  if (m) return { physical: n(m[2]), magical: n(m[1]) };
  const magical = TAKEN_MAGICAL.exec(clause);
  const physical = TAKEN_PHYSICAL.exec(clause);
  if (magical && !physical) return { physical: 0, magical: n(magical[1]) };
  if (physical && !magical) return { physical: n(physical[1]), magical: 0 };
  m = TAKEN_ALL.exec(clause);
  return m ? { physical: n(m[1]), magical: n(m[1]) } : undefined;
}

/**
 * A rendered tooltip cut into clauses by status: "X效果：" starts status X's, up to the next header or 追加效果；
 * the rest is the action's own status — or, when no status has the action's name, the status it grants (the first
 * named after 追加效果： or in 附加…状态). Names are matched longest first.
 */
export function clauses(rendered: string, ownName: string, names: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  const headers: { at: number; end: number; name: string }[] = [];
  const header = /效果：/g;
  for (let m = header.exec(rendered); m; m = header.exec(rendered)) {
    const name = nameEndingAt(rendered, m.index, names);
    if (name && name !== "追加") headers.push({ at: m.index - name.length, end: m.index + m[0].length, name });
  }
  let own = "";
  let from = 0;
  headers.forEach((h, i) => {
    own += rendered.slice(from, h.at);
    const next = headers[i + 1]?.at ?? rendered.length;
    const body = rendered.slice(h.end, next);
    const cut = /追加效果：/.exec(body);
    const mine = cut ? body.slice(0, cut.index) : body;
    if (h.name === ownName) own += mine;
    else out.set(h.name, (out.get(h.name) ?? "") + mine);
    from = cut ? h.end + cut.index : next;
  });
  own += rendered.slice(from);
  const owner = names.has(ownName) ? ownName : grantedName(own, names);
  if (owner) out.set(owner, (out.get(owner) ?? "") + own);
  return out;
}

/** The longest known status name that ends at `end` (12 characters at most). */
function nameEndingAt(text: string, end: number, names: ReadonlySet<string>): string | undefined {
  for (let k = Math.min(12, end); k >= 1; k--) {
    const candidate = text.slice(end - k, end);
    if (names.has(candidate)) return candidate;
  }
  return undefined;
}

/** The status an action grants by another name: 追加效果：告解 / 附加告解状态. */
function grantedName(text: string, names: ReadonlySet<string>): string | undefined {
  const m = /追加效果：(?:为目标附加|对自身附加|为自身附加)?([^，。：\s]{1,12})|附加([^，。：\s]{1,12}?)状态/.exec(text);
  if (!m) return undefined;
  const raw = m[1] ?? m[2]!;
  for (let k = Math.min(12, raw.length); k >= 1; k--) if (names.has(raw.slice(0, k))) return raw.slice(0, k);
  return undefined;
}

/** 无法与吟游诗人的行吟、舞者的防守之桑巴效果共存 → [行吟, 防守之桑巴] (status names after "…的"). */
export function coexistNames(rendered: string, names: ReadonlySet<string>): string[] {
  const m = /无法与(.+?)(?:效果)?共存/.exec(rendered);
  if (!m) return [];
  return m[1]!
    .split(/[、和及]/)
    .map((part) => {
      for (let k = Math.min(12, part.length); k >= 1; k--) if (names.has(part.slice(part.length - k))) return part.slice(part.length - k);
      return "";
    })
    .filter(Boolean);
}

interface Source {
  action: number;
  rank: number;
  job: number;
  minLevel: number;
  tooltip: string;
}

/** The status values every action tooltip gives (see the rules above). `kinds`: which statuses are reductions, and on which side. */
export function mitigationFromTooltips(
  actionCsv: string,
  transientCsv: string,
  statusCsv: string,
  kinds: ReadonlyMap<number, "takenDown" | "dealtDown">,
  categories: ReadonlyMap<number, readonly number[]>,
): GeneratedMitigation {
  const statusName = new Map<number, string>();
  const idsByName = new Map<string, number[]>();
  for (const [id, cells] of cnRows(statusCsv)) {
    const name = cells[1];
    if (!name) continue;
    statusName.set(id, name);
    const ids = idsByName.get(name);
    if (ids) ids.push(id);
    else idsByName.set(name, [id]);
  }
  const names = new Set(idsByName.keys());
  const tooltips = new Map<number, string>();
  for (const [id, cells] of cnRows(transientCsv)) if (cells[1]) tooltips.set(id, cells[1]);

  // Every action with a tooltip, ranked: the job's own (1), role (2), other non-PvP (3), PvP (4).
  const sources: Source[] = [];
  for (const [id, cells] of cnRows(actionCsv)) {
    const tooltip = tooltips.get(id);
    if (!cells[ACTION_NAME + 1] || !tooltip || !/减轻|降低|共存/.test(tooltip)) continue;
    const job = actionJob(cells, categories);
    const level = Number(cells[ACTION_CLASS_JOB_LEVEL + 1]) || 0;
    const pvp = cells[ACTION_IS_PVP + 1] === "True";
    const role = cells[ACTION_IS_ROLE + 1] === "True";
    const rank = pvp ? 4 : level > 0 && job > 0 ? 1 : level > 0 && role ? 2 : 3;
    sources.push({ action: id, rank, job: job > 0 ? job : 0, minLevel: level, tooltip });
  }
  sources.sort((a, b) => a.rank - b.rank || a.action - b.action);

  // By status name: the best rank of a tooltip that mentions it, the values by level from that rank, every value seen.
  const mentioned = new Map<string, number>();
  const found = new Map<string, { rank: number; action: number; byLevel: (ReductionValue | undefined)[]; dealt: boolean }>();
  const seen = new Map<string, Set<string>>();
  const groups = new Map<string, string>();
  for (const src of sources) {
    const ownName = tooltipOwner(src.action, actionCsv);
    if (!ownName) continue;
    const byName = new Map<string, (ReductionValue | undefined)[]>();
    for (let level = Math.max(1, src.minLevel); level <= MAX_LEVEL; level++) {
      const rendered = renderTooltip(src.tooltip, src.job, level);
      // The same with the conditions on parameters no log carries turned the other way: a value that changes with them is not the tooltip's to give (the log's modifier byte gives it).
      const otherwise = clauses(renderTooltip(src.tooltip, src.job, level, true), ownName, names);
      for (const [name, clause] of clauses(rendered, ownName, names)) {
        if (!mentioned.has(name) || src.rank < mentioned.get(name)!) mentioned.set(name, src.rank);
        const ids = idsByName.get(name) ?? [];
        const dealt = ids.some((id) => kinds.get(id) === "dealtDown") && !ids.some((id) => kinds.get(id) === "takenDown");
        const value = clauseValue(clause, dealt);
        if (!value) continue;
        const other = otherwise.get(name);
        if (other !== undefined && JSON.stringify(clauseValue(other, dealt)) !== JSON.stringify(value)) continue;
        let list = byName.get(name);
        if (!list) byName.set(name, (list = []));
        list[level] = value;
      }
      // groups: the action's own status with the ones it cannot coexist with
      if (src.rank <= 2) {
        const others = coexistNames(rendered, names);
        if (others.length) {
          const key = [ownName, ...others].sort()[0]!;
          for (const n of [ownName, ...others]) if (!groups.has(n)) groups.set(n, key);
        }
      }
    }
    for (const [name, byLevel] of byName) {
      const ids = idsByName.get(name) ?? [];
      const dealt = ids.some((id) => kinds.get(id) === "dealtDown") && !ids.some((id) => kinds.get(id) === "takenDown");
      const atMax = byLevel[MAX_LEVEL] ?? [...byLevel].reverse().find((v) => v !== undefined);
      if (atMax && src.rank <= 2) {
        const s = seen.get(name) ?? new Set();
        s.add(`${atMax.physical}/${atMax.magical}（${src.action}）`);
        seen.set(name, s);
      }
      const had = found.get(name);
      if (src.rank === mentioned.get(name) && (!had || src.rank < had.rank)) found.set(name, { rank: src.rank, action: src.action, byLevel, dealt });
    }
  }

  const out: GeneratedMitigation = { taken: {}, dealt: {}, conflicts: {} };
  for (const [name, f] of found) {
    const entry = steps(f.byLevel, f.action);
    if (!entry) continue;
    const group = groups.get(name);
    if (group) entry.group = group;
    const values = seen.get(name);
    const distinctValues = values ? new Set([...values].map((v) => v.replace(/（\d+）$/, ""))) : undefined;
    for (const id of idsByName.get(name) ?? []) {
      const kind = kinds.get(id);
      if (!kind) continue;
      if (distinctValues && distinctValues.size > 1) out.conflicts[id] = [...values!];
      (kind === "dealtDown" ? out.dealt : out.taken)[id] = { ...entry };
    }
  }
  return out;
}

/** The status an action grants by its own name: the action's name. */
function tooltipOwner(action: number, actionCsv: string): string | undefined {
  return actionNames(actionCsv).get(action);
}

let namesCache: { csv: string; names: Map<number, string> } | undefined;
function actionNames(actionCsv: string): Map<number, string> {
  if (namesCache?.csv === actionCsv) return namesCache.names;
  const names = new Map<number, string>();
  for (const [id, cells] of cnRows(actionCsv)) if (cells[ACTION_NAME + 1]) names.set(id, cells[ACTION_NAME + 1]!);
  namesCache = { csv: actionCsv, names };
  return names;
}

/** Values by level → the value at the lowest level that has one, and each change after it. */
function steps(byLevel: readonly (ReductionValue | undefined)[], action: number): GeneratedReduction | undefined {
  let first: ReductionValue | undefined;
  const levels: (ReductionValue & { level: number })[] = [];
  let last: ReductionValue | undefined;
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const v = byLevel[level];
    if (!v) continue;
    if (!first) first = v;
    else if (last && (v.physical !== last.physical || v.magical !== last.magical)) levels.push({ level, ...v });
    last = v;
  }
  if (!first) return undefined;
  return { physical: first.physical, magical: first.magical, ...(levels.length ? { levels } : {}), action };
}
