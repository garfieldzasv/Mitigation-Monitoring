<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { DamageRow, DeathRow, Row } from "@/core/engine/types";
import { statusIconId } from "@/core/game/statuses";
import { buildDeathReplay, DEFAULT_REPLAY_WINDOW_MS } from "@/core/replay/deathReplay";
import type { ReplayDetail, StatusChange } from "@/core/replay/detail";
import type { StatusCategory } from "@/core/status/statusTracker";
import GameIcon from "../common/GameIcon.vue";
import JobIcon from "../common/JobIcon.vue";
import StatusChips from "../monitor/StatusChips.vue";
import {
  absorbedText,
  deathSentence,
  formatClock,
  formatMitigation,
  mitigationColor,
  mitigationPercent,
  mitigationTitle,
  percentOfMax,
  STATUS_CATEGORY_LABEL,
} from "../../format";
import { readPreference, writePreference } from "../../preferences";
import type { ChartMark } from "./chartMarks";
import HpChart from "./HpChart.vue";
import UiIcon from "../common/UiIcon.vue";

/**
 * The death replay tab (docs/DESIGN.md 8.3): the encounter's deaths on the left; for the selected
 * one, the killing blow (or the enemy cast most likely behind it), the HP and shield curve and every
 * event of the last seconds, newest first. Clicking a hit opens it in the detail panel.
 */
const props = defineProps<{
  rows: Row[];
  detail: ReplayDetail;
  deathId: number | undefined;
  selectedRowId: number | undefined;
  /** A row's phase label, undefined for an encounter with a single phase. */
  phaseOf: (row: Row) => string | undefined;
  /** The archive has players' positions (version 2): falls and the arena's edge can be told. */
}>();
const emit = defineEmits<{ "update:deathId": [id: number]; select: [id: number] }>();

const WINDOWS = [10000, 15000, 20000, 30000];
const WINDOW_KEY = "mitigation-monitoring:death-window";
const SHOW_KEY = "mitigation-monitoring:death-show";
/** Status losses this close to the death are the death itself taking them; shown as one line. */
const LOST_AT_DEATH_MS = 150;
/** Event kinds without numbers: their text spans the number columns. */
const WIDE = new Set(["death", "cast", "lost"]);

const STATUS_CHANGE_LABEL: Record<StatusChange["change"], string> = {
  gain: "获得",
  refresh: "刷新",
  stacks: "层数",
  unapplied: "未生效",
  lose: "失去",
};

const windowMs = ref(readPreference(WINDOW_KEY, DEFAULT_REPLAY_WINDOW_MS, (v) => typeof v === "number" && WINDOWS.includes(v)));
watch(windowMs, (v) => writePreference(WINDOW_KEY, v));

interface Show {
  hits: boolean;
  heals: boolean;
  statuses: boolean;
  allStatuses: boolean;
  casts: boolean;
}
const DEFAULT_SHOW: Show = { hits: true, heals: true, statuses: true, allStatuses: false, casts: true };
const show = ref<Show>({ ...DEFAULT_SHOW, ...readPreference<Partial<Show>>(SHOW_KEY, {}, (v) => !!v && typeof v === "object") });
watch(show, (v) => writePreference(SHOW_KEY, v), { deep: true });

const deaths = computed(() => props.rows.filter((r): r is DeathRow => r.kind === "death"));
/** Cause of each death for the list: the killing blow, 地形杀, an instant death, an annotated mechanic, else the killer the 25 line names. */
const causes = computed(() =>
  deaths.value.map((d) => {
    const r = buildDeathReplay(d, props.rows, props.detail, 0);
    const text = r.blow ? r.blow.action.name : d.cause === "terrain" ? "地形杀" : d.cause === "other" ? (d.causeText ?? "") : d.cause === "instant" ? `即死 ${d.causeAction ?? ""}` : `${d.sourceName}（无伤害记录）`;
    return { d, text, unknown: !r.blow };
  }),
);
const death = computed(() => deaths.value.find((d) => d.id === props.deathId) ?? deaths.value[0]);
const replay = computed(() => (death.value ? buildDeathReplay(death.value, props.rows, props.detail, windowMs.value) : undefined));
const hasCasts = computed(() => props.detail.casts.length > 0);

const selectedKey = ref<string>();
watch(() => death.value?.id, () => (selectedKey.value = undefined));

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

interface Line {
  key: string;
  time: number;
  kind: string;
  type: string;
  text: string;
  sub: string;
  icon: number;
  category?: StatusCategory;
  amount: string;
  amountClass: string;
  extra: string;
  mit?: { text: string; color: string; title: string };
  hp?: number;
  rowId?: number;
}

