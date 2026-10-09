import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Engine } from "@/core/engine/engine";

/** Lines of a fixture made by scripts/make-fixture.ts, each split on "|". */
export function loadFixture(name: string): string[][] {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return gunzipSync(readFileSync(path))
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("|"));
}

/** Feeds a whole fixture into an engine; the party comes from 11 lines, the player from 02 lines. */
export function runFixture(lines: readonly (readonly string[])[]): Engine {
  const engine = new Engine();
  for (const line of lines) engine.feed(line);
  return engine;
}
