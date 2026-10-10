<script setup lang="ts">
import { computed } from "vue";
import { inEffectOrder, type DamageRow, type DeathRow, type Row } from "@/core/engine/types";
import { sourceLabel } from "@/core/filter/rowFilter";
import { isListedStatus, statusIconId } from "@/core/game/statuses";
import { termApplies } from "@/core/mitigation/multiplier";
import { partySkillsAt, type PartySkills as PartySkillsModel } from "@/core/replay/partySkills";
import { groupRow, inSharedGroup } from "@/core/replay/shieldLines";
import type { StatusSnap } from "@/core/status/statusTracker";
import GameIcon from "../common/GameIcon.vue";
import JobIcon from "../common/JobIcon.vue";
import PartySkills from "./PartySkills.vue";
import UiIcon from "../common/UiIcon.vue";
import {
  absorbedText,
  absorbedTitle,
  damageKindLabel,
  deathSentence,
  formatClock,
  hpAfterOf,
  formatMitigation,
  formatRemaining,
  formatWallClock,
  mitigationTitle,
  percentOfMax,
  STATUS_CATEGORY_LABEL,
  formatUnmitigated,
  shieldAfterOf,
  unmitigatedTitle,
  verdictLabel,
} from "../../format";

/**
 * The review window's detail panel (docs/DESIGN.md 8.2): everything about one row. For a hit: the
 * damage, the mitigation breakdown, every status on the player and on the enemy at that moment,
 * and the other players hit by the same cast. For a death: the killing blow and the hits before it. For both, the
 * party's mitigation skills at that moment: in effect, on cooldown, or ready and unused.
 */
const props = defineProps<{ row: Row; rows: Row[]; byId: Map<number, Row>; partySkills?: PartySkillsModel | undefined }>();
const emit = defineEmits<{ select: [id: number]; close: []; "open-death": [id: number] }>();

const hit = computed(() => (props.row.kind === "death" ? undefined : props.row));
const death = computed(() => (props.row.kind === "death" ? props.row : undefined));

/** Same cast, everyone it hit. */
const sameCast = computed(() => {
  const h = hit.value;
  if (!h?.seq || (h.targetCount ?? 1) < 2) return [];
  return props.rows.filter((r): r is DamageRow => r.kind !== "death" && r.seq === h.seq);
});

/** The hits the shield reports cannot tell apart from this one, as one line (core/replay/shieldLines.ts). */
const group = computed(() => {
  const h = hit.value;
  return h && inSharedGroup(h) ? groupRow(h.shieldGroup!, h.shieldGroup!.rows) : undefined;
});
/** The shields on at the hit and after it (the group's, for a hit sharing one). */
const shieldSpan = computed(() => {
  const r = group.value ?? hit.value;
  const g = r?.shieldGroup;
  if (!r || !g) return undefined;
  const after = shieldAfterOf(r);
  return { before: g.before, after };
});

const blow = computed(() => (death.value ? (props.byId.get(death.value.killerRowId ?? -1) as DamageRow | undefined) : undefined));
/** The hits before a death; the death replay tab has heals, statuses and the HP curve. */
const before = computed(() => {
  const d = death.value;
  if (!d) return [];
  return inEffectOrder(props.rows.filter((r): r is DamageRow => r.kind !== "death" && r.target.id === d.target.id && r.time <= d.time))
    .slice(-8)
    .reverse();
});

const breakdown = computed(() => {
  const h = hit.value;
  return h ? mitigationTitle(h.mitigation, h.multiplier, h.multiplierPartial, h.damageType).split("\n") : [];
});

function statusLines(list: StatusSnap[], side: "target" | "source", terms: DamageRow["mitigation"]) {
  const termOf = new Map(terms.map((t) => [`${t.side}:${t.statusId}`, t]));
  return list
    .filter((s) => isListedStatus(s.id))
    .sort((a, b) => Number(a.category === "other") - Number(b.category === "other"))
    .map((s) => ({
      s,
      icon: statusIconId(s.id, s.stacks),
      category: STATUS_CATEGORY_LABEL[s.category],
      inactive: s.category !== "other" && !termApplies(termOf.get(`${side}:${s.id}`)),
      remaining: formatRemaining(s.remainingMs),
    }));
}
const targetStatuses = computed(() => (hit.value ? statusLines(hit.value.targetStatuses, "target", hit.value.mitigation) : []));
const sourceStatuses = computed(() => (hit.value ? statusLines(hit.value.sourceStatuses, "source", hit.value.mitigation) : []));

