<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { iconPath } from "@/core/game/icons";

const props = defineProps<{ iconId: number; alt?: string }>();

const failed = ref(false);
watch(
  () => props.iconId,
  () => (failed.value = false),
);
const src = computed(() => (failed.value ? "" : iconPath(props.iconId)));
</script>

<template>
  <img v-if="src" :src="src" :alt="alt" draggable="false" @error="failed = true" />
  <span v-else class="placeholder" :title="alt" />
</template>

<style scoped>
img {
  user-select: none;
}

.placeholder {
  display: block;
  background: linear-gradient(135deg, #3a3f4b, #22252c);
}
</style>
