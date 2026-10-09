import { hexId, type OverlayCombatant } from "@/core/overlay/combatants";

export type { OverlayCombatant };

/**
 * Runtime checks for ACT's embedded browser (docs/DESIGN.md 11.2): storage persistence on this
 * origin, the review window's channels, and CompressionStream. Diagnostic only.
 */
export const PROBE_CHANNEL = "mitigation-monitoring:probe";
export const PROBE_POPUP_NAME = "mitigation-monitoring-probe";
const PROBE_DB = "mitigation-monitoring-probe";
const LAST_OPEN_KEY = "mitigation-monitoring:probe:last-open";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** What the popup reports back to the opener. */
export interface PopupReport {
  via?: "BroadcastChannel" | "postMessage";
  hasOverlayPluginApi: boolean;
  hasOpener: boolean;
  openerReadable: boolean;
  localStorageValue: string | null;
  indexedDbValue: string | null;
  broadcastChannel: boolean;
  error?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function environment(): Record<string, string> {
  const chrome = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "?";
  return {
    protocol: location.protocol,
    origin: location.origin,
    chrome,
    overlayPluginApi: String(Boolean((window as { OverlayPluginApi?: unknown }).OverlayPluginApi)),
  };
}

/** Reads what the previous run wrote, then writes `now`: run, restart ACT, run again. */
export function checkLocalStorage(now: string): CheckResult {
  try {
    const previous = localStorage.getItem(LAST_OPEN_KEY);
    localStorage.setItem(LAST_OPEN_KEY, now);
    const back = localStorage.getItem(LAST_OPEN_KEY);
    return { name: "localStorage", ok: back === now, detail: `上次写入：${previous ?? "无"}` };
  } catch (err) {
    return { name: "localStorage", ok: false, detail: message(err) };
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PROBE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
    req.onblocked = () => reject(new Error("open blocked"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("request failed"));
  });
}

export async function readIndexedDb(): Promise<string | null> {
  const db = await openDb();
  try {
    const value = await request(db.transaction("kv").objectStore("kv").get(LAST_OPEN_KEY));
    return typeof value === "string" ? value : null;
  } finally {
    db.close();
  }
}

export async function checkIndexedDb(now: string): Promise<CheckResult> {
  try {
    if (typeof indexedDB === "undefined") return { name: "IndexedDB", ok: false, detail: "不存在" };
    const previous = await readIndexedDb();
    const db = await openDb();
    try {
      await request(db.transaction("kv", "readwrite").objectStore("kv").put(now, LAST_OPEN_KEY));
    } finally {
      db.close();
    }
    const back = await readIndexedDb();
    return { name: "IndexedDB", ok: back === now, detail: `上次写入：${previous ?? "无"}` };
  } catch (err) {
    return { name: "IndexedDB", ok: false, detail: message(err) };
  }
}

export async function checkStorageEstimate(): Promise<CheckResult> {
  try {
    const storage = navigator.storage;
    if (!storage?.estimate) return { name: "存储配额", ok: false, detail: "navigator.storage.estimate 不存在" };
    const { usage = 0, quota = 0 } = await storage.estimate();
    const persisted = storage.persisted ? await storage.persisted() : false;
    const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
    return { name: "存储配额", ok: quota > 100 * 1048576, detail: `已用 ${mb(usage)} / 配额 ${mb(quota)}，persisted=${persisted}` };
  } catch (err) {
    return { name: "存储配额", ok: false, detail: message(err) };
  }
}

/** Gzips about 1 MB of log-like text and back, timing it. */
export async function checkCompression(): Promise<CheckResult> {
  if (typeof CompressionStream === "undefined" || typeof DecompressionStream === "undefined") {
    return { name: "CompressionStream", ok: false, detail: "不存在：存档将不压缩" };
  }
  try {
    const sample =
      "22|2026-09-20T00:25:28.9250000+08:00|400117E3|护锁刃龙|AB6E|咆哮|10031B3B|P6|750003|7E330000|1B|AB6E8000|0|0|0|0|0|0|0|0|0|0|0|0|181558|181558|10000|10000|||99.90|97.15|0.00|-3.11\n";
    const text = sample.repeat(Math.ceil(1048576 / sample.length));
    const t0 = performance.now();
    const gz = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    const back = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    const ms = Math.round(performance.now() - t0);
    return {
      name: "CompressionStream",
      ok: back === text,
      detail: `${Math.round(text.length / 1024)} KB → ${Math.round(gz.byteLength / 1024)} KB，往返 ${ms} ms`,
    };
  } catch (err) {
    return { name: "CompressionStream", ok: false, detail: message(err) };
  }
}

export interface CombatantSummary {
  total: number;
  first: string;
  players: { id: string; name: string; job: number; partyType: number | null }[];
  partyTypeCounts: Record<string, number>;
}

/**
 * What `getCombatants` could stand in for when PartyChanged / ChangePrimaryPlayer never arrive:
 * the players around, their jobs, a party marker, and whether the first entry is the player.
 */
export function summarizeCombatants(list: readonly OverlayCombatant[]): CombatantSummary {
  const players = list
    .filter((c) => c.Type === 1)
    .map((c) => ({ id: hexId(c.ID), name: c.Name ?? "", job: c.Job ?? 0, partyType: c.PartyType ?? null }));
  const partyTypeCounts: Record<string, number> = {};
  for (const p of players) {
    const key = String(p.partyType);
    partyTypeCounts[key] = (partyTypeCounts[key] ?? 0) + 1;
  }
  const head = list[0];
  return {
    total: list.length,
    first: head ? `${head.Name ?? ""} (Type=${head.Type ?? "?"}, ID=${hexId(head.ID)})` : "",
    players,
    partyTypeCounts,
  };
}

/** Run inside the popup: what it can see of ACT, the opener and shared storage. */
export async function collectPopupReport(): Promise<PopupReport> {
  const report: PopupReport = {
    hasOverlayPluginApi: Boolean((window as { OverlayPluginApi?: unknown }).OverlayPluginApi),
    hasOpener: Boolean(window.opener),
    openerReadable: false,
    localStorageValue: null,
    indexedDbValue: null,
    broadcastChannel: typeof BroadcastChannel !== "undefined",
  };
  try {
    report.openerReadable = typeof (window.opener as Window | null)?.location.href === "string";
  } catch {
    report.openerReadable = false;
  }
  try {
    report.localStorageValue = localStorage.getItem(LAST_OPEN_KEY);
    report.indexedDbValue = await readIndexedDb();
  } catch (err) {
    report.error = message(err);
  }
  return report;
}
