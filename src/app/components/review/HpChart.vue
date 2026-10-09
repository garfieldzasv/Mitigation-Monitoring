<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { HpPoint } from "@/core/replay/detail";
import { percentOfMax } from "../../format";
import type { ChartMark } from "./chartMarks";

/**
 * HP and shield of one player before a death (docs/DESIGN.md 8.3): HP as a stepped area, shield
 * stacked on top, gridlines at 25 % steps of max HP. Under it a strip with hits (down, red) and heals
 * (up, green); enemy casts as triangles on top. Hover shows the values at that moment; clicking a
 * mark picks the event.
 */
const props = defineProps<{
  from: number;
  to: number;
  points: readonly HpPoint[];
  maxHp: number;
  marks: readonly ChartMark[];
  selectedKey?: string | undefined;
}>();
const emit = defineEmits<{ pick: [key: string] }>();

const CURVE_H = 132;
const STRIP_H = 40;
const AXIS_H = 16;
const PAD_L = 38;
const PAD_R = 12;
const HEIGHT = CURVE_H + STRIP_H + AXIS_H;
const BAR_W = 3;

const root = ref<HTMLElement>();
const width = ref(600);
let resize: ResizeObserver | undefined;
onMounted(() => {
  const el = root.value;
  if (!el) return;
  width.value = el.clientWidth;
  resize = new ResizeObserver(() => (width.value = el.clientWidth || width.value));
  resize.observe(el);
});
onBeforeUnmount(() => resize?.disconnect());

const span = computed(() => Math.max(1, props.to - props.from));
const x = (t: number) => PAD_L + ((Math.min(props.to, Math.max(props.from, t)) - props.from) / span.value) * (width.value - PAD_L - PAD_R);
const shieldOf = (p: HpPoint) => (p.shieldPercent * p.maxHp) / 100;
const top = computed(() => {
  let m = props.maxHp;
  for (const p of props.points) m = Math.max(m, p.hp + shieldOf(p));
  return m * 1.04 || 1;
});
const y = (v: number) => 4 + (1 - v / top.value) * (CURVE_H - 8);

/** Segment i runs from point i to point i + 1 (the last one to the death). */
const segments = computed(() =>
  props.points.map((p, i) => {
    const next = props.points[i + 1];
    return { x0: x(p.time), x1: x(next ? next.time : props.to), hp: p.hp, shield: shieldOf(p) };
  }),
);

const hpPath = computed(() => {
  const segs = segments.value;
  if (segs.length === 0) return "";
  let d = `M${segs[0]!.x0},${y(0)}`;
  for (const s of segs) d += `V${y(s.hp)}H${s.x1}`;
  return `${d}V${y(0)}Z`;
});
const hpLine = computed(() => {
  const segs = segments.value;
  if (segs.length === 0) return "";
  let d = `M${segs[0]!.x0},${y(segs[0]!.hp)}`;
  for (const s of segs) d += `V${y(s.hp)}H${s.x1}`;
  return d;
});
const shieldRects = computed(() =>
  segments.value
    .filter((s) => s.shield > 0 && s.x1 > s.x0)
    .map((s) => ({ x: s.x0, w: s.x1 - s.x0, y: y(s.hp + s.shield), h: y(s.hp) - y(s.hp + s.shield) })),
);

const grid = computed(() => [0.25, 0.5, 0.75, 1].map((f) => ({ y: y(props.maxHp * f), label: `${f * 100}%` })));

/** Ticks back from the death, every 1 / 2 / 5 / 10 s depending on the window. */
const ticks = computed(() => {
  const s = span.value / 1000;
  const step = s <= 10 ? 1 : s <= 20 ? 2 : s <= 40 ? 5 : 10;
  const out: { x: number; label: string }[] = [];
  for (let k = 0; k * step * 1000 <= span.value; k++) out.push({ x: x(props.to - k * step * 1000), label: k === 0 ? "0" : `-${k * step}s` });
  return out;
});

const mid = CURVE_H + STRIP_H / 2;
const half = STRIP_H / 2 - 2;
const bars = computed(() =>
  props.marks
    .filter((m) => m.kind === "hit" || m.kind === "heal")
    .map((m) => {
      const h = Math.max(1.5, Math.min(1, m.share) * half);
      const extra = m.kind === "heal" && m.extra ? Math.min(half - h, m.extra * half) : 0;
      return {
        m,
        x: x(m.time) - BAR_W / 2,
        y: m.kind === "hit" ? mid : mid - h,
        h,
        extraY: mid - h - extra,
        extra,
      };
    }),
);
const casts = computed(() => props.marks.filter((m) => m.kind === "cast").map((m) => ({ m, x: x(m.time) })));
const deathX = computed(() => x(props.to));

// Hover readout.
const hoverT = ref<number>();
function onMove(e: MouseEvent): void {
  const svg = e.currentTarget as SVGSVGElement;
  const px = e.clientX - svg.getBoundingClientRect().left;
  if (px < PAD_L || px > width.value - PAD_R) {
    hoverT.value = undefined;
    return;
  }
  hoverT.value = props.from + ((px - PAD_L) / (width.value - PAD_L - PAD_R)) * span.value;
}
const readout = computed(() => {
  const t = hoverT.value;
  if (t === undefined) return undefined;
  let p: HpPoint | undefined;
  for (const q of props.points) {
    if (q.time > t) break;
    p = q;
  }
  const when = `${((t - props.to) / 1000).toFixed(1)} 秒`;
  if (!p) return { x: x(t), text: when };
  const shield = shieldOf(p);
  return {
    x: x(t),
    text: `${when}　HP ${p.hp.toLocaleString()}（${percentOfMax(p.hp, props.maxHp)}）${shield > 0 ? `　盾 ≈${Math.round(shield).toLocaleString()}（${percentOfMax(shield, props.maxHp)}）` : ""}`,
  };
});
</script>