/** The own party's members (24-player duties: the other parties' skills are not known to reach), and the row's player. */
const skills = computed(() =>
  props.partySkills
    ? partySkillsAt(props.partySkills, props.row.time).filter((m) => (m.player.inParty || m.player.id === props.row.target.id) && m.skills.length > 0)
    : [],
);

const VERDICT: Record<DamageRow["result"], string> = { hit: "命中", block: "格挡", parry: "招架", miss: "闪避" };
</script>

<template>
  <aside class="detail">
    <header>
      <JobIcon :job-id="row.target.job" :size="22" />
      <div class="head">
        <div class="who">{{ row.target.name }}</div>
        <div class="dim">{{ formatClock(row.offset) }}　{{ formatWallClock(row.time) }}</div>
      </div>
      <button class="close" title="关闭详情" @click="emit('close')">✕</button>
    </header>

    <template v-if="hit">
      <section>
        <h3>{{ hit.action.name }} <span class="dim">← {{ sourceLabel(hit) }}</span></h3>
        <dl>
          <dt>伤害</dt>
          <dd><span :class="{ crit: hit.crit }">{{ hit.amount.toLocaleString() }}{{ hit.crit ? "!" : "" }}</span><span v-if="hit.crit" class="crit"> 暴击</span><span v-if="hit.direct"> 直击</span>　<span class="dim">占最大 HP {{ percentOfMax(hit.amount, hit.maxHp) }}</span></dd>
          <dt>类型</dt>
          <dd>
            {{ damageKindLabel(hit) }}　{{ hit.noEffect ? "未生效" : hit.fullyAbsorbed ? `${hit.result === "hit" ? "" : VERDICT[hit.result] + "，"}被盾全部吸收` : VERDICT[hit.result] }}{{ hit.invulnerable ? "　无敌中" : "" }}
          </dd>
          <template v-if="hit.shieldGroup">
            <dt>盾吸收</dt>
            <dd :title="absorbedTitle(hit)">
              {{ absorbedText(hit) }}<span v-if="group" class="dim">（同组 {{ group.members.length }} 下合计）</span>
            </dd>
            <dt>盾量</dt>
            <dd>
              {{ shieldSpan?.before === undefined ? "?" : shieldSpan.before ? `≈${shieldSpan.before.toLocaleString()}` : "0" }} →
              {{ shieldSpan?.after === undefined ? "?" : shieldSpan.after ? `≈${shieldSpan.after.toLocaleString()}` : "0" }}
              <span class="dim">{{ hit.amount > 0 ? `打穿 ${hit.amount.toLocaleString()}` : "未打穿" }}</span>
            </dd>
          </template>
          <dt>HP</dt>
          <dd v-if="hit.noEffect" class="dim" title="这次伤害未生效">未生效</dd>
          <dd v-else>
            {{ hit.hpBefore.toLocaleString() }}（{{ percentOfMax(hit.hpBefore, hit.maxHp) }}）→
            <template v-if="hpAfterOf(hit) !== undefined">{{ hpAfterOf(hit)!.toLocaleString() }}（{{ percentOfMax(hpAfterOf(hit), hit.maxHp) }}）</template>
            <span v-else class="dim">不确定</span>
            <span class="dim">/ {{ hit.maxHp.toLocaleString() }}</span>
          </dd>
          <dt>减伤</dt>
          <dd>{{ formatMitigation(hit.multiplier, hit.multiplierPartial) }}</dd>
          <dt>未减伤估算</dt>
          <dd>
            {{ formatUnmitigated(hit) || (hit.noEffect ? "未生效" : group ? "见同组合计" : "—") }}
            <div v-if="unmitigatedTitle(hit)" class="dim pre">{{ unmitigatedTitle(hit) }}</div>
          </dd>
          <dt v-if="hit.seq">命中</dt>
          <dd v-if="hit.seq" class="dim">{{ hit.targetCount }} 人</dd>
        </dl>
      </section>

      <section>
        <h3>减伤明细</h3>
        <ul class="plain">
          <li v-for="(line, i) in breakdown" :key="i" :class="{ total: i === breakdown.length - 1 }">{{ line }}</li>
        </ul>
      </section>


      <section>
        <h3>受击者状态（{{ targetStatuses.length }}）</h3>
        <ul class="statuses">
          <li v-for="x in targetStatuses" :key="`${x.s.id}:${x.s.sourceId}`" :class="{ other: x.s.category === 'other', inactive: x.inactive }">
            <GameIcon v-if="x.icon" :icon-id="x.icon" class="sicon" /><span v-else class="sicon" />
            <span class="sname">{{ x.s.name }}{{ x.s.stacks > 1 ? ` ×${x.s.stacks}` : "" }}</span>
            <span class="cat" :class="x.s.category">{{ x.inactive ? "不生效" : x.category }}</span>
            <span class="dim rem">{{ x.remaining }}</span>
            <span class="dim src" :title="x.s.sourceName">{{ x.s.sourceName }}</span>
          </li>
          <li v-if="targetStatuses.length === 0" class="dim none">无</li>
        </ul>
      </section>

      <section>
        <h3>来源状态（{{ sourceStatuses.length }}）</h3>
        <ul class="statuses">
          <li v-for="x in sourceStatuses" :key="`${x.s.id}:${x.s.sourceId}`" :class="{ other: x.s.category === 'other', inactive: x.inactive }">
            <GameIcon v-if="x.icon" :icon-id="x.icon" class="sicon" /><span v-else class="sicon" />
            <span class="sname">{{ x.s.name }}{{ x.s.stacks > 1 ? ` ×${x.s.stacks}` : "" }}{{ x.s.inherited ? "（继承）" : "" }}</span>
            <span class="cat" :class="x.s.category">{{ x.inactive ? "不生效" : x.category }}</span>
            <span class="dim rem">{{ x.remaining }}</span>
            <span class="dim src" :title="x.s.sourceName">{{ x.s.sourceName }}</span>
          </li>
          <li v-if="sourceStatuses.length === 0" class="dim none">无</li>
        </ul>
      </section>

      <section v-if="group">
        <h3>同组受击（{{ group.members.length }} 下）<span class="dim">与同一时段的多次合计</span></h3>
        <ul class="cast group">
          <li v-for="r in group.members" :key="r.id" :class="{ current: r.id === row.id }" @click="emit('select', r.id)">
            <span class="num dim">{{ formatClock(r.offset) }}</span>
            <span class="sname">{{ r.action.name }}</span>
            <span class="num">{{ r.amount.toLocaleString() }}</span>
            <span class="dim verdict">{{ verdictLabel(r) }}</span>
          </li>
        </ul>
        <p class="dim">
          合计伤害 {{ group.amount.toLocaleString() }}，盾吸收 <span :title="absorbedTitle(group)">{{ absorbedText(group) }}</span>，未减伤估算
          <span :title="unmitigatedTitle(group)">{{ formatUnmitigated(group) || "—" }}</span>
        </p>
      </section>

      <section v-if="sameCast.length > 1">
        <h3>命中（{{ sameCast.length }}）</h3>
        <ul class="cast same">
          <li v-for="r in sameCast" :key="r.id" :class="{ current: r.id === row.id }" @click="emit('select', r.id)">
            <JobIcon :job-id="r.target.job" :size="16" />
            <span class="sname">{{ r.target.name }}</span>
            <span class="num">{{ r.amount.toLocaleString() }}</span>
            <span class="num dim" :title="absorbedTitle(r)">{{ absorbedText(r) ? `盾${absorbedText(r)}` : "" }}</span>
            <span class="num">{{ formatMitigation(r.multiplier, r.multiplierPartial) }}</span>
          </li>
        </ul>
      </section>
    </template>

    <template v-else-if="death">
      <section>
        <h3 class="deathline"><UiIcon name="death" /> {{ deathSentence(death, blow) }}</h3>
        <p v-if="death.overkill" class="dim">溢出 {{ death.overkill.toLocaleString() }}</p>
        <p v-if="blow"><button class="link" @click="emit('select', blow.id)">查看致命一击（{{ formatClock(blow.offset) }}）</button></p>
      </section>
      <section>
        <h3>死亡前最后 {{ before.length }} 次受击</h3>
        <ul class="cast before">
          <li
            v-for="r in before"
            :key="r.id"
            :class="{ current: r.id === death.killerRowId, none: r.noEffect }"
            :title="r.noEffect ? '这次伤害未生效' : undefined"
            @click="emit('select', r.id)"
          >
            <span class="num dim">{{ formatClock(r.offset) }}</span>
            <span class="sname">{{ r.action.name }}</span>
            <span class="num">{{ r.amount.toLocaleString() }}</span>
            <span class="num dim">{{ r.noEffect ? "未生效" : percentOfMax(r.hpBefore, r.maxHp) }}</span>
            <span class="num">{{ r.noEffect ? "—" : formatMitigation(r.multiplier, r.multiplierPartial) }}</span>
          </li>
        </ul>
        <p><button class="link" @click="emit('open-death', death.id)">在死亡回放里查看（治疗、状态变化、HP 曲线）</button></p>
      </section>
    </template>

    <PartySkills v-if="skills.length" :members="skills" :time="row.time" :target-id="row.target.id" />
  </aside>
