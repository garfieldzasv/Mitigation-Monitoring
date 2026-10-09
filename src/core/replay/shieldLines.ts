import { damageTaken, type DamageRow, type Row, type ShieldGroup } from "../engine/types";

/**
 * Hits the shield reports cannot tell apart (a shield group, docs/DESIGN.md 5.6): what the shields took is only known
 * for them together. The lists show each hit on its own line (docs/DESIGN.md 7.1, 8.2); the detail panel sums a group
 * up in a group line, a row made of its members: their damage summed, their names counted (龙光扩散 ×2, 护龙威压 ×3 +
 * 咆哮), the group's shield figures.
 */
export interface GroupRow extends DamageRow {
  /** The members shown (the filter may hide some). */
  members: DamageRow[];
  /** Members the filter hides. */
  hidden: number;
}

export function isGroupRow(r: Row): r is GroupRow {
  return r.kind !== "death" && "members" in r;
}

/** A row that is one of several in its shield group. */
export function inSharedGroup(r: DamageRow): boolean {
  return !isGroupRow(r) && (r.shieldGroup?.rows.length ?? 0) > 1;
}

/** The members' abilities in order of first appearance, each with its count: 护龙威压 ×3 + 咆哮. */
export function groupLabel(rows: readonly DamageRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.action.name, (counts.get(r.action.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(" + ");
}

const same = <T>(rows: readonly DamageRow[], f: (r: DamageRow) => T): T | undefined => {
  const first = f(rows[0]!);
  return rows.every((r) => f(r) === first) ? first : undefined;
};

/** One line for a shield group, made of its members shown. */
export function groupRow(group: ShieldGroup, members: DamageRow[]): GroupRow {
  const first = members[0]!;
  const settled = [...members].filter((r) => r.hpAfter !== undefined).sort((a, b) => (a.settledAt ?? a.time) - (b.settledAt ?? b.time));
  const multiplier = same(members, (r) => r.multiplier);
  const sourceName = same(members, (r) => r.source.name);
  const kind = members.every((r) => r.kind === "dot") ? "dot" : "hit";
  const landed = members.filter((r) => !r.noEffect);
  const hpAfter = settled.at(-1)?.hpAfter;
  return {
    ...first,
    kind,
    seq: undefined,
    targetCount: undefined,
    source: sourceName !== undefined ? first.source : { id: "", name: "多个来源" },
    action: { id: 0, name: groupLabel(members) },
    autoAttack: members.every((r) => r.autoAttack),
    amount: landed.reduce((s, r) => s + damageTaken(r), 0),
    fullyAbsorbed: landed.length > 0 && landed.every((r) => r.fullyAbsorbed),
    ...(members.every((r) => r.noEffect) ? { noEffect: true as const } : { noEffect: undefined }),
    damageType: same(members, (r) => r.damageType) ?? "unknown",
    result: same(members, (r) => r.result) ?? "hit",
    crit: members.some((r) => r.crit),
    direct: members.some((r) => r.direct),
    invulnerable: members.every((r) => r.invulnerable),
    ...(hpAfter !== undefined ? { hpAfter } : { hpAfter: undefined }),
    multiplier: multiplier ?? null,
    multiplierPartial: members.some((r) => r.multiplierPartial),
    mitigation: multiplier !== undefined ? first.mitigation : [],
    shieldAbsorbed: group.bound ? undefined : group.absorbed,
    shieldBefore: group.before,
    shieldGroup: group,
    fatal: members.some((r) => r.fatal) || undefined,
    members,
    hidden: group.rows.length - members.length,
  };
}

/** The shield groups of these rows, each once, in order. */
export function groupsOf(rows: readonly Row[]): ShieldGroup[] {
  const seen = new Set<ShieldGroup>();
  const out: ShieldGroup[] = [];
  for (const r of rows) {
    const g = r.kind !== "death" ? r.shieldGroup : undefined;
    if (g && !seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/** What shields took off these rows' groups together, and whether some of it is only a bound or unknown. */
export function absorbedTotal(rows: readonly Row[]): { total: number; uncertain: boolean } {
  let total = 0;
  let uncertain = false;
  for (const g of groupsOf(rows)) {
    if (g.absorbed !== undefined) total += g.absorbed;
    if (g.absorbed === undefined || g.bound) uncertain = true;
  }
  return { total, uncertain };
}
