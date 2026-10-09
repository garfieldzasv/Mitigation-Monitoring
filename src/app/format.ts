/** Display formatting shared by the monitor and the review window. Pure functions, no Vue. */
import type { Phase } from "@/core/engine/phases";
import type { DamageRow, DeathRow } from "@/core/engine/types";
import type { DamageType } from "@/core/logline/effect";
import { vulnerabilityFactor, vulnerabilityTerms, type MitigationTerm } from "@/core/mitigation/multiplier";
import { inSharedGroup, isGroupRow } from "@/core/replay/shieldLines";
import type { StatusCategory } from "@/core/status/statusTracker";

/** Short category names for status lists (the colours are the --cat-* variables). */
export const STATUS_CATEGORY_LABEL: Record<StatusCategory, string> = {
  mitigation: "减伤",
  shield: "盾",
  vulnerability: "易伤",
  invuln: "无敌",
  damageDown: "减益",
  damageUp: "增伤",
  other: "",
};

const RESULT_LABEL: Record<DamageRow["result"], string> = { hit: "", block: "格挡", parry: "招架", miss: "闪避" };

/**
 * What became of a hit: 未生效 or 无敌 alone; else 格挡 / 招架 / 闪避 and 全吸收, together when both (a
 * blocked or parried hit can still be taken whole by a shield). `short`: one character each, for the
 * monitor's narrow column (格盾, 招盾…).
 */
export function verdictLabel(r: DamageRow, short = false): string {
  if (r.noEffect) return short ? "无效" : "未生效";
  if (r.invulnerable) return "无敌";
  const result = short ? RESULT_LABEL[r.result].slice(0, 1) : RESULT_LABEL[r.result];
  const absorbed = r.fullyAbsorbed ? (short ? "盾" : "全吸收") : "";
  if (result && absorbed) return short ? result + absorbed : `${result}·${absorbed}`;
  return result || absorbed;
}

/** 「…受到源自「来源」的「技能」伤害而死亡了」 (docs/DESIGN.md 5.7); without a blow, what else the log says killed. */
export function deathSentence(death: DeathRow, blow: DamageRow | undefined): string {
  const who = death.target.name;
  if (death.cause === "terrain") return `${who}死亡（地形杀）`;
  if (death.cause === "other") return `${who}死亡（${death.causeText}）`;
  if (death.cause === "instant") return `${who}被「${death.causeAction || death.sourceName || "即死机制"}」即死`;
  if (!blow) return `${who}被「${death.sourceName}」击倒，没有伤害记录`;
  if (blow.kind === "dot") return `${who}受到持续伤害而死亡了`;
  return `${who}受到源自「${blow.source.name || death.sourceName}」的「${blow.action.name}」伤害而死亡了`;
}

const BOUND = { atLeast: "≥", atMost: "≤" } as const;

/**
 * What the shields took off a hit, or off a group line's hits together (docs/DESIGN.md 5.6): ≈12,345 (two reports,
 * each a whole % of max HP); ≥ / ≤ when the log gives only a bound; ? when it cannot say; … while its hits are still
 * taking effect; "" when it met no shield. A hit sharing its group with others: the group's figure (共…).
 */
export function absorbedText(r: DamageRow): string {
  const g = r.shieldGroup;
  if (!g) return "";
  const text = !g.closed ? "…" : g.absorbed === undefined ? "?" : `${g.bound ? BOUND[g.bound] : "≈"}${g.absorbed.toLocaleString()}`;
  return inSharedGroup(r) ? `共${text}` : text;
}

/** The tooltip of absorbedText: what the figure is, and why it is a bound or unknown. */
export function absorbedTitle(r: DamageRow): string {
  const g = r.shieldGroup;
  if (!g) return "";
  const together = g.rows.length > 1 ? "与同一时段的多次合计\n" : "";
  if (!g.closed) return `${together}计算中`;
  if (g.absorbed === undefined) return `${together}盾吸收量不确定`;
  if (g.bound === "atLeast") return `${together}盾吸收量下限`;
  if (g.bound === "atMost") return `${together}盾吸收量上限`;
  return `${together}误差约 1% 最大 HP`;
}

