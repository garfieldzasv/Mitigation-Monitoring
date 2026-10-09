/**
 * What cactbot's authors annotated by hand (docs/DESIGN.md 9.4), read from OverlayPlugin/cactbot at a pinned commit:
 *
 * - **Auto-attacks** in the raidboss timelines (ui/raidboss/data/**.txt). Many bosses auto-attack with an action the
 *   game data does not mark (ActionCategory is not 1, no name: ACT logs \`unknown_b25e\`); the timeline authors note
 *   them: an entry named \`--auto--\` or \`Attack\`, or a comment \`# B25E --sync--: Autoattack\`, \`# A4EE Attack (Howling
 *   Blade)\`, \`# 368 attack\`. A note that doubts it (\`?\`, "related", "timing") or a self-cast does not count.
 * - **Death reasons** in the oopsy files (ui/oopsyraidsy/data/**.ts): a trigger with a \`deathReason\` names the
 *   ability (or the status gained) after which a player's death is that reason, unless damage came after it
 *   (oopsy's death report). Kept: those of an Ability or GainsEffect trigger, by zone, with their text; "Knocked
 *   off" / "Pushed off" / "Slid off" are falls, "… into wall" the arena's edge.
 */
import ts from "typescript";
import { fetchText } from "./sources";

const REPO = "OverlayPlugin/cactbot";

export interface CactbotCommit {
  sha: string;
  date: string;
}

export async function resolveCactbotCommit(ref: string): Promise<CactbotCommit> {
  const c = JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/commits/${ref}`)) as { sha: string; commit: { committer: { date: string } } };
  return { sha: c.sha, date: c.commit.committer.date };
}

export async function cactbotFiles(sha: string): Promise<string[]> {
  const tree = JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/git/trees/${sha}?recursive=1`)) as { tree: { path: string; type: string }[] };
  return tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
}

export const cactbotUrl = (sha: string, path: string) => `https://raw.githubusercontent.com/${REPO}/${sha}/${path}`;

/** IDs of hex form as cactbot writes them (\`368\`, \`B25E\`). */
const HEX = /^[0-9A-F]{2,5}$/;

/** An entry the timeline names as an auto-attack: \`"--auto--"\` or \`"Attack"\`, with its ability ID(s), commented out or not. */
const ENTRY = /^\s*[\d.]+\s+"(?:--auto--|Attack|attack)"\s+#?\s*Ability\s*\{\s*id:\s*(?:"([0-9A-F]+)"|\[([^\]]*)\])/;
/** A comment that starts with an ability ID: \`# B25E --sync--: Autoattack\`. */
const COMMENT = /^\s*#\s*([0-9A-F]{2,5})\b\s*(?:--sync--)?\s*[-:–\s]*(.*)$/;
const LABEL_STARTS_ATTACK = /^(?:attack|攻撃|攻击)\b/i;
const LABEL_SAYS_AUTO = /\bauto[- ]?attacks?\b|\bautoattacks?\b|\bautos\b|\[auto-attack\]/i;
const LABEL_DOUBTS = /\?|related|timing|self-cast/i;

/** Ability IDs a timeline annotates as auto-attacks. */
export function timelineAutoAttacks(text: string): number[] {
  const ids = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const entry = ENTRY.exec(line);
    if (entry) {
      const list = entry[1] ? [entry[1]] : (entry[2] ?? "").split(",").map((s) => s.trim().replace(/"/g, ""));
      for (const id of list) if (HEX.test(id)) ids.add(Number.parseInt(id, 16));
      continue;
    }
    const comment = COMMENT.exec(line);
    if (!comment) continue;
    const label = comment[2]!.trim();
    if (LABEL_DOUBTS.test(label)) continue;
    if (LABEL_STARTS_ATTACK.test(label) || LABEL_SAYS_AUTO.test(label)) ids.add(Number.parseInt(comment[1]!, 16));
  }
  return [...ids];
}

export type DeathReasonKind = "fall" | "wall" | "other";

export interface CactbotDeathReason {
  /** The zones of the oopsy file. */
  zones: number[];
  /** What sets it on the player: hit by one of these abilities, or gaining one of these statuses. */
  on: "ability" | "status";
  ids: number[];
  kind: DeathReasonKind;
  /** The annotation's text, Chinese when it has one. */
  text: string;
}

const kindOf = (en: string): DeathReasonKind => (/into (?:a |the )?wall/i.test(en) ? "wall" : /knocked off|pushed off|slid off|fell off|fall/i.test(en) ? "fall" : "other");

/** \`ZoneId.X\` → number, from resources/zone_id.ts. */
export function zoneIds(zoneIdTs: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of zoneIdTs.matchAll(/^\s*'?([A-Za-z0-9_]+)'?:\s*(\d+),/gm)) out.set(m[1]!, Number(m[2]));
  return out;
}

