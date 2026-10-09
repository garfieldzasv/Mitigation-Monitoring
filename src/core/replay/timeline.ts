import { isPlayerId } from "../combatants/registry";
import type { Phase } from "../engine/phases";
import { type DamageRow, type DeathRow, type Row, damageTaken } from "../engine/types";
import { getRoleGroup, ROLE_GROUPS } from "../game/jobs";
import { isActionEnabler } from "../game/statuses";
import type { PartyMember } from "../party/partyState";
import type { StatusCategory } from "../status/statusTracker";
import type { Actor, HpPoint, PlayerCast, ReplayDetail, StatusChange } from "./detail";
import { meanReduction } from "./stats";

/**
 * The timeline tab's lanes (docs/DESIGN.md 8.6), in time and not in pixels: what the boss cast, how
 * hard each cast hit and how well it was mitigated, what every player put up against it, and how
 * each player's HP went. Only the statuses the rest of the review knows (statuses.json categories).
 */

/** A player's lanes show what they put up against damage: on players, and debuffs on enemies. */
const CASTER_CATEGORIES: readonly StatusCategory[] = ["invuln", "mitigation", "damageDown", "shield"];
/** One application: the same source's same status landing on several targets within this. */
export const SAME_APPLICATION_MS = 1000;
/** A status lands at most this long after the cast that applied it (雪仇's 26 line comes 0.6 s after its 21). */
const CAST_TO_STATUS_MS = 1500;
/** ...and the 21 line may come a hair after the 26 lines it caused. */
const STATUS_TO_CAST_MS = 100;
/** An aura's re-send or a walk-in this long after its cast's span ends still belongs to it (ticks drift). */
const JOIN_MS = 1000;
/** Same-name enemies starting the same cast within this make one cast bar ×N (as in the death replay). */
const SAME_CAST_MS = 1000;
/** Cast bars on one line keep at least this apart. */
const CAST_GAP_MS = 300;

export interface TimelinePlayer {
  id: string;
  name: string;
  job: number;
  /** In the player's own party (24-player duties show the others collapsed). */
  inParty: boolean;
}

/**
 * One status on one or more targets. In a player's lanes, one cast: from casting it, as long as the
 * action lasts (castSpans). Elsewhere (an enemy's own buff, a vulnerability), as long as it was on.
 */
export interface StatusSpan {
  key: string;
  status: { id: number; name: string };
  category: StatusCategory;
  /** The player behind it (a pet's owner); for an enemy's own status, the enemy. */
  caster: Actor;
  start: number;
  end: number;
  targets: Actor[];
  stacks: number;
  /** Its line within the status's lane: casts on different targets at the same time (two charges of 神祝祷) take two, they never overlap. */
  lane: number;
  /** The cast it began with (castSpans), if one: its action, and whether a pet cast it. */
  cast?: { action: { id: number; name: string }; byPet: boolean };
  /** An aura's cast whose time on its caster could not be told (castSpans): the span is the cast alone. */
  lengthUnknown?: true;
  /** Players the same cast was meant for who kept a stronger one of its kind (docs/DESIGN.md 5.4: it did not take). */
  refused?: Actor[];
}

/** A cast meant to apply a status that took on nobody (a weaker shield on a stronger one, 5.4): no span to tell it on. */
export interface UnappliedMark {
  key: string;
  time: number;
  status: { id: number; name: string };
  category: StatusCategory;
  target: Actor;
}

/** One status of one caster (or of the enemies): its applications in time order. */
export interface StatusLine {
  key: string;
  status: { id: number; name: string };
  category: StatusCategory;
  spans: StatusSpan[];
  unapplied: UnappliedMark[];
  /** Lines its spans take (StatusSpan.lane), at least 1. */
  lanes: number;
}

export interface CasterGroup {
  player: TimelinePlayer;
  lines: StatusLine[];
}

