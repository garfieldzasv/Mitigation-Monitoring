import { describe, expect, it } from "vitest";
import { formatClock, formatMitigation, formatRemaining, formatUnmitigated, remainingSeconds, mitigationColor, mitigationPercent, mitigationTitle, statusRemaining, unmitigatedEstimate, verdictLabel, vulnerabilityNote } from "@/app/format";
import type { DamageRow } from "@/core/engine/types";

describe("formatClock", () => {
  it("mm:ss without fractions, negative before the pull", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(72_400)).toBe("01:12");
    expect(formatClock(426_999)).toBe("07:06");
    expect(formatClock(-1_200)).toBe("-00:01");
  });
});

describe("formatRemaining", () => {
  it("seconds under a minute, m:ss above, so food's hour fits the detail column", () => {
    expect(formatRemaining(8_640)).toBe("8.7 秒"); // rounded up, like the icons
    expect(formatRemaining(59_940)).toBe("60.0 秒");
    expect(formatRemaining(60_000)).toBe("1:00");
    expect(formatRemaining(3_203_200)).toBe("53:23");
    expect(formatRemaining(Number.POSITIVE_INFINITY)).toBe("常驻");
  });

  it("光环 for a player's aura: it has no time of its own; a stance stays 常驻", () => {
    const player = "10000001";
    expect(statusRemaining({ id: 1873, remainingMs: Number.POSITIVE_INFINITY, sourceId: player })).toBe("光环");
    expect(statusRemaining({ id: 1833, remainingMs: Number.POSITIVE_INFINITY, sourceId: player })).toBe("常驻");
    expect(statusRemaining({ id: 1191, remainingMs: 8_640, sourceId: player })).toBe("8.7 秒");
  });
});

describe("a status icon's seconds and its tooltip agree (docs/DESIGN.md 7.1)", () => {
  it("both round up; the icon's is the tooltip's rounded up again", () => {
    expect([remainingSeconds(57_030), formatRemaining(57_030)]).toEqual([58, "57.1 秒"]); // was 58 against 57.0
    expect([remainingSeconds(57_000), formatRemaining(57_000)]).toEqual([57, "57.0 秒"]);
    expect([remainingSeconds(300), formatRemaining(300)]).toEqual([1, "0.3 秒"]); // never 0 while it is still on
    expect([remainingSeconds(0), formatRemaining(0)]).toEqual([0, "0.0 秒"]);
    for (let ms = 0; ms < 60_000; ms += 7.3) expect(remainingSeconds(ms)).toBe(Math.ceil(Number.parseFloat(formatRemaining(ms))));
  });
});

describe("mitigation", () => {
  it("turns a multiplier into a reduction percentage", () => {
    expect(mitigationPercent(0.72)).toBe(28);
    expect(mitigationPercent(1)).toBe(0);
    expect(mitigationPercent(1.1)).toBe(-10);
    expect(formatMitigation(0.72)).toBe("28%");
    expect(formatMitigation(0.9, true)).toBe("10%?");
    expect(formatMitigation(null)).toBe("—");
  });

  it("explains the multiplier on hover", () => {
    const title = mitigationTitle(
      [
        { name: "铁壁", percent: 20, effect: "reduction", side: "target", statusId: 1191 },
        { name: "雪仇", percent: 10, effect: "reduction", side: "source", statusId: 1193, inherited: true },
        { name: "抗死", percent: 0, effect: "reduction", side: "target", statusId: 2707 },
        { name: "策动", percent: 15, effect: "reduction", side: "target", statusId: 1951, overlapped: true },
        { name: "某减伤", percent: null, effect: "reduction", side: "target", statusId: 99999 },
        { name: "受伤加重", percent: null, effect: "increase", side: "target", statusId: 1789, stacks: 2 },
        { name: "受伤加重", percent: 30, effect: "increase", side: "target", statusId: 1789 },
        { name: "魔法受伤加重", percent: 0, effect: "increase", side: "target", statusId: 60 },
        { name: "伤害提高", percent: 10, effect: "increase", side: "source", statusId: 61 },
      ],
      0.72,
      true,
      "physical",
    );
    expect(title.split("\n")).toEqual([
      "铁壁　−20%",
      "雪仇（Boss 身上，继承自本体）　−10%",
      "抗死　对物理伤害不生效",
      "策动　不叠加，不计入",
      "某减伤　数值未知",
      "受伤加重 ×2　易伤，数值未知，不计入",
      "受伤加重　+30%，易伤不计入减伤",
      "魔法受伤加重　对物理伤害不生效",
      "伤害提高（Boss 身上）　+10%，增伤不计入减伤",
      "物理伤害，合计减伤 28%?（有数值未知的减伤，实际更高）",
    ]);
    expect(mitigationTitle([], null, false, "unknown")).toContain("持续伤害");
  });

  it("is red at 0%, green at 50%, clamped outside", () => {
    expect(mitigationColor(0)).toBe("hsl(0, 70%, 58%)");
    expect(mitigationColor(25)).toBe("hsl(60, 70%, 58%)");
    expect(mitigationColor(50)).toBe("hsl(120, 70%, 58%)");
    expect(mitigationColor(-10)).toBe(mitigationColor(0));
    expect(mitigationColor(80)).toBe(mitigationColor(50));
  });
});

