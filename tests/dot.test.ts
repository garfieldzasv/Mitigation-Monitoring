import { describe, expect, it } from "vitest";
import { Engine } from "@/core/engine/engine";
import type { DamageRow } from "@/core/engine/types";
import type { GameEvent } from "@/core/logline/parse";
import { loadFixture, runFixture } from "./helpers/fixture";

const T = 1_000_000;
const P = { id: "10000001", name: "P1" };
const BOSS = { id: "40000001", name: "狂热糖潮" };

const debuff = (sec: number, id: number, name: string, source = BOSS): GameEvent => ({
  type: "gainEffect",
  time: T + sec * 1000,
  effectId: id,
  effectName: name,
  duration: 9999,
  sourceId: source.id,
  sourceName: source.name,
  targetId: P.id,
  targetName: P.name,
  stacks: 0,
});
const tick = (sec: number, effectId = 0): GameEvent => ({
  type: "tick",
  time: T + sec * 1000,
  kind: "dot",
  targetId: P.id,
  targetName: P.name,
  effectId,
  amount: 9000,
  targetHp: 100000,
  targetMaxHp: 100000,
});

function dotRows(events: GameEvent[]): DamageRow[] {
  const engine = new Engine();
  engine.handle({ type: "combat", time: T, act: true, game: true, gameChanged: true });
  for (const e of events) engine.handle(e);
  return engine.current!.rows.filter((r): r is DamageRow => r.kind === "dot");
}

describe("which debuff a DoT tick came from", () => {
  it("the target's only damage-over-time debuff from an enemy: its name, and who put it there", () => {
    // 中暑「身处酷暑环境，体力逐渐流失」: the 24 line names neither the status nor the source.
    const [row] = dotRows([debuff(1, 4449, "中暑"), tick(3)]);
    expect(row).toMatchObject({ action: { name: "中暑" }, source: { name: "狂热糖潮" } });
  });

  it("two of the same name are still that status; two different ones, or none, are unknown", () => {
    const helper = { id: "40000002", name: "狂热糖潮" };
    expect(dotRows([debuff(1, 4449, "中暑"), debuff(1, 4449, "中暑", helper), tick(3)])[0]!.action.name).toBe("中暑");
    const poison = 0x12; // 中毒, a damage-over-time debuff too
    expect(dotRows([debuff(1, 4449, "中暑"), debuff(1, poison, "中毒"), tick(3)])[0]).toMatchObject({ action: { name: "持续伤害" }, source: { name: "" } });
    expect(dotRows([tick(3)])[0]!.action.name).toBe("持续伤害");
  });
});

describe("in a real pull", () => {
  it("names the hunt's DoT ticks 护龙威压; the arena applied most of them, so their source stays unknown", () => {
    const engine = runFixture(loadFixture("hunt-8p.log.gz"));
    const dots = engine.encounters.flatMap((e) => e.rows).filter((r): r is DamageRow => r.kind === "dot");
    expect(dots.length).toBeGreaterThan(500);
    expect(dots.every((r) => r.action.name === "护龙威压")).toBe(true);
    expect(dots.filter((r) => r.source.name === "护锁刃龙").length).toBeGreaterThan(10);
    expect(dots.every((r) => r.source.name === "护锁刃龙" || r.source.id === "")).toBe(true);
  });
});
