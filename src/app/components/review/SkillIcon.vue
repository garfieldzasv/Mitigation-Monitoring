<script setup lang="ts">
import { computed } from "vue";
import type { SkillState } from "@/core/replay/partySkills";
import GameIcon from "../common/GameIcon.vue";

/**
 * One mitigation skill at one moment (docs/DESIGN.md 8.2), drawn as Skills Monitoring draws it: in effect, a gold count
 * of the seconds it has left (and a gold rim); on cooldown, a dark wedge that shrinks clockwise as the charge comes
 * back, with a white count of the seconds to it; ready, the plain icon. Skills with charges show how many are left in
 * the corner, orange at none.
 */
const props = defineProps<{ state: SkillState; time: number }>();

/** At most two characters, as in Skills Monitoring: seconds, from 100 on minutes. */
function short(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s < 100 ? String(s) : `${Math.ceil(s / 60)}m`;
}
const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

const multi = computed(() => props.state.skill.maxCharges > 1);
const text = computed(() => {
  const s = props.state;
  if (s.activeUntil !== undefined) return { value: short(s.activeUntil - props.time), active: true };
  if (s.recharge) return { value: short(s.recharge.at - props.time), active: false };
  return undefined;
});
/** The share of the recast gone by: the wedge left is the rest. */
const sweep = computed(() => {
  const r = props.state.recharge;
  return r ? Math.min(1, Math.max(0, (props.time - r.from) / (r.at - r.from))) : undefined;
});
const title = computed(() => {
  const s = props.state;
  const head =
    s.state === "active"
      ? `生效中，还剩 ${secs(s.activeUntil! - props.time)} 秒`
      : s.state === "cooldown"
        ? `冷却中，${secs(s.recharge!.at - props.time)} 秒后可用`
        : "可用";
  const charges = multi.value ? `；可积蓄 ${s.skill.maxCharges} 次，剩 ${s.charges} 次${s.recharge && s.charges > 0 ? `，${secs(s.recharge.at - props.time)} 秒后加 1 次` : ""}` : "";
  return `${s.skill.name}：${head}${charges}`;
});
</script>

<template>
  <div class="skill" :class="[state.state, { empty: state.charges === 0, partial: multi && state.charges > 0 && sweep !== undefined }]" :title="title">
    <GameIcon :icon-id="state.skill.icon" :alt="state.skill.name" class="icon" />
    <div v-if="sweep !== undefined" class="sweep" :style="{ '--sweep': sweep }" />
    <span v-if="text" class="countdown" :class="{ active: text.active }">{{ text.value }}</span>
    <span v-if="multi" class="charges" :class="{ zero: state.charges === 0 }">{{ state.charges }}</span>
  </div>
</template>

<style scoped>
.skill {
  --size: 24px;
  position: relative;
  width: var(--size);
  height: var(--size);
  flex: none;
  border-radius: 3px;
  overflow: hidden;
  box-shadow:
    0 0 0 1px rgb(0 0 0 / 70%),
    0 1px 3px rgb(0 0 0 / 60%);
}
.icon {
  display: block;
  width: 100%;
  height: 100%;
}
.skill.empty .icon {
  filter: brightness(0.8) saturate(0.8);
}
/* In effect: a gold rim over the icon. */
.skill.active::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 3px;
  box-shadow: inset 0 0 0 1.5px #ffd34d;
  pointer-events: none;
}
/* The recast still to go: a dark wedge from 12 o'clock, shrinking clockwise. */
.sweep {
  position: absolute;
  inset: 0;
  background: conic-gradient(transparent calc(var(--sweep) * 360deg), rgb(0 0 0 / 55%) 0);
  pointer-events: none;
}
.skill.partial .sweep {
  opacity: 0.55;
}
.countdown {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  text-shadow:
    0 0 2px #000,
    0 0 2px #000,
    0 0 3px #000;
  font-variant-numeric: tabular-nums;
}
.countdown.active {
  color: #ffd34d;
}
/* Charges in the bottom-right corner, like the hotbar's digits. */
.charges {
  position: absolute;
  right: 1px;
  bottom: 0;
  font-size: 10px;
  font-weight: 800;
  line-height: 1;
  color: #fff;
  -webkit-text-stroke: 2px #000;
  paint-order: stroke fill;
  font-variant-numeric: tabular-nums;
}
.charges.zero {
  color: #ff8a3d;
}
</style>
