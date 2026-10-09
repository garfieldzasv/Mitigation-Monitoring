import type { ArchiveMeta, ArchiveStore } from "./types";

/** In-memory store: tests, and the fallback when IndexedDB is unavailable (lost on reload). */
export class MemoryArchiveStore implements ArchiveStore {
  private readonly metas = new Map<string, ArchiveMeta>();
  private readonly data = new Map<string, Blob[]>();

  async list(): Promise<ArchiveMeta[]> {
    return [...this.metas.values()].sort((a, b) => b.start - a.start).map((m) => structuredClone(m));
  }

  async get(id: string): Promise<ArchiveMeta | undefined> {
    const meta = this.metas.get(id);
    return meta && structuredClone(meta);
  }

  async put(meta: ArchiveMeta): Promise<void> {
    this.metas.set(meta.id, structuredClone(meta));
  }

  async update(id: string, change: (current: ArchiveMeta | undefined) => ArchiveMeta | undefined): Promise<ArchiveMeta | undefined> {
    const current = this.metas.get(id);
    const next = change(current && structuredClone(current));
    if (next) this.metas.set(id, structuredClone(next));
    return next && structuredClone(next);
  }

  async appendChunk(id: string, index: number, data: Blob): Promise<void> {
    const list = this.data.get(id) ?? [];
    list[index] = data;
    this.data.set(id, list);
  }

  async chunks(id: string): Promise<Blob[]> {
    return (this.data.get(id) ?? []).filter(Boolean);
  }

  async remove(id: string): Promise<void> {
    this.metas.delete(id);
    this.data.delete(id);
  }
}
