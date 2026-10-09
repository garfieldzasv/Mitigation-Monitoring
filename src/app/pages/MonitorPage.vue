<script setup lang="ts">
import { computed } from "vue";
import { derivePhases } from "@/core/engine/phases";
import { filterOptions, matchesRow } from "@/core/filter/rowFilter";
import PopoverMenu from "../components/common/PopoverMenu.vue";
import MonitorGrid from "../components/monitor/MonitorGrid.vue";
import MoreFilters from "../components/monitor/MoreFilters.vue";
import UiIcon from "../components/common/UiIcon.vue";
import { useLiveEngine } from "../composables/useLiveEngine";
import { useMonitorFilter } from "../composables/useMonitorFilter";
import { useNow } from "../composables/useNow";
import { useOverlayConnection } from "../composables/useOverlayConnection";
import { useSettings } from "../composables/useSettings";
import { formatClock, phaseSummary } from "../format";
import { archiveIdOf, openReviewWindow } from "../reviewWindow";
import { openSettingsWindow } from "../settingsWindow";

/** The live monitor (docs/DESIGN.md 7): toolbar + grid, filling the overlay. Right-click opens the settings. */
const { settings } = useSettings();
const { engine, version, isArchived } = useLiveEngine();
const filterState = useMonitorFilter();
const { filter, count } = filterState;

/** Opens the review window on the shown encounter; a death's [回放] opens that death's replay. */
function openReview(deathRowId?: number): void {
  const e = encounter.value;
  openReviewWindow(e ? { encounter: archiveIdOf(e.start), ...(deathRowId ? { tab: "deaths", row: deathRowId } : {}) } : {});
}
const connection = useOverlayConnection();

const encounter = computed(() => {
  void version.value;
  return engine.current ?? engine.latest;
});
const running = computed(() => {
  void version.value;
  return encounter.value !== undefined && engine.current === encounter.value;
});

/** Rows of players in scope (5.2); the filter then applies on top. */
const scoped = computed(() => {
  void version.value;
  const e = encounter.value;
  if (!e) return [];
  const visible = engine.visibility(e);
  return e.rows.filter((r) => visible(r.target.id, r.target.name));
});
const shown = computed(() => scoped.value.filter((r) => matchesRow(r, filter.value)));
const options = computed(() => filterOptions(scoped.value));
const deaths = computed(() => scoped.value.filter((r) => r.kind === "death").length);

const now = useNow(running);
const duration = computed(() => {
  const e = encounter.value;
  if (!e) return "";
  return formatClock((e.end ?? (running.value ? now.value : e.start)) - e.start);
});
/** Phases so far (docs/DESIGN.md 5.9); follows the clock while running (a window still open grows). */
const phases = computed(() => {
  void version.value;
  const e = encounter.value;
  return e ? derivePhases(e, e.end ?? (running.value ? now.value : e.start)) : [];
});
/** A 离场 window going on now (the toolbar says so); the stretches 在场 are not numbered (docs/DESIGN.md 5.9). */
const currentWindow = computed(() => (phases.value.at(-1)?.kind === "intermission" ? phases.value.at(-1) : undefined));
const selfId = computed(() => {
  void version.value;
  return engine.party.selfId;
});
/** This encounter is not archived (as the writer decided when it started). */
const notSaved = computed(() => {
  void version.value;
  return encounter.value !== undefined && !isArchived(encounter.value);
});
const look = computed(() => ({ "--panel-alpha": String(settings.value.opacity), fontSize: `${settings.value.fontSize}px` }));
</script>

<template>
  <div class="monitor" :style="look" @contextmenu.prevent="openSettingsWindow()">
    <div class="bar">
      <span v-if="connection === 'connecting'" class="dim">正在连接 ACT…</span>
      <span v-else-if="connection === 'disconnected'" class="warn" title="5 秒内没有连上 OverlayPlugin，仍在重试">未连接 ACT</span>
      <template v-if="encounter">
        <span class="zone" :class="{ live: running }" :title="encounter.zoneName">{{ running ? "●" : "○" }} {{ encounter.zoneName }}</span>
        <span class="num">{{ duration }}</span>
        <span v-if="currentWindow" class="phase-tag" :title="phaseSummary(currentWindow, encounter.start)">离场</span>
        <span class="deaths" title="死亡次数"><UiIcon name="death" /> {{ deaths }}</span>
        <span v-if="notSaved" class="tag" title="这一场没有存档，只在监控窗口里显示（设置里这个区域不存档、解除限制进入的副本不自动存档，或在复盘窗口里删除了）">不存档</span>
      </template>
      <span v-else-if="connection === 'connected'" class="dim">等待战斗…</span>
      <span class="spacer" />
      <span v-if="encounter" class="dim count">{{ shown.length }}/{{ scoped.length }}</span>
      <PopoverMenu :active="count > 0" :width="260" title="类型、判定、快捷开关、最小伤害">
        <template #trigger>筛选{{ count > 0 ? ` ${count}` : "" }} ▾</template>
        <MoreFilters :state="filterState" />
      </PopoverMenu>
      <button class="review" title="打开复盘窗口" @click="openReview()">复盘</button>
      <button class="gear" title="设置（也可以在窗口里点右键）" aria-label="设置" @click="openSettingsWindow()"><UiIcon name="gear" /></button>
    </div>
    <MonitorGrid
      :rows="shown"
      :phases="phases"
      :encounter-start="encounter?.start"
      :all-rows="scoped"
      :options="options"
      :encounter-key="encounter?.id"
      :self-id="selfId"
      :highlight-self="settings.highlightSelf"
      :row-height="settings.rowHeight"
      @open-review="openReview"
    />
  </div>
</template>

<style scoped>
.monitor {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* --panel-alpha and the font size come from the settings (look) */
  background: rgba(var(--panel-rgb), var(--panel-alpha));
  overflow: hidden;
}
.bar {
  display: flex;
  flex: none;
  gap: 10px;
  height: 24px;
  align-items: center;
  padding: 0 6px;
  border-bottom: 1px solid var(--line);
  color: var(--text-dim);
  white-space: nowrap;
}
.zone {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
.live {
  color: var(--ok);
}
.warn {
  color: var(--warn);
}
.dim {
  color: var(--text-dim);
}
.num,
.count {
  font-family: var(--mono);
}
.spacer {
  flex: 1;
}
.review,
.gear {
  padding: 0 6px;
  font-size: 11px;
  line-height: 16px;
}
.gear {
  padding: 0 4px;
}
.deaths {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.gear {
  display: inline-flex;
  align-items: center;
}
.phase-tag {
  font-size: 11px;
  padding: 0 4px;
  border-radius: 2px;
  color: var(--text-dim);
  background: rgba(255, 255, 255, 0.08);
}
.tag {
  font-size: 10px;
  padding: 0 4px;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
}
</style>
