import { describe, expect, it } from "vitest";
import { Engine } from "@/core/engine/engine";
import type { DamageRow } from "@/core/engine/types";
import type { GameEvent } from "@/core/logline/parse";

const T = 2_000_000;
const P = "10000001";
const at = (sec: number) => T + sec * 1000;
const ability = (sec: number, sourceId: string, targetId: string, damage = true): GameEvent => ({
  type: "ability",
  time: at(sec),
  sourceId,
  sourceName: sourceId === P ? "P1" : "Add",
  actionId: 1,
  actionName: "a",
  targetId,
  targetName: targetId === P ? "P1" : "Add",
  ...(damage ? { damage: { result: "hit" as const, amount: 1000, crit: false, direct: false, damageType: "magical" as const, attackType: 5, element: 0 } } : {}),
  targetHp: 100_000,
  targetMaxHp: 100_000,
  sourceHp: 1,
  sourceMaxHp: 1,
  sequence: `${sourceId}${sec}`,
  targetIndex: 0,
  targetCount: 1,
});
const add = (id: string): GameEvent => ({ type: "addCombatant", time: T, id, name: "Add", job: 0, level: 100, maxHp: 100_000 });

describe("source statuses", () => {
  it("a helper actor borrows its namesake's Reprisal; another add players hit does not", () => {
    const engine = new Engine();
    for (const id of ["40000001", "40000002", "40000003"]) engine.handle(add(id));
    engine.handle({ type: "combat", time: T, act: true, game: true, gameChanged: true });
    // Players hit adds 1 and 2; 3 is never hit (a helper). Reprisal lands on add 1.
    engine.handle(ability(1, P, "40000001", false));
    engine.handle(ability(1.1, P, "40000002", false));
    engine.handle({ type: "gainEffect", time: at(1.2), effectId: 0x4a9, effectName: "雪仇", duration: 15, sourceId: P, sourceName: "P1", targetId: "40000001", targetName: "Add", stacks: 0 });
    for (const [sec, id] of [[2, "40000001"], [3, "40000002"], [4, "40000003"]] as const) engine.handle(ability(sec, id, P));
    const rows = engine.current!.rows.filter((r): r is DamageRow => r.kind === "hit");
    const reprisal = (id: string) => rows.find((r) => r.source.id === id)!.sourceStatuses.find((s) => s.id === 0x4a9);
    expect(reprisal("40000001")?.inherited).toBeUndefined();
    expect(reprisal("40000002")).toBeUndefined();
    expect(reprisal("40000003")?.inherited).toBe(true);
  });
});
