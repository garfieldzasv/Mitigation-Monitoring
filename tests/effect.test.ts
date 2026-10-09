import { describe, expect, it } from "vitest";
import { decodeEffectValue, findAppliedStatusParams, findDamageEffect, hasInstantDeath, parseDamageFlags } from "@/core/logline/effect";

describe("decodeEffectValue", () => {
  it("reads AABB from AABBCCDD", () => {
    expect(decodeEffectValue("7E330000")).toBe(0x7e33);
    expect(decodeEffectValue("753A0000")).toBe(30010);
  });

  it("reads DDAABB when CC carries the 0x40 big-value flag", () => {
    expect(decodeEffectValue("68144001")).toBe(0x016814);
  });

  it("treats empty and malformed values as 0", () => {
    expect(decodeEffectValue("0")).toBe(0);
    expect(decodeEffectValue("")).toBe(0);
    expect(decodeEffectValue(undefined)).toBe(0);
  });
});

describe("parseDamageFlags", () => {
  it("magical fire damage", () => {
    expect(parseDamageFlags("150003", "753A0000")).toEqual({
      result: "hit",
      amount: 30010,
      crit: false,
      direct: false,
      damageType: "magical",
      attackType: 5,
      element: 1,
    });
  });

  it("unaspected magic, slashing, piercing, darkness", () => {
    expect(parseDamageFlags("750003", "1000")?.damageType).toBe("magical");
    expect(parseDamageFlags("710003", "1000")).toMatchObject({ damageType: "physical", attackType: 1, element: 7 });
    expect(parseDamageFlags("720003", "1000")).toMatchObject({ damageType: "physical", attackType: 2 });
    expect(parseDamageFlags("760003", "1000")?.damageType).toBe("special");
  });

  it("hit severity: 0x20 crit, 0x40 direct hit", () => {
    expect(parseDamageFlags("724003", "68144001")).toMatchObject({ crit: false, direct: true, amount: 0x016814 });
    expect(parseDamageFlags("712003", "1000")).toMatchObject({ crit: true, direct: false });
  });

  it("block, parry and miss", () => {
    expect(parseDamageFlags("EC730005", "75C90000")).toMatchObject({ result: "block", amount: 0x75c9, damageType: "physical" });
    expect(parseDamageFlags("710006", "1000")?.result).toBe("parry");
    expect(parseDamageFlags("710006", "1000")?.reduction).toBeUndefined(); // no reduction given
    expect(parseDamageFlags("1", "1234")).toMatchObject({ result: "miss", amount: 0 });
  });

  it("a block's or parry's reduction: the leftmost byte, signed (LogGuide: 0xEC => -20%); 100 % or more is none", () => {
    expect(parseDamageFlags("9C730005", "1000")?.reduction).toBeUndefined();
    expect(parseDamageFlags("EC730005", "75C90000")?.reduction).toBe(20);
    expect(parseDamageFlags("F1710006", "1000")?.reduction).toBe(15);
    // On a plain hit the same byte is the positional / combo bonus, not a reduction.
    expect(parseDamageFlags("21710003", "1000")?.reduction).toBeUndefined();
  });

  it("ignores non-damage effects", () => {
    expect(parseDamageFlags("200004", "26F50000")).toBeUndefined(); // heal
    expect(parseDamageFlags("1B", "AB6E8000")).toBeUndefined();
    expect(parseDamageFlags("E", "7370000")).toBeUndefined(); // status applied
    expect(parseDamageFlags("0", "0")).toBeUndefined();
  });
});

describe("findAppliedStatusParams", () => {
  const line = (...pairs: string[]) => ["21", "t", "40000001", "Boss", "1", "a", "10000001", "P1", ...pairs];

  it("reads each status put on with its modifier bytes, signed (LogGuide: a 10% mit comes as -10)", () => {
    expect(findAppliedStatusParams(line("140E", "6FD0000"))).toEqual([{ id: 0x6fd, onSource: false, first: 20, second: 0 }]);
    // two effects, one byte each (昏乱: physical, magic)
    expect(findAppliedStatusParams(line("F6FB0E", "4B30000"))).toEqual([{ id: 0x4b3, onSource: false, first: -5, second: -10 }]);
    // 0x0F: on the source
    expect(findAppliedStatusParams(line("750003", "7E330000", "FEC0F", "4A70000"))).toEqual([{ id: 0x4a7, onSource: true, first: -20, second: 15 }]);
  });

  it("skips damage, heals and removals", () => {
    expect(findAppliedStatusParams(line("750003", "7E330000", "200004", "26F50000", "10", "4A70000"))).toEqual([]);
  });
});

describe("findDamageEffect", () => {
  const line = (...pairs: string[]) => ["22", "t", "400117E3", "护锁刃龙", "AB6E", "咆哮", "10031B3B", "P6", ...pairs];

  it("finds the damage pair even when it is not the first", () => {
    expect(findDamageEffect(line("1B", "AB6E8000", "750003", "7E330000"))).toMatchObject({ result: "hit", amount: 0x7e33 });
  });

  it("skips reflected damage (after a 0x1D effect) and damage flagged for the source", () => {
    expect(findDamageEffect(line("1D", "0", "750003", "7E330000"))).toBeUndefined();
    expect(findDamageEffect(line("750003", "7E338000"))).toBeUndefined();
    expect(findDamageEffect(line("1D", "0", "750003", "7E330000", "750003", "10000000"))).toMatchObject({ amount: 0x1000 });
  });

  it("a hit the target was invulnerable to (0x07) is one of 0, marked so; instant death is 0x33", () => {
    expect(findDamageEffect(line("7", "0"))).toMatchObject({ amount: 0, invulnerable: true });
    expect(hasInstantDeath(line("33", "0", "1C", "26AB8000"))).toBe(true);
    expect(hasInstantDeath(line("750003", "7E330000"))).toBe(false);
  });
});
