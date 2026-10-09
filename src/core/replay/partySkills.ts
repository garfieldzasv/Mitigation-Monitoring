import { defensiveSkills, defensiveTimerOf, type DefensiveSkill } from "../game/defensives";
import type { ShieldUsedUp } from "../engine/engine";
import type { PlayerCast, ReplayDetail, SkillUse } from "./detail";
import type { StatusSpan } from "./timeline";

/**
 * The party's mitigation skills over a fight (docs/DESIGN.md 8.2): at any moment, which of each member's skills are in
 * effect, on cooldown, or ready and unused. The skills, their recast and charges are the game data's at the member's
 * level (core/game/defensives.ts); when they were used is the member's 21/22 lines; in effect is what the timeline
 * draws: from the cast, as long as the action lasts (core/replay/timeline.ts castSpans). A recast is cut short when the
 * tooltip says so for a shield breaking (坦培拉涂层): the shield the member's own cast of that action put on him, gone
 * early with hits about as the shield account decides (ReplayDetail.shieldsUsedUp), and not lifted at that moment by
 * the member's cast of the action that lifts it (油性坦培拉涂层 putting its own on).
 */

/** A pet's cast follows its owner's command by up to this (the fairy's 异想的幻光 1 s after the scholar's). */
const USE_TO_EFFECT_MS = 1500;
/** ...and the owner's line may come a hair after it. */
const EFFECT_TO_USE_MS = 100;

export interface PartySkillsPlayer {
  id: string;
  name: string;
  job: number;
  /** The member's level (duties sync everyone alike); 0 when unknown: the skills of the highest. */
  level: number;
  inParty: boolean;
}

interface Track {
  skill: DefensiveSkill;
  /** Uses of its recast timer, in time order (a shared timer's other action too). */
  uses: number[];
  /** Its recast cut short (a shield of it broke), in time order. */
  refunds: { time: number; ms: number }[];
  /** When its effects ran (spans of its casts). */
  effects: { start: number; end: number }[];
}

export interface MemberSkills {
  player: PartySkillsPlayer;
  tracks: Track[];
}

export interface PartySkills {
  members: MemberSkills[];
  /** Wipes and zone changes: every recast is ready again. */
  resets: number[];
}

export function buildPartySkills(input: {
  players: readonly PartySkillsPlayer[];
  detail: Pick<ReplayDetail, "skillUses" | "timerResets" | "shieldsUsedUp" | "playerCasts">;
  /** Spans of the players' casts (timeline.ts playerSpans). */
  spans: readonly StatusSpan[];
}): PartySkills {
  const usesBy = new Map<string, SkillUse[]>();
  for (const u of input.detail.skillUses) {
    const list = usesBy.get(u.caster.id);
    if (list) list.push(u);
    else usesBy.set(u.caster.id, [u]);
  }
  const members = input.players.map((player) => {
    const uses = (usesBy.get(player.id) ?? []).slice().sort((a, b) => a.time - b.time);
    const casts = input.detail.playerCasts.filter((c) => c.caster.id === player.id && !c.byPet);
    const tracks: Track[] = defensiveSkills(player.job, player.level).map((skill) => ({
      skill,
      uses: uses.filter((u) => defensiveTimerOf(u.action.id) === skill.timer).map((u) => u.time),
      refunds: refundsOf(skill, player.id, casts, input.detail.shieldsUsedUp),
      effects: [],
    }));
    const byAction = (id: number) => tracks.find((t) => t.skill.actions.includes(id));
    for (const span of input.spans) {
      if (span.caster.id !== player.id) continue;
      let track: Track | undefined;
      if (span.cast && !span.cast.byPet) track = byAction(span.cast.action.id);
      else {
        // A pet's cast, or none (an aura's re-send, a status from before the archive): the skill the member had just
        // used, the one whose tooltip names this status first.
        const near = uses.filter((u) => u.time >= span.start - USE_TO_EFFECT_MS && u.time <= span.start + EFFECT_TO_USE_MS);
        const named = near.filter((u) => byAction(u.action.id)?.skill.statuses.includes(span.status.id));
        const use = (named.length ? named : near).at(-1);
        track = use && byAction(use.action.id);
      }
      track?.effects.push({ start: span.start, end: span.end });
    }
    return { player, tracks };
  });
  return { members, resets: [...input.detail.timerResets].sort((a, b) => a - b) };
}