const lines = computed<Line[]>(() => {
  const r = replay.value;
  if (!r) return [];
  const out: Line[] = [];
  const lost: string[] = [];
  const base = { icon: 0, amount: "", amountClass: "", extra: "", sub: "" };
  r.entries.forEach((e, i) => {
    const key = `e${i}`;
    if (e.kind === "hit") {
      if (!show.value.hits) return;
      const row = e.row;
      out.push({
        ...base,
        key,
        time: e.time,
        kind: row.fatal ? "fatal" : row.kind,
        type: row.fatal ? "致命" : row.kind === "dot" ? "持续伤害" : "受击",
        text: row.action.name,
        sub: row.source.name ? `← ${row.source.name}` : "",
        amount: `−${row.amount.toLocaleString()}`,
        amountClass: "neg",
        extra: absorbedText(row) ? `盾 ${absorbedText(row)}` : row.fullyAbsorbed ? "全吸收" : "",
        ...(row.multiplier === null
          ? {}
          : {
              mit: {
                text: formatMitigation(row.multiplier, row.multiplierPartial),
                color: mitigationColor(mitigationPercent(row.multiplier)),
                title: mitigationTitle(row.mitigation, row.multiplier, row.multiplierPartial, row.damageType),
              },
            }),
        ...(row.hpAfter !== undefined && row.maxHp > 0 ? { hp: row.hpAfter / row.maxHp } : {}),
        rowId: row.id,
      });
    } else if (e.kind === "heal") {
      if (!show.value.heals) return;
      const h = e.heal;
      const source = h.source.name ? `← ${h.source.name}${h.source.ownerName ? `（${h.source.ownerName}）` : ""}` : "";
      out.push({
        ...base,
        key,
        time: e.time,
        kind: h.kind,
        type: h.kind === "hot" ? "持续治疗" : "治疗",
        text: h.action.name,
        sub: source,
        amount: `+${(h.amount - h.overheal).toLocaleString()}`,
        amountClass: "pos",
        extra: h.overheal > 0 ? `溢出 ${h.overheal.toLocaleString()}` : "",
        ...(h.maxHp > 0 ? { hp: Math.min(h.maxHp, h.hpBefore + h.amount) / h.maxHp } : {}),
      });
    } else if (e.kind === "status") {
      const c = e.change;
      if (!show.value.statuses || (c.category === "other" && !show.value.allStatuses)) return;
      if (c.change === "lose" && e.time >= r.to - LOST_AT_DEATH_MS) {
        lost.push(c.status.name);
        return;
      }
      const seconds = Number.isFinite(c.durationMs) ? `${Math.round(c.durationMs / 1000)} 秒` : "常驻";
      const note =
        c.change === "gain" || c.change === "refresh"
          ? ` · ${seconds}`
          : c.change === "unapplied"
            ? ` · 已有同类效果（更大的盾等），没有覆盖，现有的还剩 ${seconds}`
            : "";
      out.push({
        ...base,
        key,
        time: e.time,
        kind: c.change,
        type: STATUS_CHANGE_LABEL[c.change],
        text: `${c.status.name}${c.stacks > 1 ? ` ×${c.stacks}` : ""}`,
        sub: `${c.source.name ? `← ${c.source.name}` : ""}${note}`,
        icon: statusIconId(c.status.id, c.stacks),
        category: c.category,
        extra: STATUS_CATEGORY_LABEL[c.category],
      });
    } else if (e.kind === "cast") {
      if (!show.value.casts) return;
      const c = e.cast;
      out.push({
        ...base,
        key,
        time: e.time,
        kind: "cast",
        type: "读条",
        text: e.count > 1 ? `${c.action.name} ×${e.count}` : c.action.name,
        sub: `${c.source.name} · ${seconds(c.castMs)}${c.cancelled ? " · 中断" : ""}`,
      });
    } else {
      if (lost.length > 0) {
        out.push({ ...base, key: "lost", time: e.time, kind: "lost", type: "失去", text: `随死亡失去 ${lost.length} 个状态`, sub: lost.join("、") });
      }
      out.push({ ...base, key, time: e.time, kind: "death", type: "死亡", text: deathSentence(e.row, r.blow), hp: 0 });
    }
  });
  return out.reverse();
});

