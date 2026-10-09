import { describe, expect, it } from "vitest";
import { tooltipSizes } from "../scripts/game-data/barriers";
import { clauses, clauseValue, coexistNames, renderTooltip } from "../scripts/game-data/mitigation";
import { barrierShares } from "@/core/game/barriers";
import { TAKEN_MITIGATION, DEALT_MITIGATION } from "@/data/mitigation";

// Tooltips as the CN game data writes them (ActionTransient), shortened.
const TACTICIAN =
  "一定时间内，令自身和周围队员所受到的伤害减轻<If(Equal(PlayerParameter(68),31))><If(GreaterThanOrEqualTo(PlayerParameter(72),98))>15<Else/>10</If><Else/>10</If>% <UIForeground>F201F8</UIForeground><UIGlow>F201F9</UIGlow>持续时间：<UIGlow>01</UIGlow><UIForeground>01</UIForeground>15秒 无法与吟游诗人的行吟、舞者的防守之桑巴效果共存";
const HOLY_SHELTRON = "一定时间内，自身受到的伤害减轻15% 持续时间：8秒 追加效果：骑士的坚守 持续时间：4秒 骑士的坚守效果：令目标受到的伤害减轻15% 追加效果：骑士的加护 持续时间：12秒 骑士的加护效果：令目标体力持续恢复 恢复力：250";
const NASCENT_FLASH =
  "指定一名队员为目标，对自身附加原初的勇猛状态，为目标附加原初的武猛状态 持续时间：8秒 原初的勇猛效果：自身发动的战技命中时恢复体力 恢复力：400 原初的武猛效果：恢复战士自身恢复量100%的体力 同时，受到的伤害减轻10% 追加效果：为目标附加原初的血潮状态 持续时间：4秒 原初的血潮效果：令目标受到的伤害减轻10%";
const NAMES = new Set(["策动", "行吟", "防守之桑巴", "圣盾阵", "骑士的坚守", "骑士的加护", "原初的勇猛", "原初的武猛", "原初的血潮", "告解", "白牛清汁", "坚角清汁"]);

describe("mitigation from tooltips (scripts/game-data/mitigation.ts)", () => {
  it("renders a tooltip for a job and level: 策动 is 10% below 98, 15% from 98", () => {
    expect(renderTooltip(TACTICIAN, 31, 97)).toContain("伤害减轻10%持续时间：15秒");
    expect(renderTooltip(TACTICIAN, 31, 98)).toContain("伤害减轻15%");
    expect(renderTooltip(TACTICIAN, 23, 100)).toContain("伤害减轻10%"); // another job's version
    expect(renderTooltip("令自身和周围队员所受到的伤害减轻２０％", 0, 100)).toBe("令自身和周围队员所受到的伤害减轻20%");
  });

  it("reads one value for both damage types, or a split one", () => {
    expect(clauseValue("自身受到的伤害减轻15%", false)).toEqual({ physical: 15, magical: 15 });
    expect(clauseValue("区域内的队员所受到的伤害会减轻10%", false)).toEqual({ physical: 10, magical: 10 });
    expect(clauseValue("令自身和周围队员所受到的物理伤害减轻5%、魔法伤害减轻10%", false)).toEqual({ physical: 5, magical: 10 });
    expect(clauseValue("令自身和周围队员所受到的魔法伤害减轻10%", false)).toEqual({ physical: 0, magical: 10 });
    expect(clauseValue("附加物理伤害减轻10%的防护罩", false)).toEqual({ physical: 10, magical: 0 });
    expect(clauseValue("令目标物理攻击造成的伤害降低5%，魔法攻击造成的伤害降低10%", true)).toEqual({ physical: 5, magical: 10 });
    expect(clauseValue("使自身周围的敌人攻击伤害降低10%", true)).toEqual({ physical: 10, magical: 10 });
    expect(clauseValue("恢复战士自身恢复量100%的体力", false)).toBeUndefined();
  });

  it("gives each status its own clause: the action's own, and each 'X效果：'", () => {
    const c = clauses(renderTooltip(HOLY_SHELTRON, 19, 100), "圣盾阵", NAMES);
    expect(clauseValue(c.get("圣盾阵")!, false)).toEqual({ physical: 15, magical: 15 });
    expect(clauseValue(c.get("骑士的坚守")!, false)).toEqual({ physical: 15, magical: 15 });
    expect(clauseValue(c.get("骑士的加护")!, false)).toBeUndefined();
    const n = clauses(renderTooltip(NASCENT_FLASH, 21, 100), "原初的勇猛", NAMES);
    expect(clauseValue(n.get("原初的勇猛")!, false)).toBeUndefined(); // the WAR's own: no reduction
    expect(clauseValue(n.get("原初的武猛")!, false)).toEqual({ physical: 10, magical: 10 });
    expect(clauseValue(n.get("原初的血潮")!, false)).toEqual({ physical: 10, magical: 10 });
  });

  it("an unnamed 追加效果 is the action's own; an action named unlike its status gives it to the one it grants", () => {
    const tauro = clauses(renderTooltip("恢复自身或一名队员的体力 恢复力：700 追加效果：目标所受伤害减轻10% 持续时间：15秒 无法与坚角清汁效果共存", 40, 100), "白牛清汁", NAMES);
    expect(clauseValue(tauro.get("白牛清汁")!, false)).toEqual({ physical: 10, magical: 10 });
    const plenary = clauses(renderTooltip("一定时间内，令自身和周围队员所受到的伤害减轻10% 持续时间：10秒 追加效果：告解 对处于告解状态中的目标使用医治并生效时，会使目标产生额外的恢复效果", 24, 100), "全大赦", NAMES);
    expect(clauseValue(plenary.get("告解")!, false)).toEqual({ physical: 10, magical: 10 });
  });

  it("reads which statuses cannot coexist", () => {
    expect(coexistNames(renderTooltip(TACTICIAN, 31, 100), NAMES)).toEqual(["行吟", "防守之桑巴"]);
  });

  it("the generated table, as the import wrote it: the hand-checked values, and the statuses no log had shown", () => {
    expect(TAKEN_MITIGATION[1856]).toMatchObject({ physical: 15, magical: 15 }); // 盾阵 (synced below 82)
    expect(TAKEN_MITIGATION[1858]).toMatchObject({ physical: 10, magical: 10 }); // 原初的武猛
    expect(TAKEN_MITIGATION[1857]).toBeUndefined(); // 原初的勇猛: none
    expect(TAKEN_MITIGATION[1951]).toMatchObject({ physical: 10, magical: 10, levels: [{ level: 98, physical: 15, magical: 15 }] });
    expect(TAKEN_MITIGATION[1951]!.group).toBe(TAKEN_MITIGATION[1934]!.group); // 策动 and 行吟 do not stack
    expect(TAKEN_MITIGATION[2619]!.group).toBe(TAKEN_MITIGATION[2618]!.group); // 白牛清汁 and 坚角清汁 neither
    expect(DEALT_MITIGATION[1203]).toMatchObject({ physical: 5, magical: 10 }); // 昏乱
  });
});

