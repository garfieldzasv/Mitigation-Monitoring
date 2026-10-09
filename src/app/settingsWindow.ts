import { pageUrl } from "./composables/useUrlParams";

/**
 * The settings window (docs/DESIGN.md 7.3): a small popup, like Skills Monitoring's settings. It
 * writes localStorage; the monitor picks the change up at once (useSettings).
 */
const WINDOW_NAME = "mitigation-monitoring-settings";

export function openSettingsWindow(): void {
  window.open(pageUrl("/settings"), WINDOW_NAME, "width=500,height=720");
}
