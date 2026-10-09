import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { decodeLines } from "@/core/archive/codec";
import { replayArchive } from "@/core/archive/replay";
import { groupSessions, type ArchiveMeta } from "@/core/archive/types";
import { summarize } from "@/core/archive/writer";
import type { Encounter, Row } from "@/core/engine/types";
import type { ReplayDetail } from "@/core/replay/detail";
import { archiveStore, openArchiveChannel, type ArchiveMessage } from "../archive";

export interface LoadedEncounter {
  meta: ArchiveMeta;
  encounter: Encounter;
  /** Rows of players in the archive's scope, in time order. */
  rows: Row[];
  byId: Map<number, Row>;
  selfId: string | undefined;
  /** Heals, status changes, HP and enemy casts, for the death replay. */
  detail: ReplayDetail;
}

/** A recorded encounter is reloaded at most this often while the monitor keeps writing it. */
const RELOAD_MS = 3000;

/**
 * The review window's view of the archive (docs/DESIGN.md 8): the 复盘 list (each zone visit's pulls together), and
 * the selected pull rebuilt from its raw lines with the monitor's engine. Pinning and deleting go by 复盘. Follows the monitor's writes over
 * the BroadcastChannel, so an encounter still being fought updates as it goes.
 */
export function useReviewArchive() {
  const store = archiveStore();
  const list = ref<ArchiveMeta[]>([]);
  /** 复盘, newest first, each with its pulls oldest first. */
  const sessions = computed(() => groupSessions(list.value));
  const selectedId = ref<string>();
  const loaded = shallowRef<LoadedEncounter>();
  const loading = ref(false);
  const error = ref("");

  async function refresh(): Promise<void> {
    try {
      list.value = await store.list();
    } catch (err) {
      error.value = `读取存档失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Each load takes a ticket; only the latest one may publish its result. */
  let ticket = 0;

  async function load(id: string): Promise<void> {
    const mine = ++ticket;
    const current = () => mine === ticket;
    loading.value = true;
    try {
      const meta = await store.get(id);
      const chunks = meta ? await store.chunks(id) : [];
      const lines = await decodeLines(chunks);
      if (!current()) return; // another encounter was selected meanwhile
      if (!meta) {
        loaded.value = undefined;
        error.value = "这场存档已经不在了（可能超出保留数量被清理）";
        return;
      }
      const replay = replayArchive(meta, lines);
      if (!replay.encounter) {
        loaded.value = undefined;
        error.value = "存档里没有找到这场战斗的开始";
        return;
      }
      const rows = replay.encounter.rows.filter((r) => replay.visible(r.target.id, r.target.name));
      void refreshSummary(meta, summarize(replay.encounter, replay.visible));
      loaded.value = {
        meta,
        encounter: replay.encounter,
        rows,
        byId: new Map(rows.map((r) => [r.id, r])),
        selfId: meta.self?.id,
        detail: replay.detail,
      };
      // A chunk whose write failed (storage full) leaves a gap: what it held is missing from the review.
      error.value = chunks.length < meta.chunkCount ? `这场存档缺少 ${meta.chunkCount - chunks.length} 段数据（写入时失败，可能是存储空间不足），部分受击和死亡可能缺失` : "";
    } catch (err) {
      if (current()) error.value = `读取这场存档失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (current()) loading.value = false;
    }
  }

  /**
   * The list's summary of an archive is derived data, computed by the version that recorded it;
   * replaying with today's engine can count differently (open-world fights once showed 0 rows).
   * Store the counts of the replay just made — unless the monitor has written to the archive since
   * it was read (it keeps writing until 10 s after the end), in which case its own summary stands.
   */
  async function refreshSummary(meta: ArchiveMeta, fresh: ArchiveMeta["summary"]): Promise<void> {
    if (fresh.rows === meta.summary.rows && fresh.deaths === meta.summary.deaths) return;
    try {
      const written = await store.update(meta.id, (now) =>
        now && now.end !== undefined && now.chunkCount === meta.chunkCount ? { ...now, summary: fresh } : undefined,
      );
      if (written) await refresh();
    } catch {
      // the list keeps the old counts
    }
  }

  async function select(id: string): Promise<void> {
    selectedId.value = id;
    await load(id);
  }

  /** Shows no encounter, with a reason (a link to an encounter that has no archive). */
  function clear(reason: string): void {
    ticket++;
    selectedId.value = undefined;
    loaded.value = undefined;
    loading.value = false;
    error.value = reason;
  }

  /** Pins or unpins a 复盘: all its pulls together. */
  async function togglePin(sessionId: string): Promise<void> {
    const session = sessions.value.find((x) => x.id === sessionId);
    if (!session) return;
    const pinned = !session.pinned;
    // Read and write in one transaction: the monitor may be writing this archive right now.
    for (const pull of session.pulls) await store.update(pull.id, (meta) => meta && { ...meta, pinned });
    await refresh();
  }

  /** Deletes a 复盘, every pull. One being recorded may go too: the monitor then stops recording it. */
  async function remove(sessionId: string): Promise<void> {
    const session = sessions.value.find((x) => x.id === sessionId);
    if (!session) return;
    for (const pull of session.pulls) await store.remove(pull.id);
    if (session.pulls.some((p) => p.id === selectedId.value)) clear("");
    await refresh();
  }

  /** Deletes every 复盘, pinned ones too; one being recorded goes too: the monitor then stops recording it. */
  async function removeAll(): Promise<void> {
    for (const meta of await store.list()) await store.remove(meta.id);
    clear("");
    await refresh();
  }

  // Live updates from the monitor: refresh the list; reload the selected encounter, throttled.
  let reloadTimer: number | undefined;
  let lastReload = 0;
  const channel = openArchiveChannel();
  if (channel) {
    channel.onmessage = (e: MessageEvent<ArchiveMessage>) => {
      if (e.data?.type !== "archive") return;
      void refresh();
      if (e.data.id !== selectedId.value || reloadTimer !== undefined) return;
      const wait = Math.max(0, lastReload + RELOAD_MS - Date.now());
      reloadTimer = window.setTimeout(() => {
        reloadTimer = undefined;
        lastReload = Date.now();
        if (selectedId.value) void load(selectedId.value);
      }, wait);
    };
  }
  onBeforeUnmount(() => {
    channel?.close();
    window.clearTimeout(reloadTimer);
  });

  return { list, sessions, selectedId, loaded, loading, error, refresh, select, clear, togglePin, remove, removeAll };
}
