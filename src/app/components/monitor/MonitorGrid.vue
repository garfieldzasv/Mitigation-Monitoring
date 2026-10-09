<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Phase } from "@/core/engine/phases";
import { type DamageRow, type DeathRow, type Row, damageTaken } from "@/core/engine/types";
import { sourceLabel, type FilterOptions } from "@/core/filter/rowFilter";
import ChecklistFilter from "../common/ChecklistFilter.vue";
import JobIcon from "../common/JobIcon.vue";
import PopoverMenu from "../common/PopoverMenu.vue";
import StatusChips from "./StatusChips.vue";
import UiIcon from "../common/UiIcon.vue";
import { useMonitorFilter } from "../../composables/useMonitorFilter";
import { absorbedText, deathSentence, formatClock, formatMitigation, mitigationColor, mitigationPercent, mitigationTitle, phaseSummary, verdictLabel } from "../../format";
import { monitorItems, type MonitorItem } from "../../monitorItems";
import { isAtTop, virtualWindow } from "../../virtualWindow";

/**
 * The monitor's 7-column grid (docs/DESIGN.md 7.1): fixed column widths, only the status column
 * stretches. The newest row is on top and the view stays at the top; once the user scrolls down,
 * the lines in view stay put as new ones arrive, and a 返回顶部 button brings the view back. Where a
 * phase starts, a line says so (monitorItems). Virtualised with a fixed line height.
 */
const props = defineProps<{
  /** In time order; displayed newest first. One line per hit, a shield group's too (docs/DESIGN.md 7.1). */
  rows: Row[];
  /** The encounter's phases (derivePhases); dividers appear when there are several. */
  phases: Phase[];
  encounterStart: number | undefined;
  /** Every row of the encounter in scope (for the death text's killing blow). */
  allRows: readonly Row[];
  options: FilterOptions;
  /** Changes when a new encounter is shown; the view jumps to its newest row. */
  encounterKey: number | undefined;
  selfId: string | undefined;
  /** Tint the player's own rows (a setting). */
  highlightSelf: boolean;
  rowHeight: number;
}>();
/** A death row's [回放]: open the review window at that death. */
const emit = defineEmits<{ "open-review": [rowId: number] }>();

const { filter, update } = useMonitorFilter();

const body = ref<HTMLElement>();
const scrollTop = ref(0);
const viewport = ref(0);
const following = ref(true);

/** The lines, newest first (0 = top). */
const items = computed<MonitorItem[]>(() => monitorItems(props.rows, props.phases));

const win = computed(() => virtualWindow(scrollTop.value, viewport.value, props.rowHeight, items.value.length));
/** The lines in view: a phase line carries `phase`, a row line `r`. */
const slice = computed(() => {
  const out: { key: string; index: number; phase?: Phase; r?: Row }[] = [];
  for (let i = win.value.start; i < win.value.end; i++) {
    const item = items.value[i]!;
    out.push(item.kind === "phase" ? { key: item.key, index: i, phase: item.phase } : { key: item.key, index: i, r: item.row });
  }
  return out;
});

function onScroll(): void {
  const el = body.value;
  if (!el) return;
  scrollTop.value = el.scrollTop;
  following.value = isAtTop(el.scrollTop, props.rowHeight);
}

async function toTop(): Promise<void> {
  following.value = true;
  await nextTick();
  const el = body.value;
  if (!el) return;
  el.scrollTop = 0;
  scrollTop.value = 0;
}

/**
 * New lines are inserted above whatever is in view. Following, the view simply stays at the top;
 * scrolled down, it moves down by the lines added above the previous top line, so the lines being
 * read do not jump. A filter change can drop that line; the scroll position is then left alone.
 */
let topKey: string | undefined;
watch(
  items,
  (list) => {
    const previous = topKey;
    topKey = list[0]?.key;
    const el = body.value;
    if (!el || following.value || previous === undefined) return;
    const added = list.findIndex((item) => item.key === previous);
    if (added > 0) {
      el.scrollTop += added * props.rowHeight;
      scrollTop.value = el.scrollTop;
    }
  },
  { flush: "post" },
);
watch(
  () => props.encounterKey,
  () => {
    topKey = undefined;
    void toTop();
  },
);

/**
 * The status column takes the width left over, so how many icons fit is measured on its header
 * cell: 17px per icon (15 + 2 gap) after 6px of padding, at least 3.
 */
const STATUS_ICON_PITCH = 17;
const statusHead = ref<HTMLElement>();
const statusSlots = ref(5);

