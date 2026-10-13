<script setup lang="ts">
import { computed } from "vue";
import { inEffectOrder, type DamageRow, type DeathRow, type Row } from "@/core/engine/types";
import { sourceLabel } from "@/core/filter/rowFilter";
import { isListedStatus, statusIconId } from "@/core/game/statuses";
import { termApplies } from "@/core/mitigation/multiplier";
import { partySkillsAt, type PartySkills as PartySkillsModel } from "@/core/replay/partySkills";
import { groupRow, inSharedGroup } from "@/core/replay/shieldLines";
import type { StatusSnap } from "@/core/status/statusTracker";
import GameIcon from "../common/GameIcon.vue";
import JobIcon from "../common/JobIcon.vue";
import PartySkills from "./PartySkills.vue";
import UiIcon from "../common/UiIcon.vue";
import {
  absorbedText,
  absorbedTitle,
  damageKindLabel,
  deathSentence,
  formatClock,
  hpAfterOf,
  formatMitigation,
  formatWallClock,
  mitigationTable,
  mitigationTitle,
  percentOfMax,
  netMitigation,
  type MitigationLine,
  STATUS_CATEGORY_LABEL,
  formatUnmitigated,
  shieldAfterOf,
  statusRemaining,
  unmitigatedRange,
  unmitigatedTitle,
  verdictLabel,
} from "../../format";

/**
 * The review window's detail panel (docs/DESIGN.md 8.2): everything about one row. For a hit: the
 * damage, the mitigation breakdown, every status on the player and on the enemy at that moment,
 * and the other players hit by the same cast. For a death: the killing blow and the hits before it. For both, the
 * party's mitigation skills at that moment: in effect, on cooldown, or ready and unused.
 */
const props = defineProps<{ row: Row; rows: Row[]; byId: Map<number, Row>; partySkills?: PartySkillsModel | undefined }>();
const emit = defineEmits<{ select: [id: number]; close: []; "open-death": [id: number] }>();

const hit = computed(() => (props.row.kind === "death" ? undefined : props.row));
const death = computed(() => (props.row.kind === "death" ? props.row : undefined));

/** Same cast, everyone it hit. */
const sameCast = computed(() => {
  const h = hit.value;
  if (!h?.seq || (h.targetCount ?? 1) < 2) return [];
  return props.rows.filter((r): r is DamageRow => r.kind !== "death" && r.seq === h.seq);
});

/** The hits the shield reports cannot tell apart from this one, as one line (core/replay/shieldLines.ts). */
const group = computed(() => {
  const h = hit.value;
  return h && inSharedGroup(h) ? groupRow(h.shieldGroup!, h.shieldGroup!.rows) : undefined;
});
/** The shields on at the hit and after it (the group's, for a hit sharing one). */
const shieldSpan = computed(() => {
  const r = group.value ?? hit.value;
  const g = r?.shieldGroup;
  if (!r || !g) return undefined;
  const after = shieldAfterOf(r);
  return { before: g.before, after };
});

/** One of the hit's figures: what, how much, its share of max HP where it has one, and a note under it. */
interface Figure {
  label: string;
  value: string;
  percent?: string | undefined;
  title?: string | undefined;
  crit?: boolean;
  dim?: boolean;
  note?: string | undefined;
}
/** The hit's figures as a table, so the values and the shares line up. */
const figures = computed((): Figure[] => {
  const h = hit.value;
  if (!h) return [];
  const pct = (v: number | undefined) => (v === undefined ? undefined : percentOfMax(v, h.maxHp));
  const out: Figure[] = [{ label: "伤害", value: `${h.amount.toLocaleString()}${h.crit ? "!" : ""}`, percent: pct(h.amount), crit: h.crit }];
  const g = h.shieldGroup;
  if (g) {
    const shield = (v: number | undefined) => (v === undefined ? "?" : v ? `≈${v.toLocaleString()}` : "0");
    const bound = g.bound === "atLeast" ? "≥" : g.bound === "atMost" ? "≤" : "";
    out.push(
      { label: "盾吸收", value: absorbedText(h), percent: g.closed && g.absorbed !== undefined ? `${bound}${pct(g.absorbed)}` : undefined, title: absorbedTitle(h) },
      { label: "受击前盾量", value: shield(shieldSpan.value?.before), percent: pct(shieldSpan.value?.before) },
      {
        label: "受击后盾量",
        value: shield(shieldSpan.value?.after),
        percent: pct(shieldSpan.value?.after),
        note: group.value ? `盾吸收和盾量是同组 ${group.value.members.length} 下的合计` : undefined,
      },
    );
  }
  if (h.noEffect) out.push({ label: "HP", value: "未生效", dim: true, title: "这次伤害未生效" });
  else {
    const after = hpAfterOf(h);
    out.push(
      { label: "受击前 HP", value: h.hpBefore.toLocaleString(), percent: pct(h.hpBefore) },
      after === undefined ? { label: "受击后 HP", value: "不确定", dim: true } : { label: "受击后 HP", value: after.toLocaleString(), percent: pct(after) },
    );
  }
  const e = unmitigatedRange(h);
  out.push(
    { label: "最大 HP", value: h.maxHp.toLocaleString() },
    { label: "减伤", value: formatMitigation(h.multiplier, h.multiplierPartial) },
    {
      label: "未减伤估算",
      value: formatUnmitigated(h) || (h.noEffect ? "未生效" : group.value ? "见同组合计" : "—"),
      percent: e && e.lo === e.hi ? `${e.dir ?? ""}${pct(e.lo)}` : undefined,
      note: unmitigatedTitle(h),
    },
  );
  if (h.seq) out.push({ label: "命中", value: `${h.targetCount} 人` });
  return out;
});

