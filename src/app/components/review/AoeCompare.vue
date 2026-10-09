<script setup lang="ts">
import { computed, ref } from "vue";
import type { DamageRow, Row } from "@/core/engine/types";
import { aoeGroups, missingMitigation, type AoeGroup } from "@/core/replay/aoe";
import JobIcon from "../common/JobIcon.vue";
import StatusChips from "../monitor/StatusChips.vue";
import {
  absorbedText,
  absorbedTitle,
  formatClock,
  hpAfterOf,
  formatMitigation,
  formatReduction,
  mitigationColor,
  mitigationPercent,
  mitigationTitle,
  percentOfMax,
  reductionColor,
  formatUnmitigated,
  hpAfterNote,
  unmitigatedTitle,
  verdictLabel,
  shieldAfterOf,
} from "../../format";

/**
 * The AOE comparison tab (docs/DESIGN.md 8.4): every cast that hit at least 4 of the shown players;
 * for the selected one, each player's damage, shield, mitigation and statuses side by side, with the
 * party mitigations most of the others had and this player missed. One instance per encounter (the
 * review page keys it), so the filter and selection survive the live reloads of a recording.
 */
const props = defineProps<{
  rows: Row[];
  /** Each player's damage taken against the others (docs/DESIGN.md 5.5), for the unmitigated estimate. */
  selectedRowId: number | undefined;
  /** A row's phase label, undefined for an encounter with a single phase. */
  phaseOf: (row: Row) => string | undefined;
}>();
const emit = defineEmits<{ select: [id: number] }>();

type SortKey = "time" | "max" | "avg" | "deaths";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "time", label: "时间" },
  { key: "max", label: "最高伤害" },
  { key: "avg", label: "平均伤害" },
  { key: "deaths", label: "死亡" },
];

/**
 * A hit's shield cells: the shields on at it, left after it, and what got through. A hit sharing its shield group with
 * others: the group's figures (组…), the reports telling only those.
 */
function shieldCells(r: DamageRow): { before: string; after: string; through: string; title: string } {
  const g = r.shieldGroup;
  if (!g) return { before: r.noEffect ? "" : "无盾", after: "", through: "", title: "" };
  const shared = g.rows.length > 1 ? "组" : "";
  const fmt = (v: number | undefined) => (v === undefined ? "?" : v === 0 ? "0" : `≈${v.toLocaleString()}`);
  return {
    before: shared + fmt(g.before),
    after: shared + fmt(shared ? g.after : shieldAfterOf(r)),
    through: r.amount > 0 ? r.amount.toLocaleString() : "未穿",
    title: `盾吸收 ${absorbedText(r)}\n${absorbedTitle(r)}`,
  };
}

const groups = computed(() => aoeGroups(props.rows));
const withPhase = computed(() => groups.value.some((g) => props.phaseOf(g.rows[0]!) !== undefined));
const actions = computed(() => [...new Set(groups.value.map((g) => g.action))]);
const actionFilter = ref("");
const sort = ref<SortKey>("time");
const shown = computed(() => {
  const list = groups.value.filter((g) => !actionFilter.value || g.action === actionFilter.value);
  const by: Record<SortKey, (a: AoeGroup, b: AoeGroup) => number> = {
    time: (a, b) => a.time - b.time,
    max: (a, b) => b.max - a.max,
    avg: (a, b) => b.avg - a.avg,
    deaths: (a, b) => b.deaths - a.deaths || a.time - b.time,
  };
  return [...list].sort(by[sort.value]);
});

const selectedSeq = ref<string>();
const group = computed(() => shown.value.find((g) => g.seq === selectedSeq.value) ?? shown.value[0]);
const missing = computed(() => (group.value ? missingMitigation(group.value) : new Map<number, { id: number; name: string }[]>()));
const members = computed(() => (group.value ? [...group.value.rows].sort((a, b) => b.amount - a.amount) : []));

function verdict(r: DamageRow): string {
  return r.fatal ? "致死" : verdictLabel(r);
}
</script>

