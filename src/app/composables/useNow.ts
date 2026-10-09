import { onBeforeUnmount, ref, watch, type Ref } from "vue";

/** The current time, refreshed every `intervalMs` only while `active` is true. */
export function useNow(active: Ref<boolean>, intervalMs = 1000): Ref<number> {
  const now = ref(Date.now());
  let timer: number | undefined;
  const stop = () => window.clearInterval(timer);
  watch(
    active,
    (on) => {
      stop();
      now.value = Date.now();
      if (on) timer = window.setInterval(() => (now.value = Date.now()), intervalMs);
    },
    { immediate: true },
  );
  onBeforeUnmount(stop);
  return now;
}
