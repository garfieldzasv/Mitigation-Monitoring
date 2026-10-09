<script setup lang="ts">
import { computed, ref } from "vue";
import type { FilterOption } from "@/core/filter/rowFilter";
import JobIcon from "./JobIcon.vue";

/**
 * A checklist of values present in the encounter: unticking hides rows with that value. "仅"
 * shows only one value, "全部显示" clears. Hidden values not in this encounter stay hidden.
 */
const props = defineProps<{ title: string; options: FilterOption[]; hidden: string[]; withJob?: boolean }>();
const emit = defineEmits<{ "update:hidden": [hidden: string[]] }>();

const query = ref("");
const hiddenSet = computed(() => new Set(props.hidden));
const shown = computed(() => {
  const q = query.value.trim();
  return q ? props.options.filter((o) => o.label.includes(q)) : props.options;
});

function toggle(key: string): void {
  const next = new Set(props.hidden);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  emit("update:hidden", [...next]);
}

function only(key: string): void {
  emit("update:hidden", props.options.map((o) => o.key).filter((k) => k !== key));
}
</script>

<template>
  <div class="checklist">
    <div class="head">
      <span class="title">{{ title }}</span>
      <button class="link" :disabled="hidden.length === 0" @click="emit('update:hidden', [])">全部显示</button>
    </div>
    <input v-if="options.length > 8" v-model="query" class="search" placeholder="搜索" />
    <ul>
      <li v-for="o in shown" :key="o.key" :class="{ off: hiddenSet.has(o.key) }" @click="toggle(o.key)">
        <span class="box">{{ hiddenSet.has(o.key) ? "" : "✓" }}</span>
        <JobIcon v-if="withJob" :job-id="o.job ?? 0" :size="16" />
        <span class="label" :title="o.label">{{ o.label }}</span>
        <span class="count">{{ o.count }}</span>
        <button class="only" title="只看这一项" @click.stop="only(o.key)">仅</button>
      </li>
      <li v-if="shown.length === 0" class="empty">没有可选项</li>
    </ul>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.title {
  color: var(--text-dim);
}
.search {
  width: 100%;
  margin-bottom: 4px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 4px;
  border-radius: 3px;
  cursor: pointer;
}
li:hover {
  background: var(--hover);
}
li.off .label,
li.off .count {
  color: var(--text-dim);
  text-decoration: line-through;
}
.box {
  width: 12px;
  text-align: center;
  color: var(--accent);
}
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  font-family: var(--mono);
  color: var(--text-dim);
}
.only {
  visibility: hidden;
  padding: 0 4px;
  font-size: 11px;
}
li:hover .only {
  visibility: visible;
}
.empty {
  color: var(--text-dim);
  cursor: default;
}
</style>
