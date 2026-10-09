import { describe, expect, it } from "vitest";
import { isNoCombatZone, zonePath, zoneTree, type ZoneNode } from "@/core/game/zones";
import { nodeStates, setSkipped } from "@/core/settings/zoneSkip";

const find = (key: string, nodes: readonly ZoneNode[] = zoneTree()): ZoneNode | undefined => {
  for (const n of nodes) {
    if (n.key === key) return n;
    const below = find(key, n.children ?? []);
    if (below) return below;
  }
  return undefined;
};

describe("the zone tree, from the game data", () => {
  it("副本 by the game's content types, 野外地图, 特殊场景", () => {
    const [duty, field, special] = zoneTree();
    expect([duty!.label, field!.label, special!.label]).toEqual(["副本", "野外地图", "特殊场景"]);
    expect(duty!.children!.map((c) => c.label)).toEqual(["迷宫挑战", "讨伐歼灭战", "大型任务", "绝境战", "诛灭战", "特殊迷宫探索"]);
    expect(special!.children!.slice(0, 6).map((c) => c.label)).toEqual(["禁地优雷卡", "天佑女王", "蜃景幻界新月岛", "深层迷宫", "寻宝", "对战"]);
    expect(special!.children!.at(-1)!.label).toBe("其他区域");
  });

  it("places where no fight happens are left out: towns, inns, housing, barracks, the Gold Saucer, ocean fishing…", () => {
    const labels: string[] = [];
    const walk = (nodes: readonly ZoneNode[]) => nodes.forEach((n) => (labels.push(n.label), walk(n.children ?? [])));
    walk(zoneTree());
    for (const place of ["主城", "旅馆", "房屋", "军营", "无名岛", "宇宙探索", "金碟游乐场", "格里达尼亚新街", "后桅旅店", "穹顶皓天", "出海垂钓", "九宫幻卡：幻卡对局室", "大地使者", "天上福地云冠群岛"]) {
      expect(labels).not.toContain(place);
    }
    // 132 格里达尼亚新街, 177 后桅旅店, 979 穹顶皓天, 534 双蛇党军营, 144 金碟游乐场, 900 出海垂钓, 901 天上福地云冠群岛 (大地使者)
    for (const zone of [132, 177, 979, 534, 144, 900, 901]) {
      expect(isNoCombatZone(zone)).toBe(true);
      expect(zonePath(zone)).toEqual([]);
    }
    // Fights happen here: the open world, a duty, Eureka.
    for (const zone of [137, 0x514, 732]) expect(isNoCombatZone(zone)).toBe(false);
  });

  it("long lists by expansion; short ones flat", () => {
    expect(find("duty:t2")!.children!.map((c) => c.label)).toEqual(["重生之境", "苍穹之禁城", "红莲之狂潮", "暗影之逆焰", "晓月之终途", "金曦之遗辉"]);
    expect(find("duty:t28")!.children!.map((c) => c.label)).toEqual([
      "巴哈姆特绝境战",
      "究极神兵绝境战",
      "亚历山大绝境战",
      "幻想龙诗绝境战",
      "欧米茄绝境验证战",
      "光暗未来绝境战",
      "妖星乱舞绝境战",
    ]);
  });

  it("each zone's path from its category to its own node", () => {
    expect(zonePath(0x514)).toEqual(["duty", "duty:t4", "duty:t4:v5", "z:1300"]); // 护锁刃龙狩猎战
    expect(zonePath(137)).toEqual(["field", "field:v0", "z:137"]); // 东拉诺西亚
    expect(zonePath(732)).toEqual(["special", "special:t26", "z:732"]); // 优雷卡常风之地
    expect(zonePath(99999)).toEqual([]);
  });
});

describe("checking and unchecking nodes", () => {
  const tree: ZoneNode[] = [
    {
      key: "a",
      label: "A",
      count: 3,
      children: [
        { key: "a1", label: "A1", count: 2, children: [{ key: "x", label: "X", count: 1 }, { key: "y", label: "Y", count: 1 }] },
        { key: "a2", label: "A2", count: 1 },
      ],
    },
    { key: "b", label: "B", count: 1 },
  ];

  it("checking a node drops the keys under it; a parent whose children are all checked takes their place", () => {
    expect(setSkipped(["x"], "a1", true, tree)).toEqual(["a1"]);
    expect(setSkipped(["a1"], "a2", true, tree)).toEqual(["a"]);
    expect(setSkipped(["x"], "y", true, tree)).toEqual(["a1"]);
  });

  it("unchecking a node checked through one above checks the others instead", () => {
    expect(setSkipped(["a"], "x", false, tree)).toEqual(["a2", "y"]);
    expect(setSkipped(["a", "b"], "a2", false, tree)).toEqual(["b", "a1"]);
    expect(setSkipped(["a1"], "a1", false, tree)).toEqual([]);
  });

  it("keys from another game-data version stay as they are", () => {
    expect(setSkipped(["old"], "b", true, tree)).toEqual(["old", "b"]);
    expect(setSkipped(["old"], "nope", true, tree)).toEqual(["old"]);
  });

  it("the boxes: on through a node above, some when part of what is under it is", () => {
    const states = nodeStates(["x", "b"], tree);
    expect(Object.fromEntries(states)).toEqual({ a: "some", a1: "some", x: "on", y: "off", a2: "off", b: "on" });
    expect(nodeStates(["a"], tree).get("y")).toBe("on");
  });
});
