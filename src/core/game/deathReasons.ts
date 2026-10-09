import cactbot from "@/data/generated/cactbot.json";

/**
 * Death reasons cactbot's oopsy authors annotate by hand (scripts/game-data/cactbot.ts): in a zone, after being hit by
 * one of these abilities (or gaining one of these statuses), a player's death is that reason unless damage came after
 * it — "Knocked off" (a fall), "Pushed into wall" (the arena's lethal edge), or a mechanic's own.
 */
export interface DeathReason {
  kind: "fall" | "wall" | "other";
  /** cactbot's text, Chinese when it has one (击退坠落, 击退至墙). */
  text: string;
}

interface ZoneReasons {
  ability: Map<number, DeathReason>;
  status: Map<number, DeathReason>;
}

const BY_ZONE = new Map<number, ZoneReasons>();
for (const r of cactbot.deathReasons as { zones: number[]; on: "ability" | "status"; ids: number[]; kind: DeathReason["kind"]; text: string }[]) {
  for (const zone of r.zones) {
    let z = BY_ZONE.get(zone);
    if (!z) BY_ZONE.set(zone, (z = { ability: new Map(), status: new Map() }));
    for (const id of r.ids) z[r.on].set(id, { kind: r.kind, text: r.text });
  }
}

/** The reason cactbot gives a player's death after this ability hit them, or after they gained this status, in this zone. */
export function deathReasonOf(zoneId: number, on: "ability" | "status", id: number): DeathReason | undefined {
  return BY_ZONE.get(zoneId)?.[on].get(id);
}
