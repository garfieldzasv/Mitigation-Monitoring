import { isPlayerId } from "@/core/combatants/registry";
import type { Phase } from "@/core/engine/phases";
import type { DamageRow, DeathRow } from "@/core/engine/types";
import { missingMitigation } from "@/core/replay/aoe";
import type { CastBar, DamageEvent, MemberLane, StatusSpan, TimelineModel, UnappliedMark } from "@/core/replay/timeline";
import { formatClock, formatMitigation, formatReduction, percentOfMax, phaseSpan, STATUS_CATEGORY_LABEL } from "../../../format";

/** What the mouse is on in the timeline; the tab turns it into the tooltip's lines. */
export type TimelineHover =
  | { kind: "phase"; phase: Phase }
  | { kind: "cast"; bar: CastBar }
  | { kind: "damage"; event: DamageEvent }
  | { kind: "span"; span: StatusSpan }
  | { kind: "unapplied"; mark: UnappliedMark }
  | { kind: "hit"; row: DamageRow }
  | { kind: "death"; row: DeathRow }
  | { kind: "hp"; member: MemberLane };

export interface TipContext {
  model: TimelineModel;
  /** The pull, for encounter times. */
  origin: number;
  /** The time under the mouse. */
  at: number;
  nameOf: (id: string) => string;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const clock = (ctx: TipContext, t: number) => formatClock(t - ctx.origin);
/** At most `max` names, then "等 N 人" ("个" for enemies). */
const names = (list: readonly string[], max = 4, unit = "人") => (list.length > max ? `${list.slice(0, max).join("、")} 等 ${list.length} ${unit}` : list.join("、"));

export function tipLines(h: TimelineHover, ctx: TipContext): string[] {
  switch (h.kind) {
    case "phase":
      return [phaseSpan(h.phase, ctx.origin, ctx.model.to), "点击：缩放到这个阶段"];
    case "cast": {
      const b = h.bar;
      return [
        `${b.action}${b.count > 1 ? ` ×${b.count}` : ""}`,
        `${b.source} · ${clock(ctx, b.start)} 开始读条 · ${sec(b.castMs)}${b.cancelled ? " · 被打断" : ""}`,
      ];
    }
    case "damage":
      return damageLines(h.event, ctx);
    case "span":
      return spanLines(h.span, ctx);
    case "unapplied": {
      const m = h.mark;
      return [`${m.status.name}（${STATUS_CATEGORY_LABEL[m.category]}）未生效`, `${clock(ctx, m.time)} → ${m.target.name}：身上已有更强的同类效果，没有覆盖`, "这次施放没有给任何人挂上"];
    }
    case "hit": {
      const r = h.row;
      return [
        `${clock(ctx, r.time)} ${r.action.name}（${r.source.name || "未知"}）`,
        `${r.amount.toLocaleString()}（${percentOfMax(r.amount, r.maxHp)}）· 减伤 ${formatMitigation(r.multiplier, r.multiplierPartial)}${r.fatal ? " · 致死" : ""}`,
        "点击：查看详情",
      ];
    }
    case "death":
      return [`${clock(ctx, h.row.time)} ${h.row.target.name} 死亡`, "点击：在死亡回放里查看"];
    case "hp": {
      const p = pointAt(h.member.hp, ctx.at);
      if (!p) return [h.member.player.name];
      const shield = (p.shieldPercent * p.maxHp) / 100;
      return [
        `${h.member.player.name} · ${clock(ctx, ctx.at)}`,
        `HP ${p.hp.toLocaleString()}（${percentOfMax(p.hp, p.maxHp)}）${shield > 0 ? ` · 盾 ≈${Math.round(shield).toLocaleString()}（${percentOfMax(shield, p.maxHp)}）` : ""}`,
      ];
    }
  }
}

function damageLines(e: DamageEvent, ctx: TipContext): string[] {
  const lines = [
    `${clock(ctx, e.time)} ${e.action}（${e.source}）`,
    `命中 ${e.rows.length} 人 · 合计 ${e.total.toLocaleString()} · 平均减伤 ${formatReduction(e.avgMitigation)}${e.deaths > 0 ? ` · 死亡 ${e.deaths}` : ""}`,
  ];
  // Who went without what most of the others had (8.4); only meaningful when several were hit.
  if (e.rows.length >= 4) {
    const missing = missingMitigation(e);
    const byStatus = new Map<string, string[]>();
    for (const r of e.rows) for (const s of missing.get(r.id) ?? []) byStatus.set(s.name, [...(byStatus.get(s.name) ?? []), r.target.name]);
    for (const [status, who] of byStatus) lines.push(`缺少 ${status}：${names(who)}`);
  }
  lines.push("点击：查看伤害最高的一条");
  return lines;
}

function spanLines(s: StatusSpan, ctx: TipContext): string[] {
  const caster = ctx.nameOf(s.caster.id) || s.caster.name;
  const onSelf = s.targets.length === 1 && s.targets[0]!.id === s.caster.id;
  const who = onSelf ? "自己" : names(s.targets.map((t) => t.name), 4, s.targets.some((t) => isPlayerId(t.id)) ? "人" : "个");
  const hits = ctx.model.damage.filter((d) => d.time >= s.start && d.time < s.end);
  const lines = [
    `${s.status.name}（${STATUS_CATEGORY_LABEL[s.category]}）`,
    `${caster} → ${who}`,
    ...(s.refused?.length ? [`未覆盖：${names(s.refused.map((t) => t.name), 4, "人")}（身上已有更强的同类效果）`] : []),
    s.lengthUnknown ? `${clock(ctx, s.start)} 施放 · 持续时间未知` : `${clock(ctx, s.start)}–${clock(ctx, s.end)} · ${sec(s.end - s.start)}`,
  ];
  if (hits.length > 0) lines.push(`期间受到：${names([...new Set(hits.map((d) => d.action))], 5)}（${hits.length} 次）`);
  return lines;
}

/** The point in effect at `t`: the last one at or before it. */
export function pointAt<P extends { time: number }>(points: readonly P[], t: number): P | undefined {
  let lo = 0;
  let hi = points.length - 1;
  let found: P | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.time <= t) {
      found = points[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
