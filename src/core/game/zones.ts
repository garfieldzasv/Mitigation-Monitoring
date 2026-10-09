import catalog from "@/data/generated/zones.json";

/**
 * The zones as the settings list them (docs/DESIGN.md 6.2, 9.4), a tree: 副本, 野外地图, 特殊场景, each down to a duty or
 * a zone. Built from the game data (scripts/import-game-data.ts zoneCatalog): a duty's category is the game's own
 * (ContentFinderCondition → ContentType), any other zone's what it is for (TerritoryIntendedUse, named by
 * FFXIVClientStructs' enum). Places where no fight happens (towns, inns, housing…) are left out of the tree; a zone
 * missing from the game data (newer than it) is in no node either.
 */
export interface ZoneNode {
  /** Unique, stable across game-data updates: a category, an expansion within it, a duty or zone (`z:<first id>`). */
  key: string;
  label: string;
  /** Duties or zones under it. */
  count: number;
  children?: ZoneNode[];
  /** What a node without its zones listed covers. */
  note?: string;
}

type Row = [id: number, name: string, contentType: number, intendedUse: number, exVersion: number, sortKey: number];
const ZONES = catalog.zones as Row[];
const TYPE_NAMES: Readonly<Record<string, string>> = catalog.contentTypes;
const VERSIONS: readonly string[] = catalog.versions;

/** 副本: group fights the tool is for (docs/DESIGN.md 1.3), in this order: 迷宫挑战, 讨伐歼灭战, 大型任务, 绝境战, 诛灭战, 特殊迷宫探索. */
const DUTY_TYPES = [2, 4, 5, 28, 37, 30];
/** TerritoryIntendedUse 1: Overworld. */
const OVERWORLD = 1;
/** 特殊场景 first: the field operations (禁地优雷卡, 天佑女王, 新月岛), 深层迷宫, 寻宝, 对战; then the other content types. */
const SPECIAL_FIRST = [26, 29, 38, 21, 9, 6];
/** Zones without a duty that belong with a content type: 对战 (CrystallineConflict 28 and its custom match 37), 深层迷宫 (DeepDungeon 31). */
const USE_AS_TYPE: Readonly<Record<number, number>> = { 28: 6, 37: 6, 31: 21 };
/**
 * Places where no fight happens, by what they are for (TerritoryIntendedUse, FFXIVClientStructs' names): Town 0, Inn 2,
 * MordionGaol 5, WaitingRoom 12, HousingOutdoor 13, HousingIndoor 14, ChocoboRacing 20, Firmament 21,
 * SanctumOfTheTwelve 22 (weddings), GoldSaucer 23, LordOfVerminion 25, GrandCompanyBarracks 30, TripleTriadBattlehall
 * 35, LeapOfFaith 44, OceanFishing 46, IslandSanctuary 49, TripleTriadOpenTournament 50, TripleTriadInvitationalParlor
 * 51, Blunderville 59, CosmicExploration 60. Left out of the tree, never archived. Uses the names leave in doubt (solo
 * quest instances, seasonal areas…) stay in.
 */
const NO_COMBAT_USES: ReadonlySet<number> = new Set([0, 2, 5, 12, 13, 14, 20, 21, 22, 23, 25, 30, 35, 44, 46, 49, 50, 51, 59, 60]);
/** Duties of the gatherers and crafters, by their content type: 16 大地使者 (ocean fishing, 天上福地云冠群岛), 17 能工巧匠. Left out as well. */
const NO_COMBAT_TYPES: ReadonlySet<number> = new Set([16, 17]);
/** A group lists its duties by expansion when it has more than this many. */
const BY_VERSION_OVER = 10;

interface Leaf {
  label: string;
  zones: number[];
  version: number;
  sort: number;
}

/** Leaves of one group: zones of the same name together (a duty's or a place's several territories). */
function leavesOf(rows: readonly Row[]): Leaf[] {
  const byName = new Map<string, Leaf>();
  for (const [id, name, type, , version, sortKey] of rows) {
    const leaf = byName.get(name);
    if (leaf) leaf.zones.push(id);
    else byName.set(name, { label: name, zones: [id], version, sort: type ? sortKey : id });
  }
  return [...byName.values()].sort((a, b) => a.version - b.version || a.sort - b.sort || a.zones[0]! - b.zones[0]!);
}

const leafNode = (leaf: Leaf): ZoneNode => ({ key: `z:${leaf.zones[0]}`, label: leaf.label, count: 1 });