let resize: ResizeObserver | undefined;
onMounted(() => {
  const el = body.value;
  if (!el) return;
  viewport.value = el.clientHeight;
  const measure = () => {
    viewport.value = el.clientHeight;
    const width = statusHead.value?.clientWidth ?? 0;
    if (width > 0) statusSlots.value = Math.max(3, Math.floor((width - 6 + 2) / STATUS_ICON_PITCH));
  };
  resize = new ResizeObserver(measure);
  resize.observe(el);
  if (statusHead.value) resize.observe(statusHead.value);
  measure();
});
onBeforeUnmount(() => resize?.disconnect());

/** Top row of a multi-target action, so AOE groups read apart without being merged. */
function groupStart(row: Row, index: number): boolean {
  if (row.kind === "death" || !row.seq || (row.targetCount ?? 1) < 2) return false;
  const above = items.value[index - 1];
  return !above || above.kind !== "row" || above.row.kind === "death" || above.row.seq !== row.seq;
}

const STATUS_LEGEND = [
  "图标下方的色条：",
  "绿 = 减伤　蓝 = 盾　金 = 无敌",
  "橙 = Boss 身上的减益（雪仇、昏乱、牵制、武装解除）",
  "红 = 易伤 / Boss 增伤（数值未知，不计入减伤率）",
  "黑白 = 对这次伤害不生效（伤害类型不符，或与同类减伤不叠加）",
  "能放几个按列宽算，放不下时最后一格显示 +N；鼠标停在状态上看全部",
].join("\n");

const verdict = (r: DamageRow) => verdictLabel(r, true);

const TYPE: Record<DamageRow["damageType"], string> = { physical: "物理", magical: "魔法", special: "特殊", unknown: "未知" };
function nameTitle(r: DamageRow): string {
  const id = r.action.id ? `，技能 ID ${r.action.id.toString(16).toUpperCase()}` : "";
  return `${r.action.name}\n来源：${sourceLabel(r)}\n类型：${TYPE[r.damageType]}${id}`;
}

function amountTitle(r: DamageRow): string {
  if (r.noEffect) return "这次伤害未生效";
  const after = r.hpAfter !== undefined ? ` → ${r.hpAfter.toLocaleString()}` : "";
  const absorbed = absorbedText(r);
  const shield = absorbed ? `\n盾吸收 ${absorbed}` : "";
  return `HP ${r.hpBefore.toLocaleString()}${after} / ${r.maxHp.toLocaleString()}${shield}`;
}

function damageFraction(r: DamageRow): number {
  return r.maxHp > 0 ? Math.min(1, damageTaken(r) / r.maxHp) : 0;
}

function deathText(r: DeathRow): string {
  return deathSentence(r, props.allRows.find((x) => x.id === r.killerRowId) as DamageRow | undefined);
}

function deathTitle(r: DeathRow): string {
  return r.overkill ? `${deathText(r)}\n溢出 ${r.overkill.toLocaleString()}` : deathText(r);
}
</script>

