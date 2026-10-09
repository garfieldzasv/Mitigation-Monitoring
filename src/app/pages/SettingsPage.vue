<script setup lang="ts">
import { computed, onMounted } from "vue";
import { FONT_SIZES, KEEP_RANGE, OPACITY_RANGE, ROW_HEIGHTS } from "@/core/settings/settings";
import ZoneTree from "../components/settings/ZoneTree.vue";
import { useSettings } from "../composables/useSettings";

/**
 * The settings window (docs/DESIGN.md 7.3). Every change is saved and applied at once; the monitor
 * follows without a reload.
 */
const { settings, update, reset } = useSettings();
onMounted(() => (document.title = "设置 · 小队受伤记录"));

const opacityPercent = computed(() => Math.round(settings.value.opacity * 100));

type Flag = "highlightSelf";
type Amount = "keepEncounters" | "rowHeight" | "fontSize";

/** Out-of-range or partial input is normalised by update() (normalizeSettings). */
function setFlag(key: Flag, e: Event): void {
  update({ [key]: (e.target as HTMLInputElement).checked });
}
function setAmount(key: Amount, e: Event): void {
  const v = Number((e.target as HTMLInputElement | HTMLSelectElement).value);
  if (Number.isFinite(v)) update({ [key]: v });
}
function setOpacity(e: Event): void {
  update({ opacity: Number((e.target as HTMLInputElement).value) / 100 });
}
</script>

<template>
  <div class="settings">
    <h1>设置</h1>

    <section>
      <h2>存档</h2>
      <div class="row zones">
        <span class="name">不存档的区域</span>
        <ZoneTree :skip="settings.skipZones" @update:skip="(skipZones) => update({ skipZones })" />
        <small>勾选的区域里的战斗不存档，监控窗口照常显示。游戏数据里还没有的新区域照常存档</small>
      </div>
      <label class="row">
        <span class="name">保留复盘份数</span>
        <input type="number" :min="KEEP_RANGE.min" :max="KEEP_RANGE.max" :value="settings.keepEncounters" @change="setAmount('keepEncounters', $event)" />
        <small>最近 {{ KEEP_RANGE.min }}~{{ KEEP_RANGE.max }} 份，一次进本或进入一张地图的全部战斗为一份；收藏的不计入、不删</small>
      </label>
    </section>

    <section>
      <h2>监控窗口</h2>
      <label class="row">
        <span class="name">行高</span>
        <select :value="settings.rowHeight" @change="setAmount('rowHeight', $event)">
          <option v-for="h in ROW_HEIGHTS" :key="h" :value="h">{{ h }} px</option>
        </select>
        <small>窗口高度不变时，行高越小显示的行越多</small>
      </label>
      <label class="row">
        <span class="name">字号</span>
        <select :value="settings.fontSize" @change="setAmount('fontSize', $event)">
          <option v-for="f in FONT_SIZES" :key="f" :value="f">{{ f }} px</option>
        </select>
      </label>
      <label class="row">
        <span class="name">背景不透明度</span>
        <input
          type="range"
          :min="OPACITY_RANGE.min * 100"
          :max="OPACITY_RANGE.max * 100"
          step="5"
          :value="opacityPercent"
          @input="setOpacity"
        />
        <span class="num">{{ opacityPercent }}%</span>
      </label>
      <label class="row check">
        <input type="checkbox" :checked="settings.highlightSelf" @change="setFlag('highlightSelf', $event)" />
        <span>高亮自己的行</span>
      </label>
    </section>

    <footer>
      <button @click="reset()">恢复默认</button>
      <span class="dim">修改立即生效，保存在 ACT 的内置浏览器里</span>
    </footer>
  </div>
</template>

<style scoped>
.settings {
  height: 100%;
  overflow-y: auto;
  background: #181a1f;
  padding: 12px 16px;
  font-size: 13px;
}
h1 {
  font-size: 16px;
  margin: 0 0 12px;
}
h2 {
  font-size: 13px;
  color: var(--text-dim);
  font-weight: 600;
  margin: 0 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--line);
}
section {
  margin-bottom: 18px;
}
.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 10px;
}
.row.check {
  align-items: flex-start;
  flex-wrap: nowrap;
  cursor: pointer;
}
.row.check input {
  margin-top: 3px;
}
.row.zones {
  flex-direction: column;
  align-items: stretch;
}
.settings .row.zones small {
  padding-left: 0;
}
.name {
  width: 96px;
}
small {
  display: block;
  width: 100%;
  color: var(--text-dim);
  font-size: 11px;
  margin-top: 2px;
}
.row:not(.check) small {
  padding-left: 106px;
}
input[type="number"] {
  width: 72px;
}
input[type="range"] {
  width: 180px;
}
select {
  font: inherit;
  color: var(--text);
  background: #23262d;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
}
.num {
  font-family: var(--mono);
}
footer {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dim {
  color: var(--text-dim);
  font-size: 11px;
}
</style>
