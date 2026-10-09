<script setup lang="ts">
import { computed, ref } from "vue";
import type { Row } from "@/core/engine/types";
import type { RowFilter, RowPhase } from "@/core/filter/rowFilter";
import { abilityStats, memberStats } from "@/core/replay/stats";
import JobIcon from "../common/JobIcon.vue";
import { formatReduction, reductionColor } from "../../format";

/**
 * The statistics tab (docs/DESIGN.md 8.5): damage taken per player and per ability, for the whole
 * encounter or one stretch 在场 (the 离场 windows are not offered). A name opens the damage table showing only that
 * player or ability (in that stretch).
 */
const props = defineProps<{
  rows: Row[];
  /** A row's phase, undefined for an encounter with a single phase. */
  phaseOf: (row: Row) => RowPhase | undefined;
}>();
const emit = defineEmits<{ show: [filter: Partial<RowFilter>] }>();

/** The stretches 在场 with rows, in time order. */
const phaseLabels = computed(() => [...new Set(props.rows.map(props.phaseOf).filter((x) => x?.inPlay).map((x) => x!.label))]);
/** "" for the whole encounter. */
const phase = ref("");
const scoped = computed(() => (phase.value ? props.rows.filter((r) => props.phaseOf(r)?.label === phase.value) : props.rows));

const members = computed(() => memberStats(scoped.value));
const abilities = computed(() => abilityStats(scoped.value));
const partyTotal = computed(() => members.value.reduce((s, m) => s + m.total, 0));
const biggestAbility = computed(() => abilities.value[0]?.total ?? 0);

const share = (v: number, total: number) => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : "");

/** The phase chosen here carries over to the damage table. */
const phaseFilter = (): Partial<RowFilter> => (phase.value ? { hiddenPhases: phaseLabels.value.filter((x) => x !== phase.value) } : {});
function onlyMember(id: string): void {
  emit("show", { hiddenMembers: members.value.map((m) => m.target.id).filter((x) => x !== id), ...phaseFilter() });
}
function onlyAction(name: string): void {
  emit("show", { hiddenActions: [...new Set(abilities.value.map((a) => a.action))].filter((x) => x !== name), ...phaseFilter() });
}
</script>

