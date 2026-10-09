import { describe, expect, it } from "vitest";
import { isRelevantLineType, parseLogLine } from "@/core/logline/parse";

/** Real lines from tests/fixtures/hunt-8p.log.gz (anonymized, hash dropped). */
const split = (s: string) => s.split("|");

describe("parseLogLine", () => {
  it("22: enemy AOE on a player", () => {
    const e = parseLogLine(
      split(
        "22|2026-09-20T00:25:28.9250000+08:00|400117E3|护锁刃龙|AB6E|咆哮|10031B3B|P6|750003|7E330000|1B|AB6E8000|0|0|0|0|0|0|0|0|0|0|0|0|181558|181558|10000|10000|||99.90|97.15|0.00|-3.11|73163853|73915282|10000|10000|||99.69|89.25|0.00|0.01|0000A12B|1|8|00||01|AB6E|AB6E|3.700|8039",
      ),
    );
    expect(e).toMatchObject({
      type: "ability",
      time: Date.parse("2026-09-20T00:25:28.925+08:00"),
      sourceId: "400117E3",
      sourceName: "护锁刃龙",
      actionId: 0xab6e,
      actionName: "咆哮",
      targetId: "10031B3B",
      targetName: "P6",
      damage: { result: "hit", amount: 0x7e33, damageType: "magical" },
      targetHp: 181558,
      targetMaxHp: 181558,
      sequence: "0000A12B",
      targetIndex: 1,
      targetCount: 8,
    });
    expect(e).not.toHaveProperty("ownerId");
  });

  it("21: blocked auto-attack", () => {
    const e = parseLogLine(
      split(
        "21|2026-09-20T00:25:51.4030000+08:00|400117E3|护锁刃龙|A94D|unknown_a94d|1004BD7C|P7|EC730005|75C90000|1B|A94D8000|0|0|0|0|0|0|0|0|0|0|0|0|285523|299325|7600|10000|||89.37|90.26|-0.02|1.02|65927009|73915282|10000|10000|||98.15|89.56|0.00|-1.39|0000A1D0|0|1|00||01|A94D|A94D|0.100|4307",
      ),
    );
    expect(e).toMatchObject({ type: "ability", damage: { result: "block", amount: 0x75c9 }, targetCount: 1 });
  });

  it("37: HP after the hit and shield %", () => {
    const e = parseLogLine(
      split(
        "37|2026-09-20T00:25:29.5480000+08:00|1004BD7C|P7|0000A12B|297788|299325|10000|10000|0||99.41|85.71|0.00|0.07|1300|0|0|03|02000000|0|0|E0000000",
      ),
    );
    expect(e).toEqual({
      type: "effectResult",
      time: Date.parse("2026-09-20T00:25:29.548+08:00"),
      targetId: "1004BD7C",
      sequence: "0000A12B",
      currentHp: 297788,
      maxHp: 299325,
      shieldPercent: 0,
    });
  });

  it("37: the statuses the effect touched, as they now are (泛输血 put on again at 15 s)", () => {
    const e = parseLogLine(
      split(
        "37|2026-10-05T22:20:49.6820000+08:00|10094C5D|P1|00005050|179803|179803|3572|10000|34||91.42|99.38|0.00|1.91|2802|0|0|02|20000A53|04|41565E35|10032E5E|21000A35|0|41700000|10032E5E",
      ),
    );
    expect(e).toMatchObject({
      shieldPercent: 34,
      statuses: [
        { id: 0xa53, stacks: 4, sourceId: "10032E5E" },
        { id: 0xa35, duration: 15, stacks: 0, sourceId: "10032E5E" },
      ],
    });
    expect((e as { statuses: { duration: number }[] }).statuses[0]!.duration).toBeCloseTo(13.4, 2);
  });

  it("37 short form: the current HP only; the shield is unknown, not 0", () => {
    const e = parseLogLine(split("37|2026-09-12T23:52:11.5360000+08:00|10076F34|P3|00004D96|110654||||||100.05|95.14|0.00|-2.91"));
    expect(e).toMatchObject({ type: "effectResult", currentHp: 110654, maxHp: 0 });
    expect(e).not.toHaveProperty("shieldPercent");
  });

  it("24: DoT tick, HP before the tick", () => {
    const e = parseLogLine(
      split(
        "24|2026-09-20T00:28:41.4330000+08:00|1004BD7C|P7|DoT|0|0|222713|299325|10000|10000|||108.96|90.90|0.00|-2.02|1004BD7C|P7|FFFFFFFF|222713|299325",
      ),
    );
    expect(e).toMatchObject({ type: "tick", kind: "dot", targetId: "1004BD7C", effectId: 0, amount: 0, targetHp: 222713, sourceId: "1004BD7C" });
  });

  it("25: death", () => {
    expect(parseLogLine(split("25|2026-09-20T00:27:56.1270000+08:00|1007A46B|P8|400117FC|护锁刃龙"))).toMatchObject({
      type: "death",
      targetId: "1007A46B",
      targetName: "P8",
      sourceId: "400117FC",
      sourceName: "护锁刃龙",
    });
  });

  it("26 / 30: Reprisal on the boss", () => {
    expect(parseLogLine(split("26|2026-09-20T00:27:14.1980000+08:00|4A9|雪仇|15.00|1004BD7C|P7|400117E3|护锁刃龙|00|73915282|299325"))).toMatchObject({
      type: "gainEffect",
      effectId: 0x4a9,
      effectName: "雪仇",
      duration: 15,
      sourceId: "1004BD7C",
      targetId: "400117E3",
      stacks: 0,
    });
    expect(parseLogLine(split("30|2026-09-20T00:27:29.1990000+08:00|4A9|雪仇|0.00|1004BD7C|P7|400117E3|护锁刃龙|00|73915282|299325"))).toMatchObject({
      type: "loseEffect",
      effectId: 0x4a9,
      sourceId: "1004BD7C",
      targetId: "400117E3",
    });
  });

  it("03: job and level are hex; a summon names its owner", () => {
    expect(parseLogLine(split("03|2026-09-20T00:25:06.8040000+08:00|100187CF|P1|23|64|0000|424|萌芽池|0|0|181218|199339|10000|10000|||100.63|117.50|0.00|3.14"))).toEqual({
      type: "addCombatant",
      time: Date.parse("2026-09-20T00:25:06.804+08:00"),
      id: "100187CF",
      name: "P1",
      job: 35,
      level: 100,
      maxHp: 199339,
    });
    expect(parseLogLine(split("03|2026-09-20T00:25:21.5260000+08:00|4001180B|地星|00|64|10060E42|00||6565|7245|160610|160610|10000|10000|||99.74|99.53|0.00|-0.01"))).toMatchObject({
      id: "4001180B",
      ownerId: "10060E42",
    });
  });

  it("11, 33 victory, 260", () => {
    expect(parseLogLine(split("11|2026-09-20T00:25:06.8040000+08:00|8|100187CF|10072E3A|10060E42|1007B213|1006E95D|10031B3B|1004BD7C|1007A46B"))).toMatchObject({
      type: "partyList",
      ids: ["100187CF", "10072E3A", "10060E42", "1007B213", "1006E95D", "10031B3B", "1004BD7C", "1007A46B"],
    });
    expect(parseLogLine(split("33|2026-09-20T00:32:24.2840000+08:00|80034E86|40000003|00|00|00|00"))?.type).toBe("victory");
    // LogGuide "Line 33": the variant/criterion victory, and fade out (a wipe)
    expect(parseLogLine(split("33|2026-09-20T00:32:24.2840000+08:00|80034E86|40000002|00|00|00|00"))?.type).toBe("victory");
    expect(parseLogLine(split("33|2026-09-20T00:32:24.2840000+08:00|80034E86|40000005|00|00|00|00"))?.type).toBe("wipe");
    expect(parseLogLine(split("33|2026-09-20T00:32:24.2840000+08:00|80034E86|40000010|00|00|00|00"))?.type).toBe("wipe");
    // The duty commencing (with its time limit, E10 = 3600 s): not used
    expect(parseLogLine(split("33|2026-09-20T00:25:20.5990000+08:00|80034E86|40000001|E10|00|00|00"))).toBeUndefined();
    // ACT and the game apart: ACT's state may be other people's fights (LogGuide).
    expect(parseLogLine(split("260|2026-09-20T00:25:23.1390000+08:00|1|0|1|0"))).toMatchObject({ type: "combat", act: true, game: false, gameChanged: false });
    expect(parseLogLine(split("260|2026-09-20T00:25:23.7370000+08:00|1|1|0|1"))).toMatchObject({ type: "combat", act: true, game: true, gameChanged: true });
    expect(parseLogLine(split("260|2026-09-20T00:32:24.1190000+08:00|1|0|0|1"))).toMatchObject({ type: "combat", act: true, game: false, gameChanged: true });
    expect(parseLogLine(split("260|2026-09-20T00:33:00.0000000+08:00|0|0|1|0"))).toMatchObject({ type: "combat", act: false, game: false, gameChanged: false });
  });

  it("pre-filter keeps only consumed line types", () => {
    expect(isRelevantLineType("22")).toBe(true);
    expect(isRelevantLineType("00")).toBe(false);
    expect(isRelevantLineType("264")).toBe(false);
    expect(isRelevantLineType(undefined)).toBe(false);
  });

  it("does not read 261 lines: positions are no longer used (docs/DESIGN.md 5.7), so neither archived", () => {
    expect(isRelevantLineType("261")).toBe(false);
    expect(parseLogLine(["261", "2026-10-06T20:32:02.6570000+08:00", "Change", "100827F3", "PosX", "103.6149"])).toBeUndefined();
  });
});
