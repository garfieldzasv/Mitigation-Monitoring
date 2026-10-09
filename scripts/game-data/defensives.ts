/**
 * The mitigation skills of every job (docs/DESIGN.md 8.2, 9.4): which actions they are, by their tooltips, and their
 * recast, charges, level and upgrades, from the Action, Trait and ClassJobActionUI sheets of the Chinese client. The
 * review's detail panel shows, at each hit, each party member's mitigation skills in effect, on cooldown or ready.
 *
 * Which actions (rules, the same for every action):
 * 1. Candidates: actions in the game's Actions & Traits list (ClassJobActionUI) and role actions, not PvP, with a recast
 *    timer of their own longer than a GCD: CooldownGroup (AdditionalCooldownGroup when that is the GCD's, 58) not the
 *    GCD's, and a recast over 2.5 s at level 100.
 * 2. The tooltip, rendered for each job that has the action at level 100 (mitigation.ts renderTooltip) and cut into
 *    clauses by status (mitigation.ts clauses), says in some clause that
 *    - damage taken is reduced (mitigation.ts clauseValue);
 *    - it puts on a shield (抵消 / 抵御 … 防护罩 or 伤害: 附加能够抵御一定伤害的防护罩, 张开一个防护罩…能抵消, 抵消相当于
 *      自身最大体力20%的伤害), or spreads one (扩散) of a status the game data calls a shield;
 *    - attacks do nothing to the bearer or cannot take their HP below 1, of a status the game data calls an
 *      invulnerability (statuses.json invuln / hpFloor);
 *    - the damage an enemy deals is reduced, of a status the game data calls a damage-dealt reduction.
 *    A status's name alone is not enough: PvP and duty statuses share names with actions (龙剑, 亲疏自行).
 * 3. A follow-up ability, with a recast group of its own but too short a recast to be a cooldown, whose tooltip says
 *    what 2 asks for (即兴表演结束, 神爱抚), belongs to the action it follows: "满足发动条件后，A变为F", or
 *    "发动条件：N状态中" with N the name of A or a status A's tooltip grants (追加效果：N). Its effects are A's: 即兴表演
 *    is a mitigation skill through its finish. A GCD that a cooldown enables (炽天附体's 显灵之章, a 鼓舞激励之策) is a
 *    GCD shield like any other, not a cooldown's effect.
 *
 * Their values, by level:
 * - recast: Recast100ms, then trait "X的复唱时间缩短到N秒" from the trait's level (Skills Monitoring reads the same from
 *   the global client's "Reduces X recast time to N seconds"); a sentence about a skill's recast that says anything
 *   else stops the import, unless it has a condition (an effect in combat, not data);
 * - charges: the tooltip's 积蓄次数, else MaxCharges; trait "X变为积蓄技能 积蓄次数：N" / "X的积蓄次数增加到N次" must agree;
 * - upgrades: trait "X变为Y" with no condition (效果时间内, 状态中, 附加后, 发动后… are in-combat replacements, whose
 *   tooltips also say 无法设置到热键栏); the tiers share one recast timer;
 * - refunds: an action's tooltip "（附加自身的）防护罩因吸收到足够的伤害而消失时，X的复唱时间缩短N秒" — when the shield the
 *   action put on its caster breaks, X's recast is cut by N s (坦培拉涂层 60, its 油性坦培拉涂层 30). An action whose tooltip
 *   says "解除自身附加的S", S a shield of the refunding action, lifts that shield: then it did not break (油性坦培拉涂层).
 *   Any other sentence of an action's tooltip that cuts a mitigation skill's recast stops the import.
 * Anything these rules cannot place is a problem: the import stops with a list rather than write doubtful data.
 */
import { compressLevelSamples, MAX_LEVEL, type LevelValue } from "../../src/core/game/levelValue";
import { ALL_JOB_IDS, toAdvancedJob } from "../../src/core/game/jobs";
import type { StatusEffectKind } from "../../src/core/game/statuses";
import { clauses, clauseValue, renderTooltip } from "./mitigation";
import { cnRows, parseCsv } from "./sources";

