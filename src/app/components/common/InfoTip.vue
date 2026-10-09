<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";
import UiIcon from "./UiIcon.vue";

/**
 * An info icon whose tooltip is the slot: opens on hover or focus and stays while the pointer is over it (long enough
 * to scroll); fixed-positioned and clamped to the window, which is small: below the icon, or above it when it does not fit
 * below and there is more room above. `align`: the panel's edge that lines up with the icon's. Used by the review window's 计算说明 and the detail panel's legends.
 */
// Two roots (the icon and the teleported panel): the caller's class goes on the icon.
defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{ label: string; width?: number; size?: number; align?: "left" | "right"; panelClass?: string }>(), {
  width: 480,
  size: 14,
  align: "right",
  panelClass: "",
});

const open = ref(false);
const icon = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const style = ref<Record<string, string>>({});
let hideTimer: number | undefined;

async function show(): Promise<void> {
  window.clearTimeout(hideTimer);
  if (open.value) return;
  open.value = true;
  await nextTick();
  const r = icon.value?.getBoundingClientRect();
  if (!r) return;
  const width = Math.min(props.width, window.innerWidth - 8);
  const edge = props.align === "right" ? r.right - width : r.left;
  const left = Math.max(4, Math.min(edge, window.innerWidth - width - 4));
  // Laid out at its width first, unseen, to know its height.
  style.value = { left: `${left}px`, top: "0px", width: `${width}px`, visibility: "hidden" };
  await nextTick();
  const height = panel.value?.offsetHeight ?? 0;
  const below = window.innerHeight - r.bottom - 10;
  const above = r.top - 10;
  const up = height > below && above > below;
  const room = Math.max(120, up ? above : below);
  const top = up ? Math.max(4, r.top - 4 - Math.min(height, room)) : r.bottom + 4;
  style.value = { left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: `${room}px` };
}
/** A moment's grace: the pointer crosses the gap between the icon and the panel. */
function hideSoon(): void {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => (open.value = false), 200);
}
onBeforeUnmount(() => window.clearTimeout(hideTimer));
</script>

<template>
  <span
    ref="icon"
    v-bind="$attrs"
    class="info-tip"
    :class="{ open }"
    tabindex="0"
    :aria-label="label"
    @mouseenter="show"
    @mouseleave="hideSoon"
    @focus="show"
    @blur="hideSoon"
    @keydown.esc="open = false"
    ><UiIcon name="info" :size="size"
  /></span>
  <Teleport to="body">
    <div v-if="open" ref="panel" class="info-tip-panel" :class="panelClass" :style="style" role="tooltip" @mouseenter="show" @mouseleave="hideSoon">
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.info-tip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  cursor: help;
  user-select: none;
}
.info-tip:hover,
.info-tip:focus-visible,
.info-tip.open {
  color: var(--accent);
  outline: none;
}
.info-tip-panel {
  position: fixed;
  z-index: 100;
  overflow: auto;
  padding: 8px 12px 10px;
  background: var(--panel-solid);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
  color: var(--text);
  font-size: 12px;
  font-weight: normal;
  line-height: 1.55;
}
</style>
