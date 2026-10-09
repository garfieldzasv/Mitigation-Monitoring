import { describe, expect, it } from "vitest";
import { archivedForm, decodeLines, encodeLines, withoutHash } from "@/core/archive/codec";
import { MemoryArchiveStore } from "@/core/archive/memoryStore";
import { replayArchive } from "@/core/archive/replay";
import { archiveIdOf, groupSessions, type ArchiveMeta } from "@/core/archive/types";
import { ArchiveWriter } from "@/core/archive/writer";
import { Engine } from "@/core/engine/engine";
import { loadFixture } from "./helpers/fixture";
import { view } from "./helpers/rowView";

/** The archived lines through one engine, once, as the monitor saw them. */
function replayOnce(meta: ArchiveMeta, lines: readonly (readonly string[])[]) {
  const engine = new Engine({ maxEncounters: 4 });
  engine.setZone(meta.zoneId, meta.zoneName);
  engine.bootstrap({ combatants: meta.combatants, party: meta.party, ...(meta.self ? { selfId: meta.self.id, selfName: meta.self.name } : {}) });
  for (const line of lines) engine.feed(line);
  engine.flush();
  return engine.encounters.find((e) => e.start === meta.start);
}

/** Plays a fixture the way the monitor does: writer first, then the engine, flushing now and then. */
async function record(name: string) {
  const store = new MemoryArchiveStore();
  const engine = new Engine();
  const updates: string[] = [];
  const writer = new ArchiveWriter(engine, { store, onUpdate: (id) => updates.push(id) });
  const lines = loadFixture(name);
  lines.forEach((line, i) => {
    writer.push(line);
    // The monitor's engine reads the lines as archived.
    const archived = archivedForm(withoutHash(line));
    if (archived) engine.feed(archived);
    if (i % 2000 === 1999) void writer.flush();
  });
  await writer.seal();
  return { store, engine, updates };
}

describe("codec", () => {
  it("round-trips lines through gzip and drops the trailing hash", async () => {
    const lines = [["21", "t", "a|b"].slice(0, 2), ["26", "t", "x"]];
    const blob = await encodeLines(lines);
    expect(new Uint8Array(await blob.slice(0, 2).arrayBuffer())).toEqual(new Uint8Array([0x1f, 0x8b]));
    expect(await decodeLines([blob, await encodeLines([["37", "u"]])])).toEqual([["21", "t"], ["26", "t", "x"], ["37", "u"]]);
    expect(withoutHash(["21", "t", "0123456789abcdef"])).toEqual(["21", "t"]);
    expect(withoutHash(["21", "t", "P1"])).toEqual(["21", "t", "P1"]);
  });

  it("reads plain-text chunks (stored where CompressionStream is missing)", async () => {
    expect(await decodeLines([new Blob(["01|t|514\n02|t|1"])])).toEqual([["01", "t", "514"], ["02", "t", "1"]]);
  });
});

describe.each(["hunt-8p.log.gz", "alliance-24p.log.gz", "trial-phases.log.gz"])("archive of %s", (fixture) => {
  it("the review window rebuilds the rows the monitor showed", async () => {
    const { store, engine } = await record(fixture);
    const [meta] = await store.list();
    expect(meta).toBeDefined();
    const live = engine.encounters.find((e) => e.start === meta!.start)!;
    const lines = await decodeLines(await store.chunks(meta!.id));
    // The archive holds all the monitor went by: once through, every row comes back as it was, shields included.
    expect(replayOnce(meta!, lines)!.rows.map(view)).toEqual(live.rows.map(view));
    // The review is that same single pass: it shows exactly what the monitor showed.
    const replay = replayArchive(meta!, lines);
    expect(replay.encounter).toBeDefined();
    expect(replay.encounter!.rows.map(view)).toEqual(live.rows.map(view));
    // The same boss, leaving and coming back at the same moments: the same phases.
    expect(replay.encounter!.boss).toEqual(live.boss);
    expect(replay.encounter!.untargetable).toEqual(live.untargetable);
    // Same people shown: the frozen scope travels with the archive.
    const liveVisible = engine.visibility(live);
    expect(live.rows.map((r) => replay.visible(r.target.id, r.target.name))).toEqual(
      live.rows.map((r) => liveVisible(r.target.id, r.target.name)),
    );
  });

  it("is sealed with its result, scope and summary, in several chunks", async () => {
    const { store, engine, updates } = await record(fixture);
    const [meta] = await store.list();
    const live = engine.encounters.at(-1)!;
    expect(meta).toMatchObject({ zoneName: live.zoneName, start: live.start, end: live.end, result: live.result, pinned: false });
    expect(meta!.chunkCount).toBeGreaterThan(1);
    expect(meta!.bytes).toBeGreaterThan(0);
    expect(meta!.scope).toEqual(live.scope);
    expect(meta!.summary.deaths).toBe(live.rows.filter((r) => r.kind === "death" && engine.visibility(live)(r.target.id, r.target.name)).length);
    expect(meta!.summary.durationMs).toBe(live.end! - live.start);
    expect(updates.length).toBeGreaterThan(2);
  });
});

