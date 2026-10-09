import type { DamageType, HitResult } from "../logline/effect";
import type { MitigationTerm } from "../mitigation/multiplier";
import type { ScopeSnapshot } from "../party/partyState";
import type { StatusSnap } from "../status/statusTracker";

export interface RowActor {
  id: string;
  name: string;
}

export interface RowTarget extends RowActor {
  job: number;
}

/**
 * Hits on one player the shield reports cannot tell apart (docs/DESIGN.md 5.6): no report between them shows the
 * earlier ones taken effect, so only what the shields took off them together is known.
 */
export interface ShieldGroup {
  id: number;
  /** In the order of their lines. */
  rows: DamageRow[];
  /** Members still waiting to take effect (their 37 line, or the decision without one). */
  waiting: number;
  /** The shields on as the first hit came, together; unset when no report says. */
  before?: number;
  /** The shields on after the last one took effect, together (the report that settled the group). */
  after?: number;
  /** What the shields took off the hits together; with `bound`, only a lower or upper bound. Unset while open, or when the log does not say. */
  absorbed?: number;
  bound?: "atLeast" | "atMost";
  /** A report after every member took effect has settled it. */
  closed: boolean;
}

/** One hit (or DoT tick) on one player. An AOE that hits 8 players makes 8 rows. */
export interface DamageRow {
  kind: "hit" | "dot";
  /** Increasing within an encounter. */
  id: number;
  time: number;
  /** Milliseconds since the encounter started; negative for hits just before it. */
  offset: number;
  /** 21/22 sequence, shared by every target of one action. */
  seq?: string;
  targetCount?: number;
  target: RowTarget;
  source: RowActor;
  /**
   * For DoT rows `id` is the status ID when the game names one, else 0. `name` is the display
   * name: unnamed auto-attacks (`unknown_ae46` in the log) become 攻击.
   */
  action: { id: number; name: string };
  /** An auto-attack by the game data's ActionCategory, named or not. */
  autoAttack: boolean;
  /** Damage that reached HP (shield absorption already taken out). */
  amount: number;
  /**
   * What shields took off this hit (docs/DESIGN.md 5.6): set when it is alone in its shield group and the reports
   * say exactly. Otherwise see `shieldGroup`.
   */
  shieldAbsorbed?: number;
  /** All the shields on the player when the hit came, together, when the reports say (alone in its group). */
  shieldBefore?: number;
  /** It met a shield: the hits the reports cannot tell apart from it, and what the shields took off them together. */
  shieldGroup?: ShieldGroup;
  /** No damage got through and a shield was up. */
  fullyAbsorbed: boolean;
  /**
   * The hit did not take effect: it never got its own 37 line, and the HP updates show its damage never came off
   * (docs/DESIGN.md 5.6). Its logged damage never reached the player.
   */
  noEffect?: true;
  /** When it took effect: its own 37 line, the tick of a DoT, or when it was decided without a 37 line. */
  settledAt?: number;
  /**
   * Where its own 37 line came among all lines (a count): of hits locked in at one moment, which took effect first
   * (inEffectOrder). Unset without a 37 line.
   */
  effectOrder?: number;
  damageType: DamageType;
  attackType?: number;
  element?: number;
  /**
   * The damage effect's low severity bits, when set. Not defined by the LogGuide; used by nothing (0x06 goes with a
   * hit reaching 鼓舞 / 激励 / 魔罩 in the samples).
   */
  shieldBits?: number;
  result: HitResult;
  crit: boolean;
  direct: boolean;
  invulnerable: boolean;
  /**
   * The player's HP before it: the last HP update (37 / 38 / 39, the only lines whose HP is an update: LogGuide) with the
   * DoT / HoT ticks (24) since, before its own 37 line, or before its line when it has none (a DoT tick: before the
   * tick). Its own line's figure (read from memory, may be stale) only when no update has come (docs/DESIGN.md 5.6).
   */
  hpBefore: number;
  /** From its own 37 line (its result); unset without one. */
  hpAfter?: number;
  maxHp: number;
  /** Theoretical multiplier from known effects (docs/DESIGN.md 5.5); null for DoT ticks. */
  multiplier: number | null;
  /** Some effect with an unknown value was present. */
  multiplierPartial: boolean;
  /** The factors behind `multiplier`, for the breakdown on hover. */
  mitigation: MitigationTerm[];
  targetStatuses: StatusSnap[];
  sourceStatuses: StatusSnap[];
  fatal?: boolean;
}

