<script setup lang="ts">
import type { ArchiveMeta, ArchiveSession } from "@/core/archive/types";
import { useCtrlHeld } from "../../composables/useCtrlHeld";
import { useSettings } from "../../composables/useSettings";
import { formatClock } from "../../format";
import UiIcon from "../common/UiIcon.vue";

/**
 * The review window's left column (docs/DESIGN.md 8.1): the 复盘, newest first — each one visit to a zone, with all its
 * pulls (a 24-player duty's bosses together). The one holding the selected pull lists its pulls; pinning and deleting
 * go by 复盘.
 */
const props = defineProps<{ sessions: ArchiveSession[]; selectedId: string | undefined }>();
const emit = defineEmits<{ select: [id: string]; pin: [sessionId: string]; remove: [sessionId: string]; import: []; clear: [] }>();
const { settings } = useSettings();
/** 清空 is only clickable while Ctrl is held. */
const ctrl = useCtrlHeld();

const RESULT: Record<ArchiveMeta["result"], string> = { clear: "过本", wipe: "团灭", unknown: "" };

function when(start: number): string {
  const d = new Date(start);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function clock(start: number): string {
  const d = new Date(start);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const holdsSelected = (s: ArchiveSession) => s.pulls.some((p) => p.id === props.selectedId);
const deaths = (s: ArchiveSession) => s.pulls.reduce((n, p) => n + p.summary.deaths, 0);
const count = (s: ArchiveSession, result: ArchiveMeta["result"]) => s.pulls.filter((p) => p.end !== undefined && p.result === result).length;
/** A pull's name: its main boss; numbered within the 复盘. */
const pullName = (m: ArchiveMeta) => m.title || "战斗";
/** Imported from a log file: the files it came from. */
const importedFrom = (s: ArchiveSession) => [...new Set(s.pulls.flatMap((p) => (p.source ? [p.source.file] : [])))];

/** A 复盘 opens on its latest pull; one already showing stays on the pull it shows. */
function open(s: ArchiveSession): void {
  if (!holdsSelected(s)) emit("select", s.pulls.at(-1)!.id);
}

function confirmClear(): void {
  const pulls = props.sessions.reduce((n, s) => n + s.pulls.length, 0);
  if (props.sessions.length === 0) return;
  if (window.confirm(`删除全部 ${props.sessions.length} 份复盘（共 ${pulls} 场战斗，包括收藏的）？\n删除后不能恢复。`)) emit("clear");
}

function confirmRemove(s: ArchiveSession): void {
  const first = s.pulls[0]!;
  const recording = s.recording ? "\n其中一场正在记录，删除后不再记录它。" : "";
  if (window.confirm(`删除这份复盘（${s.pulls.length} 场战斗）？\n${when(first.start)} ${first.zoneName}${recording}`)) emit("remove", s.id);
}
</script>

<template>
  <div class="encounters">
    <div class="title">
      <span class="text" :title="`保留最近 ${settings.keepEncounters} 份，收藏（★）的不删；在设置里改。一次进本或进入一张地图的全部战斗为一份`">
        复盘 <span class="dim">· 最近 {{ settings.keepEncounters }} 份 + 收藏</span>
      </span>
      <button class="import" title="从 ACT 的网络日志（Network_*.log）里选场次导入" @click="emit('import')">导入</button>
      <span class="clear-all-wrap" :title="ctrl ? '删除全部复盘，包括收藏的' : '按住 Ctrl 才能点：删除全部复盘，包括收藏的'">
        <button class="clear-all" :disabled="!ctrl || sessions.length === 0" @click="confirmClear">清空</button>
      </span>
    </div>
    <ul>
      <li v-for="s in sessions" :key="s.id" class="session" :class="{ selected: holdsSelected(s), recording: s.recording }">
        <div class="head" @click="open(s)">
          <div class="line1">
            <span class="when">{{ when(s.pulls[0]!.start) }}</span>
            <span v-if="s.recording" class="live">● 记录中</span>
            <span v-if="importedFrom(s).length" class="tag" :title="`从日志导入：${importedFrom(s).join('、')}`">导入</span>
            <span class="spacer" />
            <button class="icon" :class="{ on: s.pinned }" :title="s.pinned ? '取消收藏' : '收藏（不会被自动清理）'" @click.stop="emit('pin', s.id)">★</button>
            <button class="icon" title="删除这份复盘" @click.stop="confirmRemove(s)">✕</button>
          </div>
          <div class="zone" :title="s.pulls[0]!.zoneName">{{ s.pulls[0]!.zoneName || "（未知区域）" }}</div>
          <div class="line3 dim">
            <span>{{ s.pulls.length }} 场</span>
            <span v-if="count(s, 'clear')" class="clear">过本 {{ count(s, "clear") }}</span>
            <span v-if="count(s, 'wipe')" class="wipe">团灭 {{ count(s, "wipe") }}</span>
            <span class="deaths"><UiIcon name="death" /> {{ deaths(s) }}</span>
          </div>
        </div>
        <ol v-if="holdsSelected(s) && s.pulls.length > 1" class="pulls">
          <li v-for="(p, i) in s.pulls" :key="p.id" :class="{ selected: p.id === selectedId }" :title="p.zoneName" @click="emit('select', p.id)">
            <span class="no num">{{ i + 1 }}</span>
            <span class="when num">{{ clock(p.start) }}</span>
            <span class="name">{{ pullName(p) }}</span>
            <span v-if="p.end === undefined" class="live">●</span>
            <span v-else class="result" :class="p.result">{{ RESULT[p.result] }}</span>
            <span class="num dim">{{ formatClock(p.summary.durationMs) }}</span>
            <span class="deaths dim"><UiIcon name="death" /> {{ p.summary.deaths }}</span>
          </li>
        </ol>
      </li>
      <li v-if="sessions.length === 0" class="empty dim">还没有存档。打一场战斗后会出现在这里。</li>
    </ul>
  </div>
</template>

<style scoped>
.encounters {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 10px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.title .text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.import,
.clear-all {
  flex: none;
  padding: 0 6px;
}
.clear-all:not(:disabled) {
  border-color: var(--bad);
  color: #ffd1c9;
}
.tag {
  font-size: 11px;
  padding: 0 4px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  color: var(--text-dim);
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.session {
  border-bottom: 1px solid var(--line);
}
.head {
  padding: 6px 10px;
  cursor: pointer;
}
.head:hover {
  background: var(--hover);
}
.session.selected > .head {
  background: rgba(108, 182, 255, 0.16);
}
.line1,
.line3 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.when,
.num {
  font-family: var(--mono);
}
.live {
  color: var(--ok);
}
.clear,
.result.clear {
  color: var(--ok);
}
.wipe,
.result.wipe {
  color: var(--bad);
}
.zone {
  margin: 2px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.icon {
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--text-dim);
  font-size: 12px;
}
.icon.on {
  color: var(--warn);
}
.pulls {
  list-style: none;
  margin: 0;
  padding: 2px 0 4px;
  background: rgba(255, 255, 255, 0.02);
}
.pulls li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 14px;
  cursor: pointer;
  white-space: nowrap;
}
.pulls li:hover {
  background: var(--hover);
}
.pulls li.selected {
  background: rgba(108, 182, 255, 0.24);
}
.no {
  width: 16px;
  text-align: right;
  color: var(--text-dim);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dim {
  color: var(--text-dim);
}
.deaths {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.empty {
  padding: 6px 10px;
  cursor: default;
}
</style>
