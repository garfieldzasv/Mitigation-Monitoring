import { barrierShares } from "../game/barriers";
import type { GameEvent } from "../logline/parse";
import { RESULT_TIMEOUT_MS } from "./damageRecorder";
import type { DamageRow, ShieldGroup } from "./types";

/**
 * What shields took off hits on players (docs/DESIGN.md 5.6), from what the log says and nothing else.
 *
 * A hit is two events (as FFLogs splits damage into calculateddamage and damage): its 21/22 line, where its damage and
 * the shields it meets are fixed (the snapshot), and its own 37 line, where it takes effect (LogGuide, quoting Ravahn).
 * A DoT tick (24) is both at once. The log never says what a hit took from the shields; it reports a player's total
 * shield (37 and 38 lines, whole % of max HP) — and a report between a hit's line and its 37 line may or may not show
 * that hit yet. So hits on one player are told apart only by a report that comes after every earlier hit took effect;
 * hits no such report separates are one group, and only the group's total is known:
 *
 *   absorbed = shield before − shield after + shields put on in between
 *
 * the report before the group's first hit, and the first report after its last hit took effect. A shield put on in
 * between counts with its size when its put-on line's lowest byte (LogGuide) confirms what the action's tooltip says
 * (game data); else the total is only a lower bound. A shield gone in between that the hits did not use up (it ran
 * out, or went before the first hit) left an unknown amount: the total is only an upper bound. A group whose last hit
 * got damage through took everything that was on until then (the game: damage gets through only an empty shield).
 *
 * The ACT plugin writes one message's lines together: a 37 line then the statuses its effect result lists (26, a 30
 * first when a status slot changes hands), a 38 line then the statuses that changed. Lines of one server packet share a
 * timestamp (Machina). So the 26 / 30 lines right after a report, for the same player at the same time, are that
 * report's — the shield it shows already counts them (泛输血's next layer put on by the hit that broke the last one).
 *
 * A group takes no more hits once one got damage through and no shield went on after it: damage gets through only an
 * empty shield, so the hits after it met none. It closes there (what it took is known: everything on until then), and
 * the player is known to have no shield until one goes on. Without this, a stream of hits (a pack of enemies on a
 * tank) never leaves a report after every earlier hit took effect, and runs on as one group long after the shield broke.
 *
 * A hit with no 37 line of its own within RESULT_TIMEOUT_MS (Triggevent's wait), or when its target or source dies,
 * or at a wipe or zone change, took effect (not every action gets a 37 line: LogGuide) unless the HP updates (37, 38,
 * 39: never stale) show its damage never came off: with no heal in between, none of them went down to the HP before
 * less the damage — less, first, the damage of the other hits whose own 37 lines came by then (each such line gives
 * the HP after its hit). Once those have taken all the HP there was, nothing was left for this one: three needles
 * locked in together on one player, two with their 37 lines taking him to 0, the third with none (docs/DESIGN.md 5.6).
 */

/** A shield's put-on line waits this long for its 26 line from the same source (Triggevent's pre-applications: 5 s). */
const PUT_ON_TO_GAIN_MS = 5000;
/** A status the ACT plugin lists again with its end moved by more than this was put on again (NetworkBuffManager). */
const REAPPLIED_MS = 2000;

interface Report {
  time: number;
  order: number;
  percent: number;
  maxHp: number;
  /** Status changes of its message: the shield it shows counts them. */
  run: Change[];
  /** It is the 37 line of a hit on the player. */
  ofHit: boolean;
}

interface Change {
  kind: "gain" | "loss";
  order: number;
  statusId: number;
  /** A gain: what it holds, when known. */
  size?: number;
  /** A loss: what it still held may not have gone to the group's hits (it ran out, or went before them). */
  unknownLeft?: boolean;
}

interface OnShield {
  due: number;
  /** When it went on (line order). */
  order: number;
  /** What the first of its layers held (泛输血 puts the next one on as the first). */
  firstSize?: number;
}

