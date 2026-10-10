/**
 * Generates src/data/generated/ from the Chinese client's game data (docs/DESIGN.md 9.4).
 *
 *   pnpm import-data [--cn <git ref>] [--cactbot <git ref>]
 *
 * Defaults: master of ffxiv-datamining-cn, main of OverlayPlugin/cactbot (its hand annotations, game-data/cactbot.ts).
 * Downloads are cached in node_modules/.cache/game-data/<commit>/ and node_modules/.cache/cactbot/<commit>/. The
 * script prints what changed since the last run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StatusEffectKind } from "../src/core/game/statuses";
import { barriersFromTooltips } from "./game-data/barriers";
import { defensivesFromGameData } from "./game-data/defensives";
import { cactbotFiles, cactbotUrl, oopsyDeathReasons, resolveCactbotCommit, timelineAutoAttacks, zoneIds } from "./game-data/cactbot";
import { jobCategories } from "./game-data/jobs";
import { mitigationFromTooltips } from "./game-data/mitigation";
import { damageEffect, type ByteRule, type EffectScope } from "./game-data/statusEffects";
import { Cache, cnCsvUrl, cnRows, fetchText, resolveCnCommit } from "./game-data/sources";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "src/data/generated");

/** Action sheet raw columns (SaintCoinach numbering): 0 Name, 3 ActionCategory. */
const ACTION_NAME = 0;
const ACTION_CATEGORY = 3;
/** ActionCategory 1 = Auto-attack. */
const AUTO_ATTACK_CATEGORY = "1";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Enemy auto-attacks often have no name in the client, so ACT logs them as `unknown_ae46`. Their
 * ActionCategory still says auto-attack, which is how the monitor names them 攻击.
 */
function autoAttackIds(actionCsv: string): { ids: number[]; unnamed: number } {
  const ids: number[] = [];
  let unnamed = 0;
  for (const [id, cells] of cnRows(actionCsv)) {
    if (cells[ACTION_CATEGORY + 1] !== AUTO_ATTACK_CATEGORY) continue;
    ids.push(id);
    if (!cells[ACTION_NAME + 1]) unnamed++;
  }
  return { ids: ids.sort((a, b) => a - b), unnamed };
}

/**
 * Status sheet raw columns: 0 Name, 1 Description, 2 Icon, 4 MaxStacks, 6 StatusCategory (1 good, 2 bad), 17
 * InflictedByActor, 18 IsPermanent, 27 IsFcBuff. The CN sheet's column names are shifted from raw 17 on: the one it
 * calls IsPermanent (17) is InflictedByActor, the one it calls PartyListPriority (18) is IsPermanent — so the global
 * sheet's columns (xivapi/ffxiv-datamining, kept to the current schema) name them, and their values agree on 99.96 % of
 * the statuses both have; IsFcBuff on all of them (its 17 are the 部队特效：… statuses).
 */
const STATUS_NAME = 0;
const STATUS_DESCRIPTION = 1;
const STATUS_ICON = 2;
const STATUS_MAX_STACKS = 4;
const STATUS_CATEGORY = 6;
const STATUS_INFLICTED_BY_ACTOR = 17;
const STATUS_IS_PERMANENT = 18;
const STATUS_IS_FC_BUFF = 27;
/** StatusCategory 2: a debuff. */
const STATUS_BAD = "2";


/**
 * A shield is a status that itself absorbs damage (伤害屏障 says 抵御, the rest 抵消). Not one that grants
 * a shield to others on some condition: 圣光幕帘's trigger on the paladin (受到治疗魔法时为周围队员附加…),
 * a stance (黑夜学派: 治疗技能会附加…, 抽取融合·防护: 使用部分技能时…) — unless it is also one itself (身附…).
 */
const SHIELD = /(抵消|抵御)一定(量的)?伤害|抵消伤害/;
const GRANTS_SHIELD = /受到治疗魔法时|治疗技能会附加|为周围队员附加|使用部分技能时/;
const IS_SHIELD_ITSELF = /(^|，)身附/;
const isShield = (text: string) => SHIELD.test(text) && (!GRANTS_SHIELD.test(text) || IS_SHIELD_ITSELF.test(text));

/**
 * Kinds by description, the first rule that matches. "invuln": damage comes to nothing (神圣领域「…均无效化」, 无敌
 * 「一切攻击都无法造成伤害」, 召唤兽的加护「暂时无敌」). "hpFloor": damage lands in full but HP stays at 1 (死斗,
 * 行尸走肉 / 死而不僵, 出死入生「…无法令体力减少到1以下」): shields still absorb it.
 */