export interface GeneratedDefensive {
  name: string;
  icon: number;
  /** Classes and jobs that have it. */
  jobs: number[];
  level: number;
  /** The game's recast timer: actions of one job sharing a group share their cooldown (原初的血气, 原初的勇猛). */
  recastGroup: number;
  /** Seconds. */
  recast: LevelValue;
  charges: LevelValue;
  /** The action it becomes when the upgrade trait is learnt (预警 → 极致防御). */
  upgradesTo?: number;
  /** Statuses its tooltip names as its effects (by name: every status ID of that name the game data classifies). */
  statuses: number[];
  /** Follow-ups whose effects are this skill's (即兴表演 → 即兴表演结束). */
  followUps?: number[];
  /** Its recast cut by `seconds` when the shield `action` put on its caster breaks; not when one of `liftedBy` lifted it. */
  refunds?: { action: number; seconds: number; liftedBy?: number[] }[];
}

export interface GeneratedDefensives {
  actions: Record<number, GeneratedDefensive>;
  /** Other actions sharing a recast timer with one of these (same job, same group): using one spends the timer. */
  sharedTimers: Record<number, { jobs: number[]; recastGroup: number }>;
  problems: string[];
}

/** Action sheet raw columns (checked against the global sheet's names, value by value). */
const A = { name: 0, icon: 2, category: 3, level: 12, isRole: 13, recast: 40, group: 41, additionalGroup: 42, maxCharges: 43, jobCategory: 50, isPvp: 56 } as const;
/** Trait sheet raw columns. */
const T = { name: 0, classJob: 3, jobCategory: 4, level: 5 } as const;
/** The recast group every GCD shares. */
const GCD_GROUP = 58;
const GCD_SECONDS = 2.5;
/** ActionCategory: spell, weaponskill, ability. */
const PLAYER_CATEGORIES = new Set(["2", "3", "4"]);

const SHIELD = /(抵消|抵御)[^。：]{0,30}?(防护罩|伤害)/;
const SPREAD = /扩散/;
const INVULN_TEXT = /攻击均无效|均无效化|一切攻击都无法造成伤害|免除自身受到的任何伤害|暂时无敌|无法令体力低于1|无法令体力减少到1以下/;
/** An action's tooltip: the shield it put on (its caster's, 附加自身的) broke, X's recast is cut (rule "refunds"). */
const REFUND = /^(附加自身的)?防护罩因吸收到足够的伤害而消失时，(.+?)的复唱时间缩短(\d+(?:\.\d+)?)秒$/;
const LIFT = /解除自身附加的(.+?)(?:，|$)/;
/** A trait sentence about something that happens in combat, not a change of data. */
const CONDITION = /时间内|状态中|附加后|发动后|学会|当|时，|时$/;

interface Row {
  id: number;
  name: string;
  icon: number;
  level: number;
  jobs: number[];
  listed: boolean;
  recast: number;
  maxCharges: number;
  group: number;
  tooltip: string;
}