interface Open {
  pub: ShieldGroup;
  before?: Report;
  /** Changes since the report before the group, until its first hit. */
  beforeChanges: Change[];
  /** Changes from the first hit on. */
  changes: Change[];
  unsettled: Set<DamageRow>;
  /** When the last member took effect, and when the last one was computed. */
  lastSettle: number;
  lastHit: number;
}

interface Book {
  /** The last report with a shield figure. */
  last?: Report;
  /** Changes since `last` while no group is open. */
  since: Change[];
  open?: Open;
  on: Map<string, OnShield>;
  /** HP updates, with their line's place. */
  hp: { time: number; order: number; hp: number }[];
  /** Hits whose own 37 line came, at that line's place: the HP updates from then on count their damage. */
  resolved: { time: number; order: number; amount: number; row: DamageRow }[];
  /** Heals and HoT ticks, with their line's place. */
  heals: { time: number; order: number }[];
  /** Hits of groups closed at a hit that got through, still to take effect: until they have, no report is the latest word. */
  early: DamageRow[];
  /** The shields on until this point (line order) were used up by a hit that got through. */
  emptyAt?: number;
}

interface PutOn {
  time: number;
  actionId: number;
  byte: number;
  heal: number;
  targetMaxHp: number;
  sourceMaxHp: number;
  sourceId: string;
}

const hpOf = (r: Report) => (r.percent * r.maxHp) / 100;

export class ShieldAccount {
  private readonly books = new Map<string, Book>();
  /** Hits waiting for their 37 line, by sequence and target. */
  private readonly waiting = new Map<string, DamageRow[]>();
  private readonly putOns = new Map<string, PutOn>();
  /** A confirmed size of a source's shield, for an action whose tooltip sizes none (展开战术 spreading 鼓舞). */
  private readonly lastExact = new Map<string, number>();
  /** A report whose message's status lines may still follow. */
  private pending: { targetId: string; report: Report } | undefined;
  private order = 0;
  private nextId = 1;

  constructor(private readonly levelOf: (id: string) => number) {}

  /** Every line, first: a report's message ends at the first line not its own; hits waiting too long are decided. */
  advance(e: GameEvent): DamageRow[] {
    this.order++;
    const changed: DamageRow[] = [];
    const p = this.pending;
    const ownStatus = (e.type === "gainEffect" || e.type === "loseEffect") && p && e.targetId === p.targetId && e.time === p.report.time;
    if (p && !ownStatus) changed.push(...this.finish());
    for (const [key, rows] of this.waiting) {
      if (e.time - rows[0]!.time <= RESULT_TIMEOUT_MS) continue;
      this.waiting.delete(key);
      for (const row of rows) if (this.decide(row)) changed.push(row);
    }
    return changed;
  }

  /** A damage row on a player, at its line: a hit computed, or a DoT tick. Returns the rows of a group it closed. */
  hit(row: DamageRow): DamageRow[] {
    if (row.kind === "hit" && row.seq) {
      const key = `${row.seq}|${row.target.id}`;
      const w = this.waiting.get(key);
      if (w) w.push(row);
      else this.waiting.set(key, [row]);
    }
    if (row.result === "miss" || row.invulnerable) {
      if (row.kind === "dot" || !row.seq) row.settledAt = row.time;
      return [];
    }
    const book = this.book(row.target.id);
    const closed = book.open && this.brokeThrough(book.open) ? this.closeThrough(book) : [];
    if (!book.open) {
      const shielded = (book.last?.percent ?? 0) > 0 || book.since.some((c) => c.kind === "gain") || (!book.last && book.on.size > 0);
      if (!shielded) {
        if (row.kind === "dot" || !row.seq) row.settledAt = row.time;
        return closed;
      }
      book.open = {
        pub: { id: this.nextId++, rows: [], waiting: 0, closed: false },
        ...(book.last ? { before: book.last } : {}),
        beforeChanges: book.since,
        changes: [],
        unsettled: new Set(),
        lastSettle: this.order,
        lastHit: this.order,
      };
      book.since = [];
    }
    const open = book.open;
    open.pub.rows.push(row);
    open.lastHit = this.order;
    row.shieldGroup = open.pub;
    if (row.amount === 0) row.fullyAbsorbed = true;
    if (row.kind === "dot" || !row.seq) {
      row.settledAt = row.time;
      open.lastSettle = this.order;
    } else {
      open.unsettled.add(row);
      open.pub.waiting = open.unsettled.size;
    }
    return closed;
  }

