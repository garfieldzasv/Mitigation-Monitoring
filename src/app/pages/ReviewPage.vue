<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter, type LocationQuery } from "vue-router";
import { derivePhases, phaseAt, type Phase } from "@/core/engine/phases";
import { inEffectOrder, type Row } from "@/core/engine/types";
import { filterOptions, matchesRow, type RowFilter, type RowPhase } from "@/core/filter/rowFilter";
import { buildPartySkills } from "@/core/replay/partySkills";
import { buildTimeline, playerSpans, timelinePlayers } from "@/core/replay/timeline";
import PopoverMenu from "../components/common/PopoverMenu.vue";
import MoreFilters from "../components/monitor/MoreFilters.vue";
import AoeCompare from "../components/review/AoeCompare.vue";
import CalcNotes from "../components/review/CalcNotes.vue";
import DamageTable from "../components/review/DamageTable.vue";
import DeathReplay from "../components/review/DeathReplay.vue";
import DetailPanel from "../components/review/DetailPanel.vue";
import EncounterList from "../components/review/EncounterList.vue";
import LogImport from "../components/review/LogImport.vue";
import StatsView from "../components/review/StatsView.vue";
import TimelineView from "../components/review/timeline/TimelineView.vue";
import UiIcon from "../components/common/UiIcon.vue";
import { useReviewFilter } from "../composables/useMonitorFilter";
import { useReviewArchive } from "../composables/useReviewArchive";
import { formatClock, phaseSpan } from "../format";
import { trackReviewWindowPlacement, type ReviewTab } from "../reviewWindow";
import { openSettingsWindow } from "../settingsWindow";

/**
 * The review window (docs/DESIGN.md 8): the 复盘 on the left (each zone visit's pulls together), the selected pull
 * rebuilt from its raw lines on the right, in tabs.
 *
 * Where it is lives in the URL, `#/review?enc=<archive id>&tab=<tab>&row=<row id>` (`row`: the
 * selected row of the damage table, or the death being replayed). The monitor opens this window by
 * name, so once it is open, a [回放] only changes the URL; the page follows the route rather than
 * reading it once. Moves made inside the window write the URL too, so it never goes stale and the
 * next [回放] always lands.
 */
const archive = useReviewArchive();
const { list, sessions, selectedId, loaded, loading, error } = archive;
const filterState = useReviewFilter();
const { filter, count } = filterState;
const route = useRoute();
const router = useRouter();

const tab = ref<ReviewTab>("damage");
/** The log import dialog (docs/DESIGN.md 9.5). */
const importing = ref(false);
/** The row in the detail panel (any tab). */
const selectedRowId = ref<number>();
const scrollToId = ref<number>();
const deathId = ref<number>();

const TABS: { key: ReviewTab; label: string }[] = [
  { key: "damage", label: "受伤明细" },
  { key: "deaths", label: "死亡回放" },
  { key: "aoe", label: "AOE 对比" },
  { key: "stats", label: "统计" },
  { key: "timeline", label: "时间轴" },
];
const TAB_KEYS: readonly string[] = TABS.map((t) => t.key);
/** Tabs whose URL `row` is the selected row (the deaths tab's is the death replayed). */
const rowInUrl = (t: ReviewTab) => t === "damage" || t === "timeline";

interface ReviewLocation {
  enc?: string;
  tab: ReviewTab;
  row?: number;
}

function readLocation(q: LocationQuery): ReviewLocation {
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const row = Number(text(q.row));
  const wanted = text(q.tab);
  return {
    ...(text(q.enc) ? { enc: text(q.enc) } : {}),
    tab: wanted && TAB_KEYS.includes(wanted) ? (wanted as ReviewTab) : "damage",
    ...(Number.isInteger(row) && row > 0 ? { row } : {}),
  };
}

/** Moves within the window: a new URL, which `follow` then applies. */
function go(change: Partial<ReviewLocation>): void {
  const next = { ...readLocation(route.query), ...change };
  const query: Record<string, string> = { tab: next.tab };
  if (next.enc) query.enc = next.enc;
  if (next.row !== undefined) query.row = String(next.row);
  void router.replace({ path: "/review", query });
}

const NOT_ARCHIVED = "这一场没有存档：设置里这个区域不存档、在复盘窗口里删除了，或超出保留数量被清理";