<template>
  <div class="grid" :style="{ '--row-h': `${rowHeight}px` }">
    <div class="line head">
      <span class="c-time">时间</span>
      <span class="c-job">
        <PopoverMenu :active="filter.hiddenMembers.length > 0" :width="200" title="按队员过滤">
          <template #trigger>职▾</template>
          <ChecklistFilter
            title="队员"
            with-job
            :options="options.members"
            :hidden="filter.hiddenMembers"
            @update:hidden="(v) => update({ hiddenMembers: v })"
          />
        </PopoverMenu>
      </span>
      <span class="c-name">
        <PopoverMenu
          :active="filter.hiddenActions.length > 0 || filter.hiddenSources.length > 0"
          :width="280"
          title="按伤害名称、来源过滤"
        >
          <template #trigger>来源 ▾</template>
          <ChecklistFilter
            title="伤害名称"
            :options="options.actions"
            :hidden="filter.hiddenActions"
            @update:hidden="(v) => update({ hiddenActions: v })"
          />
          <div class="sep" />
          <ChecklistFilter
            title="来源"
            :options="options.sources"
            :hidden="filter.hiddenSources"
            @update:hidden="(v) => update({ hiddenSources: v })"
          />
        </PopoverMenu>
      </span>
      <span class="c-amount">伤害</span>
      <span class="c-mit">减伤</span>
      <span ref="statusHead" class="c-status" :title="STATUS_LEGEND">状态</span>
      <span class="c-verdict">判</span>
    </div>

    <div ref="body" class="body" @scroll="onScroll">
      <div :style="{ height: `${win.padTop}px` }" />
      <template v-for="{ key, index, phase, r } in slice" :key="key">
      <div v-if="phase" class="line phase" :class="phase.kind" :title="phaseSummary(phase, encounterStart ?? phase.start)">
        <span class="phase-text">{{ phaseSummary(phase, encounterStart ?? phase.start) }}</span>
      </div>
      <div
        v-else-if="r"
        class="line row"
        :class="[r.kind, { self: highlightSelf && r.target.id === selfId, 'group-start': groupStart(r, index) }]"
      >
        <span class="c-time num">{{ formatClock(r.offset) }}</span>
        <span class="c-job"><JobIcon :job-id="r.target.job" :name="r.target.name" /></span>
        <template v-if="r.kind === 'death'">
          <span class="c-death" :title="deathTitle(r)">
            <span class="death-text"><UiIcon name="death" class="skull" /> {{ deathText(r) }}</span>
            <button class="open" title="在复盘窗口里看这次死亡的回放" @click="emit('open-review', r.id)">[回放]</button>
          </span>
        </template>
        <template v-else>
          <span class="c-name" :title="nameTitle(r)">{{ r.action.name }}</span>
          <span
            class="c-amount num"
            :class="{ dim: r.amount === 0, crit: r.crit }"
            :style="{ '--frac': damageFraction(r) }"
            :title="amountTitle(r)"
          >
            {{ r.amount.toLocaleString() }}<span v-if="r.crit" class="crit-mark">!</span><sup v-if="r.direct">直</sup>
          </span>
          <span
            class="c-mit num"
            :style="{ color: mitigationColor(r.multiplier === null ? null : mitigationPercent(r.multiplier)) }"
            :title="mitigationTitle(r.mitigation, r.multiplier, r.multiplierPartial, r.damageType)"
          >
            {{ formatMitigation(r.multiplier, r.multiplierPartial) }}
          </span>
          <span class="c-status">
            <StatusChips :target="r.targetStatuses" :source="r.sourceStatuses" :terms="r.mitigation" :max="statusSlots" />
          </span>
          <span class="c-verdict" :class="{ small: verdict(r).length > 1 }">{{ verdict(r) }}</span>
        </template>
      </div>
      </template>
      <div :style="{ height: `${win.padBottom}px` }" />
    </div>

    <button v-if="!following" class="to-top" @click="toTop">返回顶部 ↑</button>
  </div>
</template>

<style scoped>
.grid {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.line {
  display: grid;
  /* 来源 is fixed (about 8 characters, longer names are cut with the full name on hover); the
     status column takes the rest, so a wider window shows more status icons. */
  grid-template-columns: 44px 26px 110px 64px 44px minmax(92px, 1fr) 28px;
  align-items: center;
  column-gap: 0;
}
.line > span {
  padding: 0 3px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head {
  height: 20px;
  flex: none;
  color: var(--text-dim);
  border-bottom: 1px solid var(--line);
  /* leave room for the body's scrollbar so header and rows line up */
  padding-right: 6px;
}
.head .c-time,
.head .c-amount,
.head .c-mit {
  text-align: right;
}
.head .c-verdict {
  text-align: center;
}
.head > span {
  overflow: visible;
}
.body {
  flex: 1;
  min-height: 0;
  overflow-y: scroll;
  overflow-x: hidden;
}
.row {
  height: var(--row-h);
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
/* A phase starting: one line across the grid, the same height as a row (virtualisation). */
.phase {
  display: flex;
  align-items: center;
  height: var(--row-h);
  padding: 0 6px;
  color: #cfd8e3;
  font-size: 11px;
  background: rgba(108, 182, 255, 0.12);
  border-top: 1px solid rgba(108, 182, 255, 0.45);
}
.phase.intermission {
  color: var(--text-dim);
  background: rgba(255, 255, 255, 0.04);
  border-top-color: var(--line-strong);
}
.phase-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row.group-start {
  box-shadow: inset 0 1px 0 var(--line);
}
.num {
  font-family: var(--mono);
  text-align: right;
}
.dim {
  color: var(--text-dim);
}
.c-job {
  display: flex;
  justify-content: center;
}
.c-amount {
  background: linear-gradient(to left, var(--bar-damage) calc(var(--frac, 0) * 100%), transparent 0);
}
.c-death {
  grid-column: 3 / -1;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #ffd9d4;
}
.death-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.open {
  flex: none;
  padding: 0 2px;
  border: 0;
  background: none;
  color: #ffd1c9;
  font-size: 11px;
  line-height: 15px;
}
.open:hover {
  color: #fff;
  background: none;
  text-decoration: underline;
}
.skull {
  vertical-align: -0.12em;
}
.c-verdict {
  text-align: center;
  color: var(--text-dim);
}
.c-verdict.small {
  font-size: 10px;
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
.sep {
  height: 1px;
  margin: 6px 0;
  background: var(--line);
}
.to-top {
  position: absolute;
  right: 12px;
  top: 28px;
  padding: 2px 10px;
  background: var(--panel-solid);
  border-color: var(--accent);
  color: var(--accent);
}
</style>
