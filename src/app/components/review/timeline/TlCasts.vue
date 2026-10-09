<script setup lang="ts">
import { computed } from "vue";
import type { CastBar } from "@/core/replay/timeline";
import { onScreen, xOf, type Viewport } from "../../../timelineView";
import type { TimelineHover } from "./hover";

/** Enemy cast bars, one line per overlap level; enemy abilities have no icon data, so text bars. */
const props = defineProps<{ view: Viewport; bars: readonly CastBar[]; lineHeight: number }>();
const emit = defineEmits<{ hover: [h: TimelineHover | undefined] }>();

const shown = computed(() =>
  props.bars
    .filter((b) => onScreen(props.view, b.start, b.end))
    .map((b) => {
      const left = xOf(props.view, b.start);
      return { b, left, width: Math.max(3, xOf(props.view, b.end) - left), top: 2 + b.line * props.lineHeight };
    }),
);
</script>

<template>
  <div class="casts">
    <div
      v-for="i in shown"
      :key="i.b.key"
      class="bar"
      :class="{ cancelled: i.b.cancelled }"
      :style="{ left: `${i.left}px`, width: `${i.width}px`, top: `${i.top}px`, height: `${lineHeight - 3}px` }"
      @mouseenter="emit('hover', { kind: 'cast', bar: i.b })"
      @mouseleave="emit('hover', undefined)"
    >
      <span v-if="i.width > 24" class="text">{{ i.b.action }}{{ i.b.count > 1 ? ` ×${i.b.count}` : "" }}</span>
    </div>
  </div>
</template>

<style scoped>
.casts {
  position: relative;
  height: 100%;
}
.bar {
  position: absolute;
  border: 1px solid rgba(229, 162, 92, 0.75);
  background: rgba(229, 162, 92, 0.22);
  border-radius: 2px;
  overflow: hidden;
}
.bar.cancelled {
  border-style: dashed;
  border-color: var(--line-strong);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-dim);
}
.text {
  display: block;
  padding: 0 3px;
  font-size: 11px;
  line-height: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