async function follow(q: LocationQuery): Promise<void> {
  const at = readLocation(q);
  if (tab.value !== at.tab) selectedRowId.value = undefined;
  tab.value = at.tab;
  if (at.tab === "deaths") {
    if (deathId.value !== at.row) selectedRowId.value = undefined;
    deathId.value = at.row;
  } else if (rowInUrl(at.tab)) {
    selectedRowId.value = at.row;
    scrollToId.value = at.row;
  }
  if (!at.enc) {
    await archive.refresh();
    const newest = list.value[0];
    if (newest) go({ enc: newest.id });
    return;
  }
  if (at.enc === selectedId.value) return;
  if (!list.value.some((m) => m.id === at.enc)) await archive.refresh(); // recorded after this window opened
  if (list.value.some((m) => m.id === at.enc)) await archive.select(at.enc);
  else archive.clear(NOT_ARCHIVED);
}

watch(() => route.query, (q) => void follow(q), { immediate: true });
onMounted(() => trackReviewWindowPlacement());

function selectEncounter(id: string): void {
  selectedRowId.value = undefined;
  deathId.value = undefined;
  go({ enc: id, row: undefined });
}

/** 清空 (Ctrl held, confirmed): every 复盘 goes, pinned ones too. */
async function clearAll(): Promise<void> {
  await archive.removeAll();
  go({ enc: undefined, row: undefined });
}

/** Pulls imported from a log: the list shows them; the first one opens. */
async function imported(ids: string[]): Promise<void> {
  importing.value = false;
  await archive.refresh();
  if (ids[0]) selectEncounter(ids[0]);
}

/** The detail panel's row; in the damage table and the timeline it is also the URL's row (and brought into view). */
function selectRow(id: number): void {
  if (rowInUrl(tab.value)) go({ row: id });
  else selectedRowId.value = id;
}

function closeDetail(): void {
  if (rowInUrl(tab.value)) go({ row: undefined });
  else selectedRowId.value = undefined;
}

function switchTab(key: ReviewTab): void {
  if (key !== tab.value) go({ tab: key, row: undefined });
}

/** A death's detail panel, or the death list → that death's replay. */
function openDeath(id: number): void {
  go({ tab: "deaths", row: id });
}

/** Statistics → the damage table showing only one player or ability. */
function showInTable(patch: Partial<RowFilter>): void {
  filterState.clear();
  filterState.update(patch);
  go({ tab: "damage", row: undefined });
}

const rows = computed(() => loaded.value?.rows ?? []);
/** Phases of the loaded encounter (docs/DESIGN.md 5.9); one still recorded ends at its last stored line. */
const phases = computed<Phase[]>(() => (loaded.value ? derivePhases(loaded.value.encounter, phaseEnd.value) : []));
/** A row's phase; undefined for an encounter with a single phase (nothing to tell apart). */
const phaseOf = (row: Row): RowPhase | undefined => {
  const p = phases.value.length > 1 ? phaseAt(phases.value, row.time) : undefined;
  return p && { label: p.label, inPlay: p.kind === "fight" };
};
/** A row's phase label, for display. */
const phaseLabelOf = (row: Row): string | undefined => phaseOf(row)?.label;
// Hits locked in together on one player, in the order they took effect (docs/DESIGN.md 5.6).
const shown = computed(() => inEffectOrder(rows.value.filter((r) => matchesRow(r, filter.value, phaseOf(r)))));
const options = computed(() => filterOptions(rows.value, phaseOf));
/** The stretches 在场: the phase filter offers these only, not the 离场 windows. */
const inPlay = computed(() => phases.value.filter((p) => p.kind === "fight"));
// Phase labels are one pull's times: a filter on them does not carry over to another encounter.
watch(
  () => loaded.value?.meta.id,
  (id, was) => {
    if (id !== was && filter.value.hiddenPhases.length > 0) filterState.update({ hiddenPhases: [] });
  },
);

/** Where the last phase ends: the encounter's end, or for one still recorded its last stored line. */
const phaseEnd = computed(() => {
  const l = loaded.value;
  return l ? (l.encounter.end ?? l.meta.lastLineTime ?? l.rows.at(-1)?.time ?? l.meta.start) : 0;
});
/** The stretch 在场 the damage table is narrowed to, if the filter hides every other one. */
const onlyPhase = computed(() => {
  const labels = inPlay.value.map((p) => p.label);
  const visible = labels.filter((x) => !filter.value.hiddenPhases.includes(x));
  return visible.length === 1 && labels.length > 1 ? visible[0] : undefined;
});