export function defensivesFromGameData(input: {
  actionCsv: string;
  transientCsv: string;
  statusCsv: string;
  traitCsv: string;
  traitTransientCsv: string;
  classJobActionUiCsv: string;
  kinds: ReadonlyMap<number, StatusEffectKind>;
  categories: ReadonlyMap<number, readonly number[]>;
}): GeneratedDefensives {
  const problems: string[] = [];
  const supported = new Set(ALL_JOB_IDS);

  const idsByName = new Map<string, number[]>();
  for (const [id, cells] of cnRows(input.statusCsv)) {
    const name = cells[1];
    if (!name) continue;
    const ids = idsByName.get(name);
    if (ids) ids.push(id);
    else idsByName.set(name, [id]);
  }
  const statusNames = new Set(idsByName.keys());
  const tooltips = new Map<number, string>();
  for (const [id, cells] of cnRows(input.transientCsv)) if (cells[1]) tooltips.set(id, cells[1]);
  // ClassJobActionUI: a row per class or job, a subrow per action of its Actions & Traits window (raw column 0).
  const listed = new Set(
    parseCsv(input.classJobActionUiCsv)
      .slice(3)
      .map((cells) => Number(cells[1]))
      .filter((id) => id > 0),
  );

  const cell = (cells: readonly string[], raw: number) => cells[raw + 1] ?? "";
  const rows = new Map<number, Row>();
  for (const [id, cells] of cnRows(input.actionCsv)) {
    const name = cell(cells, A.name);
    const level = Number(cell(cells, A.level)) || 0;
    if (!name || level <= 0 || cell(cells, A.isPvp) === "True" || !PLAYER_CATEGORIES.has(cell(cells, A.category))) continue;
    const jobs = (input.categories.get(Number(cell(cells, A.jobCategory))) ?? []).filter((j) => supported.has(j));
    if (jobs.length === 0) continue;
    const isListed = listed.has(id) || cell(cells, A.isRole) === "True";
    if (!isListed) continue;
    const group = Number(cell(cells, A.group)) || 0;
    const own = group !== GCD_GROUP ? group : Number(cell(cells, A.additionalGroup)) || 0;
    rows.set(id, {
      id,
      name,
      icon: Number(cell(cells, A.icon)) || 0,
      level,
      jobs,
      listed: isListed,
      recast: (Number(cell(cells, A.recast)) || 0) / 10,
      maxCharges: Math.max(1, Number(cell(cells, A.maxCharges)) || 0),
      group: own === GCD_GROUP ? 0 : own,
      tooltip: tooltips.get(id) ?? "",
    });
  }
  const renderJobs = (row: Row) => [...new Set(row.jobs.map(toAdvancedJob))];
  const byName = (name: string, jobs: readonly number[]) => [...rows.values()].find((r) => r.name === name && r.jobs.some((j) => jobs.includes(j)));

  // ---------- traits: recast steps, upgrades, charge claims ----------
  const traitText = new Map<number, string>();
  for (const [id, cells] of cnRows(input.traitTransientCsv)) if (cells[1]) traitText.set(id, cells[1]);
  interface Trait {
    id: number;
    name: string;
    level: number;
    jobs: number[];
    sentences: string[];
  }
  const traits: Trait[] = [];
  for (const [id, cells] of cnRows(input.traitCsv)) {
    const level = Number(cell(cells, T.level)) || 0;
    const job = Number(cell(cells, T.classJob)) || 0;
    const jobs = job > 0 ? [job, toAdvancedJob(job)] : [...(input.categories.get(Number(cell(cells, T.jobCategory))) ?? [])];
    const text = traitText.get(id);
    if (level <= 0 || !text || !jobs.some((j) => supported.has(j))) continue;
    // Rendered for its own job (traits carry the same macros as tooltips); sentences end at 。 or a line break.
    const sentences = text
      .split(/\r?\n|。/)
      .map((s) => renderTooltip(s, toAdvancedJob(jobs[0]!), level))
      .filter(Boolean);
    traits.push({ id, name: cell(cells, T.name), level, jobs: [...new Set(jobs)], sentences });
  }
  /** action → [level, seconds][] */
  const recastSteps = new Map<number, [number, number][]>();
  /** lower → its uppers (more than one: a problem, if the lower is a mitigation skill). */
  const upgradesTo = new Map<number, number[]>();
  const chargeClaims: { trait: Trait; row: Row; charges: number }[] = [];
  for (const trait of traits) {
    for (const s of trait.sentences) {
      for (const m of s.matchAll(/(?:^|，)([^，]+?)的复唱时间缩短到(\d+(?:\.\d+)?)秒/g)) {
        for (const name of m[1]!.split(/[、与和及]/)) {
          const row = byName(name, trait.jobs);
          if (row) recastSteps.set(row.id, [...(recastSteps.get(row.id) ?? []), [trait.level, Number(m[2])]]);
        }
      }
      for (const m of s.matchAll(/(?:^|，)([^，]+?)(?:变为积蓄技能积蓄次数：|的积蓄次数增加到|最多可积蓄)(\d+)/g)) {
        for (const name of m[1]!.split(/[、与和及]/)) {
          const row = byName(name, trait.jobs);
          if (row) chargeClaims.push({ trait, row, charges: Number(m[2]) });
        }
      }
      if (CONDITION.test(s)) continue;
      for (const piece of s.split("，")) {
        const m = /^(.+?)变为(.+)$/.exec(piece);
        if (!m) continue;
        const lower = byName(m[1]!, trait.jobs);
        const upper = byName(m[2]!, trait.jobs);
        if (!lower || !upper || /无法设置到热键栏/.test(upper.tooltip)) continue;
        upgradesTo.set(lower.id, [...new Set([...(upgradesTo.get(lower.id) ?? []), upper.id])]);
      }
    }
  }

  const levels = Array.from({ length: MAX_LEVEL }, (_, i) => i + 1);
  const recastOf = (row: Row): LevelValue => {
    const steps = [...(recastSteps.get(row.id) ?? [])].sort((a, b) => a[0] - b[0]);
    return compressLevelSamples(levels.map((lv) => steps.filter(([at]) => at <= lv).at(-1)?.[1] ?? row.recast));
  };
  /** Per level; below the action's level, its first learnt value. */
  const chargesOf = (row: Row, job: number): number[] =>
    levels.map((lv) => {
      const c = /积蓄次数：(\d+)/.exec(renderTooltip(row.tooltip, job, Math.max(lv, row.level)));
      return c ? Number(c[1]) : row.maxCharges;
    });
  const hasOwnTimer = (row: Row) => row.group > 0 && recastAt100(row) > GCD_SECONDS;
  const recastAt100 = (row: Row) => {
    const v = recastOf(row);
    return typeof v === "number" ? v : v.at(-1)![1];
  };

  // ---------- which actions ----------
  /** The statuses the tooltip of `row`, rendered for `job`, says it puts on (rule 2); undefined when it says none. */
  function effects(row: Row, job: number): number[] | undefined {
    const rendered = renderTooltip(row.tooltip, job, MAX_LEVEL);
    let found = false;
    const statuses = new Set<number>();
    for (const [name, clause] of clauses(rendered, row.name, statusNames)) {
      const ids = idsByName.get(name) ?? [];
      const of = (...wanted: StatusEffectKind[]) => ids.filter((id) => wanted.includes(input.kinds.get(id)!));
      const taken = clauseValue(clause, false);
      const dealt = of("dealtDown").length > 0 ? clauseValue(clause, true) : undefined;
      const says =
        (taken !== undefined && taken.physical + taken.magical > 0) ||
        (dealt !== undefined && dealt.physical + dealt.magical > 0) ||
        SHIELD.test(clause) ||
        (SPREAD.test(clause) && of("shield").length > 0) ||
        (INVULN_TEXT.test(clause) && of("invuln", "hpFloor").length > 0);
      if (!says) continue;
      found = true;
      for (const id of of("takenDown", "dealtDown", "shield", "invuln", "hpFloor")) statuses.add(id);
    }
    return found ? [...statuses].sort((a, b) => a - b) : undefined;
  }

  const out: GeneratedDefensives = { actions: {}, sharedTimers: {}, problems };
  const followUpsOf = new Map<number, number[]>();
  const statusesOf = new Map<number, Set<number>>();
  const skills = new Map<number, Row>();
  for (const row of rows.values()) {
    const byJob = renderJobs(row).map((job) => ({ job, statuses: effects(row, job) }));
    const effective = byJob.filter((x) => x.statuses);
    if (effective.length === 0) continue;
    const statuses = new Set(effective.flatMap((x) => x.statuses!));
    if (hasOwnTimer(row)) {
      skills.set(row.id, { ...row, jobs: row.jobs.filter((j) => effective.some((x) => x.job === toAdvancedJob(j))) });
      statusesOf.set(row.id, statuses);
      continue;
    }
    // Rule 3: a follow-up ability belongs to the action it follows.
    if (row.group === 0) continue;
    const rendered = renderTooltip(row.tooltip, effective[0]!.job, MAX_LEVEL);
    const replaced = /满足发动条件后，(.+?)变为/.exec(rendered)?.[1];
    const condition = /发动条件：(.+?)状态中/.exec(rendered)?.[1];
    const parents = [...rows.values()].filter(
      (p) =>
        p.id !== row.id &&
        hasOwnTimer(p) &&
        p.jobs.some((j) => row.jobs.includes(j)) &&
        (p.name === replaced || p.name === condition || (condition !== undefined && renderTooltip(p.tooltip, effective[0]!.job, MAX_LEVEL).includes(`追加效果：${condition}`))),
    );
    if (parents.length > 1) problems.push(`#${row.id} ${row.name}: follows ${parents.map((p) => `#${p.id} ${p.name}`).join(" and ")}`);
    const parent = parents[0];
    if (!parent) continue;
    followUpsOf.set(parent.id, [...(followUpsOf.get(parent.id) ?? []), row.id]);
    const into = statusesOf.get(parent.id) ?? new Set();
    for (const s of statuses) into.add(s);
    statusesOf.set(parent.id, into);
    if (!skills.has(parent.id)) skills.set(parent.id, parent);
  }

  for (const row of skills.values()) {
    const jobs = renderJobs(row);
    const charges = jobs.map((job) => compressLevelSamples(chargesOf(row, job)));
    if (new Set(charges.map((c) => JSON.stringify(c))).size > 1) problems.push(`#${row.id} ${row.name}: charges differ by job: ${charges.map((c) => JSON.stringify(c)).join(" ")}`);
    const uppers = upgradesTo.get(row.id) ?? [];
    if (uppers.length > 1) problems.push(`#${row.id} ${row.name}: upgrades to ${uppers.map((u) => `#${u}`).join(" and ")}`);
    const upper = uppers[0];
    const followUps = followUpsOf.get(row.id);
    out.actions[row.id] = {
      name: row.name,
      icon: row.icon,
      jobs: row.jobs,
      level: row.level,
      recastGroup: row.group,
      recast: recastOf(row),
      charges: charges[0]!,
      ...(upper !== undefined && skills.has(upper) ? { upgradesTo: upper } : {}),
      statuses: [...(statusesOf.get(row.id) ?? [])].sort((a, b) => a - b),
      ...(followUps ? { followUps: followUps.sort((a, b) => a - b) } : {}),
    };
    if (upper !== undefined && skills.has(upper) && skills.get(upper)!.group !== row.group) {
      problems.push(`#${row.id} ${row.name} upgrades to #${upper} with another recast group (${row.group} → ${skills.get(upper)!.group})`);
    }
  }

  // Two statements of the game must agree: trait text and the action's tooltip.
  for (const { trait, row, charges } of chargeClaims) {
    if (!skills.has(row.id)) continue;
    const got = chargesOf(row, toAdvancedJob(row.jobs[0]!))[Math.max(trait.level, row.level) - 1];
    if (got !== charges) problems.push(`trait #${trait.id} ${trait.name}: ${row.name} has ${charges} charges at Lv${trait.level}, its tooltip says ${got}`);
  }
  // A sentence about a skill's recast that the recast rule did not read means a rule is missing.
  for (const trait of traits) {
    for (const s of trait.sentences) {
      if (!/复唱时间/.test(s) || CONDITION.test(s) || /缩短到\d/.test(s)) continue;
      const about = [...skills.values()].filter((r) => s.includes(`${r.name}的复唱`) && r.jobs.some((j) => trait.jobs.includes(j)));
      if (about.length) problems.push(`trait #${trait.id} ${trait.name}: unread "${s}"`);
    }
  }

  // Refunds: an action's tooltip cutting a mitigation skill's recast when its shield breaks.
  // Cut before rendering, as the traits are: a rendered tooltip has lost its line breaks.
  const sentencesOf = (row: Row) =>
    new Set(renderJobs(row).flatMap((job) => row.tooltip.split(/\r?\n|。/).map((x) => renderTooltip(x, job, MAX_LEVEL).trim()).filter(Boolean)));
  const shieldsOf = (row: Row) => new Set(renderJobs(row).flatMap((job) => (effects(row, job) ?? []).filter((id) => input.kinds.get(id) === "shield")));
  for (const row of rows.values()) {
    for (const sentence of sentencesOf(row)) {
      const about = [...skills.values()].filter((r) => sentence.includes(`${r.name}的复唱时间缩短`) && r.jobs.some((j) => row.jobs.includes(j)));
      if (about.length === 0) continue;
      const m = REFUND.exec(sentence.trim());
      const target = m ? about.find((r) => r.name === m[2]) : undefined;
      const shields = shieldsOf(row);
      if (!m || !target) {
        problems.push(`#${row.id} ${row.name}: unread "${sentence}"`);
        continue;
      }
      // Whose shield: the caster's (附加自身的), or the only one the action puts on, its caster's.
      if (!m[1] && [...sentencesOf(row)].some((x) => /队员/.test(x))) problems.push(`#${row.id} ${row.name}: whose shield breaking cuts the recast: "${sentence}"`);
      if (shields.size === 0) problems.push(`#${row.id} ${row.name}: a refund on breaking, but no shield in its tooltip`);
      const liftedBy = [...rows.values()]
        .filter((l) => l.id !== row.id && l.jobs.some((j) => row.jobs.includes(j)))
        .filter((l) => [...sentencesOf(l)].some((x) => (idsByName.get(LIFT.exec(x)?.[1] ?? "") ?? []).some((id) => shields.has(id))))
        .map((l) => l.id)
        .sort((a, b) => a - b);
      const entry = out.actions[target.id]!;
      const refunds = (entry.refunds ??= []);
      if (!refunds.some((r) => r.action === row.id)) refunds.push({ action: row.id, seconds: Number(m[3]), ...(liftedBy.length ? { liftedBy } : {}) });
    }
  }
  for (const entry of Object.values(out.actions)) entry.refunds?.sort((a, b) => a.action - b.action);

  for (const row of rows.values()) {
    if (skills.has(row.id) || !hasOwnTimer(row)) continue;
    const shared = [...skills.values()].filter((s) => s.group === row.group && s.jobs.some((j) => row.jobs.includes(j)));
    if (shared.length) out.sharedTimers[row.id] = { jobs: row.jobs.filter((j) => shared.some((s) => s.jobs.includes(j))), recastGroup: row.group };
  }
  return out;
}
