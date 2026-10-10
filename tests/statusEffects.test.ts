import { describe, expect, it } from "vitest";
import { damageEffect } from "../scripts/game-data/statusEffects";
import { isAuraStatus, isListedStatus, negatesDamage, statusCategory } from "@/core/game/statuses";

// Descriptions as the CN Status sheet writes them.
describe("what a damage status's description says (scripts/game-data/statusEffects.ts)", () => {
  it("the damage it covers: its own clause's type or element, else all", () => {
    expect(damageEffect("受到攻击的伤害增加", "takenUp")).toEqual({ scope: "", byte: "first" }); // 受伤加重
    expect(damageEffect("受到物理攻击的伤害减少", "takenDown").scope).toBe("physical");
    expect(damageEffect("受到魔法攻击的伤害增加", "takenUp").scope).toBe("magical");
    expect(damageEffect("减轻所受到的物理和魔法伤害", "takenDown").scope).toBe(""); // both: all
    // 物理 in another clause (a counter) is not its scope
    expect(damageEffect("受到攻击的伤害减少并且受到物理攻击时会发动反击", "takenDown").scope).toBe("");
    expect(damageEffect("被打上了火之烙印无法对拉哈布雷亚造成伤害，自身受到火属性攻击的伤害增加", "takenUp").scope).toBe("fire");
  });

  it("a condition the log cannot check makes it conditional", () => {
    expect(damageEffect("接近锁链连接的同伴时受到的伤害增加", "takenUp").scope).toBe("conditional");
    expect(damageEffect("发生故障，与他人的距离过近或过远时，被攻击时所受到的伤害增加", "takenUp").scope).toBe("conditional");
    expect(damageEffect("部分攻击命中自身特定方向时，受到的伤害增加", "takenUp").scope).toBe("conditional");
    expect(damageEffect("身缠光属性以太，受到的暗属性伤害提高", "takenUp").scope).toBe("conditional");
    expect(damageEffect("可以承受雷电，被特定技能攻击时受到的伤害减少", "takenDown").scope).toBe("conditional");
    // "特定" elsewhere is not its condition; "连接" alone is no tether
    expect(damageEffect("攻击所造成的伤害提高，效果中发动特定技能会积累兽魂量值", "dealtUp").scope).toBe("");
    expect(damageEffect("和魔列车连接在一起，受到的伤害增加，体力逐渐减少", "takenUp").scope).toBe("");
  });

  it("with other modifiers: the byte of its own sign when only it has that sign, else none", () => {
    expect(damageEffect("身体变得特别小，移动速度与发动攻击造成的伤害降低，被攻击时所受到的伤害增加", "takenUp").byte).toBe("sign");
    expect(damageEffect("最大体力降低，受到攻击的伤害增加", "takenUp").byte).toBe("sign");
    expect(damageEffect("强化了攻击的形态，攻击所造成的伤害提高，受到攻击的伤害增加", "takenUp").byte).toBe("none");
    expect(damageEffect("展开着魔法阵魔法攻击力提高，能够发动强大的魔法，但被攻击时所受伤害增加", "takenUp").byte).toBe("none");
  });

  it("an HP floor is shown as an invulnerability but does not negate damage", () => {
    expect(statusCategory(409, "target")).toBe("invuln"); // 死斗
    expect(negatesDamage(409)).toBe(false);
    expect(negatesDamage(810)).toBe(false); // 行尸走肉
    expect(negatesDamage(82)).toBe(true); // 神圣领域
    expect(negatesDamage(1570)).toBe(true); // 无敌「一切攻击都无法造成伤害」
    expect(negatesDamage(1567)).toBe(true); // 召唤兽的加护「暂时无敌」
    expect(statusCategory(2517, "target")).toBe("other"); // 起死回生: "移动到不会受到伤害的安全位置" is no invulnerability
  });
});

describe("statuses the review does not list (docs/DESIGN.md 8.2)", () => {
  it("those the game does not show: no name and no icon", () => {
    expect(isListedStatus(0x808)).toBe(false); // Unknown_808: carries a VFX
    expect(isListedStatus(0x7a5)).toBe(false); // 致命蝙蝠 circling
    expect(isListedStatus(0x1152)).toBe(false); // 野蛮恨心 with its weapon out
    expect(isListedStatus(0x1153)).toBe(false);
  });

  it("free company buffs", () => {
    expect(isListedStatus(365)).toBe(false); // 部队特效：讨伐经验值提高
    expect(isListedStatus(2932)).toBe(false); // 部队特效：城内冲刺时间延长
  });

  it("the rest stay, unrelated ones too", () => {
    expect(isListedStatus(0xee0)).toBe(true); // 免除方向要求: named, with an icon
    expect(isListedStatus(1873)).toBe(true); // 节制
    expect(isListedStatus(0x74f)).toBe(true); // 天辉
  });
});

describe("a player's aura (docs/DESIGN.md 5.4): the timer hidden, but not forever", () => {
  const player = "10000001";
  it("the effect an aura or a ground effect keeps re-sending", () => {
    for (const id of [1873, 299, 1912, 738, 3689, 2216, 2217, 2218, 1176, 3885]) expect(isAuraStatus(id, player)).toBe(true);
  });

  it("not a stance, a dance partner, 关心 (forever), nor a timed status like the caster's own 节制", () => {
    for (const id of [1833, 91, 1824, 2605, 1872, 1191]) expect(isAuraStatus(id, player)).toBe(false);
  });

  it("not a duty's mechanics, which no player put on", () => {
    expect(isAuraStatus(1726, "40001234")).toBe(false); // 拘束
    expect(isAuraStatus(2832, "E0000000")).toBe(false); // 黑暗咒缚
  });
});
