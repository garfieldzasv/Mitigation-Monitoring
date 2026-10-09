import { IndexedDbArchiveStore } from "@/core/archive/indexedDbStore";
import { MemoryArchiveStore } from "@/core/archive/memoryStore";
import type { ArchiveStore } from "@/core/archive/types";

/**
 * The archive as the app sees it: IndexedDB, shared by the monitor and the review window; memory
 * when IndexedDB is missing (the review window then sees nothing). The monitor announces each
 * write on a BroadcastChannel so an open review window can refresh (docs/DESIGN.md 3.3).
 */
export const ARCHIVE_CHANNEL = "mitigation-monitoring:live";

export interface ArchiveMessage {
  type: "archive";
  id: string;
}

let store: ArchiveStore | undefined;

export function archiveStore(): ArchiveStore {
  store ??= typeof indexedDB !== "undefined" ? new IndexedDbArchiveStore() : new MemoryArchiveStore();
  return store;
}

export function openArchiveChannel(): BroadcastChannel | undefined {
  return typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(ARCHIVE_CHANNEL) : undefined;
}
