import { describe, expect, it } from "vitest";
import { Engine } from "@/core/engine/engine";
import { readCombatants, type OverlayCombatant } from "@/core/overlay/combatants";

/** Shaped like the getCombatants reply seen in ACT: the player first, party members PartyType 1. */
const reply: OverlayCombatant[] = [
  { ID: 0x100187cf, OwnerID: 0, Type: 1, PartyType: 1, Job: 35, Level: 100, Name: "P1", MaxHP: 199339 },
  { ID: 0x10072e3a, OwnerID: 0, Type: 1, PartyType: 1, Job: 24, Level: 100, Name: "P2" },
  { ID: 0x10099999, OwnerID: 0, Type: 1, PartyType: 2, Job: 21, Level: 100, Name: "Alliance" },
  { ID: 0x4001180b, OwnerID: 0x10072e3a, Type: 2, PartyType: 0, Job: 0, Level: 100, Name: "地星" },
  { ID: 0x400117e3, OwnerID: 0, Type: 2, PartyType: 0, Job: 0, Level: 100, Name: "护锁刃龙" },
];

describe("readCombatants", () => {
  it("takes the player from the first entry and the party from PartyType 1", () => {
    const s = readCombatants(reply);
    expect(s.selfId).toBe("100187CF");
    expect(s.selfName).toBe("P1");
    expect(s.party.map((m) => [m.id, m.job, m.inParty])).toEqual([
      ["100187CF", 35, true],
      ["10072E3A", 24, true],
    ]);
    expect(s.combatants).toHaveLength(5);
    expect(s.combatants.find((c) => c.name === "地星")).toMatchObject({ id: "4001180B", ownerId: "10072E3A" });
    expect(s.combatants.find((c) => c.name === "护锁刃龙")).not.toHaveProperty("ownerId");
  });

  it("names no player when the first entry is not one", () => {
    expect(readCombatants([reply[4]!]).selfId).toBeUndefined();
    expect(readCombatants([])).toEqual({ combatants: [], party: [] });
  });
});

describe("Engine.bootstrap", () => {
  it("fills the player, the party and combatants that nothing else provided", () => {
    const engine = new Engine();
    engine.bootstrap(readCombatants(reply));
    expect(engine.party.selfId).toBe("100187CF");
    expect(engine.party.list()).toHaveLength(2);
    expect(engine.registry.ownerOf("4001180B")).toBe("10072E3A"); // pet, via its owner
    expect(engine.scope.includes("10072E3A", "P2")).toBe(true);
  });

  it("never overrides what events or log lines already gave", () => {
    const engine = new Engine();
    engine.setSelf("10000001", "Me");
    engine.setParty([{ id: "10000001", name: "Me", job: 19, level: 100, inParty: true }]);
    engine.bootstrap(readCombatants(reply));
    expect(engine.party.selfId).toBe("10000001");
    expect(engine.party.list().map((m) => m.id)).toEqual(["10000001"]);
  });
});