describe("shield sizes from tooltips (scripts/game-data/barriers.ts)", () => {
  const STATUSES = new Set(["鼓舞", "激励", "均衡诊断", "齐衡诊断"]);
  const ACTIONS = new Set(["吉星相位", "阳星相位", "阳星合相"]);
  it("reads whose share of what: a named status's, an action's (…效果量：), or the action's own shield", () => {
    const adlo = tooltipSizes(renderTooltip("追加效果：为目标附加能够抵御一定伤害的防护罩鼓舞鼓舞效果：抵消相当于治疗量<If(Equal(PlayerParameter(68),28))><If(GreaterThanOrEqualTo(PlayerParameter(72),85))>180<Else/>125</If><Else/>125</If>%的伤害 追加效果（暴击时）：为目标附加能够抵御一定伤害的防护罩激励激励效果：抵消相当于治疗量180%的伤害", 28, 84), STATUSES, ACTIONS);
    expect(adlo.get("s:鼓舞")).toEqual({ of: "heal", percents: [125] });
    expect(adlo.get("s:激励")).toEqual({ of: "heal", percents: [180] });
    const sect = tooltipSizes("追加效果：使用吉星相位及阳星合相时，附加能够抵御一定伤害的防护罩吉星相位效果量：抵消相当于治疗量250%的伤害阳星合相效果量：抵消相当于治疗量125%的伤害", STATUSES, ACTIONS);
    expect(sect.get("a:吉星相位")).toEqual({ of: "heal", percents: [250] });
    expect(sect.get("a:阳星合相")).toEqual({ of: "heal", percents: [125] });
    expect(tooltipSizes("为自身或一名队员附加能够抵御一定伤害的防护罩该防护罩能够抵消相当于目标最大体力25%的伤害量", STATUSES, ACTIONS).get("")).toEqual({ of: "bearer", percents: [25] });
    expect(tooltipSizes("为自身及周围队员附加能够抵御一定伤害的防护罩防护罩效果：抵消相当于骑士自身最大体力10%的伤害量", STATUSES, ACTIONS).get("")).toEqual({ of: "caster", percents: [10] });
  });

  it("alternatives: sizes by stacks, and 摆脱's 2 % per status it removes", () => {
    expect(tooltipSizes("0档时：抵消相当于目标最大体力5%的伤害量1档时：抵消相当于目标最大体力6%的伤害量", STATUSES, ACTIONS).get("")!.percents).toEqual([5, 6]);
    const shake = "为自身及周围队员附加能够抵御一定伤害的防护罩该防护罩能够抵消相当于目标最大体力15%的伤害量另外，若自身处于“战栗”“戮罪”“原初的血气”状态，发动该技能会解除这些状态每解除一个状态，防护罩的效果量上升2%持续时间：30秒";
    expect(tooltipSizes(shake, STATUSES, ACTIONS).get("")!.percents).toEqual([15, 17, 19, 21]);
  });

  it("the generated table: by the caster's level; an action another one turns into is read for its job (均衡诊断: ClassJob 0, 贤者 by ClassJobCategory)", () => {
    expect(barrierShares(185, 297, 84)).toEqual({ of: "heal", percents: [125] });
    expect(barrierShares(185, 297, 100)).toEqual({ of: "heal", percents: [180] });
    expect(barrierShares(186, 297, 90)).toEqual({ of: "heal", percents: [160] }); // 士气高扬之策's own shield
    expect(barrierShares(24291, 2607, 90)).toEqual({ of: "heal", percents: [180] });
    expect(barrierShares(24292, 2609, 80)).toEqual({ of: "heal", percents: [230] });
    expect(barrierShares(24292, 2609, 0)!.percents.sort()).toEqual([230, 320]); // level unknown: either
    expect(barrierShares(3595, 1921, 100)).toEqual({ of: "heal", percents: [250] }); // 中间学派's, put on by 吉星相位
  });
});