<template>
  <div ref="root" class="chart">
    <svg :width="width" :height="HEIGHT" @mousemove="onMove" @mouseleave="hoverT = undefined">
      <g class="grid">
        <template v-for="g in grid" :key="g.label">
          <line :x1="PAD_L" :x2="width - PAD_R" :y1="g.y" :y2="g.y" />
          <text :x="PAD_L - 4" :y="g.y + 3" text-anchor="end">{{ g.label }}</text>
        </template>
        <line :x1="PAD_L" :x2="width - PAD_R" :y1="y(0)" :y2="y(0)" class="base" />
      </g>
      <path :d="hpPath" class="hp-area" />
      <rect v-for="(r, i) in shieldRects" :key="`s${i}`" :x="r.x" :y="r.y" :width="r.w" :height="r.h" class="shield" />
      <path :d="hpLine" class="hp-line" />
      <line :x1="deathX" :x2="deathX" :y1="0" :y2="CURVE_H + STRIP_H" class="death" />

      <g v-for="c in casts" :key="c.m.key" class="cast" :class="{ selected: c.m.key === selectedKey }" @click="emit('pick', c.m.key)">
        <polygon :points="`${c.x - 4},1 ${c.x + 4},1 ${c.x},8`" />
        <line :x1="c.x" :x2="c.x" :y1="8" :y2="CURVE_H" />
        <title>{{ c.m.label }}</title>
      </g>

      <line :x1="PAD_L" :x2="width - PAD_R" :y1="mid" :y2="mid" class="strip-mid" />
      <g v-for="b in bars" :key="b.m.key" class="bar" :class="[b.m.kind, { selected: b.m.key === selectedKey }]" @click="emit('pick', b.m.key)">
        <rect :x="b.x" :y="b.y" :width="BAR_W" :height="b.h" />
        <rect v-if="b.extra > 0" :x="b.x" :y="b.extraY" :width="BAR_W" :height="b.extra" class="over" />
        <title>{{ b.m.label }}</title>
      </g>

      <g class="axis">
        <text v-for="t in ticks" :key="t.label" :x="t.x" :y="HEIGHT - 3" text-anchor="middle">{{ t.label }}</text>
      </g>
      <g v-if="readout" class="readout">
        <line :x1="readout.x" :x2="readout.x" :y1="0" :y2="CURVE_H + STRIP_H" />
      </g>
    </svg>
    <div class="legend">
      <span v-if="readout" class="value">{{ readout.text }}</span>
      <template v-else>
        <span><i class="sw hp" />HP</span>
        <span><i class="sw sh" />盾</span>
        <span><i class="sw hit" />受击</span>
        <span><i class="sw heal" />治疗（浅色为溢出）</span>
        <span><i class="sw cast" />敌方读条</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.chart {
  position: relative;
  width: 100%;
  user-select: none;
}
svg {
  display: block;
}
.grid line {
  stroke: rgba(255, 255, 255, 0.08);
  stroke-dasharray: 3 3;
}
.grid line.base {
  stroke: rgba(255, 255, 255, 0.2);
  stroke-dasharray: none;
}
.grid text,
.axis text {
  fill: var(--text-dim);
  font-size: 10px;
  font-family: var(--mono);
}
.hp-area {
  fill: rgba(111, 207, 127, 0.22);
}
.hp-line {
  fill: none;
  stroke: var(--ok);
  stroke-width: 1.5;
}
.shield {
  fill: rgba(108, 182, 255, 0.45);
}
.death {
  stroke: var(--bad);
  stroke-width: 1.5;
  stroke-dasharray: 4 3;
}
.strip-mid {
  stroke: rgba(255, 255, 255, 0.15);
}
.bar {
  cursor: pointer;
}
.bar.hit rect {
  fill: var(--bad);
}
.bar.heal rect {
  fill: var(--ok);
}
.bar.heal rect.over {
  fill: rgba(111, 207, 127, 0.35);
}
.bar.selected rect {
  fill: #fff;
}
.cast {
  cursor: pointer;
}
.cast polygon {
  fill: var(--cat-source);
}
.cast line {
  stroke: rgba(229, 162, 92, 0.25);
  stroke-dasharray: 2 3;
}
.cast.selected polygon {
  fill: #fff;
}
.readout line {
  stroke: rgba(255, 255, 255, 0.5);
}
.legend {
  display: flex;
  gap: 14px;
  height: 18px;
  align-items: center;
  padding-left: 38px;
  color: var(--text-dim);
  font-size: 11px;
}
.legend .value {
  color: var(--text);
  font-family: var(--mono);
}
.sw {
  display: inline-block;
  width: 10px;
  height: 8px;
  margin-right: 4px;
  vertical-align: 0;
}
.sw.hp {
  background: var(--ok);
}
.sw.sh {
  background: rgba(108, 182, 255, 0.6);
}
.sw.hit {
  background: var(--bad);
}
.sw.heal {
  background: var(--ok);
  opacity: 0.6;
}
.sw.cast {
  background: var(--cat-source);
}
</style>