const blow = computed(() => (death.value ? (props.byId.get(death.value.killerRowId ?? -1) as DamageRow | undefined) : undefined));
/** The hits before a death; the death replay tab has heals, statuses and the HP curve. */
const before = computed(() => {
  const d = death.value;
  if (!d) return [];
  return inEffectOrder(props.rows.filter((r): r is DamageRow => r.kind !== "death" && r.target.id === d.target.id && r.time <= d.time))
    .slice(-8)
    .reverse();
});

/** The mitigation breakdown as a table, each status with its icon, and the mitigation with the vulnerabilities taken in. */
const breakdown = computed(() => {
  const h = hit.value;
  if (!h || h.multiplier === null) return undefined;
  const t = mitigationTable(h.mitigation, h.damageType);
  const withIcon = (l: MitigationLine) => ({ ...l, key: `${l.term.side}:${l.term.statusId}`, icon: l.term.statusId ? statusIconId(l.term.statusId, l.term.stacks ?? 1) : 0 });
  return { ...t, counted: t.counted.map(withIcon), uncounted: t.uncounted.map(withIcon), taken: netMitigation(h.mitigation, h.multiplier, h.multiplierPartial) };
});

function statusLines(list: StatusSnap[], side: "target" | "source", terms: DamageRow["mitigation"]) {
  const termOf = new Map(terms.map((t) => [`${t.side}:${t.statusId}`, t]));
  return list
    .filter((s) => isListedStatus(s.id))
    .sort((a, b) => Number(a.category === "other") - Number(b.category === "other"))
    .map((s) => ({
      s,
      icon: statusIconId(s.id, s.stacks),
      category: STATUS_CATEGORY_LABEL[s.category],
      inactive: s.category !== "other" && !termApplies(termOf.get(`${side}:${s.id}`)),
      remaining: statusRemaining(s),
    }));
}
const targetStatuses = computed(() => (hit.value ? statusLines(hit.value.targetStatuses, "target", hit.value.mitigation) : []));
const sourceStatuses = computed(() => (hit.value ? statusLines(hit.value.sourceStatuses, "source", hit.value.mitigation) : []));

/** The own party's members (24-player duties: the other parties' skills are not known to reach), and the row's player. */
const skills = computed(() =>
  props.partySkills
    ? partySkillsAt(props.partySkills, props.row.time).filter((m) => (m.player.inParty || m.player.id === props.row.target.id) && m.skills.length > 0)
    : [],
);

const VERDICT: Record<DamageRow["result"], string> = { hit: "命中", block: "格挡", parry: "招架", miss: "闪避" };
</script>

