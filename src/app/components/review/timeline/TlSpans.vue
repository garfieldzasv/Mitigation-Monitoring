<script setup lang="ts">
import { computed } from "vue";
import { statusIconId } from "@/core/game/statuses";
import type { StatusSpan, UnappliedMark } from "@/core/replay/timeline";
import { onScreen, xOf, type Viewport } from "../../../timelineView";
import GameIcon from "../../common/GameIcon.vue";
import JobIcon from "../../common/JobIcon.vue";
import type { TimelineHover } from "./hover";

/**
 * Status spans on one line: the icon where it started (in a player's lanes, the cast), then a band
 * in the category's colour for as long as it lasts; ×N for several targets, the target's job for one
 * other player. A cast that took on nobody (a weaker shield on a stronger one) is its icon in grey, no band. Spans overlapping in time sit on lines of their own (StatusSpan.lane), LANE_H apart.
 * `compact`: thin bands only, a caster's overview. With `focus` (a hovered damage bar's time), the
 * spans not in effect then are dimmed: what covered that hit stands out.
 */
const props = defineProps<{
  view: Viewport;
  spans: readonly StatusSpan[];
  unapplied?: readonly UnappliedMark[];
  compact?: boolean;
  focus?: number | undefined;
  jobOf: (id: string) => number | undefined;
}>();
const emit = defineEmits<{ hover: [h: TimelineHover | undefined] }>();

const ICON_W = 15;
/** Narrower than this, a band has no room for ×N next to its icon. */
const ROOM_FOR_NOTE = 34;
/** Height of one line of spans; a lane of n lines is 2 + n × LANE_H tall (laneHeight). */
const LANE_H = 20;

const shown = computed(() =>
  props.spans
    .filter((s) => onScreen(props.view, s.start, s.end, ICON_W))
    .map((s) => {
      const left = xOf(props.view, s.start);
      const width = Math.max(2, xOf(props.view, s.end) - left);
      const other = s.targets.length === 1 && s.targets[0]!.id !== s.caster.id ? props.jobOf(s.targets[0]!.id) : undefined;
      return {
        s,
        left,
        width,
        dim: props.focus !== undefined && !(s.start <= props.focus && s.end > props.focus),
        note: width < ROOM_FOR_NOTE ? undefined : s.targets.length > 1 ? `×${s.targets.length}` : undefined,
        targetJob: width < ROOM_FOR_NOTE ? undefined : other,
        top: 2 + s.lane * LANE_H,
      };
    }),
);
const marks = computed(() => (props.unapplied ?? []).filter((m) => onScreen(props.view, m.time, m.time, ICON_W)).map((m) => ({ m, left: xOf(props.view, m.time) })));
</script>

<template>
  <div class="spans" :class="{ compact }">
    <div
      v-for="i in shown"
      :key="i.s.key"
      class="span"
      :class="[i.s.category, { dim: i.dim }]"
      :style="compact ? { left: `${i.left}px`, width: `${i.width}px` } : { left: `${i.left}px`, width: `${i.width}px`, top: `${i.top}px` }"
      @mouseenter="emit('hover', { kind: 'span', span: i.s })"
      @mouseleave="emit('hover', undefined)"
    >
      <template v-if="!compact">
        <GameIcon class="icon" :icon-id="statusIconId(i.s.status.id, i.s.stacks)" :alt="i.s.status.name" />
        <span v-if="i.note" class="note">{{ i.note }}</span>
        <JobIcon v-else-if="i.targetJob" class="target" :job-id="i.targetJob" :size="12" />
      </template>
    </div>
    <div
      v-for="u in marks"
      :key="u.m.key"
      class="unapplied"
      :class="[u.m.category, { dim: focus !== undefined }]"
      :style="{ left: `${u.left}px` }"
      @mouseenter="emit('hover', { kind: 'unapplied', mark: u.m })"
      @mouseleave="emit('hover', undefined)"
    >
      <GameIcon v-if="!compact" class="icon" :icon-id="statusIconId(u.m.status.id, 0)" :alt="u.m.status.name" />
    </div>
  </div>
</template>

<style scoped>
.spans {
  position: relative;
  height: 100%;
}
.span {
  --c: var(--text-dim);
  position: absolute;
  top: 2px;
  height: 18px;
  display: flex;
  align-items: center;
  gap: 2px;
  border-left: 2px solid var(--c);
  background: color-mix(in srgb, var(--c) 22%, transparent);
}
.compact .span {
  top: auto;
  bottom: 3px;
  height: 5px;
  border-left: 0;
  background: color-mix(in srgb, var(--c) 60%, transparent);
}
.span.dim,
.unapplied.dim {
  opacity: 0.25;
}
.mitigation {
  --c: var(--cat-mitigation);
}
.shield {
  --c: var(--cat-shield);
}
.damageDown {
  --c: var(--cat-source);
}
.invuln {
  --c: var(--cat-invuln);
}
.vulnerability,
.damageUp {
  --c: var(--cat-vuln);
}
.icon {
  flex: none;
  width: 14px;
  height: 17px;
  object-fit: contain;
}
.note {
  font-size: 10px;
  color: var(--text-dim);
  white-space: nowrap;
}
.target {
  flex: none;
}
/* Took on nobody: the icon in grey, no band. */
.unapplied {
  --c: var(--text-dim);
  position: absolute;
  top: 2px;
  height: 18px;
  display: flex;
  align-items: center;
  border-left: 2px dashed var(--c);
}
.unapplied .icon {
  filter: grayscale(1);
  opacity: 0.55;
}
.compact .unapplied {
  display: none;
}
</style>