/** A group of duties or zones; by expansion when long. */
function group(key: string, label: string, rows: readonly Row[]): ZoneNode {
  const leaves = leavesOf(rows);
  const versions = [...new Set(leaves.map((l) => l.version))];
  const children =
    leaves.length > BY_VERSION_OVER && versions.length > 1
      ? versions.map((v) => {
          const mine = leaves.filter((l) => l.version === v);
          return { key: `${key}:v${v}`, label: VERSIONS[v] ?? `版本 ${v}`, count: mine.length, children: mine.map(leafNode) };
        })
      : leaves.map(leafNode);
  return { key, label, count: leaves.length, children };
}

interface Built {
  tree: ZoneNode[];
  /** Each zone's node keys, from its root category down to its own node. */
  paths: Map<number, string[]>;
  /** Zones where no fight happens: in no node. */
  noCombat: Set<number>;
}

function build(): Built {
  const dutyRows = new Map<number, Row[]>();
  const specialRows = new Map<number, Row[]>();
  const noCombat = new Set<number>();
  const overworld: Row[] = [];
  const unnamed: Row[] = [];
  const other: Row[] = [];
  const push = <K>(map: Map<K, Row[]>, key: K, row: Row) => {
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  };
  for (const row of ZONES) {
    const [id, , type, use] = row;
    if (NO_COMBAT_USES.has(use) || NO_COMBAT_TYPES.has(type)) {
      noCombat.add(id);
      continue;
    }
    const asType = type || USE_AS_TYPE[use] || 0;
    if (DUTY_TYPES.includes(asType)) push(dutyRows, asType, row);
    else if (asType && TYPE_NAMES[asType]) push(specialRows, asType, row);
    else if (asType) unnamed.push(row);
    else if (use === OVERWORLD) overworld.push(row);
    else other.push(row);
  }

  const duties = DUTY_TYPES.filter((t) => dutyRows.has(t)).map((t) => group(`duty:t${t}`, TYPE_NAMES[t] ?? `类型 ${t}`, dutyRows.get(t)!));
  const specialTypes = [...specialRows.keys()].sort((a, b) => rank(a) - rank(b) || a - b);
  const special: ZoneNode[] = [
    ...specialTypes.map((t) => group(`special:t${t}`, TYPE_NAMES[t]!, specialRows.get(t)!)),
    ...(unnamed.length ? [group("special:content", "其他内容", unnamed)] : []),
    { key: "special:other", label: "其他区域", count: leavesOf(other).length, note: "任务场景、单人任务、季节活动等" },
  ];
  const roots: ZoneNode[] = [
    { key: "duty", label: "副本", count: sum(duties), children: duties },
    { ...group("field", "野外地图", overworld) },
    { key: "special", label: "特殊场景", count: sum(special), children: special },
  ];

  const paths = new Map<number, string[]>();
  const leafZones = new Map<string, number[]>();
  for (const rows of [...dutyRows.values(), ...specialRows.values(), overworld, unnamed]) {
    for (const leaf of leavesOf(rows)) leafZones.set(`z:${leaf.zones[0]}`, leaf.zones);
  }
  const walk = (nodes: readonly ZoneNode[], above: string[]) => {
    for (const n of nodes) {
      const path = [...above, n.key];
      if (n.children) walk(n.children, path);
      else for (const id of leafZones.get(n.key) ?? []) paths.set(id, path);
    }
  };
  walk(roots, []);
  for (const [id] of other) paths.set(id, ["special", "special:other"]);
  return { tree: roots, paths, noCombat };
}

function rank(type: number): number {
  const i = SPECIAL_FIRST.indexOf(type);
  return i < 0 ? SPECIAL_FIRST.length : i;
}

const sum = (nodes: readonly ZoneNode[]) => nodes.reduce((s, n) => s + n.count, 0);

let built: Built | undefined;
const data = () => (built ??= build());

/** The zone tree: 副本, 野外地图, 特殊场景. */
export function zoneTree(): readonly ZoneNode[] {
  return data().tree;
}

/** Whether no fight happens in this zone (a town, an inn, housing…): it is in no node and never archived. */
export function isNoCombatZone(zoneId: number): boolean {
  return data().noCombat.has(zoneId);
}

/** The keys of the nodes a zone is under, root first, its own last; empty for a zone the game data does not have, or where no fight happens. */
export function zonePath(zoneId: number): readonly string[] {
  return data().paths.get(zoneId) ?? [];
}