const KIND_RULES: readonly [StatusEffectKind, RegExp | ((text: string) => boolean)][] = [
  ["invuln", /均无效化|一切攻击都无法造成伤害|暂时无敌/],
  ["hpFloor", /无法令体力减少到1以下|体力减为1/],
  ["shield", isShield],
  ["takenUp", /受到的.{0,8}伤害(增加|提高)|所受(到的)?.{0,8}伤害(增加|提高)|受到.{0,6}伤害增加/],
  // Ground markers ("…的防护区域") sit on the caster and do nothing themselves.
  ["takenDown", /减轻所受到的|受到.{0,6}的.{0,8}伤害减(少|轻)|所受.{0,6}伤害减轻/],
  ["dealtDown", /所造成的.{0,4}伤害降低|造成的伤害降低/],
  ["dealtUp", /所造成的.{0,4}伤害提高|造成的伤害提高/],
];

const plain = (description: string) => description.replace(/<[^>]*>/g, "").replace(/\s+/g, "");

function statusKind(description: string): StatusEffectKind | undefined {
  const text = plain(description);
  if (/区域/.test(text) && !/均无效化/.test(text)) return undefined;
  return KIND_RULES.find(([, rule]) => (typeof rule === "function" ? rule(text) : rule.test(text)))?.[0];
}

/**
 * [id, icon, maxStacks, kind, scope, byte] for every status with a damage-related effect; for damage taken / dealt
 * effects, which damage they cover and which put-on byte is their value (scripts/game-data/statusEffects.ts).
 */