<template>
  <div class="stats-tab">
    <div v-if="phaseLabels.length > 1" class="scope">
      <span class="dim">统计范围</span>
      <select v-model="phase">
        <option value="">整场</option>
        <option v-for="p in phaseLabels" :key="p" :value="p">{{ p }}</option>
      </select>
    </div>
    <section>
      <h3>按队员 <span class="dim">点名字在受伤明细里只看这个人</span></h3>
      <div class="list">
        <div class="mrow head">
          <span>角色</span>
          <span class="r">受击</span>
          <span class="r">承伤合计</span>
          <span class="r">占全队</span>
          <span class="r">其中 DoT</span>
          <span class="r">盾吸收</span>
          <span class="r">平均减伤</span>
          <span>最大一击</span>
          <span class="r">死亡</span>
        </div>
        <div v-for="m in members" :key="m.target.id" class="mrow">
          <span class="who">
            <JobIcon :job-id="m.target.job" :size="16" />
            <button class="link ell" :title="`在受伤明细里只看 ${m.target.name}`" @click="onlyMember(m.target.id)">{{ m.target.name }}</button>
          </span>
          <span class="num">{{ m.hits }}</span>
          <span class="num total">
            <span class="sharebar" :style="{ width: share(m.total, members[0]?.total ?? 0) }" />
            <span class="v">{{ m.total.toLocaleString() }}</span>
          </span>
          <span class="num dim">{{ share(m.total, partyTotal) }}</span>
          <span class="num dim">{{ m.dotTotal ? m.dotTotal.toLocaleString() : "" }}</span>
          <span class="num dim" :title="m.shieldUncertain ? '部分条目只知道上限或下限，或不确定' : ''">{{ m.shieldAbsorbed ? `≈${m.shieldAbsorbed.toLocaleString()}${m.shieldUncertain ? "*" : ""}` : m.shieldUncertain ? "?" : "" }}</span>
          <span class="num" :style="{ color: reductionColor(m.avgMitigation) }">{{ formatReduction(m.avgMitigation) }}</span>
          <span class="ell" :title="m.biggest ? `${m.biggest.action.name} ${m.biggest.amount.toLocaleString()}` : ''">
            <template v-if="m.biggest">{{ m.biggest.action.name }} <span class="num dim">{{ m.biggest.amount.toLocaleString() }}</span></template>
          </span>
          <span class="num" :class="{ bad: m.deaths > 0 }">{{ m.deaths || "" }}</span>
        </div>
      </div>
    </section>

    <section class="abilities">
      <h3>按伤害名称 <span class="dim">点名字在受伤明细里只看这个技能</span></h3>
      <div class="list">
        <div class="arow head">
          <span>伤害名称</span>
          <span>来源</span>
          <span class="r" title="不同的施放次数（DoT 每跳算一次）">次数</span>
          <span class="r">命中</span>
          <span class="r">合计</span>
          <span class="r">平均</span>
          <span class="r">最高</span>
          <span class="r">平均减伤</span>
          <span class="r">致死</span>
        </div>
        <div v-for="a in abilities" :key="`${a.action}\u0000${a.source}`" class="arow">
          <span class="ell"><button class="link" :title="`在受伤明细里只看 ${a.action}`" @click="onlyAction(a.action)">{{ a.action }}</button></span>
          <span class="ell dim" :title="a.source">{{ a.source || "未知" }}</span>
          <span class="num">{{ a.casts }}</span>
          <span class="num">{{ a.hits }}</span>
          <span class="num total">
            <span class="sharebar" :style="{ width: share(a.total, biggestAbility) }" />
            <span class="v">{{ a.total.toLocaleString() }}</span>
          </span>
          <span class="num">{{ a.avg.toLocaleString() }}</span>
          <span class="num">{{ a.max.toLocaleString() }}</span>
          <span class="num" :style="{ color: reductionColor(a.avgMitigation) }">{{ formatReduction(a.avgMitigation) }}</span>
          <span class="num" :class="{ bad: a.fatal > 0 }">{{ a.fatal || "" }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stats-tab {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 10px 0;
  gap: 10px;
}
section {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
section:first-child {
  flex: none;
  max-height: 45%;
}
.abilities {
  flex: 1;
}
.scope {
  display: flex;
  align-items: center;
  gap: 8px;
}
select {
  font: inherit;
  color: var(--text);
  background: #23262d;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
}
h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 4px;
}
h3 .dim {
  font-weight: normal;
  font-size: 11px;
  margin-left: 8px;
}
.list {
  min-height: 0;
  overflow: auto;
}
.mrow,
.arow {
  display: grid;
  align-items: center;
  height: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}
.mrow {
  grid-template-columns: 150px 52px 130px 64px 90px 96px 72px minmax(160px, 1fr) 44px;
  min-width: 860px;
}
.arow {
  grid-template-columns: minmax(150px, 1.3fr) minmax(110px, 1fr) 52px 52px 130px 84px 84px 72px 44px;
  min-width: 860px;
}
.mrow > span,
.arow > span {
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
  z-index: 1;
}
.mrow:not(.head):hover,
.arow:not(.head):hover {
  background: var(--hover);
}
.who {
  display: flex;
  align-items: center;
  gap: 6px;
}
.link {
  max-width: 100%;
  text-align: left;
}
.ell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.r,
.num {
  text-align: right;
}
.num {
  font-family: var(--mono);
}
.total {
  position: relative;
}
.sharebar {
  position: absolute;
  right: 4px;
  top: 2px;
  bottom: 2px;
  max-width: calc(100% - 8px);
  background: var(--bar-damage);
}
.total .v {
  position: relative;
}
.bad {
  color: var(--bad);
}
.dim {
  color: var(--text-dim);
}
</style>
