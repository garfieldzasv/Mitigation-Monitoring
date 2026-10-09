import autoAttacks from "@/data/generated/autoAttacks.json";
import cactbot from "@/data/generated/cactbot.json";

/** The CN client's name for auto-attacks. */
export const AUTO_ATTACK_NAME = "攻击";

/**
 * Auto-attacks: actions whose ActionCategory is auto-attack in the game data (scripts/import-game-data.ts), and those
 * cactbot's timeline authors annotate as auto-attacks (scripts/game-data/cactbot.ts: many bosses auto-attack with an
 * action the data files as an ability, 格莱杨拉波尔's unknown_b25e).
 */
const AUTO_ATTACK_IDS: ReadonlySet<number> = new Set([...autoAttacks.ids, ...cactbot.autoAttacks]);

export function isAutoAttack(actionId: number, logName: string): boolean {
  return AUTO_ATTACK_IDS.has(actionId) || logName === AUTO_ATTACK_NAME;
}

/**
 * The name to show for an action. Most enemy auto-attacks have no name in the client, so ACT logs
 * them as `unknown_ae46`; some carry the Japanese 攻撃. Both show as 攻击. Named auto-attacks
 * (机关炮 and the like) and unnamed non-auto-attacks keep what the log says.
 */
export function displayActionName(actionId: number, logName: string): string {
  if (AUTO_ATTACK_IDS.has(actionId) && (logName === "" || logName === "攻撃" || /^unknown_/i.test(logName))) {
    return AUTO_ATTACK_NAME;
  }
  return logName;
}
