/**
 * Damage reductions by status ID, in percent (docs/DESIGN.md 5.5). The statuses carry no usable numbers
 * (descriptions say only 减轻所受到的伤害; the Status sheet's ParamModifier disagrees with the tooltips), but the
 * tooltip of every action that grants one says how much: scripts/import-game-data.ts reads them all
 * (scripts/game-data/mitigation.ts) into generated/mitigation.json — every status of every job, role and duty
 * action, not only those seen in logs. Here only what a tooltip cannot say. A status no tooltip values (a duty's
 * own mechanics: the value lives on the server) takes the modifier its put-on line carried in the log
 * (core/mitigation/multiplier.ts fromLog); with neither, the rate shows "?".
 */
import generated from "./generated/mitigation.json";

export interface MitigationValue {
  physical: number;
  magical: number;
}

export interface MitigationContext {
  /** The player hit; its level stands in for the caster's (everyone in a duty is synced alike). */
  level: number;
  /** The status was applied by the player who carries it. */
  selfApplied: boolean;
  /** Whether the status's caster currently has any of these statuses. */
  casterHas: (statusIds: readonly number[]) => boolean;
}

export interface MitigationEntry extends MitigationValue {
  /** Statuses in one group do not stack (the tooltip says 无法…共存): only the strongest applies. */
  group?: string;
  /** Different values from these levels up (ascending). */
  levels?: readonly (MitigationValue & { level: number })[];
  /** Values that depend on who applied the status. */
  adjust?: (ctx: MitigationContext) => MitigationValue | undefined;
}

const all = (percent: number, extra: Omit<MitigationEntry, "physical" | "magical"> = {}): MitigationEntry => ({
  physical: percent,
  magical: percent,
  ...extra,
});

const RAMPART = 1191;
const SENTINEL = 74;
const GUARDIAN = 3829;

/**
 * What the tooltips cannot say, over what they do. 武装: 武装戍卫's tooltip gives 15% to "范围内的队员" without
 * naming the status (the PLD's own 武装戍卫 only blocks). 骑士的坚守: 15% from the PLD's own 圣盾阵, 10% given by
 * 干预 (one status, two tooltips). 干预: 10%, 20% while the PLD has 铁壁, 预警 or 极致防御 (效果提高10%).
 */
const TAKEN_RULES: Readonly<Record<number, MitigationEntry>> = {
  1176: all(15), // 武装 Passage of Arms
  2675: all(15, { adjust: (ctx) => (ctx.selfApplied ? undefined : { physical: 10, magical: 10 }) }), // 骑士的坚守
  1174: all(10, { adjust: (ctx) => (ctx.casterHas([RAMPART, SENTINEL, GUARDIAN]) ? { physical: 20, magical: 20 } : undefined) }), // 干预
};

const fromTooltips = (table: Record<string, MitigationEntry & { action?: number }>): Record<number, MitigationEntry> =>
  Object.fromEntries(Object.entries(table).map(([id, { action: _action, ...entry }]) => [Number(id), entry]));

/** On the player taking the damage: every status a tooltip values, and the rules above. */
export const TAKEN_MITIGATION: Readonly<Record<number, MitigationEntry>> = { ...fromTooltips(generated.taken), ...TAKEN_RULES };

/** On the enemy dealing the damage (雪仇, 昏乱, 牵制, 武装解除…). */
export const DEALT_MITIGATION: Readonly<Record<number, MitigationEntry>> = fromTooltips(generated.dealt);

/** The values that apply to one status in one hit. */
export function resolveEntry(entry: MitigationEntry, ctx: MitigationContext): MitigationValue {
  const adjusted = entry.adjust?.(ctx);
  if (adjusted) return adjusted;
  let value: MitigationValue = entry;
  for (const step of entry.levels ?? []) if (ctx.level >= step.level) value = step;
  return value;
}
