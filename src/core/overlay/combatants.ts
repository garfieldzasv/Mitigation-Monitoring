import type { CombatantInfo } from "../combatants/registry";
import type { PartyMember } from "../party/partyState";

/** One entry of OverlayPlugin's `getCombatants` reply (only the fields this app reads). */
export interface OverlayCombatant {
  ID?: number;
  OwnerID?: number;
  /** 1 = player character. */
  Type?: number;
  /** 1 = in the player's party. */
  PartyType?: number;
  Job?: number;
  Level?: number;
  Name?: string;
  MaxHP?: number;
}

export interface CombatantSnapshot {
  combatants: CombatantInfo[];
  selfId?: string;
  selfName?: string;
  party: PartyMember[];
}

/** Numeric IDs as the log writes them: 8 uppercase hex digits. */
export const hexId = (n: number | undefined) => ((n ?? 0) >>> 0).toString(16).toUpperCase().padStart(8, "0");

/**
 * Reads a `getCombatants` reply. As seen in ACT (docs/DESIGN.md 11.2): the player is the first
 * entry, players have Type 1, and party members PartyType 1, with their ClassJob IDs in Job.
 */
export function readCombatants(list: readonly OverlayCombatant[]): CombatantSnapshot {
  const combatants: CombatantInfo[] = list
    .filter((c) => c.ID)
    .map((c) => ({
      id: hexId(c.ID),
      name: c.Name ?? "",
      job: c.Job ?? 0,
      level: c.Level ?? 0,
      ...(c.OwnerID ? { ownerId: hexId(c.OwnerID) } : {}),
      maxHp: c.MaxHP ?? 0,
    }));
  const head = list[0];
  const party = list
    .filter((c) => c.Type === 1 && c.PartyType === 1 && c.ID)
    .map((c) => ({ id: hexId(c.ID), name: c.Name ?? "", job: c.Job ?? 0, level: c.Level ?? 0, inParty: true }));
  return {
    combatants,
    ...(head?.Type === 1 && head.ID ? { selfId: hexId(head.ID), selfName: head.Name ?? "" } : {}),
    party,
  };
}
