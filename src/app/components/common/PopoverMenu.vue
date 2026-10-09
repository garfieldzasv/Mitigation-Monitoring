<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";

/**
 * A button that opens a panel below it. The panel is fixed-positioned and clamped to the window:
 * an overlay is a small window, and nothing may spill outside it. Closes on an outside click or Esc.
 */
const props = defineProps<{ active?: boolean; width?: number; title?: string }>();

const open = ref(false);
const root = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const style = ref<Record<string, string>>({});

function place(): void {
  const trigger = root.value?.getBoundingClientRect();
  if (!trigger) return;
  const width = Math.min(props.width ?? 240, window.innerWidth - 8);
  const left = Math.max(4, Math.min(trigger.left, window.innerWidth - width - 4));
  const top = trigger.bottom + 2;
  style.value = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(120, window.innerHeight - top - 6)}px`,
  };
}

function onOutside(e: MouseEvent): void {
  const target = e.target as Node;
  if (!root.value?.contains(target) && !panel.value?.contains(target)) close();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") close();
}

async function show(): Promise<void> {
  open.value = true;
  await nextTick();
  place();
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKey);
}

function close(): void {
  open.value = false;
  document.removeEventListener("mousedown", onOutside, true);
  document.removeEventListener("keydown", onKey);
}

onBeforeUnmount(close);
</script>

<template>
  <span ref="root" class="popover">
    <button class="trigger" :class="{ active, open }" :title="title" @click="open ? close() : show()">
      <slot name="trigger" />
    </button>
    <Teleport to="body">
      <div v-if="open" ref="panel" class="popover-panel" :style="style">
        <slot :close="close" />
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.popover {
  display: inline-flex;
  min-width: 0;
}
.trigger {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.trigger:hover,
.trigger.open {
  color: var(--text);
}
.trigger.active {
  color: var(--accent);
}
.popover-panel {
  position: fixed;
  z-index: 100;
  overflow: auto;
  padding: 6px;
  background: var(--panel-solid);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
  color: var(--text);
}
</style>
