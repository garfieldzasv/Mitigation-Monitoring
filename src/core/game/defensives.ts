import generated from "@/data/generated/defensives.json";
import { evalLevelValue, MAX_LEVEL, type LevelValue } from "./levelValue";

/**
 * Every job's mitigation skills (docs/DESIGN.md 8.2), as scripts/game-data/defensives.ts reads them from the game data:
 * the actions whose tooltips say they reduce damage, put on a shield, make the bearer invulnerable or weaken an enemy,
 * with their recast, charges, level and upgrades.
 */
interface Entry {
  name: string;
  icon: number;
  jobs: number[];
  level: number;
  recastGroup: number;
  recast: LevelValue;
  charges: LevelValue;
  upgradesTo?: number;
  statuses: number[];
  followUps?: number[];
  refunds?: { action: number; seconds: number; liftedBy?: number[] }[];
}

const ACTIONS = (generated as unknown as { actions: Record<string, Entry> }).actions;
const SHARED = (generated as unknown as { sharedTimers: Record<string, { jobs: number[]; recastGroup: number }> }).sharedTimers;

/** One mitigation skill as a player of one job at one level has it. */
export interface DefensiveSkill {
  /** The tier the player has: 预警 below 92, 极致防御 from 92. */
  id: number;
  name: string;
  icon: number;
  /** The recast timer it spends: every tier of it, and the actions sharing its group (原初的血气 and 原初的勇猛). */
  timer: string;
  recastMs: number;
  maxCharges: number;
  /** Actions whose casts are this skill's: its tiers and follow-ups (即兴表演结束). */
  actions: readonly number[];
  /** Statuses its tooltip names: whose they are when a pet casts them (异想的幻光 is the fairy's). */
  statuses: readonly number[];
  /**
   * Its recast cut by `ms` when the shield `action` put on its caster breaks, unless one of `liftedBy` lifted it at that
   * moment (坦培拉涂层: 60 s, its 油性坦培拉涂层: 30 s; scripts/game-data/defensives.ts).
   */
  refunds: readonly { action: number; ms: number; liftedBy: readonly number[] }[];
}

/** The recast timer an action spends, if it is (or shares a timer with) a mitigation skill. */
export function defensiveTimerOf(actionId: number): string | undefined {
  const group = ACTIONS[actionId]?.recastGroup ?? SHARED[actionId]?.recastGroup;
  return group ? `g${group}` : undefined;
}

/** Lower tier → the tiers of its chain, every one. */
let families: Map<number, number[]> | undefined;
function family(id: number): number[] {
  if (!families) {
    families = new Map();
    const top = (a: number): number => {
      const seen = new Set<number>();
      while (ACTIONS[a]?.upgradesTo !== undefined && !seen.has(a)) {
        seen.add(a);
        a = ACTIONS[a]!.upgradesTo!;
      }
      return a;
    };
    const byTop = new Map<number, number[]>();
    for (const key of Object.keys(ACTIONS)) {
      const t = top(Number(key));
      byTop.set(t, [...(byTop.get(t) ?? []), Number(key)]);
    }
    for (const tiers of byTop.values()) for (const t of tiers) families.set(t, tiers);
  }
  return families.get(id) ?? [id];
}

const cache = new Map<string, DefensiveSkill[]>();

/**
 * The mitigation skills a player of `job` at `level` has, one per chain (its learnt tier), in the order they are learnt.
 * A level of 0 (unknown) counts as the highest.
 */
export function defensiveSkills(job: number, level: number): DefensiveSkill[] {
  const lv = level > 0 ? level : MAX_LEVEL;
  const key = `${job}:${lv}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const skills: (DefensiveSkill & { first: number })[] = [];
  const done = new Set<number>();
  for (const key of Object.keys(ACTIONS)) {
    const id = Number(key);
    if (done.has(id)) continue;
    const tiers = family(id).filter((t) => ACTIONS[t]!.jobs.includes(job));
    for (const t of family(id)) done.add(t);
    const learnt = tiers.filter((t) => ACTIONS[t]!.level <= lv).sort((a, b) => ACTIONS[b]!.level - ACTIONS[a]!.level)[0];
    if (learnt === undefined) continue;
    const a = ACTIONS[learnt]!;
    skills.push({
      id: learnt,
      name: a.name,
      icon: a.icon,
      timer: `g${a.recastGroup}`,
      recastMs: evalLevelValue(a.recast, lv) * 1000,
      maxCharges: Math.max(1, evalLevelValue(a.charges, lv)),
      actions: [...new Set(tiers.flatMap((t) => [t, ...(ACTIONS[t]!.followUps ?? [])]))],
      statuses: [...new Set(tiers.flatMap((t) => ACTIONS[t]!.statuses))],
      refunds: tiers.flatMap((t) => (ACTIONS[t]!.refunds ?? []).map((r) => ({ action: r.action, ms: r.seconds * 1000, liftedBy: r.liftedBy ?? [] }))),
      first: Math.min(...tiers.map((t) => ACTIONS[t]!.level)),
    });
  }
  const out = skills.sort((x, y) => x.first - y.first || x.id - y.id).map(({ first: _first, ...s }) => s);
  cache.set(key, out);
  return out;
}

/** Every icon a mitigation skill can show, for scripts/copy-icons.ts. */
export function allDefensiveIconIds(): number[] {
  return [...new Set(Object.values(ACTIONS).map((a) => a.icon))].filter((i) => i > 0);
}
