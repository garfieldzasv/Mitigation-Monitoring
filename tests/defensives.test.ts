import { describe, expect, it } from "vitest";
import { defensiveSkills, defensiveTimerOf } from "@/core/game/defensives";

const names = (job: number, level: number) => defensiveSkills(job, level).map((s) => s.name);
const skill = (job: number, level: number, name: string) => defensiveSkills(job, level).find((s) => s.name === name);

describe("mitigation skills from the game data (scripts/game-data/defensives.ts)", () => {
  it("a paladin at 100 has every mitigation, invulnerability and party shield, each chain at its learnt tier", () => {
    expect(names(19, 100)).toEqual(expect.arrayContaining(["铁壁", "雪仇", "圣盾阵", "极致防御", "神圣领域", "圣光幕帘", "干预", "武装戍卫"]));
    expect(names(19, 100)).not.toContain("预警");
    expect(names(19, 100)).not.toContain("盾阵");
  });

  it("level sync: lower tiers below an upgrade, nothing learnt above the level", () => {
    expect(names(19, 90)).toContain("预警");
    expect(names(19, 90)).not.toContain("极致防御");
    expect(names(19, 50)).toEqual(expect.arrayContaining(["铁壁", "雪仇", "盾阵", "预警", "神圣领域"]));
    expect(names(19, 50)).not.toContain("圣光幕帘");
    expect(names(19, 50)).not.toContain("干预");
  });

  it("charges and recast by level, from tooltips and traits", () => {
    expect(skill(24, 100, "神祝祷")).toMatchObject({ maxCharges: 2, recastMs: 30000 });
    expect(skill(24, 80, "神祝祷")).toMatchObject({ maxCharges: 1 });
    expect(skill(23, 100, "行吟")!.recastMs).toBe(90000);
    expect(skill(23, 80, "行吟")!.recastMs).toBe(120000);
    expect(skill(32, 100, "献奉")!.maxCharges).toBe(2);
  });

  it("recast refunds from the tooltips: a shield breaking cuts it (坦培拉涂层 60 s, unless 油性 lifted it; its 油性 30 s)", () => {
    expect(skill(42, 100, "坦培拉涂层")!.refunds).toEqual([
      { action: 34685, ms: 60000, liftedBy: [34686] },
      { action: 34686, ms: 30000, liftedBy: [] },
    ]);
    expect(defensiveSkills(19, 100).every((s) => s.refunds.length === 0)).toBe(true);
  });

  it("an unknown level counts as the highest", () => {
    expect(names(19, 0)).toEqual(names(19, 100));
  });

  it("tooltips decide, not status names: no damage-up, knockback or crit skills", () => {
    expect(names(23, 100)).toEqual(["行吟"]);
    for (const job of [19, 20, 22, 23, 33, 35, 38]) {
      for (const n of ["亲疏自行", "占卜", "鼓励", "龙剑", "贤者的叙事谣", "军神的赞美歌", "短兵相接", "即刻咏唱"]) expect(names(job, 100)).not.toContain(n);
    }
  });

  it("a skill whose finish puts the shield on counts through it (即兴表演 → 即兴表演结束)", () => {
    const improvisation = skill(38, 100, "即兴表演")!;
    expect(improvisation.actions).toContain(25789);
    expect(names(38, 100)).not.toContain("即兴表演结束");
  });

  it("a GCD a cooldown enables is not the cooldown's effect (炽天附体's 显灵之章)", () => {
    expect(names(28, 100)).toEqual(expect.arrayContaining(["野战治疗阵", "展开战术", "异想的幻光", "慰藉", "疾风怒涛之计"]));
    expect(names(28, 100)).not.toContain("炽天附体");
  });

  it("actions sharing a recast group share the timer; the tiers of a chain too", () => {
    expect(skill(21, 100, "原初的血气")!.timer).toBe(skill(21, 100, "原初的勇猛")!.timer);
    expect(defensiveTimerOf(17)).toBe(defensiveTimerOf(36920));
    expect(defensiveTimerOf(7561)).toBeUndefined(); // 即刻咏唱
  });
});
