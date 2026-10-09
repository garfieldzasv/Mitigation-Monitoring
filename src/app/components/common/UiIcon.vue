<script setup lang="ts">
/**
 * The app's own icons, drawn inline so they stay sharp at any size and take the text colour: a skull for deaths (the
 * ☠ glyph depends on the font and blurs at 12 px), an "i" in a circle for the notes, a gear for the settings.
 */
defineProps<{ name: "death" | "info" | "gear"; size?: number }>();

const PATHS = {
  // A skull: cranium and jaw with teeth notches; eyes and nose cut out (even-odd).
  death:
    "M12 2C7 2 3.5 5.6 3.5 10.2c0 2.6 1.1 4.6 3 5.9V19a1 1 0 0 0 1 1H9v-2h1.5v2h3v-2H15v2h1.5a1 1 0 0 0 1-1v-2.9c1.9-1.3 3-3.3 3-5.9C20.5 5.6 17 2 12 2Zm-3.5 7.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM12 13.6l1.2 2.2h-2.4L12 13.6Z",
  // A ring, a dot and a bar.
  info: "M12 1.8a10.2 10.2 0 1 0 0 20.4 10.2 10.2 0 1 0 0-20.4Zm0 1.9a8.3 8.3 0 1 1 0 16.6 8.3 8.3 0 1 1 0-16.6ZM10.9 10.2h2.2v7.4h-2.2ZM12 5.9a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 1 0 0-2.7Z",
  // Eight teeth around a hole.
  gear: "M19.48 8.9L19.92 10.32L22.5 10.52L22.5 13.48L19.92 13.68L19.48 15.1L18.79 16.41L20.47 18.38L18.38 20.47L16.41 18.79L15.1 19.48L13.68 19.92L13.48 22.5L10.52 22.5L10.32 19.92L8.9 19.48L7.59 18.79L5.62 20.47L3.53 18.38L5.21 16.41L4.52 15.1L4.08 13.68L1.5 13.48L1.5 10.52L4.08 10.32L4.52 8.9L5.21 7.59L3.53 5.62L5.62 3.53L7.59 5.21L8.9 4.52L10.32 4.08L10.52 1.5L13.48 1.5L13.68 4.08L15.1 4.52L16.41 5.21L18.38 3.53L20.47 5.62L18.79 7.59Z M15.4 12a3.4 3.4 0 1 0-6.8 0a3.4 3.4 0 1 0 6.8 0Z",
} as const;
</script>

<template>
  <svg class="ui-icon" :class="`ui-icon-${name}`" viewBox="0 0 24 24" :width="size ?? 12" :height="size ?? 12" aria-hidden="true">
    <path :d="PATHS[name]" fill="currentColor" fill-rule="evenodd" />
  </svg>
</template>

<style scoped>
.ui-icon {
  display: inline-block;
  flex: none;
  vertical-align: -0.15em;
}
</style>
