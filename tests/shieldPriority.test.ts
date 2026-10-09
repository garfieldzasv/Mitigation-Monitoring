import { describe, expect, it } from "vitest";
import { BARRIER_PRIORITY, barrierRank, UNRANKED_BARRIER } from "@/data/shieldPriority";

describe("the order barriers absorb damage in (data/shieldPriority.ts)", () => {
  it("follows the tested order: 至黑之夜 before 输血 before 泛输血, 激励 before 齐衡诊断 before 鼓舞", () => {
    const order = [1178, 2612, 2613, 1918, 2608, 297].map((id) => barrierRank(id, 100));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(barrierRank(297, 100)).toBe(25); // 鼓舞 last
    expect(barrierRank(3686, 100)).toBe(1); // 坦培拉涂层 first
  });

  it("a barrier is told by its name: every status ID of that name has the same rank", () => {
    expect(barrierRank(297, 100)).toBe(barrierRank(3087, 100)); // 鼓舞
    expect(barrierRank(1178, 100)).toBe(barrierRank(1308, 100)); // 至黑之夜
  });

  it("守护纹 ranks 1 from level 84, 11 below; an unknown level counts as the highest", () => {
    expect(barrierRank(2597, 90)).toBe(1);
    expect(barrierRank(2597, 80)).toBe(11);
    expect(barrierRank(2597, 0)).toBe(1);
  });

  it("a barrier neither source names comes after all of them", () => {
    expect(barrierRank(4788, 100)).toBe(UNRANKED_BARRIER); // 魔法屏障
    expect(barrierRank(2114, 100)).toBe(UNRANKED_BARRIER); // 哥布防御 (Blue Mage)
    expect(Math.max(...BARRIER_PRIORITY.map((b) => b.rank))).toBeLessThan(UNRANKED_BARRIER);
  });

  it("no status ID has two ranks", () => {
    const ids = BARRIER_PRIORITY.flatMap((b) => b.ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