/** The death reasons one oopsy file annotates. */
export function oopsyDeathReasons(source: string, zones: ReadonlyMap<string, number>): CactbotDeathReason[] {
  const file = ts.createSourceFile("oopsy.ts", source, ts.ScriptTarget.Latest, true);
  // Local helpers that build a reason (p8s: const wallDeathReason = () => …): their text, by name.
  const helpers = new Map<string, { en?: string; cn?: string }>();
  file.forEachChild(function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const t = textOf(node.initializer);
      if (t.en) helpers.set(node.name.text, t);
    }
    node.forEachChild(visit);
  });
  let fileZones: number[] = [];
  const out: CactbotDeathReason[] = [];
  file.forEachChild(function visit(node) {
    if (ts.isPropertyAssignment(node) && propName(node) === "zoneId") {
      const list = ts.isArrayLiteralExpression(node.initializer) ? [...node.initializer.elements] : [node.initializer];
      fileZones = list.flatMap((e) => (ts.isPropertyAccessExpression(e) && zones.has(e.name.text) ? [zones.get(e.name.text)!] : []));
    }
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map(node.properties.filter(ts.isPropertyAssignment).map((p) => [propName(p), p.initializer] as const));
      const reason = props.get("deathReason") ?? node.properties.find((p) => ts.isMethodDeclaration(p) && propName(p) === "deathReason");
      const type = props.get("type");
      const netRegex = props.get("netRegex");
      if (reason && type && ts.isStringLiteral(type) && netRegex && fileZones.length > 0) {
        const on = type.text === "Ability" ? "ability" : type.text === "GainsEffect" ? "status" : undefined;
        let t = textOf(reason);
        if (!t.en && ts.isCallExpression(reason) && ts.isIdentifier(reason.expression)) t = helpers.get(reason.expression.text) ?? t;
        const ids = idsOf(netRegex, on === "status" ? "effectId" : "id");
        if (on && t.en && ids.length > 0) out.push({ zones: fileZones, on, ids, kind: kindOf(t.en), text: t.cn ?? t.en });
      }
    }
    node.forEachChild(visit);
  });
  return out;
}

function propName(p: ts.ObjectLiteralElementLike): string {
  return p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "";
}

/** The first \`text: { en, cn }\` inside a node. */
function textOf(node: ts.Node): { en?: string; cn?: string } {
  let found: { en?: string; cn?: string } | undefined;
  node.forEachChild(function visit(n) {
    if (found) return;
    if (ts.isPropertyAssignment(n) && propName(n) === "text" && ts.isObjectLiteralExpression(n.initializer)) {
      const t: { en?: string; cn?: string } = {};
      for (const p of n.initializer.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isStringLiteralLike(p.initializer)) continue;
        if (propName(p) === "en") t.en = p.initializer.text;
        if (propName(p) === "cn") t.cn = p.initializer.text;
      }
      if (t.en) found = t;
      return;
    }
    n.forEachChild(visit);
  });
  return found ?? {};
}

/** Hex IDs of a netRegex (\`NetRegexes.ability({ id: '82A' })\` or \`{ id: ['9CC2', …] }\`), under \`key\`. */
function idsOf(netRegex: ts.Expression, key: string): number[] {
  const literal = ts.isCallExpression(netRegex) ? netRegex.arguments[0] : netRegex;
  if (!literal || !ts.isObjectLiteralExpression(literal)) return [];
  const ids: number[] = [];
  for (const p of literal.properties) {
    if (!ts.isPropertyAssignment(p) || propName(p) !== key) continue;
    const values = ts.isArrayLiteralExpression(p.initializer) ? p.initializer.elements : [p.initializer];
    for (const v of values) if (ts.isStringLiteralLike(v) && HEX.test(v.text.toUpperCase())) ids.push(Number.parseInt(v.text, 16));
  }
  return ids;
}
