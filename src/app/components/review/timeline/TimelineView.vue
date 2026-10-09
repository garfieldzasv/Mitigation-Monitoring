<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { phaseAt, type Phase } from "@/core/engine/phases";
import { statusIconId } from "@/core/game/statuses";
import type { CasterGroup, MemberLane, StatusLine, StatusSpan, TimelineModel } from "@/core/replay/timeline";
import { formatClock } from "../../../format";
import { readPreference, writePreference } from "../../../preferences";
import {
  centerOn,
  clampView,
  fitScale,
  fitView,
  initialView,
  MAX_PX_PER_SEC,
  onScreen,
  ticks,
  timeAt,
  viewEnd,
  xOf,
  zoomAt,
  type Viewport,
} from "../../../timelineView";
import GameIcon from "../../common/GameIcon.vue";
import JobIcon from "../../common/JobIcon.vue";
import { tipLines, type TimelineHover } from "./hover";
import TlCasts from "./TlCasts.vue";
import TlDamage from "./TlDamage.vue";
import TlHp from "./TlHp.vue";
import TlPhases from "./TlPhases.vue";
import TlSpans from "./TlSpans.vue";

/**
 * The timeline tab (docs/DESIGN.md 8.6): lanes against time, for looking at mitigation. Phases, enemy
 * casts, a bar per cast that hit (height = damage, colour = mitigation) and per auto-attack, then per
 * player what they put up (one line per status), and every player's HP. Opens on about two minutes;
 * drag or Shift+wheel pans, Ctrl+wheel zooms (out to the whole pull at most), the plain wheel scrolls
 * the lanes. Hovering a damage bar dims every status not in effect then.
 */
const props = defineProps<{
  model: TimelineModel;
  /** The pull: time 0. */
  origin: number;
  selectedRowId?: number | undefined;
  /** A row to bring on screen (the URL's row). */
  scrollTo?: number | undefined;
}>();
const emit = defineEmits<{ select: [rowId: number]; openDeath: [rowId: number] }>();

const LABEL_W = 150;
const labelWidth = `${LABEL_W}px`;
const CAST_LINE_H = 16;
const COLLAPSED_KEY = "mitigation-monitoring:timeline-collapsed";
type Section = "casters" | "members";

// ---------- lanes ----------

type Lane =
  | { key: string; kind: "phases" | "casts" | "damage" | "autos"; label: string; height: number }
  | { key: string; kind: "bossBuff"; label: string; height: number; line: StatusLine }
  | { key: string; kind: "section"; label: string; height: number; section: Section; collapsed: boolean }
  | { key: string; kind: "caster"; label: string; height: number; group: CasterGroup; collapsed: boolean; overview: StatusSpan[] }
  | { key: string; kind: "status"; label: string; height: number; line: StatusLine }
  | { key: string; kind: "hp"; label: string; height: number; member: MemberLane };
/** `top`: the boss and damage lanes stay put while the players' lanes scroll under them, stacked from here. */
type PlacedLane = Lane & { top?: number };

const collapsedSections = ref(new Set<Section>(readPreference<Section[]>(COLLAPSED_KEY, [], Array.isArray)));
watch(collapsedSections, (v) => writePreference(COLLAPSED_KEY, [...v]), { deep: true });
/** Per caster, for this encounter: 24-player duties start with only the own party open. */
const casterOpen = ref(new Map<string, boolean>());
const isOpen = (g: CasterGroup) => casterOpen.value.get(g.player.id) ?? (props.model.casters.length <= 8 || g.player.inParty);

function toggleSection(s: Section): void {
  const next = new Set(collapsedSections.value);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  collapsedSections.value = next;
}
function toggleCaster(g: CasterGroup): void {
  casterOpen.value = new Map(casterOpen.value).set(g.player.id, !isOpen(g));
}

/** A status's lane: 20 px per line of spans (TlSpans), casts overlapping in time taking a line each. */
const laneHeight = (line: StatusLine) => 2 + line.lanes * 20;

