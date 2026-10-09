<script setup lang="ts">
import { computed } from "vue";
import type { DamageEvent } from "@/core/replay/timeline";
import { reductionColor } from "../../../format";
import { onScreen, xOf, type Viewport } from "../../../timelineView";
import type { TimelineHover } from "./hover";
import UiIcon from "../../common/UiIcon.vue";

/**
 * Party damage: one bar per cast that hit, its colour the mean mitigation (red 0 % → green 50 %), its
 * height the total against the hardest-hitting cast of the pull (so heights hold while panning) on a
 * square-root scale: one raidwide 30 times a tank buster would otherwise flatten every other bar.
 */
const props = withDefaults(defineProps<{ view: Viewport; events: readonly DamageEvent[]; height: number; barWidth?: number; selectedRowId?: number | undefined }>(), {
  barWidth: 4,
  selectedRowId: undefined,
});
const emit = defineEmits<{ hover: [h: TimelineHover | undefined]; pick: [rowId: number] }>();

/** Room above the tallest bar for the death mark. */
const TOP = 10;
/** A bar is hovered and clicked anywhere in a column this wide, the lane's height: a 2 px bar is hard to hit. */
const HIT_W = 9;
const hitWidth = `${HIT_W}px`;

const biggest = computed(() => props.events.reduce((m, e) => Math.max(m, e.total), 1));
const shown = computed(() =>
  props.events
    .filter((e) => onScreen(props.view, e.time, e.time, HIT_W))
    .map((e) => ({
      e,
      left: xOf(props.view, e.time) - HIT_W / 2,
      h: Math.max(2, Math.sqrt(e.total / biggest.value) * (props.height - TOP - 2)),
      color: reductionColor(e.avgMitigation),
      selected: props.selectedRowId !== undefined && e.rows.some((r) => r.id === props.selectedRowId),
    })),
);
</script>

<template>
  <div class="damage">
    <div
      v-for="b in shown"
      :key="b.e.key"
      class="hit"
      :class="{ selected: b.selected }"
      :style="{ left: `${b.left}px` }"
      @mouseenter="emit('hover', { kind: 'damage', event: b.e })"
      @mouseleave="emit('hover', undefined)"
      @click="emit('pick', b.e.biggest.id)"
    >
      <span class="bar" :style="{ width: `${barWidth}px`, height: `${b.h}px`, background: b.color }">
        <UiIcon v-if="b.e.deaths > 0" name="death" class="death" :size="10" />
      </span>
    </div>
  </div>
</template>

<style scoped>
.damage {
  position: relative;
  height: 100%;
}
.hit {
  position: absolute;
  top: 0;
  bottom: 0;
  width: v-bind(hitWidth);
  cursor: pointer;
}
.bar {
  position: absolute;
  bottom: 1px;
  left: 50%;
  transform: translateX(-50%);
}
.hit:hover .bar,
.hit.selected .bar {
  outline: 1px solid #fff;
}
.death {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  color: var(--bad);
  font-size: 9px;
  line-height: 10px;
}
</style>
