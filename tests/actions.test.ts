import { describe, expect, it } from "vitest";
import { displayActionName, isAutoAttack } from "@/core/game/actions";

describe("auto-attacks", () => {
  it("unnamed enemy auto-attacks (seen in ACT as unknown_ae46) show as 攻击", () => {
    expect(isAutoAttack(0xae46, "unknown_ae46")).toBe(true);
    expect(displayActionName(0xae46, "unknown_ae46")).toBe("攻击");
    expect(displayActionName(0xa94d, "unknown_a94d")).toBe("攻击");
    expect(displayActionName(0xa94d, "")).toBe("攻击");
  });

  it("the player's own 攻击 (7) counts, and named ones keep their name", () => {
    expect(isAutoAttack(7, "攻击")).toBe(true);
    expect(displayActionName(7, "攻击")).toBe("攻击");
  });

  it("unnamed actions that are not auto-attacks keep the log's name", () => {
    expect(isAutoAttack(0xab6e, "咆哮")).toBe(false);
    expect(displayActionName(0xab6e, "咆哮")).toBe("咆哮");
    expect(displayActionName(1, "unknown_1")).toBe("unknown_1");
  });
});