/** An enemy cast bar; same-name enemies casting the same thing together are one bar ×count. */
export interface CastBar {
  key: string;
  start: number;
  end: number;
  action: string;
  source: string;
  castMs: number;
  count: number;
  cancelled: boolean;
  /** The line it is drawn on, so bars never overlap. */
  line: number;
}

/** One cast that hit players: every hit row of a 21/22 sequence. */
export interface DamageEvent {
  key: string;
  time: number;
  action: string;
  source: string;
  rows: DamageRow[];
  total: number;
  /** meanReduction of the hits. */
  avgMitigation: number | null;
  deaths: number;
  /** The hardest hit: what a click opens. */
  biggest: DamageRow;
}

export interface MemberLane {
  player: TimelinePlayer;
  hp: readonly HpPoint[];
  /** Hits and DoT ticks. */
  hits: DamageRow[];
  deaths: DeathRow[];
  /** Vulnerabilities on the player, whoever applied them. */
  vulnerabilities: StatusSpan[];
}

export interface TimelineModel {
  from: number;
  to: number;
  phases: Phase[];
  casts: CastBar[];
  castLines: number;
  /** Enemies' own damage-ups. */
  bossBuffs: StatusLine[];
  /** Casts that hit, auto-attacks aside. */
  damage: DamageEvent[];
  /** Auto-attacks (the game data's and cactbot's, core/game/actions.ts): a lane of their own, they come every few seconds. */
  autoAttacks: DamageEvent[];
  casters: CasterGroup[];
  members: MemberLane[];
}

export interface TimelineInput {
  /** The encounter's start, and its end (the last stored line while it is still recorded). */
  start: number;
  end: number;
  /** Rows of the shown players. */
  rows: readonly Row[];
  detail: ReplayDetail;
  phases: Phase[];
  /** Shown players, in display order (timelinePlayers). */
  players: readonly TimelinePlayer[];
}

export function buildTimeline(input: TimelineInput): TimelineModel {
  const { rows, detail, players } = input;
  const from = Math.min(input.start, rows[0]?.time ?? input.start);
  const to = Math.max(input.end, from);
  /** Overlapping the view; a cast whose length is not known (a point), from its start. */
  const inRange = (s: { start: number; end: number; lengthUnknown?: true }) => (s.lengthUnknown ? s.start >= from : s.end > from) && s.start < to;

  const onPlayers = statusIntervals(detail.statusChanges, to);
  const onEnemies = statusIntervals(detail.enemyStatusChanges, to);
  const shown = new Set(players.map((p) => p.id));

  const applied = playerSpans(detail, shown, to).filter(inRange);
  const unapplied = detail.statusChanges.filter((c) => c.change === "unapplied" && c.time >= from && c.time < to);
  const casters = players.map((player) => ({
    player,
    lines: statusLines(
      applied.filter((s) => s.caster.id === player.id),
      unapplied.filter((c) => casterOf(c).id === player.id && CASTER_CATEGORIES.includes(c.category)),
    ),
  }));

  const bossBuffs = statusLines(groupSpans(onEnemies.filter((i) => i.category === "damageUp" && !shown.has(i.caster.id))).filter(inRange), []);

  const members = players.map((player) => ({
    player,
    hp: detail.hpOf(player.id),
    hits: rows.filter((r): r is DamageRow => r.kind !== "death" && r.target.id === player.id),
    deaths: rows.filter((r): r is DeathRow => r.kind === "death" && r.target.id === player.id),
    vulnerabilities: onPlayers.filter((i) => i.category === "vulnerability" && i.target.id === player.id).map((i) => spanOf([i])).filter(inRange),
  }));

  const casts = castBars(detail, from, to);
  const isAuto = (r: DamageRow) => r.autoAttack;
  return {
    from,
    to,
    phases: input.phases,
    casts,
    castLines: casts.reduce((n, c) => Math.max(n, c.line + 1), 0),
    bossBuffs,
    damage: damageEvents(rows, (r) => !isAuto(r)),
    autoAttacks: damageEvents(rows, isAuto),
    casters,
    members,
  };
}