  /** A 37 line: `rows` (its own hits, the recorder paired them) took effect; with a shield figure, a report. */
  result(targetId: string, time: number, sequence: string, rows: readonly DamageRow[], percent: number | undefined, maxHp: number): void {
    this.waiting.delete(`${sequence}|${targetId}`);
    const book = rows.length > 0 ? this.book(targetId) : undefined;
    for (const row of rows) {
      row.settledAt = time;
      this.settle(row);
      if (row.amount > 0) book!.resolved.push({ time, order: this.order, amount: row.amount, row });
    }
    if (book) while (book.resolved.length > 0 && time - book.resolved[0]!.time > 2 * RESULT_TIMEOUT_MS) book.resolved.shift();
    if (percent !== undefined && maxHp > 0) this.report(targetId, time, percent, maxHp, rows.length > 0);
  }

  /** A player's total shield (a 37 or 38 line with it); its message's status lines may follow. */
  report(targetId: string, time: number, percent: number, maxHp: number, ofHit = false): void {
    this.pending = { targetId, report: { time, order: this.order, percent, maxHp, run: [], ofHit } };
  }

  /** A shield's put-on line (a 21/22 line putting it on a player): its action, the lowest byte of what it holds, the line's heal. */
  shieldPutOn(targetId: string, statusId: number, actionId: number, sourceId: string, byte: number, heal: number, targetMaxHp: number, sourceMaxHp: number, time: number): void {
    this.putOns.set(`${targetId}|${statusId}`, { time, actionId, byte, heal, targetMaxHp, sourceMaxHp, sourceId });
  }

  /** A shield put on a player (26), lasting `durationMs`. */
  shieldGained(targetId: string, statusId: number, sourceId: string, time: number, durationMs: number): void {
    const book = this.book(targetId);
    const key = `${statusId}|${sourceId}`;
    const was = book.on.get(key);
    const run = this.runOf(targetId, time);
    const line = this.putOns.get(`${targetId}|${statusId}`);
    const ofLine = line && line.sourceId === sourceId && time >= line.time && time - line.time <= PUT_ON_TO_GAIN_MS ? line : undefined;
    if (ofLine) this.putOns.delete(`${targetId}|${statusId}`);
    // The ACT plugin writes a 26 line for a status already on when its end moved by more than 2 s (put on again), or
    // when only its parameter changed: the latter is no new shield.
    if (was && !ofLine && Math.abs(time + durationMs - was.due) <= REAPPLIED_MS) return;
    // 泛输血's next layer, put on in the result of the hit that broke the last one: as the first one was.
    const refill = !ofLine && was !== undefined && run?.ofHit === true;
    const size = ofLine ? this.sizeOf(ofLine, statusId) : refill ? was!.firstSize : undefined;
    const changes: Change[] = [];
    // Put on again over itself (a new cast): what the old one still held is gone, how much unknown — none, when a hit
    // that got through used it up.
    const usedUp = was !== undefined && book.emptyAt !== undefined && was.order <= book.emptyAt;
    if (was && !refill && !usedUp) changes.push({ kind: "loss", order: this.order, statusId, unknownLeft: true });
    changes.push({ kind: "gain", order: this.order, statusId, ...(size !== undefined ? { size } : {}) });
    const firstSize = ofLine ? size : was?.firstSize;
    book.on.set(key, { due: time + durationMs, order: this.order, ...(firstSize !== undefined ? { firstSize } : {}) });
    this.place(book, run, changes);
  }

