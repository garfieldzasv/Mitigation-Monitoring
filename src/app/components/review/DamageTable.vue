<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DamageRow, DeathRow, Row } from "@/core/engine/types";
import { sourceLabel, type FilterOptions } from "@/core/filter/rowFilter";
import ChecklistFilter from "../common/ChecklistFilter.vue";
import JobIcon from "../common/JobIcon.vue";
import PopoverMenu from "../common/PopoverMenu.vue";
import StatusChips from "../monitor/StatusChips.vue";
import UiIcon from "../common/UiIcon.vue";
import { useReviewFilter } from "../../composables/useMonitorFilter";
import {
  absorbedText,
  absorbedTitle,
  damageKindLabel,
  deathSentence,
  formatClock,
  hpAfterOf,
  formatMitigation,
  formatWallClock,
  mitigationColor,
  mitigationPercent,
  mitigationTitle,
  percentOfMax,
  formatUnmitigated,
  unmitigatedTitle,
  verdictLabel,
} from "../../format";
import { virtualWindow } from "../../virtualWindow";

/**
 * The review window's full damage table (docs/DESIGN.md 8.2): every column, in time order,
 * virtualised, one line per hit (a shield group's hits too: their shield figure is the group's). Clicking a row
 * selects it for the detail panel; `scrollTo` brings a row into view (a death opened from the monitor).
 */
const props = defineProps<{
  rows: Row[];
  byId: Map<number, Row>;
  /** Each player's damage taken against the others (docs/DESIGN.md 5.5), for the unmitigated estimate. */
  options: FilterOptions;
  selectedId: number | undefined;
  scrollTo: number | undefined;
  selfId: string | undefined;
  /** A row's phase label (docs/DESIGN.md 5.9); the 阶段 column shows when the encounter has several stretches 在场. */
  phaseOf: (row: Row) => string | undefined;
}>();
const emit = defineEmits<{ select: [id: number] }>();

const ROW_HEIGHT = 24;
const { filter, update } = useReviewFilter();
const withPhase = computed(() => props.options.phases.length > 1);

const body = ref<HTMLElement>();
const headWrap = ref<HTMLElement>();
const scrollTop = ref(0);
/** The body scrolls both ways; the header follows it sideways (a narrow window with the detail panel open). */
function onScroll(): void {
  const el = body.value;
  if (!el) return;
  scrollTop.value = el.scrollTop;
  if (headWrap.value) headWrap.value.scrollLeft = el.scrollLeft;
}
const viewport = ref(0);
const lines = computed(() => props.rows);
const win = computed(() => virtualWindow(scrollTop.value, viewport.value, ROW_HEIGHT, lines.value.length));
const slice = computed(() => lines.value.slice(win.value.start, win.value.end));
const holds = (r: Row, id: number | undefined) => id !== undefined && r.id === id;

let resize: ResizeObserver | undefined;
onMounted(() => {
  const el = body.value;
  if (!el) return;
  viewport.value = el.clientHeight;
  resize = new ResizeObserver(() => (viewport.value = el.clientHeight));
  resize.observe(el);
});
onBeforeUnmount(() => resize?.disconnect());

async function reveal(id: number | undefined): Promise<void> {
  if (id === undefined) return;
  const index = lines.value.findIndex((r) => holds(r, id));
  const el = body.value;
  if (index < 0 || !el) return;
  await nextTick();
  const top = index * ROW_HEIGHT;
  if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - ROW_HEIGHT) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
  scrollTop.value = el.scrollTop;
}
watch(() => [props.scrollTo, lines.value.length] as const, () => void reveal(props.scrollTo), { immediate: true });

const verdict = (r: DamageRow) => verdictLabel(r);

function hpText(r: DamageRow): string {
  // A hit that never landed has no HP of its own: its "before" is the last update at lock-in, often stale.
  if (r.noEffect) return "—";
  return `${percentOfMax(r.hpBefore, r.maxHp)} → ${percentOfMax(hpAfterOf(r), r.maxHp)}`;
}
function hpTitle(r: DamageRow): string {
  if (r.noEffect) return "这次伤害未生效";
  const after = r.hpAfter === undefined ? "不确定" : r.hpAfter.toLocaleString();
  return `受击前 ${r.hpBefore.toLocaleString()}　受击后 ${after}　最大 ${r.maxHp.toLocaleString()}`;
}
function deathText(r: DeathRow): string {
  return deathSentence(r, props.byId.get(r.killerRowId ?? -1) as DamageRow | undefined);
}
</script>