/** When `skill`'s recast was cut short: a shield of a refunding action, put on the member by his own cast, used up. */
function refundsOf(skill: DefensiveSkill, playerId: string, casts: readonly PlayerCast[], usedUp: readonly ShieldUsedUp[]): Track["refunds"] {
  if (skill.refunds.length === 0) return [];
  const out: Track["refunds"] = [];
  for (const lost of usedUp) {
    if (lost.targetId !== playerId || lost.sourceId !== playerId) continue;
    // Whose shield: the member's last cast that put this status on.
    const put = casts.filter((c) => c.time <= lost.time && c.applied.includes(lost.statusId)).at(-1);
    const refund = skill.refunds.find((r) => r.action === put?.action.id);
    if (!refund) continue;
    // Lifted, not broken: the lifting action put its own on in that moment (one packet, one timestamp).
    if (casts.some((c) => c.time === lost.time && refund.liftedBy.includes(c.action.id))) continue;
    out.push({ time: lost.time, ms: refund.ms });
  }
  return out.sort((a, b) => a.time - b.time);
}

export interface SkillState {
  skill: DefensiveSkill;
  /** In effect, else on cooldown (no charge left), else ready. */
  state: "active" | "cooldown" | "ready";
  charges: number;
  /** In effect until. */
  activeUntil?: number;
  /** The charge coming back: since when, and when. */
  recharge?: { from: number; at: number };
}

export interface MemberSkillStates {
  player: PartySkillsPlayer;
  skills: SkillState[];
}

/** Every member's skills at `time`. */
export function partySkillsAt(model: PartySkills, time: number): MemberSkillStates[] {
  let since = -Infinity;
  for (const r of model.resets) if (r <= time) since = r;
  return model.members.map(({ player, tracks }) => ({ player, skills: tracks.map((t) => stateAt(t, time, since)) }));
}

/**
 * One skill at `time`, its timer counted from `since` (the last reset): a use spends a charge, a charge comes back a
 * recast after the previous one started to; a use when none was left (one from before the archive) restarts it; a
 * refund brings the coming charge closer by its amount (none coming, it does nothing).
 */
function stateAt(track: Track, time: number, since: number): SkillState {
  const { recastMs, maxCharges } = track.skill;
  let charges = maxCharges;
  let from: number | undefined;
  const recover = (now: number) => {
    if (from === undefined || recastMs <= 0) return;
    const n = Math.floor((now - from) / recastMs);
    if (n <= 0) return;
    charges = Math.min(maxCharges, charges + n);
    from = charges >= maxCharges ? undefined : from + n * recastMs;
  };
  let next = 0;
  const refundUntil = (now: number) => {
    for (; next < track.refunds.length && track.refunds[next]!.time <= now; next++) {
      const r = track.refunds[next]!;
      if (r.time <= since) continue;
      recover(r.time);
      if (from !== undefined) from -= r.ms;
    }
  };
  for (const use of track.uses) {
    if (use <= since) continue;
    if (use > time) break;
    refundUntil(use);
    recover(use);
    if (charges > 0) {
      charges--;
      from ??= use;
    } else from = use;
  }
  refundUntil(time);
  recover(time);
  let activeUntil: number | undefined;
  for (const e of track.effects) if (e.start > since && e.start <= time && time < e.end) activeUntil = Math.max(activeUntil ?? 0, e.end);
  return {
    skill: track.skill,
    state: activeUntil !== undefined ? "active" : charges === 0 ? "cooldown" : "ready",
    charges,
    ...(activeUntil !== undefined ? { activeUntil } : {}),
    ...(from !== undefined ? { recharge: { from, at: from + recastMs } } : {}),
  };
}
