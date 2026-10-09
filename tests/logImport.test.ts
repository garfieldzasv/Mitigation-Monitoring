import { describe, expect, it } from "vitest";
import { archivedForm, decodeLines, withoutHash } from "@/core/archive/codec";
import { blobBatches } from "@/core/archive/logFile";
import { importLog, scanLog, type LogBatches } from "@/core/archive/logImport";
import { MemoryArchiveStore } from "@/core/archive/memoryStore";
import { replayArchive } from "@/core/archive/replay";
import { groupSessions, type ArchiveMeta } from "@/core/archive/types";
import { Engine } from "@/core/engine/engine";
import { loadFixture } from "./helpers/fixture";
import { view } from "./helpers/rowView";

const HASH = "0123456789abcdef";
/** A fixture as a Network log reads: its lines with the trailing hash, a thousand at a time. */
const logOf =
  (lines: readonly (readonly string[])[]): LogBatches =>
  async function* () {
    for (let i = 0; i < lines.length; i += 1000) yield lines.slice(i, i + 1000).map((l) => [...l, HASH]);
  };

/** The rows the monitor showed for the pull starting at `start`. */
function liveRows(lines: readonly (readonly string[])[], start: number) {
  const engine = new Engine();
  for (const line of lines) {
    const archived = archivedForm(withoutHash(line));
    if (archived) engine.feed(archived);
  }
  engine.flush();
  return engine.encounters.find((e) => e.start === start)!.rows.map(view);
}

async function replayed(store: MemoryArchiveStore, meta: ArchiveMeta) {
  const replay = replayArchive(meta, await decodeLines(await store.chunks(meta.id)));
  return replay.encounter!.rows.map(view);
}

describe("scanning a log file", () => {
  it("finds its pulls as the monitor cuts them, with zone, boss, result and counts", async () => {
    const pulls = await scanLog(logOf(loadFixture("hunt-8p.log.gz")));
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ zoneName: "护锁刃龙狩猎战", title: "护锁刃龙", result: "clear", summary: { deaths: 7, rows: 761 } });
    expect(pulls[0]!.end).toBeGreaterThan(pulls[0]!.start);
    expect(pulls[0]!.session).toBe(pulls[0]!.id);
  });

  it("puts the pulls of one zone visit in one 复盘, named by its first", async () => {
    const pulls = await scanLog(logOf(loadFixture("alliance-24p.log.gz")));
    expect(pulls.map((p) => p.title)).toEqual(["才思敏捷的亚蒙", "始皇帝赞德"]);
    expect(pulls.every((p) => p.session === pulls[0]!.id)).toBe(true);
  });

  it("stops when aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(scanLog(logOf(loadFixture("hunt-8p.log.gz")), abort.signal)).rejects.toThrow();
  });
});

describe("importing pulls", () => {
  it("archives a pull as the monitor would: the review rebuilds the rows it showed", async () => {
    const lines = loadFixture("hunt-8p.log.gz");
    const [pull] = await scanLog(logOf(lines));
    const store = new MemoryArchiveStore();
    expect(await importLog(logOf(lines), [pull!], store, { file: "Network_30301_20260920.log" })).toEqual([pull!.id]);
    const [meta] = await store.list();
    expect(meta).toMatchObject({ id: pull!.id, start: pull!.start, end: pull!.end, result: "clear", pinned: true, session: pull!.session, source: { kind: "networkLog", file: "Network_30301_20260920.log" } });
    expect(await replayed(store, meta!)).toEqual(liveRows(lines, pull!.start));
  });

  it("a pull in a duty entered with 解除限制 imports like any other: that setting only governs the monitor's own archive", async () => {
    const lines = loadFixture("hunt-8p.log.gz");
    const at = lines.findIndex((l) => l[0] === "01");
    lines.splice(at + 1, 0, ["265", lines[at]![1]!, "514", "护锁刃龙狩猎战", "True", "1", "0", "0", "0", "0"]);
    const [pull] = await scanLog(logOf(lines));
    expect(pull).toMatchObject({ zoneName: "护锁刃龙狩猎战", title: "护锁刃龙", result: "clear", summary: { deaths: 7, rows: 761 } });
    const store = new MemoryArchiveStore();
    expect(await importLog(logOf(lines), [pull!], store, { file: "Network_30301_20260920.log" })).toEqual([pull!.id]);
    const [meta] = await store.list();
    expect(await replayed(store, meta!)).toEqual(liveRows(lines, pull!.start));
  });

  it("a later pull of a zone visit joins its 复盘 and carries its own pre-pull state", async () => {
    const lines = loadFixture("alliance-24p.log.gz");
    const [first, boss] = await scanLog(logOf(lines));
    const store = new MemoryArchiveStore();
    expect(await importLog(logOf(lines), [boss!], store, { file: "x.log" })).toEqual([boss!.id]);
    const [meta] = await store.list();
    expect(meta!.session).toBe(first!.id);
    expect(await replayed(store, meta!)).toEqual(liveRows(lines, boss!.start));
  });

  it("leaves alone pulls already archived, and never prunes the archive", async () => {
    const lines = loadFixture("trial-phases.log.gz");
    const pulls = await scanLog(logOf(lines));
    const store = new MemoryArchiveStore();
    // More finished, unpinned 复盘 than the monitor keeps: an import does not clean up.
    for (let i = 0; i < 25; i++) {
      await store.put({ version: 2, id: `e${i + 1}`, zoneId: 1, zoneName: "", start: i + 1, end: i + 2, result: "clear", party: [], combatants: [], summary: { durationMs: 1, deaths: 0, rows: 0 }, chunkCount: 0, bytes: 0, pinned: false });
    }
    expect(await importLog(logOf(lines), pulls, store, { file: "x.log" })).toEqual([pulls[0]!.id]);
    expect(await importLog(logOf(lines), pulls, store, { file: "x.log" })).toEqual([]);
    expect(groupSessions(await store.list())).toHaveLength(26);
  });

  it("the party a log names by ID gets names, jobs and levels from the 03 lines after it", async () => {
    const lines = loadFixture("hunt-8p.log.gz");
    // The 11 line before the players' 03 lines, as a log can have it.
    const party = lines.find((l) => l[0] === "11")!;
    const reordered = [party, ...lines.filter((l) => l !== party)];
    const [pull] = await scanLog(logOf(reordered));
    const store = new MemoryArchiveStore();
    await importLog(logOf(reordered), [pull!], store, { file: "x.log" });
    const [meta] = await store.list();
    expect(meta!.party.length).toBe(8);
    expect(meta!.party.every((m) => m.name && m.job > 0 && m.level === 100)).toBe(true);
  });
});

describe("reading a log file", () => {
  it("splits lines and fields across slice boundaries, CRLF and multi-byte text included", async () => {
    const text = "01|2026-09-20T00:00:00|514|护锁刃龙狩猎战|hash1\r\n21|t|10000001|名字|7531|铁壁\r\n\r\n26|t|x";
    const batches: string[][][] = [];
    const progress: number[] = [];
    for await (const b of blobBatches(new Blob([text]), (read) => progress.push(read), 7)()) batches.push(b.map((l) => [...l]));
    expect(batches.flat()).toEqual([
      ["01", "2026-09-20T00:00:00", "514", "护锁刃龙狩猎战", "hash1"],
      ["21", "t", "10000001", "名字", "7531", "铁壁"],
      ["26", "t", "x"],
    ]);
    expect(progress.at(-1)).toBe(new Blob([text]).size);
  });
});
