export type JobRole = "tank" | "healer" | "melee" | "ranged" | "caster";

/** Sort groups used by the in-game party list: melee, ranged and caster all count as DPS. */
export type RoleGroup = "tank" | "healer" | "dps";

export const ROLE_GROUPS: readonly RoleGroup[] = ["tank", "healer", "dps"];

export interface JobInfo {
  id: number;
  abbr: string;
  name: string;
  role: JobRole;
  /** For base classes: the job they advance into (GLA → PLD). */
  advancedJob?: number;
}

/**
 * Supported combat jobs and classes. Blue Mage (36) and Beastmaster (43) are intentionally
 * absent: members with unknown jobs still occupy a row but show no skills.
 */
const JOB_LIST: readonly JobInfo[] = [
  { id: 1, abbr: "GLA", name: "剑术师", role: "tank", advancedJob: 19 },
  { id: 2, abbr: "PGL", name: "格斗家", role: "melee", advancedJob: 20 },
  { id: 3, abbr: "MRD", name: "斧术师", role: "tank", advancedJob: 21 },
  { id: 4, abbr: "LNC", name: "枪术师", role: "melee", advancedJob: 22 },
  { id: 5, abbr: "ARC", name: "弓箭手", role: "ranged", advancedJob: 23 },
  { id: 6, abbr: "CNJ", name: "幻术师", role: "healer", advancedJob: 24 },
  { id: 7, abbr: "THM", name: "咒术师", role: "caster", advancedJob: 25 },
  { id: 26, abbr: "ACN", name: "秘术师", role: "caster", advancedJob: 27 },
  { id: 29, abbr: "ROG", name: "双剑师", role: "melee", advancedJob: 30 },
  { id: 19, abbr: "PLD", name: "骑士", role: "tank" },
  { id: 21, abbr: "WAR", name: "战士", role: "tank" },
  { id: 32, abbr: "DRK", name: "暗黑骑士", role: "tank" },
  { id: 37, abbr: "GNB", name: "绝枪战士", role: "tank" },
  { id: 24, abbr: "WHM", name: "白魔法师", role: "healer" },
  { id: 28, abbr: "SCH", name: "学者", role: "healer" },
  { id: 33, abbr: "AST", name: "占星术士", role: "healer" },
  { id: 40, abbr: "SGE", name: "贤者", role: "healer" },
  { id: 20, abbr: "MNK", name: "武僧", role: "melee" },
  { id: 22, abbr: "DRG", name: "龙骑士", role: "melee" },
  { id: 30, abbr: "NIN", name: "忍者", role: "melee" },
  { id: 34, abbr: "SAM", name: "武士", role: "melee" },
  { id: 39, abbr: "RPR", name: "钐镰客", role: "melee" },
  { id: 41, abbr: "VPR", name: "蝰蛇剑士", role: "melee" },
  { id: 23, abbr: "BRD", name: "吟游诗人", role: "ranged" },
  { id: 31, abbr: "MCH", name: "机工士", role: "ranged" },
  { id: 38, abbr: "DNC", name: "舞者", role: "ranged" },
  { id: 25, abbr: "BLM", name: "黑魔法师", role: "caster" },
  { id: 27, abbr: "SMN", name: "召唤师", role: "caster" },
  { id: 35, abbr: "RDM", name: "赤魔法师", role: "caster" },
  { id: 42, abbr: "PCT", name: "绘灵法师", role: "caster" },
];

const JOBS_BY_ID = new Map<number, JobInfo>(JOB_LIST.map((j) => [j.id, j]));

/** Advanced jobs in the in-game default party list order. */
export const ADVANCED_JOB_IDS: readonly number[] = JOB_LIST.filter((j) => !j.advancedJob).map(
  (j) => j.id,
);

export const ALL_JOB_IDS: readonly number[] = JOB_LIST.map((j) => j.id);

export function getJob(id: number): JobInfo | undefined {
  return JOBS_BY_ID.get(id);
}

/** Maps a base class to its advanced job; advanced jobs and unknown IDs map to themselves. */
export function toAdvancedJob(id: number): number {
  return JOBS_BY_ID.get(id)?.advancedJob ?? id;
}

/** Melee, ranged and caster all sort as DPS in the party list. */
export function getRoleGroup(jobId: number): RoleGroup | undefined {
  const role = JOBS_BY_ID.get(jobId)?.role;
  if (!role) return undefined;
  return role === "tank" || role === "healer" ? role : "dps";
}

/** In-game job icons are 062100 + ClassJob ID. */
export function jobIconId(jobId: number): number {
  return 62100 + jobId;
}