<template>
  <aside class="detail">
    <header>
      <JobIcon :job-id="row.target.job" :size="22" />
      <div class="head">
        <div class="who">{{ row.target.name }}</div>
        <div class="dim">{{ formatClock(row.offset) }}　{{ formatWallClock(row.time) }}</div>
      </div>
      <button class="close" title="关闭详情" @click="emit('close')">✕</button>
    </header>

    <template v-if="hit">
      <section>
        <h3>{{ hit.action.name }} <span class="dim">← {{ sourceLabel(hit) }}</span></h3>
        <div class="kind">
          {{ damageKindLabel(hit) }} ·
          {{ hit.noEffect ? "未生效" : hit.fullyAbsorbed ? `${hit.result === "hit" ? "" : VERDICT[hit.result] + "，"}被盾全部吸收` : VERDICT[hit.result]
          }}<span v-if="hit.crit" class="crit"> · 暴击</span>{{ hit.direct ? " · 直击" : "" }}{{ hit.invulnerable ? " · 无敌中" : "" }}
        </div>
        <ul class="figures">
          <li class="head">
            <span />
            <span class="r">数值</span>
            <span class="r" title="占受击者最大 HP 的比例">占最大 HP</span>
          </li>
          <template v-for="f in figures" :key="f.label">
            <li :title="f.title">
              <span class="dim">{{ f.label }}</span>
              <span class="num" :class="{ crit: f.crit, dim: f.dim }">{{ f.value }}</span>
              <span class="num">{{ f.percent }}</span>
            </li>
            <li v-if="f.note" class="note">{{ f.note }}</li>
          </template>
        </ul>
      </section>

      <section>
        <h3>减伤明细</h3>
        <p v-if="!breakdown" class="dim">持续伤害不显示减伤</p>
        <template v-else>
          <ul class="terms">
            <li class="head">
              <span />
              <span class="wide">状态</span>
              <span class="side" title="在受击者身上，还是在来源（敌人）身上">对象</span>
              <span class="val r" title="这个状态对这一下的减伤或增伤">数值</span>
            </li>
            <li v-for="l in breakdown.counted" :key="l.key">
              <GameIcon v-if="l.icon" :icon-id="l.icon" class="sicon" /><span v-else class="sicon" />
              <span class="sname wide" :title="l.name">{{ l.name }}</span>
              <span class="side dim">{{ l.side }}</span>
              <span class="val num">{{ l.value }}</span>
            </li>
            <li v-if="breakdown.counted.length === 0" class="none"><span /><span class="wide">无</span></li>
            <li class="total">
              <span />
              <span class="label">合计减伤 <span class="dim">{{ breakdown.type }}伤害</span></span>
              <span class="val num">{{ formatMitigation(hit.multiplier, hit.multiplierPartial) }}</span>
            </li>
            <template v-if="breakdown.uncounted.length">
              <li class="head">
                <span />
                <span>不计入减伤</span>
                <span>原因</span>
                <span class="side">对象</span>
                <span class="val r">数值</span>
              </li>
              <li v-for="l in breakdown.uncounted" :key="l.key" class="out" :title="l.title">
                <GameIcon v-if="l.icon" :icon-id="l.icon" class="sicon" /><span v-else class="sicon" />
                <span class="sname">{{ l.name }}</span>
                <span :class="{ vuln: l.term.effect === 'increase' && l.term.percent !== 0 }">{{ l.reason }}</span>
                <span class="side">{{ l.side }}</span>
                <span class="val num" :class="{ vuln: l.term.effect === 'increase' && l.term.percent !== 0 }">{{ l.value }}</span>
              </li>
            </template>
            <li v-if="breakdown.taken.text" class="total taken">
              <span />
              <span class="label" title="算上易伤和增伤后的减伤；负数是比原本多受的伤害">实际减伤</span>
              <span class="val num">{{ breakdown.taken.text }}</span>
            </li>
          </ul>
          <p v-for="n in breakdown.taken.notes" :key="n" class="dim">{{ n }}</p>
        </template>
      </section>


      <section>
        <h3>受击者状态（{{ targetStatuses.length }}）</h3>
        <ul class="statuses">
          <li v-for="x in targetStatuses" :key="`${x.s.id}:${x.s.sourceId}`" :class="{ other: x.s.category === 'other', inactive: x.inactive }">
            <GameIcon v-if="x.icon" :icon-id="x.icon" class="sicon" /><span v-else class="sicon" />
            <span class="sname">{{ x.s.name }}{{ x.s.stacks > 1 ? ` ×${x.s.stacks}` : "" }}</span>
            <span class="cat" :class="x.s.category">{{ x.inactive ? "不生效" : x.category }}</span>
            <span class="dim rem">{{ x.remaining }}</span>
            <span class="dim src" :title="x.s.sourceName">{{ x.s.sourceName }}</span>
          </li>
          <li v-if="targetStatuses.length === 0" class="dim none">无</li>
        </ul>
      </section>

      <section>
        <h3>来源状态（{{ sourceStatuses.length }}）</h3>
        <ul class="statuses">
          <li v-for="x in sourceStatuses" :key="`${x.s.id}:${x.s.sourceId}`" :class="{ other: x.s.category === 'other', inactive: x.inactive }">
            <GameIcon v-if="x.icon" :icon-id="x.icon" class="sicon" /><span v-else class="sicon" />
            <span class="sname">{{ x.s.name }}{{ x.s.stacks > 1 ? ` ×${x.s.stacks}` : "" }}{{ x.s.inherited ? "（继承）" : "" }}</span>
            <span class="cat" :class="x.s.category">{{ x.inactive ? "不生效" : x.category }}</span>
            <span class="dim rem">{{ x.remaining }}</span>
            <span class="dim src" :title="x.s.sourceName">{{ x.s.sourceName }}</span>
          </li>
          <li v-if="sourceStatuses.length === 0" class="dim none">无</li>
        </ul>
      </section>

      <section v-if="group">
        <h3>同组受击（{{ group.members.length }} 下）<span class="dim">与同一时段的多次合计</span></h3>
        <ul class="cast group">
          <li v-for="r in group.members" :key="r.id" :class="{ current: r.id === row.id }" @click="emit('select', r.id)">
            <span class="num dim">{{ formatClock(r.offset) }}</span>
            <span class="sname">{{ r.action.name }}</span>
            <span class="num">{{ r.amount.toLocaleString() }}</span>
            <span class="dim verdict">{{ verdictLabel(r) }}</span>
          </li>
        </ul>
        <p class="dim">
          合计伤害 {{ group.amount.toLocaleString() }}，盾吸收 <span :title="absorbedTitle(group)">{{ absorbedText(group) }}</span>，未减伤估算
          <span :title="unmitigatedTitle(group)">{{ formatUnmitigated(group) || "—" }}</span>
        </p>
      </section>

      <section v-if="sameCast.length > 1">
        <h3>命中（{{ sameCast.length }}）</h3>
        <ul class="cast same">
          <li v-for="r in sameCast" :key="r.id" :class="{ current: r.id === row.id }" @click="emit('select', r.id)">
            <JobIcon :job-id="r.target.job" :size="16" />
            <span class="sname">{{ r.target.name }}</span>
            <span class="num">{{ r.amount.toLocaleString() }}</span>
            <span class="num dim" :title="absorbedTitle(r)">{{ absorbedText(r) ? `盾${absorbedText(r)}` : "" }}</span>
            <span class="num">{{ formatMitigation(r.multiplier, r.multiplierPartial) }}</span>
          </li>
        </ul>
      </section>
    </template>

    <template v-else-if="death">
      <section>
        <h3 class="deathline"><UiIcon name="death" /> {{ deathSentence(death, blow) }}</h3>
        <p v-if="death.overkill" class="dim">溢出 {{ death.overkill.toLocaleString() }}</p>
        <p v-if="blow"><button class="link" @click="emit('select', blow.id)">查看致命一击（{{ formatClock(blow.offset) }}）</button></p>
      </section>
      <section>
        <h3>死亡前最后 {{ before.length }} 次受击</h3>
        <ul class="cast before">
          <li class="head">
            <span class="r" title="战斗时间">时间</span>
            <span>伤害名称</span>
            <span class="r" title="扣掉盾之后实际掉的血">伤害</span>
            <span class="r" title="这一下打中之前的 HP，占最大 HP 的比例">受击前 HP</span>
            <span class="r" title="这一下打中时的减伤率">减伤</span>
          </li>
          <li
            v-for="r in before"
            :key="r.id"
            :class="{ current: r.id === death.killerRowId, none: r.noEffect }"
            :title="r.noEffect ? '这次伤害未生效' : r.id === death.killerRowId ? '致命一击' : undefined"
            @click="emit('select', r.id)"
          >
            <span class="num dim">{{ formatClock(r.offset) }}</span>
            <span class="sname">{{ r.action.name }}</span>
            <span class="num" :title="`占最大 HP ${percentOfMax(r.amount, r.maxHp)}`">{{ r.amount.toLocaleString() }}</span>
            <span class="num dim" :title="r.noEffect ? undefined : `受击前 ${r.hpBefore.toLocaleString()}　最大 ${r.maxHp.toLocaleString()}`">{{
              r.noEffect ? "未生效" : percentOfMax(r.hpBefore, r.maxHp)
            }}</span>
            <span class="num" :title="r.noEffect ? undefined : mitigationTitle(r.mitigation, r.multiplier, r.multiplierPartial, r.damageType)">{{
              r.noEffect ? "—" : formatMitigation(r.multiplier, r.multiplierPartial)
            }}</span>
          </li>
        </ul>
        <p><button class="link" @click="emit('open-death', death.id)">在死亡回放里查看（治疗、状态变化、HP 曲线）</button></p>
      </section>
    </template>

    <PartySkills v-if="skills.length" :members="skills" :time="row.time" :target-id="row.target.id" />
  </aside>
