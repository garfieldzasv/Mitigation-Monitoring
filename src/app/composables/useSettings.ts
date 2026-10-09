import { readonly, ref, type DeepReadonly, type Ref } from "vue";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "@/core/settings/settings";

/**
 * Settings shared by every window (docs/DESIGN.md 7.3): stored in localStorage, and announced on a
 * BroadcastChannel when changed so the monitor applies them at once (the `storage` event is the
 * fallback). Storage can throw in embedded browsers; settings then live in memory for this window.
 */
const STORAGE_KEY = "mitigation-monitoring:settings";
const CHANNEL = "mitigation-monitoring:settings";

interface SettingsStore {
  state: Ref<Settings>;
  save(next: Settings): void;
}

let store: SettingsStore | undefined;

function load(): Settings {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeSettings(undefined);
  }
}

function createStore(): SettingsStore {
  const state = ref<Settings>(load());
  const reload = () => (state.value = load());
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : undefined;
  if (channel) channel.onmessage = reload;
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) reload();
  });
  return {
    state,
    save(next) {
      state.value = next;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // this window only
      }
      channel?.postMessage("changed");
    },
  };
}

export function useSettings() {
  const s = (store ??= createStore());
  return {
    settings: readonly(s.state) as DeepReadonly<Ref<Settings>>,
    update(patch: Partial<Settings>): void {
      s.save(normalizeSettings({ ...s.state.value, ...patch }));
    },
    reset(): void {
      s.save(normalizeSettings(DEFAULT_SETTINGS));
    },
  };
}
