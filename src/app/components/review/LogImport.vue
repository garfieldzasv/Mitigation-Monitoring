<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { blobBatches } from "@/core/archive/logFile";
import { importLog, scanLog, type LogPull } from "@/core/archive/logImport";
import type { ArchiveMeta } from "@/core/archive/types";
import { archiveStore } from "../../archive";
import { formatClock } from "../../format";
import UiIcon from "../common/UiIcon.vue";

/**
 * Importing pulls from an ACT log file (docs/DESIGN.md 9.5): pick or drop a Network_*.log, the pulls it holds are
 * listed by zone visit (scanLog), the chosen ones become 复盘 (importLog). Pulls already archived cannot be chosen.
 */
const props = defineProps<{ archived: readonly ArchiveMeta[] }>();
const emit = defineEmits<{ close: []; imported: [ids: string[]] }>();

type Step = "pick" | "scan" | "list" | "import";
const step = ref<Step>("pick");
const file = shallowRef<File>();
const pulls = shallowRef<LogPull[]>([]);
const chosen = ref(new Set<string>());
const read = ref(0);
const error = ref("");
const dragging = ref(false);
const input = ref<HTMLInputElement>();
let abort: AbortController | undefined;

const RESULT: Record<LogPull["result"], string> = { clear: "过本", wipe: "团灭", unknown: "" };
const existing = computed(() => new Set(props.archived.map((m) => m.id)));
/** By zone visit (one 复盘 each), in file order. */
const groups = computed(() => {
  const out: { session: string; pulls: LogPull[] }[] = [];
  for (const p of pulls.value) {
    const last = out.at(-1);
    if (last?.session === p.session) last.pulls.push(p);
    else out.push({ session: p.session, pulls: [p] });
  }
  return out;
});
const selectable = (p: LogPull) => !existing.value.has(p.id);
const size = computed(() => file.value?.size ?? 0);
const percent = computed(() => (size.value > 0 ? Math.round((read.value / size.value) * 100) : 0));
const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

function stamp(start: number, withDate: boolean): string {
  const d = new Date(start);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time;
}

function batches(f: File) {
  return blobBatches(f, (at) => (read.value = at));
}

