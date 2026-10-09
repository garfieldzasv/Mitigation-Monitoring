<script setup lang="ts">
import type { MemberSkillStates } from "@/core/replay/partySkills";
import InfoTip from "../common/InfoTip.vue";
import JobIcon from "../common/JobIcon.vue";
import SkillIcon from "./SkillIcon.vue";

/**
 * The detail panel's 队伍减伤状态 (docs/DESIGN.md 8.2): every member's mitigation skills at the row's moment, by member,
 * the row's player marked. In effect, on cooldown and ready look apart (SkillIcon), told by the legend on the info icon;
 * the ready ones are what was there and not used.
 */
defineProps<{ members: MemberSkillStates[]; time: number; targetId: string }>();
</script>

<template>
  <section class="party-skills">
    <h3>
      队伍减伤状态
      <InfoTip class="legend-tip" label="图例" :width="200" :size="13" align="left">
        <p><span class="gold">金色数字</span>生效剩余秒数</p>
        <p><span class="white">白色数字</span>冷却剩余秒数</p>
        <p>无数字为可用</p>
      </InfoTip>
    </h3>
    <ul>
      <li v-for="m in members" :key="m.player.id" :class="{ target: m.player.id === targetId }">
        <JobIcon :job-id="m.player.job" :size="16" />
        <span class="name" :title="m.player.name">{{ m.player.name }}</span>
        <div class="icons">
          <SkillIcon v-for="s in m.skills" :key="s.skill.id" :state="s" :time="time" />
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.party-skills {
  margin-bottom: 12px;
}
h3 {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 6px;
}
p {
  margin: 0;
}
.gold {
  color: #ffd34d;
}
.white {
  color: #fff;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: grid;
  grid-template-columns: 16px 80px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 3px;
}
li.target {
  background: rgba(108, 182, 255, 0.12);
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.icons {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
</style>
