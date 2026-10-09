<script setup lang="ts">
import { computed, ref } from "vue";
import { zoneTree, type ZoneNode } from "@/core/game/zones";
import { nodeStates, setSkipped } from "@/core/settings/zoneSkip";

/**
 * The zones whose fights are not archived (docs/DESIGN.md 6.2, 7.3): the zone tree with a checkbox on every node.
 * Checking a category covers everything in it; a box is half-checked when only part of what is under it is. The
 * search shows the matching duties and zones with the nodes above them.
 */
const props = defineProps<{ skip: readonly string[] }>();
const emit = defineEmits<{ "update:skip": [skip: string[]] }>();

const tree = zoneTree();
const expanded = ref(new Set<string>());
const query = ref("");

const states = computed(() => nodeStates(props.skip, tree));

interface Line {
  node: ZoneNode;
  depth: number;
  open: boolean;
}

/** Nodes matching the search, or with a match under them; undefined without a search. */
const matching = computed(() => {
  const q = query.value.trim();
  if (!q) return undefined;
  const keep = new Set<string>();
  const visit = (n: ZoneNode): boolean => {
    const below = (n.children ?? []).map(visit).some(Boolean);
    const hit = n.label.includes(q) || below;
    if (hit) keep.add(n.key);
    return hit;
  };
  tree.forEach(visit);
  return keep;
});

const lines = computed<Line[]>(() => {
  const out: Line[] = [];
  const keep = matching.value;
  const walk = (nodes: readonly ZoneNode[], depth: number) => {
    for (const node of nodes) {
      if (keep && !keep.has(node.key)) continue;
      // While searching, everything leading to a match is open (a matching category shows all it holds).
      const open = keep ? (node.children ?? []).some((c) => keep.has(c.key)) : expanded.value.has(node.key);
      out.push({ node, depth, open });
      if (open && node.children) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
});

function toggleOpen(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

function check(node: ZoneNode, e: Event): void {
  emit("update:skip", setSkipped(props.skip, node.key, (e.target as HTMLInputElement).checked, tree));
}

const skippedCount = computed(() => {
  let n = 0;
  const count = (nodes: readonly ZoneNode[]) => {
    for (const node of nodes) {
      if (states.value.get(node.key) === "on") n += node.count;
      else if (node.children) count(node.children);
    }
  };
  count(tree);
  return n;
});
</script>

<template>
  <div class="zone-tree">
    <div class="tools">
      <input v-model="query" type="search" placeholder="搜索副本或地图" />
      <span class="dim">已选 {{ skippedCount }} 项</span>
      <button v-if="skip.length > 0" @click="emit('update:skip', [])">全部清除</button>
    </div>
    <ul>
      <li v-for="l in lines" :key="l.node.key" :style="{ paddingLeft: `${4 + l.depth * 16}px` }">
        <button v-if="l.node.children" class="twisty" :title="l.open ? '收起' : '展开'" :disabled="!!matching" @click="toggleOpen(l.node.key)">
          {{ l.open ? "▾" : "▸" }}
        </button>
        <span v-else class="twisty" />
        <label :title="l.node.note">
          <input
            type="checkbox"
            :checked="states.get(l.node.key) === 'on'"
            :indeterminate="states.get(l.node.key) === 'some'"
            @change="check(l.node, $event)"
          />
          <span class="label">{{ l.node.label }}</span>
          <span v-if="l.node.children" class="dim">{{ l.node.count }}</span>
          <span v-if="l.node.note" class="dim">{{ l.node.note }}</span>
        </label>
      </li>
      <li v-if="lines.length === 0" class="dim empty">没有找到</li>
    </ul>
  </div>
</template>

<style scoped>
.zone-tree {
  width: 100%;
}
.tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.tools input {
  flex: 1;
  min-width: 0;
  font: inherit;
  color: var(--text);
  background: #23262d;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  padding: 1px 6px;
}
.tools button {
  font-size: 11px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 2px 0;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 3px;
}
li {
  display: flex;
  align-items: center;
  gap: 2px;
  line-height: 22px;
  white-space: nowrap;
}
li:hover {
  background: var(--hover);
}
.twisty {
  display: inline-block;
  width: 16px;
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-dim);
  font-size: 11px;
  text-align: center;
}
.twisty:disabled {
  opacity: 0.5;
}
label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  cursor: pointer;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dim {
  color: var(--text-dim);
  font-size: 11px;
}
.empty {
  padding-left: 8px;
}
</style>