const lanes = computed<PlacedLane[]>(() => {
  const m = props.model;
  const out: Lane[] = [];
  if (m.phases.length > 1) out.push({ key: "phases", kind: "phases", label: "阶段", height: 20 });
  out.push({ key: "casts", kind: "casts", label: "Boss 读条", height: 4 + Math.max(1, m.castLines) * CAST_LINE_H });
  for (const line of m.bossBuffs) out.push({ key: `boss:${line.key}`, kind: "bossBuff", label: line.status.name, height: laneHeight(line), line });
  out.push({ key: "damage", kind: "damage", label: "团队受伤", height: 48 });
  if (m.autoAttacks.length > 0) out.push({ key: "autos", kind: "autos", label: "自动攻击", height: 30 });
  const pinned: PlacedLane[] = [];
  let top = 0;
  for (const lane of out) {
    pinned.push({ ...lane, top });
    top += lane.height;
  }
  out.length = 0;

  const castersCollapsed = collapsedSections.value.has("casters");
  out.push({ key: "section:casters", kind: "section", label: "减伤", height: 22, section: "casters", collapsed: castersCollapsed });
  if (!castersCollapsed) {
    for (const group of m.casters) {
      const open = isOpen(group);
      out.push({ key: `caster:${group.player.id}`, kind: "caster", label: group.player.name, height: 22, group, collapsed: !open, overview: group.lines.flatMap((l) => l.spans) });
      if (open) for (const line of group.lines) out.push({ key: `status:${group.player.id}:${line.key}`, kind: "status", label: line.status.name, height: laneHeight(line), line });
    }
  }

  const membersCollapsed = collapsedSections.value.has("members");
  out.push({ key: "section:members", kind: "section", label: "队员 HP", height: 22, section: "members", collapsed: membersCollapsed });
  if (!membersCollapsed) for (const member of m.members) out.push({ key: `hp:${member.player.id}`, kind: "hp", label: member.player.name, height: 36, member });
  return [...pinned, ...out];
});
const lanesHeight = computed(() => lanes.value.reduce((s, l) => s + l.height, 0));

const jobs = computed(() => new Map(props.model.members.map((m) => [m.player.id, m.player.job])));
const jobOf = (id: string) => jobs.value.get(id);
const names = computed(() => new Map(props.model.members.map((m) => [m.player.id, m.player.name])));

// ---------- viewport ----------

const scroller = ref<HTMLElement>();
/** Width 0 until measured; the first measure opens the default view. */
const view = shallowRef<Viewport>({ from: props.model.from, pxPerSec: 1, width: 0 });
const bounded = (v: Viewport) => clampView(v, props.model.from, props.model.to);
function setView(v: Viewport): void {
  view.value = bounded(v);
}
const canZoomOut = computed(() => view.value.pxPerSec > fitScale(view.value.width, props.model.from, props.model.to) + 1e-6);
const canZoomIn = computed(() => view.value.pxPerSec < MAX_PX_PER_SEC);

let resize: ResizeObserver | undefined;
onMounted(() => {
  const el = scroller.value;
  if (!el) return;
  const measure = () => {
    const width = Math.max(100, el.clientWidth - LABEL_W);
    if (view.value.width === 0) {
      view.value = initialView(width, props.model.from, props.model.to);
      bringOnScreen(props.scrollTo, true);
    } else setView({ ...view.value, width });
  };
  measure();
  resize = new ResizeObserver(measure);
  resize.observe(el);
});
onBeforeUnmount(() => {
  resize?.disconnect();
  endDrag();
});

/** A recording still being fought: a view at its end follows it. */
watch(
  () => props.model.to,
  (to, before) => {
    const v = view.value;
    if (before !== undefined && viewEnd(v) >= before - 500) setView({ ...v, from: v.from + (to - before) });
    else setView(v);
  },
);

function rowTime(id: number): number | undefined {
  for (const m of props.model.members) {
    const r = m.hits.find((x) => x.id === id) ?? m.deaths.find((x) => x.id === id);
    if (r) return r.time;
  }
  return undefined;
}
/** Centres a row unless it is already on screen. */
function bringOnScreen(id: number | undefined, always = false): void {
  const t = id === undefined ? undefined : rowTime(id);
  if (t === undefined || view.value.width === 0) return;
  if (always || !onScreen(view.value, t, t)) setView(centerOn(view.value, t, props.model.from, props.model.to));
}
watch(() => props.scrollTo, (id) => bringOnScreen(id));

function zoomBy(factor: number, anchorX = view.value.width / 2): void {
  view.value = zoomAt(view.value, factor, anchorX, props.model.from, props.model.to);
}
function fitAll(): void {
  setView(fitView(view.value.width, props.model.from, props.model.to));
}
function zoomToPhase(p: Phase): void {
  const end = p.end ?? props.model.to;
  const pad = (end - p.start) * 0.03;
  setView(fitView(view.value.width, p.start - pad, end + pad));
}

// ---------- mouse ----------

