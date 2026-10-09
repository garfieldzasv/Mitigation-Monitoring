<script setup lang="ts">
import type { DamageType } from "@/core/logline/effect";
import type { Verdict } from "@/core/filter/rowFilter";
import type { FilterState } from "../../composables/useMonitorFilter";

/**
 * The 筛选 panel: damage type, verdict, quick switches, minimum amount (docs/DESIGN.md 7.2). Works
 * on whichever filter it is given: the monitor's or the review window's.
 */
const props = defineProps<{ state: FilterState }>();
const { filter, update, clear } = props.state;

const TYPES: { key: DamageType; label: string }[] = [
  { key: "physical", label: "物理" },
  { key: "magical", label: "魔法" },
  { key: "special", label: "特殊" },
];
const VERDICTS: { key: Verdict; label: string }[] = [
  { key: "hit", label: "命中" },
  { key: "block", label: "格挡" },
  { key: "parry", label: "招架" },
  { key: "miss", label: "闪避" },
  { key: "absorbed", label: "全吸收" },
  { key: "noEffect", label: "未生效" },
];

function toggleIn<T>(list: T[], key: T): T[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

function setMin(e: Event): void {
  const n = Number.parseInt((e.target as HTMLInputElement).value, 10);
  update({ minAmount: Number.isFinite(n) && n > 0 ? n : 0 });
}
</script>

<template>
  <div class="more">
    <section>
      <div class="title">类型</div>
      <button
        v-for="t in TYPES"
        :key="t.key"
        class="chip"
        :class="{ off: filter.hiddenDamageTypes.includes(t.key) }"
        @click="update({ hiddenDamageTypes: toggleIn(filter.hiddenDamageTypes, t.key) })"
      >
        {{ t.label }}
      </button>
    </section>
    <section>
      <div class="title">判定</div>
      <button
        v-for="v in VERDICTS"
        :key="v.key"
        class="chip"
        :class="{ off: filter.hiddenVerdicts.includes(v.key) }"
        @click="update({ hiddenVerdicts: toggleIn(filter.hiddenVerdicts, v.key) })"
      >
        {{ v.label }}
      </button>
    </section>
    <section class="switches">
      <label><input type="checkbox" :checked="filter.hideAutoAttacks" @change="update({ hideAutoAttacks: !filter.hideAutoAttacks })" />隐藏自动攻击</label>
      <label><input type="checkbox" :checked="filter.hideZero" @change="update({ hideZero: !filter.hideZero })" />隐藏 0 伤害</label>
      <label><input type="checkbox" :checked="filter.hideDots" @change="update({ hideDots: !filter.hideDots })" />隐藏 DoT</label>
    </section>
    <section>
      <label class="min">
        最小伤害
        <input type="number" min="0" step="1000" :value="filter.minAmount || ''" placeholder="不限" @change="setMin" />
      </label>
    </section>
    <button class="link clear" @click="clear">清空全部过滤</button>
  </div>
</template>

<style scoped>
section {
  margin-bottom: 8px;
}
.title {
  color: var(--text-dim);
  margin-bottom: 3px;
}
.chip {
  margin: 0 4px 4px 0;
}
.chip.off {
  color: var(--text-dim);
  text-decoration: line-through;
  opacity: 0.7;
}
.switches label {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
}
.min {
  display: flex;
  align-items: center;
  gap: 6px;
}
.min input {
  width: 90px;
}
.clear {
  float: right;
}
</style>
