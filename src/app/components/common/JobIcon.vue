<script setup lang="ts">
import { computed } from "vue";
import { getJob, jobIconId } from "@/core/game/jobs";
import GameIcon from "./GameIcon.vue";

/**
 * A job as its game icon, the job's name on hover, or the player's and the job's when `name` is given (the monitor shows
 * no names: two players of one job tell apart by it). Unknown jobs (0) show the placeholder.
 */
const props = defineProps<{ jobId: number; size?: number; name?: string }>();
const job = computed(() => getJob(props.jobId));
const title = computed(() => (props.name ? (job.value ? `${props.name}（${job.value.name}）` : props.name) : job.value?.name));
const px = computed(() => `${props.size ?? 18}px`);
</script>

<template>
  <GameIcon :icon-id="jobIconId(jobId)" :alt="job?.abbr" :title="title" class="job-icon" />
</template>

<style scoped>
.job-icon {
  display: block;
  width: v-bind(px);
  height: v-bind(px);
}
</style>