  /**
   * A shield gone from a player (30). Ran out (at or after its 26 line's time plus duration: LogGuide, the logged
   * duration may only have counted down a little): what it still held is unknown. Gone early while a group is open:
   * its hits broke it. Gone early in the moment of the last report (the 38 after a hit's 37): that report shows it.
   * Returns whether hits used it up — all but running out or going with no hit about (docs/DESIGN.md 8.2 refunds).
   */
  shieldLost(targetId: string, statusId: number, sourceId: string, time: number): boolean {
    const book = this.book(targetId);
    const key = `${statusId}|${sourceId}`;
    const was = book.on.get(key);
    book.on.delete(key);
    // Used up by a hit that got through: nothing was left in it.
    if (was && book.emptyAt !== undefined && was.order <= book.emptyAt) return true;
    const expired = was !== undefined && time >= was.due;
    const run = this.runOf(targetId, time);
    if (!run && !book.open && !expired && book.last?.time === time) return true;
    const unknownLeft = expired || (!run && !book.open);
    this.place(book, run, [{ kind: "loss", order: this.order, statusId, ...(unknownLeft ? { unknownLeft: true } : {}) }]);
    return !unknownLeft;
  }

  /** A player's HP as a 37, 38 or 39 line gives it. */
  hpReading(targetId: string, time: number, hp: number): void {
    const readings = this.book(targetId).hp;
    readings.push({ time, order: this.order, hp });
    while (readings.length > 0 && time - readings[0]!.time > 2 * RESULT_TIMEOUT_MS) readings.shift();
  }

  /** A heal or HoT tick landed on the player. */
  healed(targetId: string, time: number): void {
    const heals = this.book(targetId).heals;
    heals.push({ time, order: this.order });
    while (heals.length > 0 && time - heals[0]!.time > 2 * RESULT_TIMEOUT_MS) heals.shift();
  }

  /** A combatant died: hits on it or from it still waiting are decided now; `landed`: its killing blow. */
  died(id: string, landed?: DamageRow): DamageRow[] {
    const changed: DamageRow[] = [];
    for (const [key, rows] of this.waiting) {
      if (rows[0]!.target.id !== id && rows[0]!.source.id !== id) continue;
      this.waiting.delete(key);
      for (const row of rows) if (this.decide(row, row === landed)) changed.push(row);
    }
    return changed;
  }

  /** A wipe, a zone change, the end of a replay: every waiting hit is decided, every group closed with what is known. */
  flush(): DamageRow[] {
    const changed = this.finish();
    for (const rows of this.waiting.values()) for (const row of rows) if (this.decide(row)) changed.push(row);
    this.waiting.clear();
    for (const book of this.books.values()) {
      if (!book.open) continue;
      changed.push(...this.close(book.open, undefined));
      book.open = undefined;
    }
    return changed;
  }

  /** A new encounter: sizes learned from earlier casts are not used (the review replays one encounter's lines). */
  forgetSizes(): void {
    this.lastExact.clear();
  }

  /** Nothing is carried over (a wipe or zone change, after flush). */
  clear(): void {
    this.books.clear();
    this.waiting.clear();
    this.putOns.clear();
    this.pending = undefined;
  }

  private book(id: string): Book {
    let b = this.books.get(id);
    if (!b) this.books.set(id, (b = { since: [], on: new Map(), hp: [], resolved: [], heals: [], early: [] }));
    return b;
  }

  /** The report whose message a status line at `time` on this player belongs to. */
  private runOf(targetId: string, time: number): Report | undefined {
    const p = this.pending;
    return p && p.targetId === targetId && p.report.time === time ? p.report : undefined;
  }

  private place(book: Book, run: Report | undefined, changes: Change[]): void {
    if (run) run.run.push(...changes);
    else if (book.open) book.open.changes.push(...changes);
    else book.since.push(...changes);
  }

