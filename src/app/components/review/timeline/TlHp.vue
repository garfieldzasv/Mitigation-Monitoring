<script setup lang="ts">
import { computed } from "vue";
import type { MemberLane } from "@/core/replay/timeline";
import { onScreen, stepPath, xOf, type Viewport } from "../../../timelineView";
import type { TimelineHover } from "./hover";

/**
 * One player's HP over the pull (docs/DESIGN.md 8.6): HP as a stepped area with the shield stacked
 * on it, hits hanging from the top (length = share of max HP), vulnerabilities as a red strip at the
 * bottom, deaths as red lines.
 */
const props = defineProps<{ view: Viewport; member: MemberLane; height: number; end: number; selectedRowId?: number | undefined }>();
const emit = defineEmits<{ hover: [h: TimelineHover | undefined]; pick: [rowId: number]; death: [rowId: number] }>();

/** A hit is hovered and clicked anywhere in a column this wide: the 2 px tick alone is hard to hit. */
const HIT_W = 7;
const hitWidth = `${HIT_W}px`;
/** Full HP sits below the top, leaving room for the shield above it. */
const SCALE = 1.3;
const y = (share: number) => props.height - 1 - (Math.min(share, SCALE) / SCALE) * (props.height - 2);
const hpShare = (i: number) => {
  const p = props.member.hp[i]!;
  return p.hp / p.maxHp;
};

const hpArea = computed(() => stepPath(props.member.hp, hpShare, props.view, y, props.end, props.height));
const shieldArea = computed(() =>
  stepPath(props.member.hp, (i) => hpShare(i) + props.member.hp[i]!.shieldPercent / 100, props.view, y, props.end, props.height),
);
const hpLine = computed(() => stepPath(props.member.hp, hpShare, props.view, y, props.end));

const hits = computed(() =>
  props.member.hits
    .filter((r) => onScreen(props.view, r.time, r.time, HIT_W))
    .map((r) => ({
      r,
      left: xOf(props.view, r.time) - HIT_W / 2,
      h: Math.max(3, Math.min(1, r.maxHp > 0 ? r.amount / r.maxHp : 0) * (props.height - 2)),
      selected: r.id === props.selectedRowId,
    })),
);
const deaths = computed(() => props.member.deaths.filter((d) => onScreen(props.view, d.time, d.time, 2)).map((d) => ({ d, left: xOf(props.view, d.time) })));
const vulns = computed(() =>
  props.member.vulnerabilities
    .filter((s) => onScreen(props.view, s.start, s.end))
    .map((s) => ({ s, left: xOf(props.view, s.start), width: Math.max(2, xOf(props.view, s.end) - xOf(props.view, s.start)) })),
);
</script>

<template>
  <div class="hp" @mouseenter="emit('hover', { kind: 'hp', member })" @mouseleave="emit('hover', undefined)">
    <svg :width="view.width" :height="height">
      <path :d="shieldArea" class="shield" />
      <path :d="hpArea" class="hp-area" />
      <path :d="hpLine" class="hp-line" />
    </svg>
    <div
      v-for="v in vulns"
      :key="v.s.key"
      class="vuln"
      :style="{ left: `${v.left}px`, width: `${v.width}px` }"
      @mouseenter.stop="emit('hover', { kind: 'span', span: v.s })"
      @mouseleave.stop="emit('hover', { kind: 'hp', member })"
    />
    <div
      v-for="h in hits"
      :key="h.r.id"
      class="hit"
      :class="{ dot: h.r.kind === 'dot', fatal: h.r.fatal, selected: h.selected }"
      :style="{ left: `${h.left}px` }"
      @mouseenter.stop="emit('hover', { kind: 'hit', row: h.r })"
      @mouseleave.stop="emit('hover', { kind: 'hp', member })"
      @click="emit('pick', h.r.id)"
    >
      <span class="tick" :style="{ height: `${h.h}px` }" />
    </div>
    <div
      v-for="d in deaths"
      :key="d.d.id"
      class="death"
      :style="{ left: `${d.left - 1}px` }"
      @mouseenter.stop="emit('hover', { kind: 'death', row: d.d })"
      @mouseleave.stop="emit('hover', { kind: 'hp', member })"
      @click="emit('death', d.d.id)"
    />
  </div>
</template>

<style scoped>
.hp {
  position: relative;
  height: 100%;
}
svg {
  position: absolute;
  inset: 0;
  display: block;
}
.shield {
  fill: rgba(108, 182, 255, 0.45);
}
.hp-area {
  fill: #2b4a33;
}
.hp-line {
  fill: none;
  stroke: var(--ok);
  stroke-width: 1;
}
.hit {
  position: absolute;
  top: 0;
  bottom: 0;
  width: v-bind(hitWidth);
  cursor: pointer;
}
.tick {
  position: absolute;
  top: 0;
  left: 50%;
  width: 2px;
  margin-left: -1px;
  background: rgba(229, 112, 92, 0.85);
}
.hit.dot .tick {
  background: rgba(229, 112, 92, 0.4);
}
.hit.fatal .tick {
  background: #ff4a3a;
}
.hit:hover .tick,
.hit.selected .tick {
  background: #fff;
}
.death {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 3px;
  border-left: 2px solid var(--bad);
  cursor: pointer;
}
.vuln {
  position: absolute;
  bottom: 0;
  height: 3px;
  background: var(--cat-vuln);
}
</style>
