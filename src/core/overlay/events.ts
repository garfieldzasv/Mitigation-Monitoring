/**
 * Subset of OverlayPlugin events used by this app.
 *
 * Verified in OverlayPlugin's source (FFXIVRequiredEventSource / FFXIVOptionalEventSource):
 * - PartyChanged and ChangePrimaryPlayer are cached: a new subscriber receives the current value
 *   immediately, so an overlay opened mid-session needs no further events.
 * - While solo, PartyChanged carries a one-member party (the player), never an empty one.
 * - Member `id` is uppercase hex, the same format as source IDs in log lines.
 */
export interface OverlayPartyMember {
  id: string;
  name: string;
  worldId: number;
  job: number;
  level: number;
  inParty: boolean;
}

/**
 * ACT's encounter summary, pushed about once a second while ACT is in combat. Only the keys of
 * `Combatant` are used: they are who ACT parses, which follows ACT's parse filter
 * (docs/DESIGN.md 5.2). The player may appear as "YOU".
 */
export interface OverlayCombatData {
  type: "CombatData";
  Encounter?: Record<string, string>;
  Combatant?: Record<string, Record<string, string>>;
  isActive?: string | boolean;
}

export interface OverlayEventMap {
  LogLine: { type: "LogLine"; line: string[]; rawLine: string };
  PartyChanged: { type: "PartyChanged"; party: OverlayPartyMember[] };
  ChangePrimaryPlayer: { type: "ChangePrimaryPlayer"; charID: number; charName: string };
  ChangeZone: { type: "ChangeZone"; zoneID: number; zoneName: string };
  CombatData: OverlayCombatData;
}

export type OverlayEventName = keyof OverlayEventMap;

export type OverlayHandler<E extends OverlayEventName> = (event: OverlayEventMap[E]) => void;