const lanesEl = ref<HTMLElement>();
const root = ref<HTMLElement>();
/** Where the mouse is over the plots: x in the drawing area, and its time. */
const pointer = ref<{ x: number; t: number; clientX: number; clientY: number }>();
const hovered = shallowRef<TimelineHover>();
/** A hovered damage bar's time: the spans not covering it are dimmed. */
const focus = computed(() => (hovered.value?.kind === "damage" ? hovered.value.event.time : undefined));

function onMove(e: MouseEvent): void {
  const el = lanesEl.value;
  if (!el) return;
  const x = e.clientX - el.getBoundingClientRect().left - LABEL_W;
  pointer.value = x >= 0 && x <= view.value.width ? { x, t: timeAt(view.value, x), clientX: e.clientX, clientY: e.clientY } : undefined;
}
function onLeave(): void {
  pointer.value = undefined;
  hovered.value = undefined;
}

function onWheel(e: WheelEvent): void {
  if (e.ctrlKey) {
    // Ctrl+wheel, and a touchpad pinch (which arrives as one).
    e.preventDefault();
    const el = lanesEl.value;
    const x = el ? e.clientX - el.getBoundingClientRect().left - LABEL_W : view.value.width / 2;
    zoomBy(Math.exp(-e.deltaY * 0.002), Math.max(0, Math.min(view.value.width, x)));
    return;
  }
  const sideways = e.shiftKey ? e.deltaX || e.deltaY : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
  if (sideways === 0) return; // the plain wheel scrolls the lanes
  e.preventDefault();
  setView({ ...view.value, from: view.value.from + (sideways / view.value.pxPerSec) * 1000 });
}

// Dragging pans both ways; a drag is not a click on whatever it started on.
let drag: { x: number; y: number; from: number; top: number; moved: boolean } | undefined;
let swallowClick = false;
function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest(".label")) return;
  drag = { x: e.clientX, y: e.clientY, from: view.value.from, top: scroller.value?.scrollTop ?? 0, moved: false };
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", endDrag);
}
function onDragMove(e: PointerEvent): void {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  setView({ ...view.value, from: drag.from - (dx / view.value.pxPerSec) * 1000 });
  if (scroller.value) scroller.value.scrollTop = drag.top - dy;
}
function endDrag(): void {
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", endDrag);
  swallowClick = !!drag?.moved;
  drag = undefined;
}
function onClickCapture(e: MouseEvent): void {
  if (!swallowClick) return;
  swallowClick = false;
  e.stopPropagation();
}

// ---------- reading aids ----------

const tickList = computed(() => ticks(view.value, props.origin));
const phaseLines = computed(() =>
  props.model.phases.length > 1
    ? props.model.phases.slice(1).filter((p) => onScreen(view.value, p.start, p.start)).map((p) => ({ key: p.label, x: xOf(view.value, p.start) }))
    : [],
);
const readout = computed(() => {
  const p = pointer.value;
  if (!p) return "";
  const phase = props.model.phases.length > 1 ? phaseAt(props.model.phases, p.t) : undefined;
  return `${formatClock(p.t - props.origin)}${phase ? ` · ${phase.kind === "fight" ? "在场" : "离场"} +${formatClock(p.t - phase.start)}` : ""}`;
});
const tip = computed(() => {
  const h = hovered.value;
  const p = pointer.value;
  const box = root.value?.getBoundingClientRect();
  if (!h || !p || !box) return undefined;
  const lines = tipLines(h, { model: props.model, origin: props.origin, at: p.t, nameOf: (id) => names.value.get(id) ?? "" });
  const x = p.clientX - box.left;
  const y = p.clientY - box.top;
  // Beside the mouse, on whichever side has room.
  return { lines, style: { left: x > box.width - 320 ? undefined : `${x + 14}px`, right: x > box.width - 320 ? `${box.width - x + 14}px` : undefined, top: `${Math.min(y + 14, box.height - 24 - lines.length * 16)}px` } };
});

function pick(rowId: number): void {
  emit("select", rowId);
}
</script>

