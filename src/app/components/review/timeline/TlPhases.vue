<script setup lang="ts">
import { computed } from "vue";
import type { Phase } from "@/core/engine/phases";
import { onScreen, xOf, type Viewport } from "../../../timelineView";
import type { TimelineHover } from "./hover";

/** The phase band: blocks 在场 and 离场, each named by its time; a click zooms to it. */
const props = defineProps<{ view: Viewport; phases: readonly Phase[]; end: number }>();
const emit = defineEmits<{ hover: [h: TimelineHover | undefined]; zoom: [phase: Phase] }>();

const blocks = computed(() =>
  props.phases
    .filter((p) => onScreen(props.view, p.start, p.end ?? props.end))
    .map((p) => {
      const left = xOf(props.view, p.start);
      return { p, left, width: Math.max(1, xOf(props.view, p.end ?? props.end) - left) };
    }),
);
</script>

<template>
  <div class="phases">
    <div
      v-for="b in blocks"
      :key="b.p.label"
      class="block"
      :class="b.p.kind"
      :style="{ left: `${b.left}px`, width: `${b.width}px` }"
      @mouseenter="emit('hover', { kind: 'phase', phase: b.p })"
      @mouseleave="emit('hover', undefined)"
      @click="emit('zoom', b.p)"
    >
      <!-- A phase that began off screen keeps its label in view. -->
      <span class="label" :style="{ paddingLeft: `${Math.max(4, 4 - b.left)}px` }">{{ b.p.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.phases {
  position: relative;
  height: 100%;
}
.block {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border: 1px solid rgba(108, 182, 255, 0.4);
  background: rgba(108, 182, 255, 0.12);
  border-radius: 2px;
  overflow: hidden;
  cursor: pointer;
}
.block.intermission {
  border-color: var(--line-strong);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-dim);
}
.label {
  display: block;
  padding-right: 4px;
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;
}
</style>
