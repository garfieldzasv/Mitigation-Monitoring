import { zonePath, zoneTree, type ZoneNode } from "../game/zones";

/**
 * Which zones' fights are not archived (docs/DESIGN.md 6.2): a set of zone-tree keys (core/game/zones.ts). A key skips
 * everything under it, so a category stays skipped for duties added to it later. Keys the tree does not have (from
 * another game-data version) are kept and do nothing.
 */

/** A node's checkbox: on (it or a node above it is skipped), some (something under it is), off. */
export type CheckState = "on" | "some" | "off";

/** Whether a zone's fights are skipped: its node or one above it is. A zone missing from the game data never is. */
export function zoneSkipped(skip: readonly string[], zoneId: number): boolean {
  return skip.length > 0 && zonePath(zoneId).some((k) => skip.includes(k));
}

/** Every node's checkbox state, by key. */
export function nodeStates(skip: readonly string[], tree: readonly ZoneNode[] = zoneTree()): Map<string, CheckState> {
  const set = new Set(skip);
  const states = new Map<string, CheckState>();
  const visit = (node: ZoneNode, above: boolean): CheckState => {
    const on = above || set.has(node.key);
    let state: CheckState = on ? "on" : "off";
    const children = node.children?.map((c) => visit(c, on)) ?? [];
    if (!on && children.some((c) => c !== "off")) state = children.every((c) => c === "on") ? "on" : "some";
    states.set(node.key, state);
    return state;
  };
  for (const n of tree) visit(n, false);
  return states;
}

interface Index {
  parent: Map<string, string | undefined>;
  children: Map<string, readonly ZoneNode[]>;
}

function indexOf(tree: readonly ZoneNode[]): Index {
  const parent = new Map<string, string | undefined>();
  const children = new Map<string, readonly ZoneNode[]>();
  const walk = (nodes: readonly ZoneNode[], up: string | undefined) => {
    for (const n of nodes) {
      parent.set(n.key, up);
      children.set(n.key, n.children ?? []);
      walk(n.children ?? [], n.key);
    }
  };
  walk(tree, undefined);
  return { parent, children };
}

/**
 * Checks (`on`: skip) or unchecks a node; returns the new keys. Checking drops the keys under it, and a parent whose
 * children are then all checked takes their place. Unchecking a node checked through a node above it checks that
 * node's other children instead, down the way to it.
 */
export function setSkipped(skip: readonly string[], key: string, on: boolean, tree: readonly ZoneNode[] = zoneTree()): string[] {
  const idx = indexOf(tree);
  if (!idx.parent.has(key)) return [...skip];
  const set = new Set(skip);
  const under = (k: string): string[] => (idx.children.get(k) ?? []).flatMap((c) => [c.key, ...under(c.key)]);
  for (const k of under(key)) set.delete(k);
  const path: string[] = [];
  for (let k: string | undefined = key; k !== undefined; k = idx.parent.get(k)) path.unshift(k);
  if (on) {
    set.add(key);
    for (let i = path.length - 2; i >= 0; i--) {
      const siblings = idx.children.get(path[i]!)!;
      if (!siblings.every((c) => set.has(c.key))) break;
      for (const c of siblings) set.delete(c.key);
      set.add(path[i]!);
    }
  } else {
    set.delete(key);
    const top = path.findIndex((k, i) => i < path.length - 1 && set.has(k));
    if (top >= 0) {
      set.delete(path[top]!);
      for (let i = top; i < path.length - 1; i++) for (const c of idx.children.get(path[i]!)!) if (c.key !== path[i + 1]) set.add(c.key);
    }
  }
  return [...skip.filter((k) => set.has(k)), ...[...set].filter((k) => !skip.includes(k))];
}
