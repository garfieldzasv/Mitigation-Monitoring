const EMPTY: ReadonlySet<string> = new Set();

/** Player character IDs start with 10; everything else (enemies, pets, ground objects) with 40. */
export function isPlayerId(id: string): boolean {
  return id.startsWith("10");
}

export interface CombatantInfo {
  id: string;
  name: string;
  job: number;
  level: number;
  ownerId?: string;
  maxHp: number;
}

/**
 * Who is who, from 03 / 04 lines. IDs are reused across zones (a stale table once mistook enemies
 * for pets 175 times in our samples), so the table is cleared on every zone change.
 */
export class CombatantRegistry {
  private readonly byId = new Map<string, CombatantInfo>();
  private readonly idsByName = new Map<string, Set<string>>();

  add(info: CombatantInfo): void {
    this.remove(info.id);
    this.byId.set(info.id, info);
    let ids = this.idsByName.get(info.name);
    if (!ids) {
      ids = new Set();
      this.idsByName.set(info.name, ids);
    }
    ids.add(info.id);
  }

  remove(id: string): void {
    const old = this.byId.get(id);
    if (!old) return;
    this.byId.delete(id);
    this.idsByName.get(old.name)?.delete(id);
  }

  clear(): void {
    this.byId.clear();
    this.idsByName.clear();
  }

  get(id: string): CombatantInfo | undefined {
    return this.byId.get(id);
  }

  /** Everything known now (saved with an archive, so a replay knows names, jobs and owners). */
  all(): CombatantInfo[] {
    return [...this.byId.values()];
  }

  /** Every live combatant with this name: a boss and its invisible helper actors share one. */
  idsNamed(name: string): ReadonlySet<string> {
    return this.idsByName.get(name) ?? EMPTY;
  }

  /**
   * Owner of a pet or summon: the line's own owner field first, then the AddCombatant record. Not a
   * side: enemies spawned for one player in the open world are "owned" by that player too.
   */
  ownerOf(id: string, lineOwnerId?: string): string | undefined {
    return lineOwnerId ?? this.byId.get(id)?.ownerId;
  }
}