</template>

<style scoped>
.detail {
  width: 360px;
  flex: none;
  overflow-y: auto;
  border-left: 1px solid var(--line);
  padding: 10px 12px;
  user-select: text;
}
header {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}
.who {
  font-size: 14px;
}
.head {
  flex: 1;
  min-width: 0;
}
.close {
  align-self: flex-start;
  border: 0;
  background: none;
  color: var(--text-dim);
  padding: 0 4px;
}
section {
  margin-bottom: 12px;
}
h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 6px;
}
.kind {
  margin: -2px 0 6px;
}
/* The hit's figures: 数值 and 占最大 HP in columns, the right one at the edge as the 减伤明细's 数值. */
.figures li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 96px 64px;
  gap: 6px;
  align-items: center;
  min-height: 20px;
}
.figures li.head {
  min-height: 18px;
  color: var(--text-dim);
  font-size: 11px;
}
.figures .r {
  text-align: right;
  white-space: nowrap;
}
.figures .num {
  white-space: nowrap;
}
/* A figure's note, under it. */
.figures li.note {
  display: block;
  min-height: 0;
  padding: 0 0 2px 12px;
  color: var(--text-dim);
  white-space: pre-line;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
/* Fixed columns, shared by both status lists, so category, time and caster line up across them. */
.statuses li,
.cast li,
.terms li {
  display: grid;
  align-items: center;
  gap: 6px;
  height: 22px;
}
.statuses li {
  grid-template-columns: 15px minmax(0, 1fr) 42px 52px 72px;
}
.statuses li.none {
  display: block;
}
.cast.same li {
  grid-template-columns: 16px minmax(0, 1fr) 64px 96px 40px;
}
/* 判定 as wide as the damage table's, for "格挡·全吸收" on one line. */
.cast.group li {
  grid-template-columns: 40px minmax(0, 1fr) 64px 76px;
}
.cast.group .verdict {
  white-space: nowrap;
}
/* One grid for the counted and the uncounted, so 对象 and 数值 line up across them; the counted ones' names run over
   the uncounted ones' 原因, the total sits in 数值. The icons line up with the status lists'. */
.terms li {
  grid-template-columns: 15px minmax(0, 1fr) 44px 40px 44px;
}
.terms li.head {
  height: 18px;
  color: var(--text-dim);
  font-size: 11px;
}
.terms .r {
  text-align: right;
  white-space: nowrap;
}
.terms .wide {
  grid-column: 2 / 4;
}
.terms .label {
  grid-column: 2 / 5;
  white-space: nowrap;
}
.terms li.total {
  border-top: 1px solid var(--line);
}
.terms li.total + li.head {
  margin-top: 6px;
}
.terms li.none,
.terms li.out {
  color: var(--text-dim);
}
.terms .vuln {
  color: var(--cat-vuln);
}
/* 受击前 HP as wide as its heading. */
.cast.before li {
  grid-template-columns: 40px minmax(0, 1fr) 64px 56px 40px;
}
.rem {
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
}
.statuses li.other {
  opacity: 0.6;
}
.statuses li.inactive .sicon {
  filter: grayscale(1);
  opacity: 0.5;
}
.sicon {
  width: 15px;
  height: 18px;
  flex: none;
  object-fit: contain;
}
.sname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cat {
  text-align: center;
  font-size: 11px;
  white-space: nowrap;
}
.cat.mitigation {
  color: var(--cat-mitigation);
}
.cat.shield {
  color: var(--cat-shield);
}
.cat.damageDown {
  color: var(--cat-source);
}
.cat.vulnerability,
.cat.damageUp {
  color: var(--cat-vuln);
}
.cat.invuln {
  color: var(--cat-invuln);
}
.src {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.cast li {
  cursor: pointer;
  padding: 0 4px;
  border-radius: 3px;
}
.cast li:hover {
  background: var(--hover);
}
.cast li.current {
  background: rgba(108, 182, 255, 0.18);
}
/* A list's headings: what each column is, lined up with its values (the time and the figures to the right). */
.cast li.head {
  height: 18px;
  cursor: default;
  color: var(--text-dim);
  font-size: 11px;
}
.cast li.head:hover {
  background: none;
}
.cast li.head .r {
  text-align: right;
}
.cast li.none {
  color: var(--text-dim);
}
.num {
  font-family: var(--mono);
  text-align: right;
}
.dim {
  color: var(--text-dim);
}
.crit {
  color: var(--bad);
}
.deathline {
  color: #ffb4a8;
}
</style>