/** A phase chip: the damage table showing only that stretch 在场 (again: all of them). */
function showPhase(label: string): void {
  filterState.update({ hiddenPhases: onlyPhase.value === label ? [] : inPlay.value.map((p) => p.label).filter((x) => x !== label) });
  if (tab.value !== "damage") go({ tab: "damage", row: undefined });
}
/** The timeline's lanes; computed only while the timeline tab shows them. */
const timeline = computed(() => {
  const l = loaded.value;
  if (!l) return undefined;
  const players = timelinePlayers(l.rows, l.meta.party);
  return buildTimeline({ start: l.encounter.start, end: phaseEnd.value, rows: l.rows, detail: l.detail, phases: phases.value, players });
});
/** The party's mitigation skills over the pull, for the detail panel (docs/DESIGN.md 8.2); computed once a row is opened. */
const partySkills = computed(() => {
  const l = loaded.value;
  if (!l) return undefined;
  const players = timelinePlayers(l.rows, l.meta.party);
  // Everyone in a duty is synced alike: a player missing from the party list takes the party's level.
  const partyLevel = Math.max(0, ...l.meta.party.map((m) => m.level || 0));
  return buildPartySkills({
    players: players.map((p) => ({ ...p, level: l.meta.party.find((m) => m.id === p.id)?.level || partyLevel })),
    detail: l.detail,
    spans: playerSpans(l.detail, new Set(players.map((p) => p.id)), phaseEnd.value),
  });
});
const selectedRow = computed(() => (selectedRowId.value === undefined ? undefined : loaded.value?.byId.get(selectedRowId.value)));
watch(loaded, (l) => (document.title = l ? `复盘 · ${l.meta.zoneName}` : "复盘"), { immediate: true });

const header = computed(() => {
  const l = loaded.value;
  if (!l) return undefined;
  const d = new Date(l.meta.start);
  const pad = (n: number) => String(n).padStart(2, "0");
  const result = l.meta.end === undefined ? "记录中" : l.meta.result === "clear" ? "过本" : l.meta.result === "wipe" ? "团灭" : "";
  const boss = l.encounter.boss;
  // Which of its 复盘's pulls this is.
  const pulls = sessions.value.find((x) => x.pulls.some((p) => p.id === l.meta.id))?.pulls ?? [];
  const index = pulls.findIndex((p) => p.id === l.meta.id);
  return {
    zone: l.meta.zoneName,
    pull: boss?.name ?? l.meta.title ?? "",
    position: pulls.length > 1 && index >= 0 ? `第 ${index + 1} / ${pulls.length} 场` : "",
    when: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    duration: formatClock(phaseEnd.value - l.meta.start),
    result,
    // How far a pull that did not clear got: the boss's HP as last seen.
    bossLeft: boss && l.meta.result !== "clear" && boss.hpPercent > 0 ? `${boss.name} 剩余 ${boss.hpPercent.toFixed(1)}%` : "",
    deaths: l.rows.filter((r) => r.kind === "death").length,
  };
});
</script>

