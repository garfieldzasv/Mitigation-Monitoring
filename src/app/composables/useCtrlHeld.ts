import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * Whether Ctrl is held: what unlocks a destructive button (清空). Followed on keys and on the mouse (Ctrl pressed while
 * another window had the focus); let go when the window loses the focus.
 */
export function useCtrlHeld() {
  const held = ref(false);
  const onKey = (e: KeyboardEvent) => (held.value = e.ctrlKey);
  const onMouse = (e: MouseEvent) => (held.value = e.ctrlKey);
  const release = () => (held.value = false);
  onMounted(() => {
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("mousemove", onMouse);
    window.addEventListener("blur", release);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKey);
    window.removeEventListener("mousemove", onMouse);
    window.removeEventListener("blur", release);
  });
  return held;
}
