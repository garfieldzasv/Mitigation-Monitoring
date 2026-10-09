<script setup lang="ts">
import { computed } from "vue";
import { statusIconId } from "@/core/game/statuses";
import { termApplies, type MitigationTerm } from "@/core/mitigation/multiplier";
import type { StatusCategory, StatusSnap } from "@/core/status/statusTracker";
import GameIcon from "../common/GameIcon.vue";
import { formatRemaining, remainingSeconds } from "../../format";

/**
 * The status column: the statuses that matter for the hit (docs/DESIGN.md 7.1). On the target:
 * invulnerability, mitigation, vulnerabilities, shields. On the source: Reprisal-like debuffs and
 * damage-ups. Over the foot of each icon, the time it had left at the hit, coloured by which kind it
 * is (it replaced a coloured bar: the time says whether a shield would still be up for the next hit;
 * a row is 22px, so it sits on the icon rather than under it). Borrowed from a same-name actor (5.4)
 * is said in the tooltip only. A reduction that does not apply to this hit (wrong damage type, or
 * overlapped by a stronger one of its group) is greyed out, its time too. At most `max` slots: past
 * that, `max − 1` icons and +N.
 */
const props = withDefaults(defineProps<{ target: StatusSnap[]; source: StatusSnap[]; terms?: MitigationTerm[]; max?: number }>(), {
  terms: () => [],
  max: 5,
});

const ORDER: StatusCategory[] = ["invuln", "mitigation", "damageDown", "vulnerability", "damageUp", "shield"];
const LABEL: Record<StatusCategory, string> = {
  invuln: "无敌",
  mitigation: "减伤",
  shield: "盾",
  vulnerability: "易伤",
  damageDown: "Boss 身上的减益",
  damageUp: "Boss 增伤",
  other: "",
};

interface Chip {
  key: string;
  icon: number;
  text: string;
  /** Time left at the hit, short: `12` seconds, `53m`, `∞` for one that does not run out (permanent in the game data). */
  time: string;
  category: StatusCategory;
  inactive: boolean;
  title: string;
}

const chips = computed<Chip[]>(() => {
  const termOf = new Map(props.terms.map((t) => [`${t.side}:${t.statusId}`, t]));
  const entries = [
    ...props.target.map((s) => ({ s, side: "target" as const })),
    ...props.source.map((s) => ({ s, side: "source" as const })),
  ].filter(({ s }) => s.category !== "other");
  const seen = new Set<string>();
  const unique = entries.filter(({ s }) => {
    const key = `${s.category}:${s.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const chips = unique.map(({ s, side }) => {
    const inactive = !termApplies(termOf.get(`${side}:${s.id}`));
    const remaining = formatRemaining(s.remainingMs);
    const notes = [LABEL[s.category], s.sourceName || "?", `剩余 ${remaining}`, s.inherited ? "继承自 Boss 本体" : "", inactive ? "对这次伤害不生效" : ""];
    return {
      key: `${s.category}:${s.id}`,
      icon: statusIconId(s.id, s.stacks),
      text: s.name.slice(0, 1),
      time: shortRemaining(s),
      category: s.category,
      inactive,
      title: `${s.name}${s.stacks > 1 ? ` ×${s.stacks}` : ""}（${notes.filter(Boolean).join("，")}）`,
    };
  });
  // Applying statuses first within each category, so the greyed-out ones are the first to go into +N.
  return chips.sort(
    (a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || Number(a.inactive) - Number(b.inactive),
  );
});

/** The time a status had left, as short as the icon is wide. */
function shortRemaining(s: StatusSnap): string {
  if (!Number.isFinite(s.remainingMs)) return "∞";
  if (s.remainingMs < 60_000) return String(remainingSeconds(s.remainingMs));
  return `${Math.floor(s.remainingMs / 60_000)}m`;
}

/** Past `max`, one slot goes to the +N badge so it always fits. */
const visible = computed(() => (chips.value.length > props.max ? chips.value.slice(0, props.max - 1) : chips.value));
const more = computed(() => chips.value.length - visible.value.length);
const title = computed(() => chips.value.map((c) => c.title).join("\n"));
</script>

<template>
  <span class="chips" :title="title">
    <span
      v-for="c in visible"
      :key="c.key"
      class="chip"
      :class="[c.category, { inactive: c.inactive }]"
    >
      <GameIcon v-if="c.icon" :icon-id="c.icon" :alt="c.text" class="icon" />
      <span v-else class="text">{{ c.text }}</span>
      <span class="time">{{ c.time }}</span>
    </span>
    <span v-if="more > 0" class="more">+{{ more }}</span>
  </span>
</template>

<style scoped>
.chips {
  display: flex;
  align-items: center;
  gap: 2px;
  overflow: hidden;
}
.chip {
  flex: none;
  position: relative;
  width: 15px;
  height: 18px;
  color: var(--text-dim);
}
.icon {
  display: block;
  width: 15px;
  height: 18px;
  object-fit: contain;
}
.text {
  width: 15px;
  height: 18px;
  line-height: 18px;
  font-size: 10px;
  text-align: center;
  background: rgba(255, 255, 255, 0.08);
}
/* Over the icon's foot, readable on any icon: an outline in the page's background. */
.time {
  position: absolute;
  left: -3px;
  right: -3px;
  bottom: -2px;
  font: 700 9px/9px var(--mono);
  letter-spacing: -0.5px;
  text-align: center;
  pointer-events: none;
  text-shadow:
    1px 0 0 #000,
    -1px 0 0 #000,
    0 1px 0 #000,
    0 -1px 0 #000,
    1px 1px 0 #000,
    -1px -1px 0 #000,
    1px -1px 0 #000,
    -1px 1px 0 #000;
}
.mitigation {
  color: var(--cat-mitigation);
}
.shield {
  color: var(--cat-shield);
}
.damageDown {
  color: var(--cat-source);
}
.vulnerability,
.damageUp {
  color: var(--cat-vuln);
}
.invuln {
  color: var(--cat-invuln);
}
.chip.inactive {
  color: var(--text-dim);
}
.chip.inactive .icon,
.chip.inactive .text {
  filter: grayscale(1);
  opacity: 0.5;
}
.more {
  flex: none;
  font-size: 10px;
  color: var(--text-dim);
}
</style>