function statusTable(statusCsv: string): { rows: [number, number, number, StatusEffectKind, EffectScope, ByteRule | ""][]; counts: Record<string, number> } {
  const rows: [number, number, number, StatusEffectKind, EffectScope, ByteRule | ""][] = [];
  const counts: Record<string, number> = {};
  for (const [id, cells] of cnRows(statusCsv)) {
    if (!cells[STATUS_NAME + 1]) continue;
    const description = cells[STATUS_DESCRIPTION + 1] ?? "";
    const kind = statusKind(description);
    if (!kind) continue;
    const effect = kind === "takenUp" || kind === "takenDown" || kind === "dealtUp" || kind === "dealtDown" ? damageEffect(description, kind) : undefined;
    rows.push([id, Number(cells[STATUS_ICON + 1]) || 0, Number(cells[STATUS_MAX_STACKS + 1]) || 0, kind, effect?.scope ?? "", effect?.byte ?? ""]);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return { rows: rows.sort((a, b) => a[0] - b[0]), counts };
}

/**
 * Statuses the game shows without a timer (docs/DESIGN.md 5.4): stances, dance partners, 关心, and those an aura or a
 * ground effect keeps on while it lasts (a bard's song, 节制, standing in 野战治疗阵 or 庇护所). Their 26 lines still
 * carry a duration — 关心 is re-sent every 3 s with 60 s, a song every 3 s with 5 s — so the log alone would count
 * them down. They last until their 30 line.
 */
function permanentStatusIds(statusCsv: string): number[] {
  const ids: number[] = [];
  for (const [id, cells] of cnRows(statusCsv)) if (cells[STATUS_NAME + 1] && cells[STATUS_IS_PERMANENT + 1] === "True") ids.push(id);
  return ids.sort((a, b) => a - b);
}

/**
 * Of those, the ones that still run out (docs/DESIGN.md 5.4): IsPermanent without InflictedByActor. Neither name is
 * documented; Sapphire's own names for the sheet's flags (deps/datReader/Exd/Structs.h) are HideTimer and Forever, and
 * IsPermanent is the one hiding the timer (LogGuide), so InflictedByActor is Forever: a stance, a dance partner or
 * 关心 has both and stays until it is taken off; an aura or a ground effect only hides its timer, the game re-sends it
 * every 3 s to whoever is in range and it lapses once they leave (节制's 1873, 野战治疗阵's 299, a bard's song). A
 * duty's mechanics can be this too (拘束): what a player put on is an aura's.
 */
function auraStatusIds(statusCsv: string): number[] {
  const ids: number[] = [];
  for (const [id, cells] of cnRows(statusCsv)) {
    if (cells[STATUS_NAME + 1] && cells[STATUS_IS_PERMANENT + 1] === "True" && cells[STATUS_INFLICTED_BY_ACTOR + 1] !== "True") ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

/**
 * Statuses the review does not list (docs/DESIGN.md 8.2): those the game does not show — no name and no icon, in the
 * global sheets too (LogGuide: 808 carries a VFX, its stacks the VFX ID) — and free company buffs.
 */
function unlistedStatusIds(statusCsv: string): { unshown: number[]; fcBuffs: number[] } {
  const unshown: number[] = [];
  const fcBuffs: number[] = [];
  for (const [id, cells] of cnRows(statusCsv)) {
    if (id > 0 && !cells[STATUS_NAME + 1] && !Number(cells[STATUS_ICON + 1])) unshown.push(id);
    if (cells[STATUS_IS_FC_BUFF + 1] === "True") fcBuffs.push(id);
  }
  return { unshown: unshown.sort((a, b) => a - b), fcBuffs: fcBuffs.sort((a, b) => a - b) };
}

/**
 * [id, icon] for the statuses the review lists that have no damage effect (docs/DESIGN.md 8.2): their base icon only —
 * the greyed lists do not show stacks, and the per-stack icons would add a third to the icon files.
 */
function otherStatusIcons(statusCsv: string, classified: ReadonlySet<number>, unlisted: ReadonlySet<number>): [number, number][] {
  const icons: [number, number][] = [];
  for (const [id, cells] of cnRows(statusCsv)) {
    const icon = Number(cells[STATUS_ICON + 1]) || 0;
    if (cells[STATUS_NAME + 1] && icon > 0 && !classified.has(id) && !unlisted.has(id)) icons.push([id, icon]);
  }
  return icons.sort((a, b) => a[0] - b[0]);
}

/** Action sheet raw column 46: ActionProcStatus, the row of the sheet naming the status an action needs to be used. */
const ACTION_PROC_STATUS = 46;

/**
 * Statuses some action needs to be used (Action.ActionProcStatus → ActionProcStatus.Status): 神爱抚预备 for 神爱抚,
 * 太阳星座预备 for 太阳星座. A cast that puts one on its caster is enabling a follow-up, not lasting by it (docs/DESIGN.md
 * 8.6: how long an aura's cast lasts).
 */
function enablerStatusIds(actionCsv: string, procCsv: string): number[] {
  const proc = cnRows(procCsv);
  const ids = new Set<number>();
  for (const [, cells] of cnRows(actionCsv)) {
    const row = Number(cells[ACTION_PROC_STATUS + 1]) || 0;
    const status = row ? Number(proc.get(row)?.[1]) || 0 : 0;
    if (status > 0) ids.add(status);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Debuffs that take HP over time, by their description (中暑「体力逐渐流失」, 中毒, 出血, 感电…): what an
 * enemy DoT tick came from (docs/DESIGN.md 5.1), since its 24 line almost never names the status.
 */
const DOT_TEXT = /体力(逐渐|持续|会逐渐|会持续|不断)(减少|流失|降低|下降)|持续(受到)?.{0,6}伤害|逐渐受到伤害/;

function damageOverTimeIds(statusCsv: string): number[] {
  const ids: number[] = [];
  for (const [id, cells] of cnRows(statusCsv)) {
    if (!cells[STATUS_NAME + 1] || cells[STATUS_CATEGORY + 1] !== STATUS_BAD) continue;
    if (DOT_TEXT.test(plain(cells[STATUS_DESCRIPTION + 1] ?? ""))) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

/**
 * TerritoryType raw columns: 0 Name, 5 PlaceName, 9 TerritoryIntendedUse, 10 ContentFinderCondition, 29 ExVersion.
 * ContentFinderCondition: 43 Name, 45 ContentType, 49 SortKey. ContentType, ExVersion, PlaceName: 0 Name.
 */
const TERRITORY_NAME = 0;
const TERRITORY_PLACE = 5;
const TERRITORY_USE = 9;
const TERRITORY_CFC = 10;
const TERRITORY_VERSION = 29;
const CFC_NAME = 43;
const CFC_CONTENT_TYPE = 45;
const CFC_SORT = 49;
const NAME = 0;

/**
 * Every zone, for the setting of which zones' fights are not archived (docs/DESIGN.md 6.2, 9.4): a duty by its
 * ContentFinderCondition (its name, and the game's own category for it, ContentType: 迷宫挑战, 讨伐歼灭战…), any other
 * zone by its PlaceName and what the zone is for (TerritoryIntendedUse: town, overworld, inn, housing…; the values are
 * named by FFXIVClientStructs' TerritoryIntendedUse enum), with its expansion (ExVersion) and the duty's sort key.
 * Rows: [id, name, content type (0: not a duty), intended use, expansion, sort key].
 */
function zoneCatalog(territoryCsv: string, cfcCsv: string, contentTypeCsv: string, placeCsv: string, versionCsv: string) {
  const cfc = cnRows(cfcCsv);
  const places = cnRows(placeCsv);
  const cell = (cells: string[] | undefined, raw: number) => cells?.[raw + 1] ?? "";
  const zones: [number, string, number, number, number, number][] = [];
  const typesUsed = new Set<number>();
  for (const [id, cells] of cnRows(territoryCsv)) {
    if (!cell(cells, TERRITORY_NAME)) continue;
    const duty = cfc.get(Number(cell(cells, TERRITORY_CFC)));
    const type = duty ? Number(cell(duty, CFC_CONTENT_TYPE)) || 0 : 0;
    const name = (type ? cell(duty, CFC_NAME) : "") || cell(places.get(Number(cell(cells, TERRITORY_PLACE))), NAME);
    if (!name) continue;
    if (type) typesUsed.add(type);
    zones.push([id, name, type, Number(cell(cells, TERRITORY_USE)) || 0, Number(cell(cells, TERRITORY_VERSION)) || 0, type ? Number(cell(duty, CFC_SORT)) || 0 : 0]);
  }
  const contentTypes: Record<number, string> = {};
  for (const [id, cells] of cnRows(contentTypeCsv)) if (typesUsed.has(id) && cell(cells, NAME)) contentTypes[id] = cell(cells, NAME);
  const versions = [...cnRows(versionCsv)].sort(([a], [b]) => a - b).map(([, cells]) => cell(cells, NAME));
  return { contentTypes, versions, zones: zones.sort((a, b) => a[0] - b[0]) };
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, name);
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const after = `${JSON.stringify(value)}\n`;
  writeFileSync(file, after, "utf8");
  console.log(`${before === after ? "unchanged" : "updated  "}  src/data/generated/${name}  (${after.length} bytes)`);
}

async function main(): Promise<void> {
  const commit = await resolveCnCommit(arg("--cn") ?? "master");
  console.log(`ffxiv-datamining-cn ${commit.sha.slice(0, 12)}  ${commit.message}`);
  const cache = new Cache(join(root, "node_modules/.cache/game-data", commit.sha.slice(0, 12)));
  const sheet = (name: string) => cache.text(`${name}.csv`, () => fetchText(cnCsvUrl(commit.sha, name)));

  const actionCsv = await sheet("Action");
  const categories = jobCategories(await sheet("ClassJobCategory"));
  const autos = autoAttackIds(actionCsv);
  console.log(`auto-attacks: ${autos.ids.length} actions, ${autos.unnamed} without a name`);
  writeJson("autoAttacks.json", { source: `${commit.sha} ${commit.message}`, ids: autos.ids });

  const statusCsv = await sheet("Status");
  const statuses = statusTable(statusCsv);
  const permanent = permanentStatusIds(statusCsv);
  const auras = auraStatusIds(statusCsv);
  const dots = damageOverTimeIds(statusCsv);
  const enablers = enablerStatusIds(actionCsv, await sheet("ActionProcStatus"));
  const unlisted = unlistedStatusIds(statusCsv);
  const icons = otherStatusIcons(statusCsv, new Set(statuses.rows.map(([id]) => id)), new Set([...unlisted.unshown, ...unlisted.fcBuffs]));
  console.log(
    `statuses with a damage effect: ${statuses.rows.length}`,
    statuses.counts,
    `permanent: ${permanent.length} (still running out: ${auras.length}), damage over time: ${dots.length}, enabling an action: ${enablers.length}, not shown in the game: ${unlisted.unshown.length}, free company buffs: ${unlisted.fcBuffs.length}, other statuses with an icon: ${icons.length}`,
  );
  writeJson("statuses.json", {
    source: `${commit.sha} ${commit.message}`,
    columns: ["id", "icon", "maxStacks", "kind", "scope", "byte"],
    rows: statuses.rows,
    permanent,
    auras,
    dots,
    enablers,
    unshown: unlisted.unshown,
    fcBuffs: unlisted.fcBuffs,
    icons,
  });

  // Every reduction's value, from the tooltips of the actions that grant it (docs/DESIGN.md 5.5).
  const kinds = new Map<number, "takenDown" | "dealtDown">();
  for (const [id, , , kind] of statuses.rows) if (kind === "takenDown" || kind === "dealtDown") kinds.set(id, kind);
  const transientCsv = await sheet("ActionTransient");
  const mitigation = mitigationFromTooltips(actionCsv, transientCsv, statusCsv, kinds, categories);
  const valued = Object.keys(mitigation.taken).length + Object.keys(mitigation.dealt).length;
  console.log(`reductions: ${valued} of ${kinds.size} valued by a tooltip; ${Object.keys(mitigation.conflicts).length} valued two ways (left to src/data/mitigation.ts)`, mitigation.conflicts);
  writeJson("mitigation.json", { source: `${commit.sha} ${commit.message}`, ...mitigation });

  // What each shield holds, from the tooltips of the actions that put it on (docs/DESIGN.md 5.6).
  const shields = new Set(statuses.rows.filter((r) => r[3] === "shield").map((r) => r[0]));
  const barriers = barriersFromTooltips(actionCsv, transientCsv, statusCsv, shields, categories);
  console.log(`shield sizes: ${Object.keys(barriers.byAction).length} actions; ${Object.keys(barriers.conflicts).length} sized two ways`, barriers.conflicts);
  writeJson("barriers.json", { source: `${commit.sha} ${commit.message}`, ...barriers });

  // Every job's mitigation skills, with recast, charges, level and upgrades (docs/DESIGN.md 8.2).
  const defensives = defensivesFromGameData({
    actionCsv,
    transientCsv,
    statusCsv,
    traitCsv: await sheet("Trait"),
    traitTransientCsv: await sheet("TraitTransient"),
    classJobActionUiCsv: await sheet("ClassJobActionUI"),
    kinds: new Map(statuses.rows.map((r) => [r[0], r[3]])),
    categories,
  });
  if (defensives.problems.length > 0) {
    throw new Error(`mitigation skills: ${defensives.problems.length} problem(s), nothing written:\n  ${defensives.problems.join("\n  ")}`);
  }
  console.log(`mitigation skills: ${Object.keys(defensives.actions).length} actions, ${Object.keys(defensives.sharedTimers).length} other actions sharing their timers`);
  writeJson("defensives.json", { source: `${commit.sha} ${commit.message}`, actions: defensives.actions, sharedTimers: defensives.sharedTimers });

  const catalog = zoneCatalog(await sheet("TerritoryType"), await sheet("ContentFinderCondition"), await sheet("ContentType"), await sheet("PlaceName"), await sheet("ExVersion"));
  console.log(`zones: ${catalog.zones.length}, ${catalog.zones.filter((z) => z[2]).length} of them duties`);
  writeJson("zones.json", { source: `${commit.sha} ${commit.message}`, columns: ["id", "name", "contentType", "intendedUse", "exVersion", "sortKey"], ...catalog });

  // cactbot's hand annotations: auto-attacks in its timelines, death reasons in its oopsy files.
  const cb = await resolveCactbotCommit(arg("--cactbot") ?? "main");
  console.log(`cactbot ${cb.sha.slice(0, 12)}  ${cb.date}`);
  const cbCache = new Cache(join(root, "node_modules/.cache/cactbot", cb.sha.slice(0, 12)));
  const cbFile = (path: string) => cbCache.text(path.replace(/[\/]/g, "__"), () => fetchText(cactbotUrl(cb.sha, path)));
  const paths = await cactbotFiles(cb.sha);
  const timelines = paths.filter((p) => p.startsWith("ui/raidboss/data/") && p.endsWith(".txt"));
  const oopsy = paths.filter((p) => p.startsWith("ui/oopsyraidsy/data/") && p.endsWith(".ts"));
  const autoAttacks = new Set<number>();
  for (const p of timelines) for (const id of timelineAutoAttacks(await cbFile(p))) autoAttacks.add(id);
  const zones = zoneIds(await cbFile("resources/zone_id.ts"));
  const deathReasons = [];
  for (const p of oopsy) deathReasons.push(...oopsyDeathReasons(await cbFile(p), zones));
  console.log(`cactbot: ${autoAttacks.size} auto-attacks from ${timelines.length} timelines; ${deathReasons.length} death reasons from ${oopsy.length} oopsy files`);
  writeJson("cactbot.json", { source: `${cb.sha} ${cb.date}`, autoAttacks: [...autoAttacks].sort((a, b) => a - b), deathReasons });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