<template>
  <div class="review">
    <aside class="side">
      <EncounterList :sessions="sessions" :selected-id="selectedId" @select="selectEncounter" @pin="archive.togglePin" @remove="archive.remove" @import="importing = true" @clear="clearAll" />
    </aside>
    <main>
      <div class="top">
        <div v-if="header" class="title">
          <span class="zone">{{ header.zone }}</span>
          <span v-if="header.pull" class="pull">{{ header.pull }}</span>
          <span v-if="header.position" class="dim">{{ header.position }}</span>
          <span class="dim">{{ header.when }}</span>
          <span class="num">{{ header.duration }}</span>
          <span v-if="header.result" :class="{ live: header.result === '记录中' }">{{ header.result }}</span>
          <span v-if="header.bossLeft" class="dim">{{ header.bossLeft }}</span>
          <span class="deaths" title="死亡次数"><UiIcon name="death" /> {{ header.deaths }}</span>
        </div>
        <div v-else class="title dim">{{ loading ? "读取中…" : "选择左边的一场战斗" }}</div>
        <div v-if="loaded && inPlay.length > 1" class="phases">
          <button
            v-for="p in inPlay"
            :key="p.label"
            class="phase-chip num"
            :class="{ on: onlyPhase === p.label }"
            :title="`${phaseSpan(p, loaded.meta.start, phaseEnd)}\n点击：受伤明细只看这一段在场的时间，再点一次恢复`"
            @click="showPhase(p.label)"
          >
            {{ p.label }}
          </button>
        </div>
        <div class="top-actions">
          <CalcNotes />
          <button class="gear" title="设置" aria-label="设置" @click="openSettingsWindow()"><UiIcon name="gear" :size="13" /></button>
        </div>
        <div class="tabs">
          <button
            v-for="t in TABS"
            :key="t.key"
            class="tab"
            :data-tab="t.key"
            :class="{ on: t.key === tab }"
            @click="switchTab(t.key)"
          >
            {{ t.label }}
          </button>
          <span class="spacer" />
          <template v-if="tab === 'damage'">
            <span v-if="loaded" class="dim num">{{ shown.length }}/{{ rows.length }}</span>
            <PopoverMenu :active="count > 0" :width="260" title="类型、判定、快捷开关、最小伤害">
              <template #trigger>筛选{{ count > 0 ? ` ${count}` : "" }} ▾</template>
              <MoreFilters :state="filterState" />
            </PopoverMenu>
          </template>
        </div>
        <div v-if="error" class="error">{{ error }}</div>
      </div>
      <div class="content">
        <DamageTable
          v-if="tab === 'damage'"
          :rows="shown"
          :by-id="loaded?.byId ?? new Map()"
          :options="options"
          :selected-id="selectedRowId"
          :scroll-to="scrollToId"
          :self-id="loaded?.selfId"
          :phase-of="phaseLabelOf"
          @select="selectRow"
        />
        <!-- One instance per encounter: their own state (filters, selection) survives the live reloads of a recording. -->
        <template v-else-if="loaded">
          <DeathReplay
            v-if="tab === 'deaths'"
            :key="loaded.meta.id"
            :death-id="deathId"
            :rows="loaded.rows"
            :detail="loaded.detail"
            :selected-row-id="selectedRowId"
            :phase-of="phaseLabelOf"
            @update:death-id="openDeath"
            @select="selectRow"
          />
          <AoeCompare v-else-if="tab === 'aoe'" :key="loaded.meta.id" :rows="loaded.rows" :selected-row-id="selectedRowId" :phase-of="phaseLabelOf" @select="selectRow" />
          <StatsView v-else-if="tab === 'stats'" :key="loaded.meta.id" :rows="loaded.rows" :phase-of="phaseOf" @show="showInTable" />
          <TimelineView
            v-else-if="tab === 'timeline' && timeline"
            :key="loaded.meta.id"
            :model="timeline"
            :origin="loaded.encounter.start"
            :selected-row-id="selectedRowId"
            :scroll-to="scrollToId"
            @select="selectRow"
            @open-death="openDeath"
          />
        </template>
        <DetailPanel
          v-if="selectedRow && loaded"
          :row="selectedRow"
          :rows="loaded.rows"
          :by-id="loaded.byId"
          :party-skills="partySkills"
          @select="selectRow"
          @close="closeDetail"
          @open-death="openDeath"
        />
      </div>
    </main>
    <LogImport v-if="importing" :archived="list" @close="importing = false" @imported="imported" />
  </div>
</template>

<style scoped>
.review {
  display: flex;
  height: 100%;
  background: #181a1f;
  font-size: 12px;
}
.side {
  width: 260px;
  flex: none;
  border-right: 1px solid var(--line);
  min-height: 0;
}
main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.top {
  position: relative;
  flex: none;
  border-bottom: 1px solid var(--line);
  padding: 8px 10px 0;
}
.top-actions {
  position: absolute;
  top: 6px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.gear {
  display: inline-flex;
  align-items: center;
  padding: 2px 5px;
}
.deaths {
  white-space: nowrap;
}
.title {
  display: flex;
  gap: 12px;
  align-items: baseline;
  margin-bottom: 6px;
}
.zone {
  font-size: 15px;
  font-weight: 600;
}
.pull {
  font-size: 13px;
}
.live {
  color: var(--ok);
}
.phases {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.phase-chip {
  padding: 0 6px;
  font-size: 11px;
  line-height: 18px;
  border-color: rgba(108, 182, 255, 0.4);
  background: rgba(108, 182, 255, 0.1);
}
.phase-chip.on {
  border-color: var(--accent);
  background: rgba(108, 182, 255, 0.3);
  color: var(--text);
}
.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-bottom: 6px;
}
.tab {
  border: 0;
  background: none;
  padding: 3px 10px;
  border-radius: 3px;
}
.tab.on {
  background: rgba(108, 182, 255, 0.2);
  color: var(--text);
}
.tab:not(.on):not(:disabled) {
  color: var(--text-dim);
}
.spacer {
  flex: 1;
}
.content {
  flex: 1;
  min-height: 0;
  display: flex;
}
.error {
  color: var(--bad);
  padding-bottom: 6px;
}
.dim {
  color: var(--text-dim);
}
.num {
  font-family: var(--mono);
}
</style>