/**
 * What the given players put up against damage (invulnerabilities, mitigations, debuffs on enemies, shields), one span
 * per cast (castSpans): the timeline's lanes, and when a mitigation skill is in effect (core/replay/partySkills.ts).
 */
export function playerSpans(detail: Pick<ReplayDetail, "statusChanges" | "enemyStatusChanges" | "playerCasts">, players: ReadonlySet<string>, to: number): StatusSpan[] {
  const allChanges = [...detail.statusChanges, ...detail.enemyStatusChanges].sort((a, b) => a.time - b.time);
  return castSpans(
    allChanges.filter((c) => CASTER_CATEGORIES.includes(c.category) && players.has(casterOf(c).id)),
    allChanges,
    detail.playerCasts,
    to,
  );
}

/**
 * Players to show: everyone in the rows plus the own party, tanks, healers, then DPS, in party order within each. A
 * party taken from an 11 line names its members by ID only: their name and job come from the 03 lines, which may come
 * after it, so a member missing them takes them from their rows.
 */
export function timelinePlayers(rows: readonly Row[], party: readonly PartyMember[]): TimelinePlayer[] {
  const byId = new Map<string, TimelinePlayer>();
  for (const m of party) if (m.inParty) byId.set(m.id, { id: m.id, name: m.name, job: m.job, inParty: true });
  for (const r of rows) {
    const known = byId.get(r.target.id);
    if (known) {
      known.name ||= r.target.name;
      known.job ||= r.target.job;
      continue;
    }
    const m = party.find((p) => p.id === r.target.id);
    byId.set(r.target.id, { id: r.target.id, name: r.target.name, job: r.target.job, inParty: m?.inParty ?? party.length === 0 });
  }
  const role = (job: number) => {
    const g = getRoleGroup(job);
    return g ? ROLE_GROUPS.indexOf(g) : ROLE_GROUPS.length;
  };
  const order = (id: string) => {
    const i = party.findIndex((p) => p.id === id);
    return i < 0 ? party.length : i;
  };
  return [...byId.values()].sort((a, b) => role(a.job) - role(b.job) || order(a.id) - order(b.id) || a.name.localeCompare(b.name));
}

/** A status on one target from one source, from gain to loss, refreshes included. */
interface Interval {
  target: Actor;
  status: { id: number; name: string };
  category: StatusCategory;
  caster: Actor;
  start: number;
  end: number;
  stacks: number;
}

/** The player behind a status change: a pet's owner, else the source itself. */
function casterOf(c: StatusChange): Actor {
  return c.source.ownerId ? { id: c.source.ownerId, name: "" } : { id: c.source.id, name: c.source.name };
}

/**
 * Pairs gains with losses per target, status and source. A refresh extends the interval; one never
 * lost ends when its duration runs out, or at `to`.
 */
export function statusIntervals(changes: readonly StatusChange[], to: number): Interval[] {
  const open = new Map<string, Interval & { until: number }>();
  const out: Interval[] = [];
  const close = (key: string, at: number) => {
    const i = open.get(key);
    if (!i) return;
    open.delete(key);
    out.push({ ...i, end: Math.max(i.start, Math.min(at, i.until)) });
  };
  for (const c of changes) {
    if (c.change === "unapplied") continue;
    const key = `${c.target.id}|${c.status.id}|${c.source.id}`;
    if (c.change === "stacks") {
      const i = open.get(key);
      if (i) i.stacks = Math.max(i.stacks, c.stacks);
      continue;
    }
    const on = open.get(key);
    if (c.change === "refresh" && on && on.until > c.time) {
      on.until = c.time + c.durationMs;
      continue;
    }
    close(key, c.time);
    if (c.change === "lose") continue;
    open.set(key, {
      target: c.target,
      status: c.status,
      category: c.category,
      caster: casterOf(c),
      start: c.time,
      end: c.time,
      until: c.time + c.durationMs,
      stacks: c.stacks,
    });
  }
  for (const key of [...open.keys()]) close(key, to);
  return out.sort((a, b) => a.start - b.start);
}