/** Damage that reached the player's HP: none for a hit that did not take effect. */
export function damageTaken(r: DamageRow): number {
  return r.noEffect ? 0 : r.amount;
}

export interface DeathRow {
  kind: "death";
  id: number;
  time: number;
  offset: number;
  target: RowTarget;
  /** The killing blow, when one was found within the attribution window. */
  killerRowId?: number;
  /** Killer as named by the 25 line ("" when it names none). */
  sourceName: string;
  /**
   * No killing blow, and something else says what killed (docs/DESIGN.md 5.7): "terrain" (地形杀: the 25 line names no
   * killer, or cactbot annotates a knock-off or the wall for the zone), "instant" (an instant-death effect), "other"
   * (a mechanic cactbot annotates, `causeText`).
   */
  cause?: "terrain" | "instant" | "other";
  /** For "instant": the action whose effect was instant death. */
  causeAction?: string;
  /** For "other": cactbot's text for it (没解死宣). */
  causeText?: string;
  /** Damage beyond the HP left, for the killing blow. */
  overkill?: number;
}

export type Row = DamageRow | DeathRow;

export type EncounterResult = "wipe" | "clear" | "unknown";

/** The encounter's main boss: the enemy with the most max HP among those the players hit. */
export interface EncounterBoss {
  id: string;
  name: string;
  maxHp: number;
  /** HP as last seen (a wipe's "boss left at 12%"). */
  hpPercent: number;
}

/**
 * A stretch during which none of the enemies the players had targeted could be targeted (34 lines, deaths; docs/DESIGN.md
 * 5.9). Phases are derived from these (core/engine/phases.ts).
 */
export interface UntargetableWindow {
  start: number;
  /** Unset while still open (only while the encounter runs: see PhaseTracker.end). */
  end?: number;
  /** Boss HP % as the window started and ended. */
  hpBefore: number;
  hpAfter?: number;
}

export interface Encounter {
  id: number;
  zoneId: number;
  zoneName: string;
  start: number;
  /** Unset while the encounter is running. */
  end?: number;
  result: EncounterResult;
  /** Append-only. */
  rows: Row[];
  deaths: number;
  /** Who is shown, frozen when the encounter ends; while it runs, the engine's live scope applies. */
  scope?: ScopeSnapshot;
  boss?: EncounterBoss;
  /** In time order; while the encounter runs, the last may still be open. */
  untargetable: UntargetableWindow[];
}

/** Where a row took effect among rows locked in together: its own 37 line's place; none (or a death) after them. */
export function effectRank(r: Row): number {
  return r.kind === "death" ? Number.POSITIVE_INFINITY : (r.effectOrder ?? Number.POSITIVE_INFINITY);
}

/**
 * Rows in the order things happened (docs/DESIGN.md 5.6): hits on one player locked in at the same moment (several
 * needles of one cast, in one packet) took effect in the order of their own 37 lines — LogGuide: a 21/22 line is the
 * action locked in, its 37 line the action actually happening — not of their 21/22 lines. Only those trade places
 * among themselves; every other row keeps its place (an AOE's rows stay together). `rows`: in time order.
 */
export function inEffectOrder<R extends Row>(rows: readonly R[]): R[] {
  const out = [...rows];
  for (let i = 0; i < out.length; ) {
    let j = i + 1;
    while (j < out.length && out[j]!.time === out[i]!.time) j++;
    if (j - i > 1) {
      const places = new Map<string, number[]>();
      for (let k = i; k < j; k++) {
        const r = out[k]!;
        if (r.kind === "death") continue;
        const list = places.get(r.target.id);
        if (list) list.push(k);
        else places.set(r.target.id, [k]);
      }
      for (const at of places.values()) {
        if (at.length < 2) continue;
        const sorted = at.map((k) => out[k]!).sort((a, b) => effectRank(a) - effectRank(b) || a.id - b.id);
        at.forEach((k, n) => (out[k] = sorted[n]!));
      }
    }
    i = j;
  }
  return out;
}