const marks = computed<ChartMark[]>(() => {
  const r = replay.value;
  if (!r) return [];
  const max = r.maxHp || 1;
  const out: ChartMark[] = [];
  r.entries.forEach((e, i) => {
    const key = `e${i}`;
    if (e.kind === "hit" && show.value.hits) {
      out.push({ key, time: e.time, kind: "hit", share: e.row.amount / max, label: `${seconds(e.time - r.to)}　${e.row.action.name}　−${e.row.amount.toLocaleString()}` });
    } else if (e.kind === "heal" && show.value.heals) {
      const effective = e.heal.amount - e.heal.overheal;
      out.push({
        key,
        time: e.time,
        kind: "heal",
        share: effective / max,
        extra: e.heal.overheal / max,
        label: `${seconds(e.time - r.to)}　${e.heal.action.name}　+${effective.toLocaleString()}${e.heal.overheal ? `（溢出 ${e.heal.overheal.toLocaleString()}）` : ""}`,
      });
    } else if (e.kind === "cast" && show.value.casts) {
      out.push({ key, time: e.time, kind: "cast", share: 0, label: `${seconds(e.time - r.to)}　${e.cast.source.name}：${e.cast.action.name}（读条 ${seconds(e.cast.castMs)}）` });
    }
  });
  return out;
});