describe("verdictLabel", () => {
  const row = (over: Partial<DamageRow>): DamageRow => ({ result: "hit", fullyAbsorbed: false, invulnerable: false, ...over }) as DamageRow;

  it("a blocked or parried hit that a shield took whole is both (10-06 炼净之狱3: 格挡, 全吸收)", () => {
    expect(verdictLabel(row({ result: "block", fullyAbsorbed: true }))).toBe("格挡·全吸收");
    expect(verdictLabel(row({ result: "parry", fullyAbsorbed: true }))).toBe("招架·全吸收");
    expect(verdictLabel(row({ result: "block", fullyAbsorbed: true }), true)).toBe("格盾");
    expect(verdictLabel(row({ result: "parry" }), true)).toBe("招");
    expect(verdictLabel(row({ fullyAbsorbed: true }))).toBe("全吸收");
    expect(verdictLabel(row({ fullyAbsorbed: true }), true)).toBe("盾");
    expect(verdictLabel(row({}))).toBe("");
  });

  it("未生效 and 无敌 stand alone", () => {
    expect(verdictLabel(row({ result: "block", fullyAbsorbed: true, noEffect: true }))).toBe("未生效");
    expect(verdictLabel(row({ result: "block", noEffect: true }), true)).toBe("无效");
    expect(verdictLabel(row({ result: "parry", invulnerable: true }))).toBe("无敌");
  });
});

describe("the unmitigated estimate and vulnerabilities", () => {
  const vulnerable = (name: string, percent: number | null, stacks?: number) =>
    ({ name, percent, effect: "increase", side: "target", statusId: 1, ...(stacks ? { stacks } : {}) }) as const;
  const row = (terms: DamageRow["mitigation"]): DamageRow =>
    ({ kind: "hit", result: "hit", amount: 14_000, shieldAbsorbed: 0, multiplier: 0.8, multiplierPartial: false, target: { id: "10000001", job: 24 }, damageType: "magical", mitigation: terms }) as unknown as DamageRow;

  it("takes out a vulnerability whose value is known", () => {
    const r = row([vulnerable("受伤加重", 40, 2)]);
    expect(unmitigatedEstimate(r)).toBe(Math.round(14_000 / 0.8 / 1.4));
    expect(formatUnmitigated(r)).not.toMatch(/[≤≥]/);
    expect(vulnerabilityNote(r)).toBe("已除以易伤 受伤加重×2 +40%");
  });

  it("marks one it includes (含易伤): the real figure is lower", () => {
    const r = row([vulnerable("惊慌失措", null)]);
    expect(unmitigatedEstimate(r)).toBe(Math.round(14_000 / 0.8));
    expect(formatUnmitigated(r)).toMatch(/^≤/);
    expect(vulnerabilityNote(r)).toBe("含易伤 惊慌失措：数值不明，实际更低");
  });
});