<template>
  <div class="aoe-tab">
    <section class="groups">
      <div class="bar">
        <span class="dim">命中 ≥ 4 人的伤害 {{ shown.length }} 次</span>
        <select v-model="actionFilter">
          <option value="">全部技能</option>
          <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
        </select>
        <span class="dim">排序</span>
        <select v-model="sort">
          <option v-for="s in SORTS" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
      </div>
      <div class="list" :class="{ 'with-phase': withPhase }">
        <div class="g head">
          <span>时间</span>
          <span v-if="withPhase">阶段</span>
          <span>技能</span>
          <span>来源</span>
          <span class="r">人数</span>
          <span class="r">平均</span>
          <span class="r">最低</span>
          <span class="r">最高</span>
          <span class="r">平均减伤</span>
          <span class="r">死亡</span>
        </div>
        <div v-for="g in shown" :key="g.seq" class="g" :class="{ selected: g.seq === group?.seq, deadly: g.deaths > 0 }" @click="selectedSeq = g.seq">
          <span class="num">{{ formatClock(g.offset) }}</span>
          <span v-if="withPhase" class="dim">{{ phaseOf(g.rows[0]!) }}</span>
          <span class="ell" :title="g.action">{{ g.action }}</span>
          <span class="ell dim" :title="g.source">{{ g.source }}</span>
          <span class="num">{{ g.rows.length }}</span>
          <span class="num">{{ g.avg.toLocaleString() }}</span>
          <span class="num">{{ g.min.toLocaleString() }}</span>
          <span class="num">{{ g.max.toLocaleString() }}</span>
          <span class="num" :style="{ color: reductionColor(g.avgMitigation) }">{{ formatReduction(g.avgMitigation) }}</span>
          <span class="num" :class="{ bad: g.deaths > 0 }">{{ g.deaths || "" }}</span>
        </div>
        <div v-if="shown.length === 0" class="empty dim">这场没有命中 4 人以上的伤害</div>
      </div>
    </section>

    <section v-if="group" class="members">
      <div class="bar">
        <span class="name">{{ group.action }}</span>
        <span class="dim">{{ formatClock(group.offset) }}{{ phaseOf(group.rows[0]!) ? ` · ${phaseOf(group.rows[0]!)}` : "" }} · {{ group.source }} · 命中 {{ group.rows.length }} 人 · 合计 {{ group.total.toLocaleString() }}</span>
      </div>
      <div class="list">
        <div class="m head">
          <span>角色</span>
          <span class="r">伤害</span>
          <span class="r">占 HP</span>
          <span class="r" title="受击那一刻身上所有盾合计">盾量</span>
          <span class="r" title="这一下之后剩下的盾：打穿时为 0">剩余</span>
          <span class="r" title="有盾时打穿盾、落到 HP 上的伤害">穿盾</span>
          <span class="r">减伤</span>
          <span class="r" title="没有减伤和已知易伤时的伤害估算；来源和误差见计算说明">未减伤估算</span>
          <span class="r" title="受击后 HP">之后</span>
          <span>状态</span>
          <span title="同一次伤害里多数人身上都有、这个人没有的减伤和盾">缺少</span>
          <span>判定</span>
        </div>
        <div v-for="r in members" :key="r.id" class="m" :class="{ selected: r.id === selectedRowId, fatal: r.fatal }" @click="emit('select', r.id)">
          <span class="who"><JobIcon :job-id="r.target.job" :size="16" /><span class="ell">{{ r.target.name }}</span></span>
          <span class="num amount">
            <span class="dmgbar" :style="{ width: `${group.max > 0 ? Math.round((r.amount / group.max) * 100) : 0}%` }" />
            <span class="v">{{ r.amount.toLocaleString() }}</span>
          </span>
          <span class="num">{{ percentOfMax(r.amount, r.maxHp) }}</span>
          <span class="num dim" :title="shieldCells(r).title">{{ shieldCells(r).before }}</span>
          <span class="num" :class="{ dim: shieldCells(r).after === '0' }" :title="shieldCells(r).title">{{ shieldCells(r).after }}</span>
          <span class="num" :class="{ bad: r.shieldGroup !== undefined && r.amount > 0 }">{{ shieldCells(r).through }}</span>
          <span
            class="num"
            :style="{ color: mitigationColor(r.multiplier === null ? null : mitigationPercent(r.multiplier)) }"
            :title="mitigationTitle(r.mitigation, r.multiplier, r.multiplierPartial, r.damageType)"
          >{{ formatMitigation(r.multiplier, r.multiplierPartial) }}</span>
          <span class="num dim" :title="unmitigatedTitle(r)">{{ formatUnmitigated(r) }}</span>
          <span class="num" :title="hpAfterNote(r)">{{ percentOfMax(hpAfterOf(r), r.maxHp) }}</span>
          <span class="chips"><StatusChips :target="r.targetStatuses" :source="r.sourceStatuses" :terms="r.mitigation" :max="9" /></span>
          <span class="miss ell" :title="(missing.get(r.id) ?? []).map((s) => s.name).join('、')">{{ (missing.get(r.id) ?? []).map((s) => s.name).join("、") }}</span>
          <span class="dim">{{ verdict(r) }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.aoe-tab {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.groups {
  flex: 0 0 42%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--line-strong);
}
.members {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
}
.bar .name {
  font-size: 13px;
  font-weight: 600;
}
select {
  font: inherit;
  color: var(--text);
  background: #23262d;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.g,
.m {
  display: grid;
  align-items: center;
  height: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  cursor: pointer;
}
.g {
  grid-template-columns: 52px minmax(120px, 1.4fr) minmax(90px, 1fr) 44px 80px 80px 80px 72px 44px;
  min-width: 700px;
}
.with-phase .g {
  grid-template-columns: 52px 100px minmax(120px, 1.4fr) minmax(90px, 1fr) 44px 80px 80px 80px 72px 44px;
  min-width: 800px;
}
.m {
  grid-template-columns: 110px 96px 46px 80px 80px 70px 44px 84px 52px minmax(110px, 1fr) minmax(80px, 0.8fr) 72px;
  min-width: 910px;
}
.g > span,
.m > span {
  padding: 0 4px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.head {
  position: sticky;
  top: 0;
  background: #181a1f;
  color: var(--text-dim);
  cursor: default;
  z-index: 1;
  white-space: nowrap;
}
.g:not(.head):hover,
.m:not(.head):hover {
  background: var(--hover);
}
.selected {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
  background: rgba(108, 182, 255, 0.16);
}
.g.deadly .num.bad,
.bad {
  color: var(--bad);
}
.m.fatal {
  background: var(--row-death);
}
.r,
.num {
  text-align: right;
}
.num {
  font-family: var(--mono);
}
.ell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.who {
  display: flex;
  align-items: center;
  gap: 6px;
}
.amount {
  position: relative;
}
.dmgbar {
  position: absolute;
  right: 4px;
  top: 2px;
  bottom: 2px;
  max-width: calc(100% - 8px);
  background: var(--bar-damage);
}
.amount .v {
  position: relative;
}
.chips {
  overflow: hidden;
}
.miss {
  color: var(--warn);
}
.empty {
  padding: 16px;
}
.dim {
  color: var(--text-dim);
}
</style>