  /** A report's message is over: it closes the open group whose hits have all taken effect, else it is the latest word. */
  private finish(): DamageRow[] {
    const p = this.pending;
    if (!p) return [];
    this.pending = undefined;
    const book = this.book(p.targetId);
    const open = book.open;
    // A report between a hit's line and its result may or may not show it: not one to settle on.
    const early = this.earlyWaiting(book);
    if (open) {
      if (open.unsettled.size > 0 || p.report.order < open.lastSettle || early) {
        open.changes.push(...p.report.run);
        return [];
      }
      book.open = undefined;
      book.last = p.report;
      book.since = [];
      return this.close(open, p.report);
    }
    if (early) {
      book.since.push(...p.report.run);
      return [];
    }
    book.last = p.report;
    book.since = [];
    return [];
  }

  /** Whether hits of groups closed early have yet to take effect (those that have are dropped). */
  private earlyWaiting(book: Book): boolean {
    book.early = book.early.filter((r) => r.settledAt === undefined);
    return book.early.length > 0;
  }

  /** The open group's last hit got damage through, and no shield went on after it: the hits after it met none. */
  private brokeThrough(open: Open): boolean {
    const last = open.pub.rows.at(-1);
    if (!last || !(last.amount > 0) || last.noEffect) return false;
    return !open.changes.some((c) => c.kind === "gain" && c.order > open.lastHit);
  }

  /**
   * Closes the open group at its last hit, which got through: what it took is everything on until then (close), and
   * the player has no shield left until one goes on — a report of 0 at that hit.
   */
  private closeThrough(book: Book): DamageRow[] {
    const open = book.open!;
    book.open = undefined;
    const last = open.pub.rows.at(-1)!;
    const rows = this.close(open, undefined);
    book.last = { time: last.time, order: open.lastHit, percent: 0, maxHp: last.maxHp, run: [], ofHit: false };
    book.since = [];
    book.emptyAt = open.lastHit;
    book.early.push(...open.unsettled);
    return rows;
  }

  private close(open: Open, after: Report | undefined): DamageRow[] {
    const pub = open.pub;
    pub.closed = true;
    pub.waiting = 0;
    const all = [...open.beforeChanges, ...open.changes, ...(after?.run ?? [])];
    const last = pub.rows.at(-1);
    const gotThrough = last !== undefined && last.amount > 0 && !last.noEffect;
    // Damage got through the last hit: everything on until it was used up; what came after does not count.
    const counted = gotThrough ? all.filter((c) => c.order <= open.lastHit) : all;
    const gains = counted.filter((c) => c.kind === "gain");
    const known = gains.reduce((s, c) => s + (c.size ?? 0), 0);
    const unknownGain = gains.some((c) => c.size === undefined);
    const unknownLoss = counted.some((c) => c.kind === "loss" && c.unknownLeft);
    if (open.before) {
      const beforeGains = open.beforeChanges.filter((c) => c.kind === "gain");
      if (!beforeGains.some((c) => c.size === undefined)) pub.before = Math.round(hpOf(open.before) + beforeGains.reduce((s, c) => s + c.size!, 0));
    }
    if (after) pub.after = Math.round(hpOf(after));
    let absorbed: number | undefined;
    if (open.before && gotThrough) absorbed = hpOf(open.before) + known;
    else if (open.before && after) absorbed = Math.max(0, hpOf(open.before) + known - hpOf(after));
    if (absorbed !== undefined && !(unknownGain && unknownLoss)) {
      pub.absorbed = Math.round(absorbed);
      if (unknownGain) pub.bound = "atLeast";
      else if (unknownLoss) pub.bound = "atMost";
    }
    // What a layer put on after the last hit got through holds: the shield after it, alone (泛输血's next layer).
    if (gotThrough && after) {
      const later = all.filter((c) => c.order > open.lastHit);
      const unsized = later.filter((c) => c.kind === "gain" && c.size === undefined);
      if (unsized.length === 1 && !later.some((c) => c.kind === "loss")) this.learnLayer(pub.rows[0]!.target.id, unsized[0]!.statusId, hpOf(after) - later.reduce((s, c) => s + (c.size ?? 0), 0));
    }
    const only = pub.rows.length === 1 ? pub.rows[0] : undefined;
    if (only && pub.absorbed !== undefined && !pub.bound) only.shieldAbsorbed = pub.absorbed;
    if (only && pub.before !== undefined) only.shieldBefore = pub.before;
    return pub.rows;
  }