/** Intervals of one caster's status that started within SAME_APPLICATION_MS of each other: one span. */
function groupSpans(intervals: readonly Interval[]): StatusSpan[] {
  const current = new Map<string, Interval[]>();
  const spans: StatusSpan[] = [];
  for (const i of intervals) {
    const key = `${i.caster.id}|${i.status.id}`;
    const group = current.get(key);
    if (group && i.start - group[0]!.start <= SAME_APPLICATION_MS) group.push(i);
    else {
      if (group) spans.push(spanOf(group));
      current.set(key, [i]);
    }
  }
  for (const group of current.values()) spans.push(spanOf(group));
  return spans.sort((a, b) => a.start - b.start);
}

function spanOf(group: readonly Interval[]): StatusSpan {
  const first = group[0]!;
  return {
    key: `${first.caster.id}|${first.status.id}|${first.start}|${first.target.id}`,
    status: first.status,
    category: first.category,
    caster: first.caster,
    start: first.start,
    end: Math.max(...group.map((i) => i.end)),
    targets: distinctTargets(group.map((i) => i.target)),
    stacks: Math.max(...group.map((i) => i.stacks)),
    lane: 0,
  };
}

/**
 * A player's spans, one per cast (docs/DESIGN.md 8.6): from the moment the action was cast, for the cast's own time —
 * not from whenever each player got the status, and not cut short when a shield breaks or someone steps out.
 * - A gain belongs to the cast whose line applied that status shortly before (`applied`, 0x0E / 0x0F), and lasts as
 *   that cast put it on (摆脱's 30 s). A recast on a target the running span covers ends that span there.
 * - An aura or a ground effect (节制, 野战治疗阵): its line puts a status on its caster only (1872, 298); the effect
 *   players get (1873, 299) is put on with it and re-sent every 3 s to whoever is in range. That effect belongs to the
 *   cast that brought it: the cast's own 37 line lists it (`synced`) and its caster gained it between the cast's line
 *   and that 37 line — a status the caster already had, which a 37 line lists as well, was not brought by the cast.
 *   It lasts for the cast's time on its caster: the one status its line put on the caster that is not what some action needs to be used (isActionEnabler:
 *   节制 also gives 神爱抚预备, which 神爱抚 needs). With none or several such, that time is not known and not guessed:
 *   the span is the cast alone (`lengthUnknown`). Re-sends and players walking in join the running span.
 * - With no cast to go by (it began before the archive did), from the gain for its duration; until it was lost for a
 *   permanent status (one the game keeps on without a timer, docs/DESIGN.md 5.4).
 * `changes`: the ones to make spans of, in time order; `all`: every status change, for the durations.
 */