describe("retention", () => {
  const meta = (i: number, over: Partial<ArchiveMeta> = {}): ArchiveMeta => ({
    version: 1,
    id: `e${i}`,
    zoneId: 1,
    zoneName: "z",
    start: i,
    end: i + 1,
    result: "clear",
    party: [],
    combatants: [],
    summary: { durationMs: 1, deaths: 0, rows: 0 },
    chunkCount: 0,
    bytes: 0,
    pinned: false,
    ...over,
  });

  it("keeps the newest 20 finished encounters, plus every pinned one", async () => {
    const store = new MemoryArchiveStore();
    for (let i = 1; i <= 25; i++) await store.put(meta(i, i === 2 ? { pinned: true } : {}));
    await store.put(meta(26, { end: undefined })); // still recording
    const writer = new ArchiveWriter(new Engine(), { store });
    await writer.prune();
    const left = (await store.list()).map((m) => m.id);
    expect(left).toHaveLength(22);
    expect(left).toContain("e2"); // pinned
    expect(left).toContain("e26"); // recording
    expect(left).toContain("e6");
    expect(left).not.toContain("e5");
    expect(left).not.toContain("e1");
  });

  it("reads the number to keep when pruning (a setting that can change)", async () => {
    const store = new MemoryArchiveStore();
    for (let i = 1; i <= 12; i++) await store.put(meta(i));
    let keep = 10;
    const writer = new ArchiveWriter(new Engine(), { store, maxKept: () => keep });
    await writer.prune();
    expect(await store.list()).toHaveLength(10);
    keep = 5;
    await writer.prune();
    expect((await store.list()).map((m) => m.id)).toEqual(["e12", "e11", "e10", "e9", "e8"]);
  });
});

describe("复盘: the pulls of one zone visit (docs/DESIGN.md 6.2)", () => {
  /** Plays fixtures one after the other through one monitor; `between` runs when an encounter has just ended. */
  async function play(names: string[], between?: (store: MemoryArchiveStore, engine: Engine) => Promise<void>) {
    const store = new MemoryArchiveStore();
    const engine = new Engine({ maxEncounters: 10 });
    const writer = new ArchiveWriter(engine, { store });
    let ended = 0;
    for (const name of names) {
      for (const line of loadFixture(name)) {
        writer.push(line);
        const archived = archivedForm(withoutHash(line));
        if (archived) engine.feed(archived);
        const done = engine.encounters.filter((e) => e.end !== undefined).length;
        if (done > ended) {
          ended = done;
          await writer.flush();
          await between?.(store, engine);
        }
      }
    }
    await writer.seal();
    return { store, engine };
  }

  it("pulls in one zone visit share a 复盘, named by the first; a zone change starts a new one", async () => {
    const { store, engine } = await play(["hunt-8p.log.gz", "alliance-24p.log.gz"]);
    const metas = await store.list();
    expect(metas).toHaveLength(engine.encounters.length);
    const sessions = groupSessions(metas);
    expect(sessions.map((x) => x.pulls.map((m) => m.zoneName))).toEqual([["水晶塔 希尔科斯塔", "水晶塔 希尔科斯塔"], ["护锁刃龙狩猎战"]]);
    const alliance = sessions[0]!;
    expect(alliance.id).toBe(alliance.pulls[0]!.id);
    expect(alliance.pulls.every((m) => m.session === alliance.id)).toBe(true);
    // Each pull is named after its main boss.
    expect(sessions[1]!.pulls[0]!.title).toBe("护锁刃龙");
  });

  it("a new pull of a pinned 复盘 is pinned too", async () => {
    const { store } = await play(["alliance-24p.log.gz"], async (st) => {
      for (const m of await st.list()) await st.update(m.id, (x) => x && { ...x, pinned: true });
    });
    const metas = await store.list();
    expect(metas).toHaveLength(2);
    expect(metas.every((m) => m.pinned)).toBe(true);
  });

  it("retention counts 复盘, deleting every pull of the old ones; never the zone visit going on", async () => {
    const store = new MemoryArchiveStore();
    const pull = (session: number, i: number, over: Partial<ArchiveMeta> = {}): ArchiveMeta => ({
      version: 2,
      id: `e${session * 10 + i}`,
      session: `e${session * 10}`,
      zoneId: 1,
      zoneName: "z",
      start: session * 10 + i,
      end: session * 10 + i + 1,
      result: "clear",
      party: [],
      combatants: [],
      summary: { durationMs: 1, deaths: 0, rows: 0 },
      chunkCount: 0,
      bytes: 0,
      pinned: false,
      ...over,
    });
    for (let session = 1; session <= 8; session++) for (let i = 0; i < 3; i++) await store.put(pull(session, i, session === 2 && i === 1 ? { pinned: true } : {}));
    await new ArchiveWriter(new Engine(), { store, maxKept: 5 }).prune();
    const left = groupSessions(await store.list()).map((x) => `${x.id}:${x.pulls.length}`);
    expect(left).toEqual(["e80:3", "e70:3", "e60:3", "e50:3", "e40:3", "e20:3"]);
  });
});