const list = ref<HTMLElement>();
async function pick(key: string, fromChart = false): Promise<void> {
  selectedKey.value = key;
  const line = lines.value.find((l) => l.key === key);
  if (line?.rowId !== undefined) emit("select", line.rowId);
  if (fromChart) {
    await nextTick();
    list.value?.querySelector(`[data-key="${key}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

const blowShare = computed(() => {
  const b = replay.value?.blow;
  return b ? percentOfMax(b.amount, b.maxHp) : "";
});
function blowLine(b: DamageRow): string {
  const parts = [`${b.amount.toLocaleString()}（${blowShare.value} 最大 HP）`, `受击前 HP ${percentOfMax(b.hpBefore, b.maxHp)}`];
  if (absorbedText(b)) parts.push(`盾吸收 ${absorbedText(b)}`);
  return parts.join("　");
}
</script>

<template>
  <div class="deaths-tab">
    <aside class="death-list">
      <div class="title">死亡（{{ deaths.length }}）</div>
      <ul>
        <li v-for="c in causes" :key="c.d.id" :class="{ selected: c.d.id === death?.id }" @click="emit('update:deathId', c.d.id)">
          <span class="num dim">{{ formatClock(c.d.offset) }}</span>
          <JobIcon :job-id="c.d.target.job" :size="16" />
          <span class="name">{{ c.d.target.name }}</span>
          <span v-if="phaseOf(c.d)" class="ph">{{ phaseOf(c.d) }}</span>
          <span class="cause" :class="{ unknown: c.unknown }" :title="c.text">{{ c.text }}</span>
        </li>
        <li v-if="deaths.length === 0" class="empty dim">这场没有人死亡</li>
      </ul>
    </aside>

    <section v-if="replay && death" class="main">
      <header>
        <div class="sentence"><UiIcon name="death" /> {{ deathSentence(death, replay.blow) }}<span class="dim">　{{ formatClock(death.offset) }}</span><span v-if="phaseOf(death)" class="dim">　{{ phaseOf(death) }}</span><span v-if="death.overkill" class="dim">　溢出 {{ death.overkill.toLocaleString() }}</span></div>
        <div v-if="replay.blow" class="blow">
          <span class="label">致命一击</span>
          <button class="link" @click="emit('select', replay.blow.id)">{{ replay.blow.action.name }}</button>
          <span class="dim">← {{ replay.blow.source.name || "未知" }}</span>
          <span>{{ blowLine(replay.blow) }}</span>
          <span
            v-if="replay.blow.multiplier !== null"
            :style="{ color: mitigationColor(mitigationPercent(replay.blow.multiplier)) }"
            :title="mitigationTitle(replay.blow.mitigation, replay.blow.multiplier, replay.blow.multiplierPartial, replay.blow.damageType)"
          >减伤 {{ formatMitigation(replay.blow.multiplier, replay.blow.multiplierPartial) }}</span>
          <StatusChips :target="replay.blow.targetStatuses" :source="replay.blow.sourceStatuses" :terms="replay.blow.mitigation" :max="12" />
        </div>
        <div v-else-if="death.cause === 'terrain'" class="blow">
          <span class="label warn">地形杀</span>
        </div>
        <div v-else-if="death.cause === 'other'" class="blow">
          <span class="label warn">{{ death.causeText }}</span>
        </div>
        <div v-else-if="death.cause === 'instant'" class="blow">
          <span class="label warn">即死</span>
          <span>「{{ death.causeAction }}」的即死效果，没有伤害数值</span>
        </div>
        <div v-else class="blow">
          <span class="label warn">没有伤害记录</span>
          <span>击倒者「{{ death.sourceName }}」</span>
        </div>
        <div class="totals dim">
          最后 {{ windowMs / 1000 }} 秒：受击 {{ replay.totals.hits }} 次，共 {{ replay.totals.damage.toLocaleString() }}<template v-if="replay.totals.shieldAbsorbed || replay.totals.shieldUncertain">（盾吸收 ≈{{ replay.totals.shieldAbsorbed.toLocaleString() }}<span v-if="replay.totals.shieldUncertain" title="部分条目只知道上限或下限，或不确定">，部分不确定</span>）</template>；治疗 {{ replay.totals.heals }} 次，有效 {{ replay.totals.healing.toLocaleString() }}<template v-if="replay.totals.overheal">，溢出 {{ replay.totals.overheal.toLocaleString() }}</template>
        </div>
      </header>

      <div class="controls">
        <span class="dim">时长</span>
        <button v-for="w in WINDOWS" :key="w" class="seg" :class="{ on: w === windowMs }" @click="windowMs = w">{{ w / 1000 }} 秒</button>
        <span class="gap" />
        <label><input v-model="show.hits" type="checkbox" />受击</label>
        <label><input v-model="show.heals" type="checkbox" />治疗</label>
        <label><input v-model="show.statuses" type="checkbox" />状态</label>
        <label :class="{ disabled: !show.statuses }" title="进食、姿态、舞伴等和受伤无关的状态"><input v-model="show.allStatuses" type="checkbox" :disabled="!show.statuses" />含无关状态</label>
        <label :class="{ disabled: !hasCasts }" :title="hasCasts ? '' : '这场存档没有读条记录（早于第五阶段）'"><input v-model="show.casts" type="checkbox" :disabled="!hasCasts" />敌方读条</label>
      </div>

      <HpChart :from="replay.from" :to="replay.to" :points="replay.hp" :max-hp="replay.maxHp" :marks="marks" :selected-key="selectedKey" @pick="(k) => pick(k, true)" />

      <div ref="list" class="events">
        <div class="line head">
          <span class="c-rel" title="距死亡的秒数；悬停一行看战斗时间">距死亡</span>
          <span class="c-type">类型</span>
          <span class="c-text">内容</span>
          <span class="c-amount">数值</span>
          <span class="c-extra" />
          <span class="c-mit">减伤</span>
          <span class="c-hp">之后 HP</span>
        </div>
        <div
          v-for="l in lines"
          :key="l.key"
          :data-key="l.key"
          class="line"
          :class="[l.kind, { selected: l.key === selectedKey || (l.rowId !== undefined && l.rowId === selectedRowId), clickable: l.rowId !== undefined }]"
          :title="`战斗时间 ${formatClock(l.time - (death.time - death.offset))}`"
          @click="pick(l.key)"
        >
          <span class="c-rel num">{{ ((l.time - replay.to) / 1000).toFixed(1) }}</span>
          <span class="c-type"><span class="badge">{{ l.type }}</span></span>
          <!-- Lines without numbers (death, cast, statuses lost with the death) give the text the number columns. -->
          <span class="c-text" :class="{ wide: WIDE.has(l.kind) }" :title="`${l.text}　${l.sub}`">
            <GameIcon v-if="l.icon" :icon-id="l.icon" class="sicon" />
            <span class="t">{{ l.text }}</span>
            <span class="dim sub">{{ l.sub }}</span>
          </span>
          <template v-if="!WIDE.has(l.kind)">
            <span class="c-amount num" :class="l.amountClass">{{ l.amount }}</span>
            <span class="c-extra dim" :class="l.category ? `cat ${l.category}` : ''">{{ l.extra }}</span>
            <span class="c-mit num" :style="l.mit ? { color: l.mit.color } : {}" :title="l.mit?.title">{{ l.mit?.text ?? "" }}</span>
          </template>
          <span class="c-hp">
            <template v-if="l.hp !== undefined">
              <span class="hpbar"><span :style="{ width: `${Math.round(l.hp * 100)}%` }" /></span>
              <span class="num">{{ Math.round(l.hp * 100) }}%</span>
            </template>
          </span>
        </div>
      </div>
    </section>
    <section v-else class="main empty dim">这场没有人死亡</section>
  </div>
</template>

<style scoped>
.deaths-tab {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.death-list {
  width: 176px;
  flex: none;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.title {
  padding: 6px 10px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--line);
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
}
.death-list li {
  display: grid;
  grid-template-columns: 36px 16px minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 6px;
  align-items: center;
  padding: 5px 10px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
}
.death-list li:hover {
  background: var(--hover);
}
.death-list li.selected {
  background: rgba(200, 60, 60, 0.28);
}
.death-list .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.death-list .ph {
  grid-column: 1;
  grid-row: 2;
  font-size: 11px;
  color: var(--text-dim);
}
.death-list .cause {
  grid-column: 3;
  grid-row: 2;
  font-size: 11px;
  color: #ffb4a8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.death-list .cause.unknown {
  color: var(--warn);
}
.death-list li.empty {
  display: block;
  cursor: default;
}
.main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 12px 0;
}
.main.empty {
  padding: 16px;
}
header {
  flex: none;
}
.sentence {
  font-size: 14px;
  color: #ffd9d4;
  margin-bottom: 4px;
}
.blow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin-bottom: 4px;
}
.label {
  color: var(--text-dim);
}
.label.warn {
  color: var(--warn);
}
.totals {
  margin-bottom: 6px;
}
.controls {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-bottom: 4px;
  white-space: nowrap;
}
.controls label {
  display: flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
}
.controls input[type="checkbox"] {
  margin: 0;
}
.controls label.disabled {
  opacity: 0.5;
  cursor: default;
}
.seg {
  padding: 0 6px;
}
.seg.on {
  background: rgba(108, 182, 255, 0.25);
  border-color: var(--accent);
}
.gap {
  width: 12px;
}
.events {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border-top: 1px solid var(--line);
}
.line {
  display: grid;
  grid-template-columns: 44px 64px minmax(110px, 1fr) 80px 84px 40px 72px;
  align-items: center;
  height: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}
.c-text.wide {
  grid-column: span 4;
}
.line > span {
  padding: 0 4px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.line.head {
  position: sticky;
  top: 0;
  background: #181a1f;
  color: var(--text-dim);
  z-index: 1;
}
.line.clickable {
  cursor: pointer;
}
.line:not(.head):hover {
  background: var(--hover);
}
.line.selected {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
  background: rgba(108, 182, 255, 0.16);
}
.line.dot {
  background: var(--row-dot);
}
.line.fatal,
.line.death {
  background: var(--row-death);
}
.line.cast {
  color: #f3c99a;
}
.line.lose,
.line.lost {
  color: var(--text-dim);
}
.badge {
  display: inline-block;
  min-width: 48px;
  text-align: center;
  font-size: 11px;
  border-radius: 2px;
  padding: 0 4px;
  background: rgba(255, 255, 255, 0.07);
}
.hit .badge,
.dot .badge,
.fatal .badge,
.death .badge {
  background: rgba(229, 112, 92, 0.3);
}
.heal .badge,
.hot .badge {
  background: rgba(111, 207, 127, 0.25);
}
.gain .badge,
.refresh .badge,
.stacks .badge {
  background: rgba(108, 182, 255, 0.2);
}
.unapplied .badge {
  background: rgba(229, 184, 92, 0.3);
}
.line.unapplied .t {
  color: var(--warn);
}
.cast .badge {
  background: rgba(229, 162, 92, 0.3);
}
.c-text {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* The name keeps its room; the source / duration after it gives way first. */
.c-text .t {
  flex: 0 0 auto;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.c-text .sub {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sicon {
  width: 13px;
  height: 16px;
  flex: none;
  object-fit: contain;
}
.num {
  font-family: var(--mono);
  text-align: right;
}
.head .c-rel,
.head .c-amount,
.head .c-mit {
  text-align: right;
}
.line.head {
  cursor: default;
}
.neg {
  color: #ff9a8a;
}
.pos {
  color: #9be3a6;
}
.c-extra {
  font-size: 11px;
}
.cat.mitigation {
  color: var(--cat-mitigation);
}
.cat.shield {
  color: var(--cat-shield);
}
.cat.vulnerability,
.cat.damageUp {
  color: var(--cat-vuln);
}
.cat.invuln {
  color: var(--cat-invuln);
}
.cat.damageDown {
  color: var(--cat-source);
}
.c-hp {
  display: flex;
  align-items: center;
  gap: 4px;
}
.hpbar {
  flex: 1;
  height: 6px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 1px;
  overflow: hidden;
}
.hpbar > span {
  display: block;
  height: 100%;
  background: var(--ok);
}
.c-hp .num {
  width: 32px;
  font-size: 11px;
}
.dim {
  color: var(--text-dim);
}
</style>
