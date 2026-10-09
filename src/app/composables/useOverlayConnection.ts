import { onScopeDispose, readonly, ref, type Ref } from "vue";
import { connectionState, onConnectionState, type ConnectionState } from "@/core/overlay/overlayApi";

/**
 * The OverlayPlugin connection as a ref that follows it (docs/DESIGN.md 7.1). Never decide this
 * once at load: inside ACT the API is injected after the page loads.
 */
export function useOverlayConnection(): Readonly<Ref<ConnectionState>> {
  const state = ref<ConnectionState>(connectionState());
  onScopeDispose(onConnectionState((next) => (state.value = next)));
  return readonly(state);
}