  /** The size a layer turned out to hold: the next one put on the same way holds as much. */
  private learnLayer(targetId: string, statusId: number, size: number): void {
    if (!(size > 0)) return;
    for (const [key, on] of this.book(targetId).on) if (key.startsWith(`${statusId}|`) && on.firstSize === undefined) on.firstSize = Math.round(size);
  }

  private settle(row: DamageRow): void {
    const open = row.shieldGroup && !row.shieldGroup.closed ? this.book(row.target.id).open : undefined;
    if (!open || open.pub !== row.shieldGroup || !open.unsettled.delete(row)) return;
    open.lastSettle = this.order;
    open.pub.waiting = open.unsettled.size;
  }

  /** A hit with no 37 line of its own: took effect unless the HP updates show its damage never came off. Returns whether it changed. */
  private decide(row: DamageRow, landed = false): boolean {
    row.settledAt ??= row.time;
    const none = !landed && !this.landed(row);
    if (none) row.noEffect = true;
    this.settle(row);
    return true;
  }

  private landed(row: DamageRow): boolean {
    if (!(row.amount > 0)) return true;
    const book = this.book(row.target.id);
    let before: { time: number; order: number; hp: number } | undefined;
    for (const r of book.hp) if (r.time <= row.time) before = r;
    const after = book.hp.filter((r) => r.time > row.time && r.time - row.time <= RESULT_TIMEOUT_MS);
    if (!before || !(before.hp > 0) || after.length === 0) return true;
    for (const r of after) {
      // A heal after the update it went from (line order: one in the same moment before it is in that update): HP no longer tells.
      if (book.heals.some((h) => h.order > before!.order && h.order <= r.order)) return true;
      // What the other hits that took effect by this update leave, without this one.
      const others = book.resolved.reduce((sum, h) => (h.row !== row && h.order > before!.order && h.order <= r.order ? sum + h.amount : sum), 0);
      const left = before.hp - others;
      if (left <= 0) return false; // they took all there was: none came off for this one
      if (r.hp <= Math.max(0, left - row.amount)) return true;
    }
    return false;
  }

  /**
   * A shield's size as its put-on line says, when the line's lowest byte (LogGuide) confirms it: what the tooltip of
   * the line's action says at the caster's level (core/game/barriers.ts) — a share of the line's heal or of a max HP;
   * of several alternatives, the one the byte picks — or, for an action whose tooltip sizes no shield, the size the
   * same source's last one had.
   */
  private sizeOf(line: PutOn, statusId: number): number | undefined {
    const fits = (x: number) => [x - 1, x, x + 1].some((y) => (y & 0xff) === line.byte);
    const shares = barrierShares(line.actionId, statusId, this.levelOf(line.sourceId));
    let size: number | undefined;
    if (shares) {
      const base = shares.of === "heal" ? line.heal : shares.of === "bearer" ? line.targetMaxHp : line.sourceMaxHp;
      if (!(base > 0)) return undefined;
      const sizes = [...new Set(shares.percents.map((p) => Math.floor((p * base) / 100)))].filter(fits);
      size = sizes.length === 1 ? sizes[0] : undefined;
    } else {
      const last = this.lastExact.get(`${line.sourceId}|${statusId}`);
      size = last !== undefined && fits(last) ? last : undefined;
    }
    if (size !== undefined) this.lastExact.set(`${line.sourceId}|${statusId}`, size);
    return size;
  }
}