</template>

<style scoped>
.detail {
  width: 360px;
  flex: none;
  overflow-y: auto;
  border-left: 1px solid var(--line);
  padding: 10px 12px;
  user-select: text;
}
header {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}
.who {
  font-size: 14px;
}
.head {
  flex: 1;
  min-width: 0;
}
.close {
  align-self: flex-start;
  border: 0;
  background: none;
  color: var(--text-dim);
  padding: 0 4px;
}
section {
  margin-bottom: 12px;
}
h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 6px;
}
dl {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 3px 8px;
  margin: 0;
}
dt {
  color: var(--text-dim);
}
dd {
  margin: 0;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.plain li {
  padding: 1px 0;
}
.plain li.total {
  margin-top: 3px;
  padding-top: 3px;
  border-top: 1px solid var(--line);
}
/* Fixed columns, shared by both status lists, so category, time and caster line up across them. */
.statuses li,
.cast li {
  display: grid;
  align-items: center;
  gap: 6px;
  height: 22px;
}
.statuses li {
  grid-template-columns: 15px minmax(0, 1fr) 42px 52px 72px;
}
.statuses li.none {
  display: block;
}
.cast.same li {
  grid-template-columns: 16px minmax(0, 1fr) 64px 96px 40px;
}
/* 判定 as wide as the damage table's, for "格挡·全吸收" on one line. */
.cast.group li {
  grid-template-columns: 40px minmax(0, 1fr) 64px 76px;
}
.cast.group .verdict {
  white-space: nowrap;
}
.pre {
  white-space: pre-line;
}
.cast.before li {
  grid-template-columns: 40px minmax(0, 1fr) 64px 36px 40px;
}
.rem {
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
}
.statuses li.other {
  opacity: 0.6;
}
.statuses li.inactive .sicon {
  filter: grayscale(1);
  opacity: 0.5;
}
.sicon {
  width: 15px;
  height: 18px;
  flex: none;
  object-fit: contain;
}
.sname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cat {
  text-align: center;
  font-size: 11px;
  white-space: nowrap;
}
.cat.mitigation {
  color: var(--cat-mitigation);
}
.cat.shield {
  color: var(--cat-shield);
}
.cat.damageDown {
  color: var(--cat-source);
}
.cat.vulnerability,
.cat.damageUp {
  color: var(--cat-vuln);
}
.cat.invuln {
  color: var(--cat-invuln);
}
.src {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.cast li {
  cursor: pointer;
  padding: 0 4px;
  border-radius: 3px;
}
.cast li:hover {
  background: var(--hover);
}
.cast li.current {
  background: rgba(108, 182, 255, 0.18);
}
.cast li.none {
  color: var(--text-dim);
}
.num {
  font-family: var(--mono);
  text-align: right;
}
.dim {
  color: var(--text-dim);
}
.crit {
  color: var(--bad);
}
.deathline {
  color: #ffb4a8;
}
</style>