function castSpans(changes: readonly StatusChange[], all: readonly StatusChange[], casts: readonly PlayerCast[], to: number): StatusSpan[] {
  const byCaster = new Map<string, PlayerCast[]>();
  for (const c of casts) {
    const list = byCaster.get(c.caster.id);
    if (list) list.push(c);
    else byCaster.set(c.caster.id, [c]);
  }
  /** The caster's latest cast that `fits`, from CAST_TO_STATUS_MS before `t` to just after. */
  const castBefore = (casterId: string, t: number, fits: (c: PlayerCast) => boolean): PlayerCast | undefined => {
    const list = byCaster.get(casterId) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.time <= t + STATUS_TO_CAST_MS) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1; i >= 0 && list[i]!.time >= t - CAST_TO_STATUS_MS; i--) if (fits(list[i]!)) return list[i];
    return undefined;
  };
  const isGain = (c: StatusChange) => c.change === "gain" || c.change === "refresh";
  // When each status was lost, per target and source: how long one with no duration of its own was on.
  const losses = new Map<string, number[]>();
  for (const c of all) {
    if (c.change !== "lose") continue;
    const key = `${c.target.id}|${c.status.id}|${c.source.id}`;
    const list = losses.get(key);
    if (list) list.push(c.time);
    else losses.set(key, [c.time]);
  }
  /** Until when a gain is on by itself: its duration, or for a permanent status its 30 line (or `to`). */
  const until = (g: StatusChange): number =>
    Number.isFinite(g.durationMs) ? g.time + g.durationMs : (losses.get(`${g.target.id}|${g.status.id}|${g.source.id}`)?.find((t) => t >= g.time) ?? to);

  // How long each status a cast applied lasts, as the cast put it on; and the ones it put on its caster.
  const applied = new Map<PlayerCast, { byId: Map<number, number>; onCaster: Map<number, number> }>();
  for (const g of all) {
    if (!isGain(g) || !Number.isFinite(g.durationMs)) continue;
    const cast = castBefore(casterOf(g).id, g.time, (c) => c.applied.includes(g.status.id));
    if (!cast) continue;
    let a = applied.get(cast);
    if (!a) applied.set(cast, (a = { byId: new Map(), onCaster: new Map() }));
    a.byId.set(g.status.id, Math.max(a.byId.get(g.status.id) ?? 0, g.durationMs));
    if (g.target.id === cast.caster.id) a.onCaster.set(g.status.id, Math.max(a.onCaster.get(g.status.id) ?? 0, g.durationMs));
  }
  // When each player gained each status from each caster (a gain: it was not on before).
  const gains = new Map<string, number[]>();
  for (const c of all) {
    if (c.change !== "gain") continue;
    const key = `${c.target.id}|${c.status.id}|${casterOf(c).id}`;
    const list = gains.get(key);
    if (list) list.push(c.time);
    else gains.set(key, [c.time]);
  }
  /** The cast brought the status beyond its line: its own 37 lists it, and its caster gained it from itself in between. */
  const brought = (cast: PlayerCast, statusId: number): boolean => {
    const synced = cast.synced;
    if (!synced?.ids.includes(statusId)) return false;
    const id = cast.caster.id;
    return (gains.get(`${id}|${statusId}|${id}`) ?? []).some((t) => t >= cast.time - STATUS_TO_CAST_MS && t <= synced.time);
  };
  /** An aura's cast, its time on its caster: its one status there no action needs; undefined with none or several. */
  const casterTime = (cast: PlayerCast): number | undefined => {
    const own = [...(applied.get(cast)?.onCaster ?? [])].filter(([id]) => !isActionEnabler(id));
    return own.length === 1 ? own[0]![1] : undefined;
  };

  type Open = Omit<StatusSpan, "cast"> & { from: PlayerCast | undefined; known: boolean };
  const spans: Open[] = [];
  const running = new Map<string, Open[]>();
  const begin = (g: StatusChange, caster: Actor, start: number, end: number, cast: PlayerCast | undefined, list: Open[]): Open => {
    const span: Open = { key: `${caster.id}|${g.status.id}|${start}`, status: g.status, category: g.category, caster, start, end, targets: [], stacks: 0, lane: 0, from: cast, known: cast !== undefined };
    list.push(span);
    spans.push(span);
    return span;
  };
  const join = (span: Open, g: StatusChange) => {
    if (!span.targets.some((t) => sameTarget(t, g.target))) span.targets.push(g.target);
    span.stacks = Math.max(span.stacks, g.stacks);
  };
  for (const g of changes) {
    if (!isGain(g)) continue;
    const caster = casterOf(g);
    const key = `${caster.id}|${g.status.id}`;
    let list = running.get(key);
    if (!list) running.set(key, (list = []));

    const own = castBefore(caster.id, g.time, (c) => c.applied.includes(g.status.id));
    if (own) {
      const lasts = applied.get(own)?.byId.get(g.status.id);
      const span = list.find((s) => s.from === own) ?? begin(g, caster, own.time, lasts !== undefined ? own.time + lasts : until(g), own, list);
      // On this target the new cast replaces what an earlier one still had running.
      for (const s of list) if (s !== span && s.start < span.start && s.end > span.start && s.targets.some((t) => sameTarget(t, g.target))) s.end = span.start;
      join(span, g);
      continue;
    }
    const aura = castBefore(caster.id, g.time, (c) => brought(c, g.status.id));
    if (aura) {
      let span = list.find((s) => s.from === aura);
      if (!span) {
        const lasts = casterTime(aura);
        span = begin(g, caster, aura.time, aura.time + (lasts ?? 0), aura, list);
        if (lasts === undefined) span.lengthUnknown = true;
      }
      join(span, g);
      continue;
    }
    let current: Open | undefined;
    for (let i = list.length - 1; i >= 0 && !current; i--) {
      const s = list[i]!;
      if (s.start <= g.time && (g.time <= s.end + JOIN_MS || s.lengthUnknown)) current = s;
    }
    if (current) {
      join(current, g);
      if (!current.known) current.end = Math.max(current.end, until(g));
      continue;
    }
    join(begin(g, caster, g.time, until(g), undefined, list), g);
  }
  return spans
    .map((s) => ({
      key: s.key,
      status: s.status,
      category: s.category,
      caster: s.caster,
      start: s.start,
      end: Math.min(s.end, to),
      targets: s.targets,
      stacks: s.stacks,
      lane: 0,
      ...(s.from ? { cast: { action: s.from.action, byPet: s.from.byPet === true } } : {}),
      ...(s.lengthUnknown ? { lengthUnknown: true as const } : {}),
    }))
    .sort((a, b) => a.start - b.start);
}