<template>
  <div class="table" :class="{ 'with-phase': withPhase }">
    <div ref="headWrap" class="head-wrap">
    <div class="line head">
      <span class="c-time">时间</span>
      <span v-if="withPhase" class="c-phase">
        <PopoverMenu :active="filter.hiddenPhases.length > 0" :width="180" title="按在场时段过滤（勾掉任一段时，离场时的受击也隐藏）">
          <template #trigger>阶段 ▾</template>
          <ChecklistFilter title="在场时段" :options="options.phases" :hidden="filter.hiddenPhases" @update:hidden="(v) => update({ hiddenPhases: v })" />
        </PopoverMenu>
      </span>
      <span class="c-who">
        <PopoverMenu :active="filter.hiddenMembers.length > 0" :width="220" title="按队员过滤">
          <template #trigger>角色 ▾</template>
          <ChecklistFilter title="队员" with-job :options="options.members" :hidden="filter.hiddenMembers" @update:hidden="(v) => update({ hiddenMembers: v })" />
        </PopoverMenu>
      </span>
      <span class="c-name">
        <PopoverMenu :active="filter.hiddenActions.length > 0" :width="280" title="按伤害名称过滤">
          <template #trigger>伤害名称 ▾</template>
          <ChecklistFilter title="伤害名称" :options="options.actions" :hidden="filter.hiddenActions" @update:hidden="(v) => update({ hiddenActions: v })" />
        </PopoverMenu>
      </span>
      <span class="c-source">
        <PopoverMenu :active="filter.hiddenSources.length > 0" :width="240" title="按来源过滤">
          <template #trigger>来源 ▾</template>
          <ChecklistFilter title="来源" :options="options.sources" :hidden="filter.hiddenSources" @update:hidden="(v) => update({ hiddenSources: v })" />
        </PopoverMenu>
      </span>
      <span class="c-type">类型</span>
      <span class="c-amount">伤害</span>
      <span class="c-shield">盾吸收</span>
      <span class="c-hp">HP</span>
      <span class="c-mit">减伤</span>
      <span class="c-raw" title="没有减伤和已知易伤时的伤害估算；来源和误差见计算说明">未减伤估算</span>
      <span class="c-status">状态</span>
      <span class="c-verdict">判定</span>
      <span class="c-aoe" title="同一次施放命中的人数">AOE</span>
    </div>
    </div>
    <div ref="body" class="body" @scroll="onScroll">
      <div :style="{ height: `${win.padTop}px` }" />
      <div
        v-for="r in slice"
        :key="r.id"
        class="line row"
        :class="[r.kind, { selected: holds(r, selectedId), self: r.target.id === selfId }]"
        @click="emit('select', r.id)"
      >
        <span class="c-time num" :title="formatWallClock(r.time)">{{ formatClock(r.offset) }}</span>
        <span v-if="withPhase" class="c-phase">{{ phaseOf(r) }}</span>
        <span class="c-who"><JobIcon :job-id="r.target.job" :size="18" /><span class="who-name">{{ r.target.name }}</span></span>
        <template v-if="r.kind === 'death'">
          <span class="c-death"><UiIcon name="death" /> {{ deathText(r) }}<template v-if="r.overkill">　溢出 {{ r.overkill.toLocaleString() }}</template></span>
        </template>
        <template v-else>
          <span class="c-name" :title="r.action.name">{{ r.action.name }}</span>
          <span class="c-source" :title="sourceLabel(r)">{{ sourceLabel(r) }}</span>
          <span class="c-type">{{ damageKindLabel(r) }}</span>
          <span class="c-amount num" :class="{ dim: r.amount === 0 || r.noEffect, crit: r.crit }" :title="r.noEffect ? '这次伤害未生效' : undefined">
            {{ r.amount.toLocaleString() }}<span v-if="r.crit" class="crit-mark">!</span><sup v-if="r.direct">直</sup>
            <span class="share">{{ r.maxHp > 0 ? percentOfMax(r.amount, r.maxHp) : "" }}</span>
          </span>
          <span class="c-shield num" :title="absorbedTitle(r)">{{ absorbedText(r) }}</span>
          <span class="c-hp num" :title="hpTitle(r)">{{ hpText(r) }}</span>
          <span
            class="c-mit num"
            :style="{ color: mitigationColor(r.multiplier === null ? null : mitigationPercent(r.multiplier)) }"
            :title="mitigationTitle(r.mitigation, r.multiplier, r.multiplierPartial, r.damageType)"
          >
            {{ formatMitigation(r.multiplier, r.multiplierPartial) }}
          </span>
          <span class="c-raw num" :title="unmitigatedTitle(r)">{{ formatUnmitigated(r) }}</span>
          <span class="c-status"><StatusChips :target="r.targetStatuses" :source="r.sourceStatuses" :terms="r.mitigation" :max="10" auras /></span>
          <span class="c-verdict">{{ verdict(r) }}</span>
          <span class="c-aoe num">{{ (r.targetCount ?? 1) > 1 ? `×${r.targetCount}` : "" }}</span>
        </template>
      </div>
      <div :style="{ height: `${win.padBottom}px` }" />
      <div v-if="lines.length === 0" class="empty">没有符合条件的记录</div>
    </div>
  </div>
