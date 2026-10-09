<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { getJob } from "@/core/game/jobs";
import { addOverlayListener, getConnectionMode, removeOverlayListener, requestOverlayHandler } from "@/core/overlay/overlayApi";
import type { OverlayCombatData, OverlayPartyMember } from "@/core/overlay/events";
import { useOverlayConnection } from "../composables/useOverlayConnection";
import { pageUrl } from "../composables/useUrlParams";
import { getInitialRoute } from "../session";
import {
  checkCompression,
  checkIndexedDb,
  checkLocalStorage,
  checkStorageEstimate,
  environment,
  PROBE_CHANNEL,
  PROBE_POPUP_NAME,
  summarizeCombatants,
  type CheckResult,
  type CombatantSummary,
  type OverlayCombatant,
  type PopupReport,
} from "../probe/runtimeProbe";

/**
 * Runtime checks to run inside ACT (docs/DESIGN.md 11.2). Open as `.../index.html#/probe` in an
 * OverlayPlugin overlay, once from the local file and once from http(s); restart ACT and open it
 * again to see whether storage survived.
 */
const now = new Date().toISOString();
// An overlay URL edited from `#/` to `#/probe` can be an in-page route change rather than a reload;
// OverlayPlugin then sends no fresh cached events, which this tells apart.
const initialRoute = getInitialRoute();
const connection = useOverlayConnection();
const env = computed(() => ({
  ...environment(),
  connection: `${getConnectionMode()} · ${connection.value}`,
  pageLoadedAt: new Date(performance.timeOrigin).toISOString(),
  entry: initialRoute.startsWith("#/probe") ? "整页加载" : `应用内路由切换（页面最初打开的是 ${initialRoute}）`,
}));
const checks = ref<CheckResult[]>([]);
const popup = reactive({ opened: null as boolean | null, reports: [] as PopupReport[] });
const combat = reactive({ events: 0, names: [] as string[], title: "", duration: "", isActive: "" });
const party = ref<OverlayPartyMember[]>([]);
const partyEvents = ref(0);
const self = ref("");
const combatants = reactive({ state: "查询中…", summary: null as CombatantSummary | null });
const copied = ref(false);

async function loadCombatants(): Promise<void> {
  combatants.state = "查询中…";
  const reply = await requestOverlayHandler<{ combatants?: OverlayCombatant[] }>({ call: "getCombatants" }, 15000);
  if (!reply) {
    combatants.state = "15 秒内没有回应";
    return;
  }
  combatants.summary = summarizeCombatants(reply.combatants ?? []);
  combatants.state = `已获取（${new Date().toLocaleTimeString()}）`;
}

let channel: BroadcastChannel | undefined;
const onMessage = (data: unknown, via: PopupReport["via"]) => {
  if (data && typeof data === "object" && "hasOpener" in data) popup.reports.push({ ...(data as PopupReport), via });
};
const onWindowMessage = (e: MessageEvent) => onMessage(e.data, "postMessage");

onMounted(async () => {
  checks.value = [checkLocalStorage(now)];
  checks.value.push(await checkIndexedDb(now));
  checks.value.push(await checkStorageEstimate());
  checks.value.push(await checkCompression());
  checks.value.push({ name: "BroadcastChannel", ok: typeof BroadcastChannel !== "undefined", detail: "" });

  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(PROBE_CHANNEL);
    channel.onmessage = (e) => onMessage(e.data, "BroadcastChannel");
  }
  window.addEventListener("message", onWindowMessage);

  addOverlayListener("CombatData", onCombatData);
  addOverlayListener("PartyChanged", onParty);
  addOverlayListener("ChangePrimaryPlayer", onPrimaryPlayer);
  void loadCombatants();
});

onBeforeUnmount(() => {
  channel?.close();
  window.removeEventListener("message", onWindowMessage);
  removeOverlayListener("CombatData", onCombatData);
  removeOverlayListener("PartyChanged", onParty);
  removeOverlayListener("ChangePrimaryPlayer", onPrimaryPlayer);
});

function onCombatData(e: OverlayCombatData): void {
  combat.events++;
  combat.names = Object.keys(e.Combatant ?? {});
  combat.title = e.Encounter?.title ?? "";
  combat.duration = e.Encounter?.duration ?? "";
  combat.isActive = String(e.isActive ?? "");
}

function onParty(e: { party: OverlayPartyMember[] }): void {
  party.value = e.party;
  partyEvents.value++;
}

function onPrimaryPlayer(e: { charID: number; charName: string }): void {
  self.value = `${e.charName} (${e.charID.toString(16).toUpperCase()})`;
}

function openPopup(): void {
  const win = window.open(pageUrl("/probe-popup"), PROBE_POPUP_NAME, "width=560,height=420");
  popup.opened = win !== null;
}

/** navigator.clipboard is often missing in CEF; fall back to a selected textarea. */
function copyResults(): void {
  const text = JSON.stringify(
    {
      at: now,
      env: env.value,
      checks: checks.value,
      popup,
      combat,
      partyEvents: partyEvents.value,
      party: party.value,
      self: self.value,
      getCombatants: { state: combatants.state, ...combatants.summary },
    },
    null,
    2,
  );
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  copied.value = document.execCommand("copy");
  area.remove();
}
</script>