describe("skipping encounters", () => {
  it("saves nothing for an encounter `accept` turns down, the rest as usual", async () => {
    const store = new MemoryArchiveStore();
    const engine = new Engine();
    const asked: string[] = [];
    const writer = new ArchiveWriter(engine, {
      store,
      accept: (e) => {
        asked.push(e.zoneName);
        return false;
      },
    });
    for (const line of loadFixture("hunt-8p.log.gz")) {
      writer.push(line);
      engine.feed(line);
    }
    await writer.seal();
    expect(asked).toEqual(["护锁刃龙狩猎战"]);
    expect(await store.list()).toEqual([]);
    expect(writer.recordingId).toBeUndefined();
    expect(writer.isArchived(engine.encounters.at(-1)!)).toBe(false);
  });
});

describe("sharing the store with a review window", () => {
  /** Records the hunt, letting a "review window" act on the store halfway through the pull. */
  async function recordWith(midway: (store: MemoryArchiveStore, id: string) => Promise<void>) {
    const store = new MemoryArchiveStore();
    const engine = new Engine();
    const writer = new ArchiveWriter(engine, { store });
    const lines = loadFixture("hunt-8p.log.gz");
    const half = Math.floor(lines.length / 2);
    for (let i = 0; i < lines.length; i++) {
      writer.push(lines[i]!);
      engine.feed(lines[i]!);
      if (i === half) {
        await writer.flush();
        await midway(store, writer.recordingId!);
      } else if (i % 2000 === 1999) await writer.flush();
    }
    await writer.seal();
    return { store, writer, encounter: engine.encounters.at(-1)! };
  }

  it("keeps a pin set while the encounter is being recorded", async () => {
    const { store } = await recordWith(async (s, id) => void (await s.update(id, (m) => m && { ...m, pinned: true })));
    const [meta] = await store.list();
    expect(meta).toMatchObject({ pinned: true, result: "clear" });
    expect(meta!.end).toBeDefined();
  });

  it("stops recording an archive deleted mid-pull, instead of bringing it back without its start", async () => {
    const { store, writer, encounter } = await recordWith((s, id) => s.remove(id));
    expect(await store.list()).toEqual([]);
    expect(await store.chunks(archiveIdOf(encounter.start))).toEqual([]);
    expect(writer.isArchived(encounter)).toBe(false);
  });

  it("closes recordings an overlay left behind when it starts, not one still being written", async () => {
    const store = new MemoryArchiveStore();
    const now = Date.parse("2026-10-04T12:00:00Z");
    const recording = (id: string, start: number, lastLineTime: number): ArchiveMeta => ({
      version: 1,
      id,
      zoneId: 1,
      zoneName: "z",
      start,
      result: "unknown",
      lastLineTime,
      party: [],
      combatants: [],
      summary: { durationMs: 0, deaths: 0, rows: 3 },
      chunkCount: 1,
      bytes: 1,
      pinned: false,
    });
    await store.put(recording("left", now - 300_000, now - 120_000));
    await store.put(recording("live", now - 20_000, now - 5_000));
    await new ArchiveWriter(new Engine(), { store }).closeAbandoned(now);
    expect(await store.get("left")).toMatchObject({ end: now - 120_000, summary: { durationMs: 180_000, rows: 3 } });
    expect((await store.get("live"))?.end).toBeUndefined();
  });
});