</template>

<style scoped>
.table {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1;
}
.line {
  display: grid;
  /* Minimum 1154px; narrower and the body scrolls sideways with the header following. */
  grid-template-columns: 52px 120px minmax(112px, 1.2fr) minmax(90px, 0.8fr) 64px 110px 84px 100px 56px 124px minmax(130px, 1.3fr) 76px 36px;
  min-width: 1154px;
  align-items: center;
}
/* With phases, a 阶段 column after 时间. */
.with-phase .line {
  grid-template-columns: 52px 100px 120px minmax(112px, 1.2fr) minmax(90px, 0.8fr) 64px 110px 84px 100px 56px 124px minmax(130px, 1.3fr) 76px 36px;
  min-width: 1254px;
}
.with-phase .c-death {
  grid-column: 4 / -1;
}
.c-phase {
  color: var(--text-dim);
  font-size: 11px;
}
.head-wrap {
  flex: none;
  overflow: hidden;
}
.line > span {
  padding: 0 4px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head {
  height: 26px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--line);
  /* room for the body's vertical scrollbar, so columns line up */
  margin-right: 6px;
}
.head > span {
  overflow: visible;
}
.head .c-time,
.head .c-amount,
.head .c-shield,
.head .c-hp,
.head .c-mit,
.head .c-raw,
.head .c-aoe {
  text-align: right;
}
.body {
  flex: 1;
  min-height: 0;
  overflow-y: scroll;
  overflow-x: auto;
}
.row {
  height: 24px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}
.row:hover {
  background: var(--hover);
}
.row.self {
  background: var(--row-self);
}
.row.dot {
  background: var(--row-dot);
}
.row.death {
  background: var(--row-death);
}
.row.selected {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
  background: rgba(108, 182, 255, 0.18);
}
.num {
  font-family: var(--mono);
  text-align: right;
}
.dim {
  color: var(--text-dim);
}
.c-who {
  display: flex;
  align-items: center;
  gap: 6px;
}
.who-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.c-death {
  grid-column: 3 / -1;
  color: #ffd9d4;
}
.share {
  display: inline-block;
  width: 36px;
  color: var(--text-dim);
  font-size: 11px;
}
.c-verdict {
  text-align: center;
  color: var(--text-dim);
}
sup {
  font-size: 9px;
  color: var(--warn);
}
/* A critical hit: its damage in red, with a "!" after it. A 0 stays grey; the "!" still says it crit. */
.c-amount.crit:not(.dim),
.crit-mark {
  color: var(--bad);
}
.crit-mark {
  font-weight: 700;
}
.empty {
  padding: 16px;
  color: var(--text-dim);
}
</style>
