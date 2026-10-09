import { describe, expect, it } from "vitest";
import { archivesEncounter, archivesZone, DEFAULT_SETTINGS, normalizeSettings } from "@/core/settings/settings";

describe("normalizeSettings", () => {
  it("fills defaults for anything missing or broken", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ rowHeight: "22", fontSize: 99, highlightSelf: "yes", skipZones: "field", skipUnrestricted: 1 })).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid values, clamps numbers into range and rounds them", () => {
    expect(normalizeSettings({ skipZones: ["field", "field", 3, ""], skipUnrestricted: false, keepEncounters: 33.6, rowHeight: 26, fontSize: 13, opacity: 0.555, highlightSelf: false })).toEqual({
      skipZones: ["field"],
      skipUnrestricted: false,
      keepEncounters: 34,
      rowHeight: 26,
      fontSize: 13,
      opacity: 0.56,
      highlightSelf: false,
    });
    expect(normalizeSettings({ keepEncounters: 1, opacity: 0 })).toMatchObject({ keepEncounters: 5, opacity: 0.3 });
    expect(normalizeSettings({ keepEncounters: 500, opacity: 3 })).toMatchObject({ keepEncounters: 100, opacity: 1 });
  });

  it("by default only duties are archived; settings from before the zone tree get the default", () => {
    expect(DEFAULT_SETTINGS.skipZones).toEqual(["field", "special"]);
    expect(normalizeSettings({ skipSharedZones: true }).skipZones).toEqual(["field", "special"]);
    expect(normalizeSettings({ skipSharedZones: false }).skipZones).toEqual(["field", "special"]);
    expect(normalizeSettings({ skipZones: [] }).skipZones).toEqual([]);
  });
});

describe("archivesZone", () => {
  const skipping = (skipZones: string[]) => normalizeSettings({ skipZones });
  it("by default archives the duties only, and a zone the game data does not know yet", () => {
    for (const zone of [0x514, 372, 0x51b, 99999]) expect(archivesZone(DEFAULT_SETTINGS, zone)).toBe(true); // 护锁刃龙狩猎战, 水晶塔, 格莱杨拉波尔歼灭战
    for (const zone of [137, 0x4a4, 732, 0x4b9]) expect(archivesZone(DEFAULT_SETTINGS, zone)).toBe(false); // 东拉诺西亚, 克扎玛乌卡湿地, 优雷卡, 加加财富天坑
  });

  it("never archives where no fight happens, whatever is checked", () => {
    for (const zone of [132, 177, 979]) expect(archivesZone(skipping([]), zone)).toBe(false); // 格里达尼亚新街, 后桅旅店, 穹顶皓天
  });

  it("skips the zones under a checked node; never a zone the game data does not know", () => {
    const s = skipping(["field"]);
    expect(archivesZone(s, 137)).toBe(false); // 东拉诺西亚
    expect(archivesZone(s, 0x4a4)).toBe(false); // 克扎玛乌卡湿地 (FATEs, the open-world fight of the bug report)
    expect(archivesZone(s, 0x514)).toBe(true); // 护锁刃龙狩猎战
    expect(archivesZone(s, 0x4b9)).toBe(true); // 加加财富天坑 (treasure dungeon)
    expect(archivesZone(s, 732)).toBe(true); // 优雷卡常风之地
    expect(archivesZone(skipping(["special:t26"]), 732)).toBe(false);
    expect(archivesZone(skipping(["duty"]), 372)).toBe(false); // 水晶塔 希尔科斯塔
    expect(archivesZone(skipping(["duty"]), 99999)).toBe(true);
  });
});

describe("archivesEncounter", () => {
  const duty = 0x514; // 护锁刃龙狩猎战
  it("by default leaves out a duty entered with 解除限制; one whose settings are unknown is archived", () => {
    expect(archivesEncounter(DEFAULT_SETTINGS, { zoneId: duty, unrestricted: true })).toBe(false);
    expect(archivesEncounter(DEFAULT_SETTINGS, { zoneId: duty })).toBe(true);
  });

  it("archives it when the setting is off; the skipped zones still apply", () => {
    const s = normalizeSettings({ skipUnrestricted: false });
    expect(archivesEncounter(s, { zoneId: duty, unrestricted: true })).toBe(true);
    expect(archivesEncounter(normalizeSettings({ skipUnrestricted: false, skipZones: ["duty"] }), { zoneId: duty, unrestricted: true })).toBe(false);
  });
});
