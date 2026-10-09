import type { ArchiveMeta, ArchiveStore } from "./types";

/**
 * IndexedDB store, shared by the monitor (writer) and the review window (reader): same origin, so
 * the same database, in ACT's CEF too (docs/DESIGN.md 11.2). All Pages of one GitHub user share an
 * origin, hence the project-prefixed name (9.7).
 */
const DB_NAME = "mitigation-monitoring";
const DB_VERSION = 1;
const ENCOUNTERS = "encounters";
const CHUNKS = "chunks";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class IndexedDbArchiveStore implements ArchiveStore {
  private db: Promise<IDBDatabase> | undefined;

  /**
   * The database, opened once. A failed open is tried again on the next call. Blocked (another page still has an
   * older version open) is not a failure: the open goes on once that page closes it. A newer version opened
   * elsewhere closes this connection, and the next call opens again.
   */
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ENCOUNTERS)) db.createObjectStore(ENCOUNTERS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ["id", "index"] });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          this.db = undefined;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    }).catch((err: unknown) => {
      this.db = undefined;
      throw err;
    });
    return this.db;
  }

  async list(): Promise<ArchiveMeta[]> {
    const db = await this.open();
    const all = await request<ArchiveMeta[]>(db.transaction(ENCOUNTERS).objectStore(ENCOUNTERS).getAll());
    return all.sort((a, b) => b.start - a.start);
  }

  async get(id: string): Promise<ArchiveMeta | undefined> {
    const db = await this.open();
    return request<ArchiveMeta | undefined>(db.transaction(ENCOUNTERS).objectStore(ENCOUNTERS).get(id));
  }

  async put(meta: ArchiveMeta): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(ENCOUNTERS, "readwrite");
    tx.objectStore(ENCOUNTERS).put(meta);
    await done(tx);
  }

  async update(id: string, change: (current: ArchiveMeta | undefined) => ArchiveMeta | undefined): Promise<ArchiveMeta | undefined> {
    const db = await this.open();
    const tx = db.transaction(ENCOUNTERS, "readwrite");
    const encounters = tx.objectStore(ENCOUNTERS);
    let written: ArchiveMeta | undefined;
    // `change` runs inside the transaction's request callback, so nothing else can write in between.
    const read = encounters.get(id);
    read.onsuccess = () => {
      written = change(read.result as ArchiveMeta | undefined);
      if (written) encounters.put(written);
    };
    await done(tx);
    return written;
  }

  async appendChunk(id: string, index: number, data: Blob): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(CHUNKS, "readwrite");
    tx.objectStore(CHUNKS).put({ id, index, data });
    await done(tx);
  }

  async chunks(id: string): Promise<Blob[]> {
    const db = await this.open();
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    const rows = await request<{ index: number; data: Blob }[]>(db.transaction(CHUNKS).objectStore(CHUNKS).getAll(range));
    return rows.sort((a, b) => a.index - b.index).map((r) => r.data);
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([ENCOUNTERS, CHUNKS], "readwrite");
    tx.objectStore(ENCOUNTERS).delete(id);
    tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    await done(tx);
  }
}