<template>
  <div ref="root" class="timeline-tab">
    <div class="toolbar">
      <span class="hint dim">拖动平移 · Shift+滚轮横向 · Ctrl+滚轮缩放</span>
      <span class="spacer" />
      <span class="readout num">{{ readout }}</span>
      <button title="把整场放进窗口" @click="fitAll">适应全场</button>
      <button title="缩小（最多到整场）" :disabled="!canZoomOut" @click="zoomBy(1 / 1.5)">−</button>
      <button title="放大" :disabled="!canZoomIn" @click="zoomBy(1.5)">+</button>
    </div>
    <div ref="scroller" class="scroller" @wheel="onWheel">
      <div
        ref="lanesEl"
        class="lanes"
        :style="{ height: `${lanesHeight}px` }"
        @mousemove="onMove"
        @mouseleave="onLeave"
        @pointerdown="onPointerDown"
        @click.capture="onClickCapture"
      >
        <svg class="grid" :width="view.width" :height="lanesHeight" :style="{ left: `${LABEL_W}px` }">
          <line v-for="t in tickList" :key="t.t" :x1="t.x" :x2="t.x" y1="0" :y2="lanesHeight" class="tick" />
          <line v-for="p in phaseLines" :key="p.key" :x1="p.x" :x2="p.x" y1="0" :y2="lanesHeight" class="phase" />
        </svg>
        <div
          v-for="lane in lanes"
          :key="lane.key"
          class="lane"
          :class="[lane.kind, { pinned: lane.top !== undefined }]"
          :style="lane.top === undefined ? { height: `${lane.height}px` } : { height: `${lane.height}px`, top: `${lane.top}px` }"
        >
          <div class="label" :class="lane.kind" :title="lane.label">
            <template v-if="lane.kind === 'section'">
              <button class="fold" @click="toggleSection(lane.section)">{{ lane.collapsed ? "▶" : "▼" }} {{ lane.label }}</button>
            </template>
            <template v-else-if="lane.kind === 'caster'">
              <button class="fold" :disabled="lane.group.lines.length === 0" @click="toggleCaster(lane.group)">
                <span class="arrow">{{ lane.group.lines.length === 0 ? "" : lane.collapsed ? "▶" : "▼" }}</span>
                <JobIcon :job-id="lane.group.player.job" :size="16" />
                <span class="ell">{{ lane.label }}</span>
                <span v-if="lane.group.lines.length === 0" class="dim">（无）</span>
              </button>
            </template>
            <template v-else-if="lane.kind === 'status' || lane.kind === 'bossBuff'">
              <GameIcon class="status-icon" :icon-id="statusIconId(lane.line.status.id, 0)" :alt="lane.line.status.name" />
              <span class="ell">{{ lane.label }}</span>
            </template>
            <template v-else-if="lane.kind === 'hp'">
              <JobIcon :job-id="lane.member.player.job" :size="16" />
              <span class="ell">{{ lane.label }}</span>
            </template>
            <template v-else-if="lane.kind === 'damage'">
              <span class="stack">
                <span>{{ lane.label }}</span>
                <span class="legend dim" title="竖条高度 = 这次伤害的合计，颜色 = 平均减伤（红 0% → 绿 50%）">高 = 伤害 · 色 = 减伤</span>
              </span>
            </template>
            <span v-else class="ell">{{ lane.label }}</span>
          </div>
          <div class="plot" :style="{ width: `${view.width}px` }">
            <!-- A pinned lane covers the grid drawn behind the lanes: it draws its own. -->
            <template v-if="lane.top !== undefined">
              <i v-for="t in tickList" :key="`t${t.t}`" class="grid-tick" :style="{ left: `${t.x}px` }" />
              <i v-for="p in phaseLines" :key="`p${p.key}`" class="grid-phase" :style="{ left: `${p.x}px` }" />
            </template>
            <TlPhases v-if="lane.kind === 'phases'" :view="view" :phases="model.phases" :end="model.to" @hover="hovered = $event" @zoom="zoomToPhase" />
            <TlCasts v-else-if="lane.kind === 'casts'" :view="view" :bars="model.casts" :line-height="CAST_LINE_H" @hover="hovered = $event" />
            <TlDamage v-else-if="lane.kind === 'damage'" :view="view" :events="model.damage" :height="lane.height" :selected-row-id="selectedRowId" @hover="hovered = $event" @pick="pick" />
            <TlDamage
              v-else-if="lane.kind === 'autos'"
              :view="view"
              :events="model.autoAttacks"
              :height="lane.height"
              :bar-width="2"
              :selected-row-id="selectedRowId"
              @hover="hovered = $event"
              @pick="pick"
            />
            <TlSpans v-else-if="lane.kind === 'bossBuff'" :view="view" :spans="lane.line.spans" :job-of="jobOf" @hover="hovered = $event" />
            <TlSpans v-else-if="lane.kind === 'caster'" :view="view" :spans="lane.overview" :job-of="jobOf" :focus="focus" compact @hover="hovered = $event" />
            <TlSpans v-else-if="lane.kind === 'status'" :view="view" :spans="lane.line.spans" :unapplied="lane.line.unapplied" :job-of="jobOf" :focus="focus" @hover="hovered = $event" />
            <TlHp
              v-else-if="lane.kind === 'hp'"
              :view="view"
              :member="lane.member"
              :height="lane.height"
              :end="model.to"
              :selected-row-id="selectedRowId"
              @hover="hovered = $event"
              @pick="pick"
              @death="emit('openDeath', $event)"
            />
          </div>
        </div>
        <div v-if="pointer" class="guide" :style="{ left: `${LABEL_W + pointer.x}px` }" />
      </div>
      <div class="axis">
        <div class="label" />
        <div class="plot" :style="{ width: `${view.width}px` }">
          <span v-for="t in tickList" :key="t.t" class="tick-label num" :class="{ edge: t.x < 20 }" :style="{ left: `${t.x}px` }">{{ formatClock(t.t - origin) }}</span>
        </div>
      </div>
    </div>
    <div v-if="tip" class="tip" :style="tip.style">
      <div v-for="(l, i) in tip.lines" :key="i" :class="{ head: i === 0 }">{{ l }}</div>
    </div>
  </div>