<template>
  <div class="probe">
    <h1>运行环境实测</h1>
    <p class="hint">在 ACT 悬浮窗里打开本页。本地文件和 http(s) 地址各测一次；关掉 ACT 再打开，看“上次写入”有没有保留。</p>

    <h2>环境</h2>
    <table>
      <tr v-for="(v, k) in env" :key="k"><td>{{ k }}</td><td>{{ v }}</td></tr>
    </table>

    <h2>存储与压缩</h2>
    <table>
      <tr v-for="c in checks" :key="c.name">
        <td>{{ c.name }}</td>
        <td :class="c.ok ? 'ok' : 'bad'">{{ c.ok ? "可用" : "不可用" }}</td>
        <td>{{ c.detail }}</td>
      </tr>
    </table>

    <h2>复盘窗口（window.open）</h2>
    <button @click="openPopup">打开测试窗口</button>
    <span v-if="popup.opened !== null" :class="popup.opened ? 'ok' : 'bad'">
      {{ popup.opened ? "window.open 返回了窗口" : "window.open 返回 null（被拦截）" }}
    </span>
    <table v-if="popup.reports.length">
      <tr><th>通道</th><th>OverlayPluginApi</th><th>opener</th><th>可读 opener</th><th>localStorage</th><th>IndexedDB</th></tr>
      <tr v-for="(r, i) in popup.reports" :key="i">
        <td>{{ r.via }}</td>
        <td>{{ r.hasOverlayPluginApi }}</td>
        <td>{{ r.hasOpener }}</td>
        <td>{{ r.openerReadable }}</td>
        <td :class="r.localStorageValue === now ? 'ok' : 'bad'">{{ r.localStorageValue === now ? "同一份" : r.localStorageValue ?? "无" }}</td>
        <td :class="r.indexedDbValue === now ? 'ok' : 'bad'">{{ r.indexedDbValue === now ? "同一份" : r.indexedDbValue ?? "无" }}</td>
      </tr>
    </table>

    <h2>CombatData 玩家名单</h2>
    <p class="hint">分别把 ACT 的解析范围设成小队、全团各打一场，看下面的名单是否随之变化。</p>
    <table>
      <tr><td>收到次数</td><td>{{ combat.events }}</td></tr>
      <tr><td>Encounter</td><td>{{ combat.title }} {{ combat.duration }} isActive={{ combat.isActive }}</td></tr>
      <tr><td>Combatant（{{ combat.names.length }}）</td><td>{{ combat.names.join("、") }}</td></tr>
      <tr><td>自己</td><td>{{ self }}</td></tr>
      <tr>
        <td>PartyChanged（收到 {{ partyEvents }} 次，{{ party.length }} 人）</td>
        <td>{{ party.map((m) => `${m.name}${m.inParty ? "" : "(团队)"}`).join("、") }}</td>
      </tr>
    </table>

    <h2>getCombatants（备用数据来源）</h2>
    <p class="hint">主动查询，不依赖事件。看玩家名单和职业对不对、PartyType 能否区分小队成员、第一个单位是不是你自己。</p>
    <button @click="loadCombatants">重新获取</button> <span>{{ combatants.state }}</span>
    <table v-if="combatants.summary" class="combatants">
      <tr><td>单位总数</td><td>{{ combatants.summary.total }}</td></tr>
      <tr><td>第一个单位</td><td>{{ combatants.summary.first }}</td></tr>
      <tr><td>玩家（Type=1）</td><td>{{ combatants.summary.players.length }}</td></tr>
      <tr><td>PartyType 分布</td><td>{{ JSON.stringify(combatants.summary.partyTypeCounts) }}</td></tr>
      <tr>
        <td>玩家名单</td>
        <td>
          {{
            combatants.summary.players
              .slice(0, 40)
              .map((p) => `${p.name}（${getJob(p.job)?.abbr ?? p.job}，PartyType=${p.partyType}）`)
              .join("、")
          }}
        </td>
      </tr>
    </table>

    <p><button @click="copyResults">复制全部结果</button> <span v-if="copied" class="ok">已复制</span></p>
  </div>
</template>

<style scoped>
.probe {
  height: 100%;
  overflow: auto;
  padding: 10px 14px;
  background: #1b1d22;
  user-select: text;
}
h1 {
  font-size: 16px;
  margin: 0 0 6px;
}
h2 {
  font-size: 13px;
  margin: 14px 0 4px;
}
.hint {
  color: var(--text-dim);
  margin: 2px 0 6px;
}
table {
  border-collapse: collapse;
  margin-top: 4px;
}
td,
th {
  border: 1px solid var(--line);
  padding: 2px 6px;
  text-align: left;
  vertical-align: top;
}
.ok {
  color: var(--ok);
}
.bad {
  color: var(--bad);
}
button {
  font: inherit;
  padding: 2px 10px;
}
</style>
