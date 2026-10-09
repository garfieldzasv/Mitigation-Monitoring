import { findAppliedStatusParams } from "../logline/effect";
import { AbilityField, CombatantField, EffectField, LineType, ActorControlField, TimestampField, WIPE_COMMANDS } from "../logline/fields";

/** Raw lines kept from before a pull starts (pre-pull mitigation, shields, countdown). */
export const PREPULL_MS = 30000;

/** The recent window is compacted (and ended statuses dropped) once this many lines have left it. */
const COMPACT_AFTER = 4096;

/**
 * Remembers what an encounter archive needs from before the pull: the zone, the player, the party,
 * live combatants, statuses still running (with the 21/22 line that put each on: its modifier bytes), and the last
 * PREPULL_MS of raw lines. Replaying
 * `snapshot()` and then the encounter's own lines rebuilds the engine state at the pull. Used by
 * the archive writer and the fixture script (docs/DESIGN.md 6.2). Bounded without zone changes
 * too: hours in the open world add and remove combatants and statuses all the time.
 */
export class PrepullState {
  private zoneLine: readonly string[] | undefined;
  private playerLine: readonly string[] | undefined;
  private partyLine: readonly string[] | undefined;
  private readonly combatants = new Map<string, readonly string[]>();
  /** Statuses on until their 30 line (as the engine keeps them, statusTracker.ts). */
  private readonly statuses = new Map<string, readonly string[]>();
  /** The last 21/22 line that put a status on an entity, by `entity:statusId`. */
  private readonly putOns = new Map<string, readonly string[]>();
  private recent: { time: number; line: readonly string[] }[] = [];
  /** Index of the first entry still inside the window; the array is compacted now and then. */
  private head = 0;

  /** Every relevant raw line, in order. */
  push(line: readonly string[]): void {
    const time = Date.parse(line[TimestampField] ?? "") || 0;
    switch (line[0]) {
      case LineType.ChangeZone:
        this.zoneLine = line;
        this.combatants.clear();
        this.statuses.clear();
        this.putOns.clear();
        this.recent = [];
        this.head = 0;
        break;
      case LineType.ChangePrimaryPlayer:
        this.playerLine = line;
        break;
      case LineType.PartyList:
        this.partyLine = line;
        break;
      case LineType.AddCombatant:
        this.combatants.set(line[CombatantField.id] ?? "", line);
        break;
      case LineType.RemoveCombatant: {
        const id = line[CombatantField.id] ?? "";
        this.combatants.delete(id);
        for (const key of this.statuses.keys()) if (key.startsWith(`${id}:`)) this.statuses.delete(key);
        for (const key of this.putOns.keys()) if (key.startsWith(`${id}:`)) this.putOns.delete(key);
        break;
      }
      case LineType.Ability:
      case LineType.AOEAbility:
        for (const p of findAppliedStatusParams(line)) {
          const entity = p.onSource ? line[AbilityField.sourceId] : line[AbilityField.targetId];
          this.putOns.set(`${entity}:${p.id}`, line);
        }
        break;
      case LineType.GainsEffect:
        this.statuses.set(statusKey(line), line);
        break;
      case LineType.ActorControl:
        // A wipe clears every status, in the engine too.
        if (WIPE_COMMANDS.has(line[ActorControlField.command] ?? "")) {
          this.statuses.clear();
          this.putOns.clear();
        }
        break;
      case LineType.LosesEffect:
        this.statuses.delete(statusKey(line));
        break;
      default:
        break;
    }
    this.recent.push({ time, line });
    const cutoff = time - PREPULL_MS;
    while (this.head < this.recent.length && this.recent[this.head]!.time < cutoff) this.head++;
    if (this.head > COMPACT_AFTER && this.head * 2 > this.recent.length) {
      this.recent = this.recent.slice(this.head);
      this.head = 0;
      const on = new Set([...this.statuses.values()].map((s) => `${s[EffectField.targetId]}:${Number.parseInt(s[EffectField.effectId] ?? "", 16)}`));
      for (const key of this.putOns.keys()) if (!on.has(key)) this.putOns.delete(key);
    }
  }

  /**
   * Lines that reproduce the state at `now`: zone, player, combatants, party and still-running
   * statuses not in the recent window, then the recent window itself. A line inside the window is
   * not repeated in the header (by identity: log timestamps are not always in order).
   */
  snapshot(now: number): (readonly string[])[] {
    const recent = this.recent.slice(this.head);
    const inWindow = new Set(recent.map((r) => r.line));
    const beforeWindow = (line: readonly string[] | undefined): line is readonly string[] => line !== undefined && !inWindow.has(line);
    const out: (readonly string[])[] = [];
    if (beforeWindow(this.zoneLine)) out.push(this.zoneLine);
    if (beforeWindow(this.playerLine)) out.push(this.playerLine);
    for (const line of this.combatants.values()) if (beforeWindow(line)) out.push(line);
    if (beforeWindow(this.partyLine)) out.push(this.partyLine);
    for (const line of this.statuses.values()) {
      if (!beforeWindow(line)) continue;
      const putOn = this.putOns.get(`${line[EffectField.targetId]}:${Number.parseInt(line[EffectField.effectId] ?? "", 16)}`);
      if (beforeWindow(putOn)) out.push(putOn);
      out.push(line);
    }
    for (const r of recent) out.push(r.line);
    return out;
  }
}

function statusKey(line: readonly string[]): string {
  return `${line[EffectField.targetId]}:${line[EffectField.effectId]}:${line[EffectField.sourceId]}`;
}