</template>

<style scoped>
.timeline-tab {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
}
.toolbar button {
  flex: none;
  min-width: 24px;
  white-space: nowrap;
}
.hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.readout {
  flex: none;
  min-width: 140px;
  text-align: right;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.legend {
  font-size: 10px;
}
.spacer {
  flex: 1;
}
.scroller {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  border-top: 1px solid var(--line);
}
.lanes {
  position: relative;
  user-select: none;
  cursor: grab;
}
.lanes:active {
  cursor: grabbing;
}
.grid {
  position: absolute;
  top: 0;
  pointer-events: none;
}
.grid .tick {
  stroke: rgba(255, 255, 255, 0.05);
}
.grid .phase {
  stroke: rgba(108, 182, 255, 0.35);
  stroke-dasharray: 4 3;
}
.lane.pinned {
  position: sticky;
  z-index: 3;
  background: #181a1f;
}
.grid-tick,
.grid-phase {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  pointer-events: none;
}
.grid-tick {
  background: rgba(255, 255, 255, 0.05);
}
.grid-phase {
  background: repeating-linear-gradient(to bottom, rgba(108, 182, 255, 0.35) 0 4px, transparent 4px 7px);
}
.lane {
  display: flex;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.lane.section,
.lane.damage {
  border-bottom-color: var(--line);
}
.lane.caster {
  background: rgba(255, 255, 255, 0.02);
}
.label {
  flex: none;
  width: v-bind(labelWidth);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-right: 1px solid var(--line);
  background: #181a1f;
  cursor: default;
  z-index: 1;
}
.label.status,
.label.bossBuff {
  padding-left: 26px;
  color: var(--text-dim);
}
.label.section {
  font-weight: 600;
}
.status-icon {
  flex: none;
  width: 12px;
  height: 15px;
  object-fit: contain;
}
.fold {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  border: 0;
  background: none;
  padding: 0;
  color: inherit;
  font: inherit;
}
.arrow {
  width: 10px;
  font-size: 9px;
  color: var(--text-dim);
}
.plot {
  position: relative;
  flex: none;
  overflow: hidden;
}
.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 4;
  width: 1px;
  background: rgba(255, 255, 255, 0.45);
  pointer-events: none;
}
.axis {
  position: sticky;
  bottom: 0;
  display: flex;
  height: 20px;
  background: #181a1f;
  border-top: 1px solid var(--line);
  z-index: 2;
}
.axis .label {
  border-right: 1px solid var(--line);
}
.tick-label {
  position: absolute;
  top: 3px;
  transform: translateX(-50%);
  font-size: 10px;
  color: var(--text-dim);
  white-space: nowrap;
}
/* At the left edge, the label starts at its tick rather than half off screen. */
.tick-label.edge {
  transform: none;
}
.tip {
  position: absolute;
  z-index: 10;
  max-width: 340px;
  padding: 6px 8px;
  background: rgba(20, 22, 27, 0.96);
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  pointer-events: none;
  font-size: 11px;
  line-height: 16px;
}
.tip .head {
  font-weight: 600;
}
.ell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dim {
  color: var(--text-dim);
}
.num {
  font-family: var(--mono);
}
</style>