/** The same target: players by ID, enemies by name (a boss and its same-name helpers). */
function sameTarget(a: Actor, b: Actor): boolean {
  return isPlayerId(a.id) || isPlayerId(b.id) ? a.id === b.id : a.name === b.name;
}

/**
 * Targets once each: players by ID, enemies by name. A boss with a dozen invisible same-name helpers
 * takes one 昏乱 on all of them; that is one 昏乱 on the boss.
 */
function distinctTargets(targets: readonly Actor[]): Actor[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = isPlayerId(t.id) ? t.id : `name:${t.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const LINE_ORDER: readonly StatusCategory[] = ["invuln", "mitigation", "damageDown", "shield", "damageUp", "vulnerability", "other"];

/**
 * One line per status: invulnerabilities, mitigations, debuffs on enemies, shields; first used first
 * within each. Spans that overlap in time go to lines of their own (StatusSpan.lane). A cast that did not take on
 * someone is told on the span of the same cast (`refused`), the targets it took on; one that took on nobody has no
 * span and is a mark of its own.
 */
function statusLines(spans: readonly StatusSpan[], unapplied: readonly StatusChange[]): StatusLine[] {
  const lines = new Map<number, StatusLine & { laneEnds: number[] }>();
  const lineOf = (status: { id: number; name: string }, category: StatusCategory) => {
    let line = lines.get(status.id);
    if (!line) {
      line = { key: String(status.id), status, category, spans: [], unapplied: [], lanes: 1, laneEnds: [] };
      lines.set(status.id, line);
    }
    return line;
  };
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const line = lineOf(s.status, s.category);
    let lane = line.laneEnds.findIndex((end) => end <= s.start);
    if (lane < 0) lane = line.laneEnds.length;
    line.laneEnds[lane] = s.end;
    line.lanes = Math.max(line.lanes, lane + 1);
    line.spans.push({ ...s, lane });
  }
  for (const c of unapplied) {
    const line = lineOf(c.status, c.category);
    // The same cast: its lines come together (one AOE), its span starts at it.
    const span = line.spans.find((s) => Math.abs(s.start - c.time) <= SAME_APPLICATION_MS);
    if (span) {
      if (!span.refused?.some((t) => t.id === c.target.id)) span.refused = [...(span.refused ?? []), c.target];
      continue;
    }
    line.unapplied.push({ key: `${c.time}|${c.target.id}|${c.status.id}`, time: c.time, status: c.status, category: c.category, target: c.target });
  }
  const firstUse = (l: StatusLine) => Math.min(l.spans[0]?.start ?? Infinity, l.unapplied[0]?.time ?? Infinity);
  return [...lines.values()]
    .map(({ key, status, category, spans: lineSpans, unapplied: marks, lanes }) => ({ key, status, category, spans: lineSpans, unapplied: marks, lanes }))
    .sort((a, b) => LINE_ORDER.indexOf(a.category) - LINE_ORDER.indexOf(b.category) || firstUse(a) - firstUse(b));
}

/**
 * A cast with no bar in the game: an action without a name, which the log writes as unknown_XXXX —
 * internal timers and helpers, often tens of seconds long and cancelled. cactbot's timelines hide
 * them as well (make_timeline turns them into "--sync--").
 */
function isHiddenCast(name: string): boolean {
  return name === "" || name.toLowerCase().startsWith("unknown_");
}

/** Enemy cast bars between from and to, hidden ones left out, same-name casts merged, each on the first line it fits. */
function castBars(detail: ReplayDetail, from: number, to: number): CastBar[] {
  const bars: CastBar[] = [];
  for (const c of detail.enemyCasts()) {
    if (c.time + c.castMs < from || c.time >= to || isHiddenCast(c.action.name)) continue;
    let same: CastBar | undefined;
    for (let i = bars.length - 1; i >= 0 && c.time - bars[i]!.start <= SAME_CAST_MS && !same; i--) {
      if (bars[i]!.action === c.action.name && bars[i]!.source === c.source.name) same = bars[i];
    }
    if (same) {
      same.count++;
      continue;
    }
    bars.push({
      key: `${c.time}|${c.source.id}|${c.action.id}`,
      start: c.time,
      end: c.time + c.castMs,
      action: c.action.name,
      source: c.source.name,
      castMs: c.castMs,
      count: 1,
      cancelled: c.cancelled !== undefined,
      line: 0,
    });
  }
  const lineEnds: number[] = [];
  for (const b of bars.sort((x, y) => x.start - y.start)) {
    let line = lineEnds.findIndex((end) => end + CAST_GAP_MS <= b.start);
    if (line < 0) line = lineEnds.length;
    lineEnds[line] = b.end;
    b.line = line;
  }
  return bars;
}

/** Casts that hit the shown players, by sequence, those `wanted` (DoT ticks have no sequence). */
function damageEvents(rows: readonly Row[], wanted: (r: DamageRow) => boolean): DamageEvent[] {
  const bySeq = new Map<string, DamageRow[]>();
  for (const r of rows) {
    if (r.kind !== "hit" || !r.seq || !wanted(r)) continue;
    const group = bySeq.get(r.seq);
    if (group) group.push(r);
    else bySeq.set(r.seq, [r]);
  }
  return [...bySeq]
    .map(([seq, hits]) => {
      const first = hits[0]!;
      return {
        key: seq,
        time: first.time,
        action: first.action.name,
        source: first.source.name,
        rows: hits,
        total: hits.reduce((s, r) => s + damageTaken(r), 0),
        avgMitigation: meanReduction(hits.filter((r) => !r.noEffect)),
        deaths: hits.filter((r) => r.fatal).length,
        biggest: hits.reduce((a, b) => (damageTaken(b) > damageTaken(a) ? b : a)),
      };
    })
    .sort((a, b) => a.time - b.time);
}