async function scan(f: File): Promise<void> {
  file.value = f;
  error.value = "";
  read.value = 0;
  step.value = "scan";
  abort = new AbortController();
  try {
    const found = await scanLog(batches(f), abort.signal);
    pulls.value = found;
    chosen.value = new Set();
    step.value = "list";
    if (found.length === 0) error.value = "这个文件里没有找到战斗。要选 ACT 的网络日志（Network_*.log），并且日志里要有自己或小队进入战斗";
  } catch (err) {
    step.value = "pick";
    if (!abort.signal.aborted) error.value = `读取失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

function picked(e: Event): void {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = ""; // the same file again is a new pick
  if (f) void scan(f);
}

function dropped(e: DragEvent): void {
  dragging.value = false;
  const f = e.dataTransfer?.files[0];
  if (f && step.value !== "scan" && step.value !== "import") void scan(f);
}

function toggle(p: LogPull): void {
  if (!selectable(p)) return;
  const next = new Set(chosen.value);
  if (next.has(p.id)) next.delete(p.id);
  else next.add(p.id);
  chosen.value = next;
}

/** A zone visit's box: all its importable pulls on, or (all on already) off. */
function toggleGroup(g: { pulls: LogPull[] }): void {
  const open = g.pulls.filter(selectable);
  const next = new Set(chosen.value);
  const all = open.every((p) => next.has(p.id));
  for (const p of open) {
    if (all) next.delete(p.id);
    else next.add(p.id);
  }
  chosen.value = next;
}
const groupState = (g: { pulls: LogPull[] }) => {
  const open = g.pulls.filter(selectable);
  const on = open.filter((p) => chosen.value.has(p.id)).length;
  return { disabled: open.length === 0, checked: open.length > 0 && on === open.length, indeterminate: on > 0 && on < open.length };
};

async function run(): Promise<void> {
  const f = file.value;
  if (!f || chosen.value.size === 0) return;
  error.value = "";
  read.value = 0;
  step.value = "import";
  abort = new AbortController();
  try {
    const ids = await importLog(batches(f), pulls.value.filter((p) => chosen.value.has(p.id)), archiveStore(), { file: f.name, signal: abort.signal });
    emit("imported", ids);
  } catch (err) {
    step.value = "list";
    error.value = abort.signal.aborted ? "已取消，已经导入的场次保留在复盘列表里" : `导入失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

function close(): void {
  abort?.abort();
  emit("close");
}
const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="backdrop" @click.self="close">
    <div
      class="dialog"
      :class="{ dragging }"
      role="dialog"
      aria-label="导入日志"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="dropped"
    >
      <header>
        <h3>导入 ACT 日志</h3>
        <span class="dim name" :title="file?.name">{{ file ? `${file.name} · ${mb(size)} MB` : "" }}</span>
        <button class="close" title="关闭" @click="close">✕</button>
      </header>

      <div v-if="step === 'pick'" class="pick">
        <p>选择或拖入 ACT 的网络日志 <b>Network_*.log</b>，从中选出要复盘的场次。</p>
        <p class="dim">ACT 默认把日志存在 %APPDATA%\Advanced Combat Tracker\FFXIVLogs\。</p>
        <button class="primary" @click="input?.click()">选择日志文件…</button>
        <input ref="input" type="file" accept=".log,.txt" hidden @change="picked" />
      </div>

      <div v-else-if="step === 'scan' || step === 'import'" class="busy">
        <p>{{ step === "scan" ? "正在读取日志，找出其中的战斗…" : `正在导入 ${chosen.size} 场…` }}</p>
        <div class="bar"><div class="fill" :style="{ width: `${percent}%` }" /></div>
        <p class="dim num">{{ percent }}%　{{ mb(read) }} / {{ mb(size) }} MB</p>
        <button @click="abort?.abort()">取消</button>
      </div>

      <template v-else>
        <div class="list">
          <section v-for="g in groups" :key="g.session" class="group">
            <label class="ghead">
              <input
                type="checkbox"
                :disabled="groupState(g).disabled"
                :checked="groupState(g).checked"
                :indeterminate.prop="groupState(g).indeterminate"
                @change="toggleGroup(g)"
              />
              <span class="num">{{ stamp(g.pulls[0]!.start, true) }}</span>
              <span class="zone" :title="g.pulls[0]!.zoneName">{{ g.pulls[0]!.zoneName || "（未知区域）" }}</span>
              <span class="dim">{{ g.pulls.length }} 场</span>
            </label>
            <label v-for="p in g.pulls" :key="p.id" class="pull" :class="{ done: !selectable(p) }" :title="selectable(p) ? '' : '已经在复盘列表里'">
              <input type="checkbox" :disabled="!selectable(p)" :checked="chosen.has(p.id)" @change="toggle(p)" />
              <span class="num">{{ stamp(p.start, false) }}</span>
              <span class="title">{{ p.title || "战斗" }}</span>
              <span v-if="p.end === undefined" class="dim">日志在战斗中结束</span>
              <span v-else class="result" :class="p.result">{{ RESULT[p.result] }}</span>
              <span class="num dim">{{ formatClock(p.summary.durationMs) }}</span>
              <span class="deaths dim"><UiIcon name="death" /> {{ p.summary.deaths }}</span>
              <span class="dim num">受击 {{ p.summary.rows - p.summary.deaths }}</span>
              <span v-if="!selectable(p)" class="tag">已在复盘里</span>
            </label>
          </section>
        </div>
        <footer>
          <span class="dim">导入的复盘自动收藏（★），不会被按保留份数清理</span>
          <span class="spacer" />
          <button @click="step = 'pick'">换一个文件</button>
          <button class="primary" :disabled="chosen.size === 0" @click="run">导入 {{ chosen.size }} 场</button>
        </footer>
      </template>

      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.5);
}
.dialog {
  width: min(620px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  background: var(--panel-solid);
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  padding: 10px 14px 12px;
  user-select: text;
}
.dialog.dragging {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}
header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
h3 {
  margin: 0;
  font-size: 14px;
  white-space: nowrap;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close {
  border: 0;
  background: none;
  color: var(--text-dim);
}
.pick,
.busy {
  padding: 12px 0 6px;
}
.pick p,
.busy p {
  margin: 0 0 8px;
}
.primary {
  background: rgba(108, 182, 255, 0.25);
  border-color: var(--accent);
}
.bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
  margin-bottom: 6px;
}
.fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s;
}
.list {
  overflow-y: auto;
  min-height: 0;
  flex: 1;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.group {
  padding: 4px 0;
  border-bottom: 1px solid var(--line);
}
.group:last-child {
  border-bottom: 0;
}
label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px;
  border-radius: 3px;
  white-space: nowrap;
  cursor: pointer;
}
label:hover {
  background: var(--hover);
}
.ghead .zone {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pull {
  padding-left: 24px;
}
.pull.done {
  opacity: 0.5;
  cursor: default;
}
.pull .title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.result.clear {
  color: var(--ok);
}
.result.wipe {
  color: var(--bad);
}
.tag {
  font-size: 11px;
  padding: 0 4px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
}
footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
}
.spacer {
  flex: 1;
}
.num {
  font-family: var(--mono);
}
.dim {
  color: var(--text-dim);
}
.error {
  margin: 8px 0 0;
  color: var(--bad);
}
</style>
