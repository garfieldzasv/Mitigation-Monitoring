<script setup lang="ts">
import { onMounted, ref } from "vue";
import { collectPopupReport, PROBE_CHANNEL, type PopupReport } from "../probe/runtimeProbe";

/** The popup half of the probe: reports what it can see, over both channels the review window may use. */
const report = ref<PopupReport>();
const sent = ref<string[]>([]);

onMounted(async () => {
  report.value = await collectPopupReport();
  const data = JSON.parse(JSON.stringify(report.value)) as PopupReport;
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(PROBE_CHANNEL);
    channel.postMessage(data);
    channel.close();
    sent.value.push("BroadcastChannel");
  }
  try {
    (window.opener as Window | null)?.postMessage(data, "*");
    if (window.opener) sent.value.push("postMessage");
  } catch {
    // reported as not sent
  }
});
</script>

<template>
  <div class="popup">
    <h1>测试窗口</h1>
    <pre v-if="report">{{ JSON.stringify(report, null, 2) }}</pre>
    <p>已发回：{{ sent.join("、") || "无" }}。回到悬浮窗查看结果后，可以关闭本窗口。</p>
  </div>
</template>

<style scoped>
.popup {
  height: 100%;
  overflow: auto;
  padding: 10px 14px;
  background: #1b1d22;
  user-select: text;
}
h1 {
  font-size: 15px;
  margin: 0 0 6px;
}
pre {
  font-family: var(--mono);
}
</style>
