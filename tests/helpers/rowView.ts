import type { Row } from "@/core/engine/types";

/** What a row shows; two engines that agree on this show the same table. */
export const view = (r: Row) =>
  r.kind === "death"
    ? [r.id, r.kind, r.time, r.target.id, r.target.job, r.sourceName, r.killerRowId ?? null, r.overkill ?? null, r.cause ?? null, r.causeAction ?? null]
    : [
        r.id,
        r.kind,
        r.time,
        r.target.id,
        r.target.job,
        r.source.name,
        r.action.name,
        r.amount,
        r.result,
        r.multiplier,
        r.multiplierPartial,
        r.hpAfter ?? null,
        r.shieldAbsorbed ?? null,
        r.shieldBefore ?? null,
        r.fullyAbsorbed,
        r.noEffect ?? false,
        r.fatal ?? false,
        r.targetStatuses.map((s) => `${s.id}:${s.category}`).sort().join(","),
        r.sourceStatuses.map((s) => `${s.id}:${s.category}:${s.inherited ?? false}`).sort().join(","),
      ];
