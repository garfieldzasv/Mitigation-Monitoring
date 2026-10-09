/**
 * Icon IDs map to `icons/{group}/{id}.png`, the same layout as the game's `ui/icon` folder
 * (e.g. 806 → icons/000000/000806.png). Paths are relative to the page so they work under any
 * GitHub Pages base path.
 */
export function iconPath(iconId: number): string {
  if (!Number.isFinite(iconId) || iconId <= 0) return "";
  const id = Math.trunc(iconId);
  const group = Math.floor(id / 1000) * 1000;
  return `icons/${String(group).padStart(6, "0")}/${String(id).padStart(6, "0")}.png`;
}
