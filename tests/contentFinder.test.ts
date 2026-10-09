import { describe, expect, it } from "vitest";
import { archivedForm, withoutHash } from "@/core/archive/codec";
import { MemoryArchiveStore } from "@/core/archive/memoryStore";
import { ArchiveWriter } from "@/core/archive/writer";
import { Engine } from "@/core/engine/engine";
import { archivesEncounter, DEFAULT_SETTINGS } from "@/core/settings/settings";
import { loadFixture, runFixture } from "./helpers/fixture";

/**
 * 解除限制 (docs/DESIGN.md 6.2): OverlayPlugin writes a 265 line with the Content Finder settings at each zone change
 * (LogGuide), not necessarily after the 01 line. The hunt fixture is 护锁刃龙狩猎战 (zone 514).
 */
const FIXTURE = "hunt-8p.log.gz";

/** The fixture with a 265 line for `zone` (hex), entered with 解除限制 or not, before or after its 01 line. */
function withSettings(zone: string, unrestricted: boolean, where: "before" | "after"): string[][] {
  const lines = loadFixture(FIXTURE);
  const i = lines.findIndex((l) => l[0] === "01");
  const line = ["265", lines[i]![1]!, zone, "", "True", unrestricted ? "1" : "0", "0", "0", "0", "0"];
  lines.splice(where === "before" ? i : i + 1, 0, line);
  return lines;
}

describe("解除限制", () => {
  it("marks the zone's encounters, whichever of its 265 and 01 lines comes first", () => {
    for (const where of ["before", "after"] as const) {
      const engine = runFixture(withSettings("514", true, where));
      expect(engine.encounters.length).toBeGreaterThan(0);
      for (const e of engine.encounters) expect(e.unrestricted).toBe(true);
    }
  });

  it("not when the settings are off, or the 265 line names another zone, or there is none", () => {
    for (const lines of [withSettings("514", false, "after"), withSettings("86", true, "after"), loadFixture(FIXTURE)]) {
      const engine = runFixture(lines);
      expect(engine.encounters.length).toBeGreaterThan(0);
      for (const e of engine.encounters) expect(e.unrestricted).toBeUndefined();
    }
  });

  it("by default its fights are not archived", async () => {
    const store = new MemoryArchiveStore();
    const engine = new Engine();
    const writer = new ArchiveWriter(engine, { store, accept: (e) => archivesEncounter(DEFAULT_SETTINGS, e) });
    for (const raw of withSettings("514", true, "after")) {
      writer.push(raw);
      const line = archivedForm(withoutHash(raw));
      if (line) engine.feed(line);
    }
    await writer.seal();
    expect(engine.encounters.length).toBeGreaterThan(0);
    expect(await store.list()).toEqual([]);
  });
});