/** The shields left on the player after a hit (or a group line's hits), together. Undefined with no shield, or for a hit sharing its group. */
export function shieldAfterOf(r: DamageRow): number | undefined {
  const g = r.shieldGroup;
  if (!g || inSharedGroup(r)) return undefined;
  return g.after ?? (g.closed && r.amount > 0 ? 0 : undefined);
}

/** How much of a hit got through the shields on the player: its damage, when a shield was on. */
export function shieldBreakthrough(r: DamageRow): number | undefined {
  return r.shieldGroup ? r.amount : undefined;
}

/** Local wall-clock time with milliseconds, for the review window's detail panel. */
export function formatWallClock(time: number): string {
  const d = new Date(time);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** The AttackType sheet: 6 is ブレス (breath), 7 音波 (sound). */
const ATTACK: Record<number, string> = { 1: "斩击", 2: "突刺", 3: "打击", 4: "射击", 5: "魔法", 6: "吐息", 7: "音波" };
const ELEMENT: Record<number, string> = { 1: "火", 2: "冰", 3: "风", 4: "土", 5: "雷", 6: "水" };

/** 魔法·火, 斩击, 暗…; unaspected damage has no element suffix. */
export function damageKindLabel(r: DamageRow): string {
  if (r.kind === "dot") return "持续伤害";
  const attack = ATTACK[r.attackType ?? 0] ?? "未知";
  const element = ELEMENT[r.element ?? 0];
  return element ? `${attack}·${element}` : attack;
}

/** The note on a hit's HP after when no 37 line gave it. Empty when its 37 line gave it. */
export function hpAfterNote(r: DamageRow): string {
  if (r.hpAfter !== undefined) return "";
  return r.noEffect ? "这次伤害未生效" : "受击后的 HP 不确定";
}

/** The unmitigated estimate: a single figure, or a range for a group line whose hits met different mitigation; `dir`: the real figure is higher (≥) or lower (≤). */
export interface Unmitigated {
  lo: number;
  hi: number;
  dir?: "≥" | "≤";
}

/**
 * What a hit (or a group line's hits) would have done to the player without the mitigation on them (docs/DESIGN.md
 * 5.5): (damage + shield) ÷ multiplier ÷ the vulnerabilities on the player whose value is known — as souma's 减伤记录
 * does. A group's shield figure is for its hits together: with different multipliers it is a range. A hit sharing its
 * group: none of its own. "≥" with a mitigation of unknown value or a shield figure that is a lower bound, "≤" with a
 * vulnerability of unknown value or an upper bound; both, neither.
 */
export function unmitigatedRange(r: DamageRow): Unmitigated | undefined {
  if (r.result === "miss" || r.noEffect || inSharedGroup(r)) return undefined;
  const parts = isGroupRow(r) ? r.members.filter((m) => !m.noEffect && m.result !== "miss") : [r];
  if (parts.length === 0 || parts.some((m) => m.multiplier === null || m.multiplier <= 0)) return undefined;
  const scale = (m: DamageRow) => m.multiplier! * vulnerabilityFactor(m.mitigation);
  const base = parts.reduce((s, m) => s + m.amount / scale(m), 0);
  const dirs = new Set<"≥" | "≤">();
  let absorbed = 0;
  const g = r.shieldGroup;
  if (g) {
    if (g.absorbed === undefined) return undefined;
    absorbed = g.absorbed;
    if (g.bound === "atLeast") dirs.add("≥");
    if (g.bound === "atMost") dirs.add("≤");
  }
  if (parts.some((m) => m.multiplierPartial)) dirs.add("≥");
  if (parts.some((m) => vulnerabilityTerms(m.mitigation).some((t) => t.percent === null))) dirs.add("≤");
  const scales = parts.map(scale);
  const lo = Math.round(base + absorbed / Math.max(...scales));
  const hi = Math.round(base + absorbed / Math.min(...scales));
  return { lo, hi, ...(dirs.size === 1 ? { dir: [...dirs][0]! } : {}) };
}

/** The unmitigated estimate as one figure; undefined when there is none, or only a range. */
export function unmitigatedEstimate(r: DamageRow): number | undefined {
  const e = unmitigatedRange(r);
  return e && e.lo === e.hi ? e.lo : undefined;
}

/** The unmitigated estimate as shown: `≥12,345`, `12,000–13,000`; "" when there is none. */
export function formatUnmitigated(r: DamageRow): string {
  const e = unmitigatedRange(r);
  if (!e) return "";
  return `${e.dir ?? ""}${e.lo === e.hi ? e.lo.toLocaleString() : `${e.lo.toLocaleString()}–${e.hi.toLocaleString()}`}`;
}

/** A vulnerability on the player whose value is unknown: the estimate includes it (含易伤). */
export function vulnerabilityUnknown(r: DamageRow): boolean {
  return vulnerabilityTerms(r.mitigation).some((t) => t.percent === null);
}

/** How the estimate took the player's vulnerabilities out, and which it includes. Empty with none. */
export function vulnerabilityNote(r: DamageRow): string {
  const terms = vulnerabilityTerms(r.mitigation);
  if (terms.length === 0) return "";
  const name = (t: (typeof terms)[number]) => (t.stacks ? `${t.name}×${t.stacks}` : t.name);
  const known = terms.filter((t) => t.percent !== null && t.percent > 0);
  const unknown = terms.filter((t) => t.percent === null);
  const parts: string[] = [];
  if (known.length) parts.push(`已除以易伤 ${known.map((t) => `${name(t)} +${t.percent}%`).join("、")}`);
  if (unknown.length) parts.push(`含易伤 ${unknown.map(name).join("、")}：数值不明，实际更低`);
  return parts.join("；");
}

/** The unmitigated estimate's tooltip in the tables: why it is a range or a bound, and the vulnerabilities. */
export function unmitigatedTitle(r: DamageRow): string | undefined {
  const e = unmitigatedRange(r);
  if (!e) return inSharedGroup(r) ? "盾吸收只有同组几下的合计，单下估算不了；同组合计见详情" : undefined;
  const notes = [
    e.lo !== e.hi ? "这几下的减伤不同，盾在各下之间怎么分不确定，所以是范围" : "",
    r.shieldGroup?.bound === "atLeast" ? "盾吸收只知道下限，实际更高" : r.shieldGroup?.bound === "atMost" ? "盾吸收只知道上限，实际可能更低" : "",
    r.multiplierPartial ? "有数值未知的减伤，实际更高" : "",
    vulnerabilityNote(r),
  ];
  return notes.filter(Boolean).join("\n");
}

/** HP after a hit: its own 37 line's; unknown without one. */
export function hpAfterOf(r: DamageRow): number | undefined {
  return r.hpAfter;
}

/** Encounter time as `mm:ss`; negative for hits just before the pull (`-00:02`). */
export function formatClock(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "";
  const total = Math.floor(Math.abs(offsetMs) / 1000);
  return `${sign}${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * A phase starting, in one line (the monitor's divider): `在场 04:09 起 · boss 44%`, or for a window with nothing to
 * hit `离场 03:13 起 · 无可选中的敌人（boss 44%）`.
 */
export function phaseSummary(p: Phase, encounterStart: number): string {
  const parts = [`${p.kind === "fight" ? "在场" : "离场"} ${formatClock(p.start - encounterStart)} 起`];
  if (p.kind === "intermission") parts.push(p.hpStart !== undefined ? `无可选中的敌人（boss ${Math.round(p.hpStart)}%）` : "无可选中的敌人");
  else if (p.hpStart !== undefined) parts.push(`boss ${Math.round(p.hpStart)}%`);
  return parts.join(" · ");
}

/** A phase's span for the review: `在场 00:00–03:13 · boss 100%→44%`, `离场 03:13–03:40 · 无可选中的敌人`. */
export function phaseSpan(p: Phase, encounterStart: number, encounterEnd: number): string {
  const range = `${formatClock(p.start - encounterStart)}–${formatClock((p.end ?? encounterEnd) - encounterStart)}`;
  if (p.kind === "intermission") return `离场 ${range} · 无可选中的敌人`;
  const hp = p.hpStart !== undefined && p.hpEnd !== undefined ? ` · boss ${Math.round(p.hpStart)}%→${Math.round(p.hpEnd)}%` : "";
  return `在场 ${range}${hp}`;
}

/**
 * A status's time left under a minute in tenths of a second, rounded up like the icons' whole seconds (docs/DESIGN.md
 * 7.1): the icon's figure is this one rounded up again, so a tooltip's 57.1 never sits on an icon's 57.
 */
function remainingTenths(ms: number): number {
  return Math.max(0, Math.ceil(ms / 100));
}

/** The whole seconds on a status icon (under a minute): rounded up, as the game counts down. */
export function remainingSeconds(ms: number): number {
  return Math.ceil(remainingTenths(ms) / 10);
}

/** A status's time left: `8.7 秒` under a minute (rounded up), `53:23` from there (food lasts an hour), `常驻` if it never ends. */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms)) return "常驻";
  if (ms < 60_000) return `${(remainingTenths(ms) / 10).toFixed(1)} 秒`;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** `63%` of max HP (damage, HP, shield); `?` when max HP is unknown, `—` when the value is. */
export function percentOfMax(value: number | undefined, maxHp: number): string {
  if (value === undefined) return "—";
  return maxHp > 0 ? `${Math.round((value / maxHp) * 100)}%` : "?";
}

/** A mean reduction from the statistics (0.28) as `28%`; `—` when none is known. */
export function formatReduction(reduction: number | null): string {
  return reduction === null ? "—" : `${Math.round(reduction * 100)}%`;
}

/** The colour of a mean reduction, on the same scale as a hit's mitigation. */
export function reductionColor(reduction: number | null): string {
  return mitigationColor(reduction === null ? null : Math.round(reduction * 100));
}

/** Damage reduction in whole percent from a multiplier: ×0.72 → 28. */
export function mitigationPercent(multiplier: number): number {
  return Math.round((1 - multiplier) * 100);
}

/** `28%`, with `?` when some reduction's value is unknown; `—` when none applies (DoT ticks). */
export function formatMitigation(multiplier: number | null, partial = false): string {
  if (multiplier === null) return "—";
  return `${mitigationPercent(multiplier)}%${partial ? "?" : ""}`;
}

/** Red at 0%, green at 50% (and above), a hue gradient between. */
export function mitigationColor(percent: number | null): string {
  if (percent === null) return "var(--text-dim)";
  const t = Math.min(1, Math.max(0, percent / 50));
  return `hsl(${Math.round(120 * t)}, 70%, 58%)`;
}

const TYPE: Record<DamageType, string> = { physical: "物理", magical: "魔法", special: "特殊", unknown: "未知类型" };

/** The breakdown shown on hover: one line per status, then the total. */
export function mitigationTitle(
  terms: readonly MitigationTerm[],
  multiplier: number | null,
  partial: boolean,
  damageType: DamageType,
): string {
  if (multiplier === null) return "持续伤害不显示减伤";
  const lines = terms.map((t) => {
    const stacks = t.stacks ? ` ×${t.stacks}` : "";
    const where = t.side === "source" ? "（Boss 身上" + (t.inherited ? "，继承自本体）" : "）") : "";
    let value: string;
    const what = t.side === "source" ? "增伤" : "易伤";
    if (t.effect === "increase") value = t.percent === null ? `${what}，数值未知，不计入` : t.percent === 0 ? `对${TYPE[damageType]}伤害不生效` : `+${t.percent}%，${what}不计入减伤`;
    else if (t.overlapped) value = "不叠加，不计入";
    else if (t.percent === null) value = "数值未知";
    else if (t.percent === 0) value = `对${TYPE[damageType]}伤害不生效`;
    else value = `−${t.percent}%`;
    return `${t.name}${stacks}${where}　${value}`;
  });
  lines.push(`${TYPE[damageType]}伤害，合计减伤 ${formatMitigation(multiplier, partial)}${partial ? "（有数值未知的减伤，实际更高）" : ""}`);
  return lines.join("\n");
}
