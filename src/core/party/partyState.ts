import type { CombatantRegistry } from "../combatants/registry";

export interface PartyMember {
  id: string;
  name: string;
  job: number;
  level: number;
  /** False for alliance members outside the player's own party. */
  inParty: boolean;
}

/**
 * The party and the player. Live, it comes from OverlayPlugin's PartyChanged and
 * ChangePrimaryPlayer; from a log file, from 11 (PartyList) and 02 lines (docs/DESIGN.md 9.5).
 */
export class PartyState {
  private members = new Map<string, PartyMember>();
  selfId: string | undefined;
  selfName: string | undefined;

  setParty(list: readonly PartyMember[]): void {
    this.members = new Map(list.map((m) => [m.id, m]));
  }

  /** Party from an 11 line: IDs only, so names, jobs and levels come from 03 lines. */
  setFromPartyList(ids: readonly string[], registry: CombatantRegistry): void {
    this.setParty(
      ids.map((id) => {
        const c = registry.get(id);
        return { id, name: c?.name ?? "", job: c?.job ?? 0, level: c?.level ?? 0, inParty: true };
      }),
    );
  }

  /**
   * A combatant's 03 line: a member the party knows by ID only (an 11 line before the member's 03 line) gets the name,
   * job and level it lacked. What PartyChanged gave stays.
   */
  fill(info: { id: string; name: string; job: number; level: number }): void {
    const m = this.members.get(info.id);
    if (!m) return;
    this.members.set(info.id, { ...m, name: m.name || info.name, job: m.job || info.job, level: m.level || info.level });
  }

  setSelf(id: string, name: string): void {
    this.selfId = id;
    this.selfName = name;
  }

  get(id: string): PartyMember | undefined {
    return this.members.get(id);
  }

  list(): PartyMember[] {
    return [...this.members.values()];
  }
}

/**
 * Whose rows are shown (docs/DESIGN.md 5.2): the player, their own party, and whoever else ACT
 * parses. ACT's parse filter does not change the log lines (24-player content logs all 24 targets
 * even when ACT parses only the party), but it decides who is in CombatData, so CombatData's names
 * add the rest of an alliance when ACT is set to parse it.
 *
 * CombatData alone cannot be the scope. It is ACT's ally list, which ACT works out from who acted on
 * whom starting from the player: it is empty until the player has acted, and early in a pull it can
 * flip to "the player plus the enemies" for a few seconds (both seen by Horizoverlay Reborn, whose
 * devlog has the decompiled logic). The player and party are therefore always in, whatever
 * CombatData says; enemy names that a flipped list adds never match a player target.
 */
export class DisplayScope {
  /** Union of CombatData names seen this encounter; null while none has arrived (always, from a log file). */
  private names: Set<string> | null = null;
  /** Union of in-party member IDs seen this encounter. */
  private partyIds = new Set<string>();

  constructor(private readonly party: PartyState) {}

  /**
   * Encounter start: the previous encounter's names no longer apply; start from the current party.
   * Within an encounter the scope only grows, so someone who leaves mid-pull or as the duty ends
   * (the party list empties a couple of seconds before combat ends) keeps their rows.
   */
  reset(): void {
    this.names = null;
    this.partyIds = new Set();
    this.partyChanged();
  }

  partyChanged(): void {
    for (const m of this.party.list()) if (m.inParty) this.partyIds.add(m.id);
  }

  /** Keys of CombatData.Combatant. Pets, "Limit Break" and enemies may be in there; they never match a player. */
  setCombatDataNames(names: Iterable<string>): void {
    this.names ??= new Set();
    for (const name of names) this.names.add(name);
  }

  /** The scope as plain data, frozen into an encounter when it ends. */
  snapshot(): ScopeSnapshot {
    return {
      combatDataNames: this.names ? [...this.names] : null,
      partyIds: [...this.partyIds],
      ...(this.party.selfId ? { selfId: this.party.selfId } : {}),
    };
  }

  includes(id: string, name: string): boolean {
    return inScope(id, name, this.party.selfId, this.partyIds, this.names);
  }
}

/** The scope rule, shared by the live scope and frozen ones. */
function inScope(
  id: string,
  name: string,
  selfId: string | undefined,
  partyIds: ReadonlySet<string>,
  names: ReadonlySet<string> | null,
): boolean {
  return id === selfId || partyIds.has(id) || (names?.has(name) ?? false);
}

/** A display scope frozen with an encounter; serializable, so the archive can keep it. */
export interface ScopeSnapshot {
  /** CombatData names (players, and whatever else ACT listed), or null when none arrived. */
  combatDataNames: string[] | null;
  partyIds: string[];
  selfId?: string;
}

export type ScopePredicate = (id: string, name: string) => boolean;

/**
 * A frozen scope as a predicate. Archives keep the raw scope rather than a verdict, so archives
 * saved before the player and party were always in follow the current rule too.
 */
export function compileScope(s: ScopeSnapshot): ScopePredicate {
  const names = s.combatDataNames ? new Set(s.combatDataNames) : null;
  const ids = new Set(s.partyIds);
  return (id, name) => inScope(id, name, s.selfId, ids, names);
}
