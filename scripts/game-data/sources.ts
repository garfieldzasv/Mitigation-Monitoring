/**
 * Download layer for the game-data import (adapted from Skills Monitoring). The source is
 * thewakingsands/ffxiv-datamining-cn: SaintCoinach CSV exports of the Chinese client. Its CSV
 * headers are not trusted: columns are read by raw index. Every download is pinned to a git commit
 * and cached on disk, so re-running the import is cheap and reproducible.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CN_REPO = "thewakingsands/ffxiv-datamining-cn";

export class Cache {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async text(name: string, load: () => Promise<string>): Promise<string> {
    const file = join(this.dir, name);
    if (existsSync(file)) return readFileSync(file, "utf8");
    const text = await load();
    writeFileSync(file, text, "utf8");
    return text;
  }
}

export async function fetchText(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": "mitigation-monitoring-import" } });
    if (res.ok) return res.text();
    if (attempt >= 5 || (res.status !== 429 && res.status < 500)) {
      throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

export interface CnCommit {
  sha: string;
  message: string;
}

export async function resolveCnCommit(ref: string): Promise<CnCommit> {
  const c = JSON.parse(await fetchText(`https://api.github.com/repos/${CN_REPO}/commits/${ref}`)) as {
    sha: string;
    commit: { message: string };
  };
  return { sha: c.sha, message: c.commit.message.split("\n")[0]! };
}

export function cnCsvUrl(sha: string, sheet: string): string {
  return `https://raw.githubusercontent.com/${CN_REPO}/${sha}/${sheet}.csv`;
}

/** Minimal RFC 4180 parser: quoted fields may contain commas, quotes ("") and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * SaintCoinach CSV → row id → raw columns. Lines 1-3 are the raw column indexes, the (possibly
 * stale) column names and types; data starts at line 4. `cells[0]` is the row id, so raw column
 * `n` (as numbered on line 1) is `cells[n + 1]`.
 */
export function cnRows(csv: string): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const cells of parseCsv(csv).slice(3)) {
    if (cells[0] === "" || cells[0] === undefined) continue;
    map.set(Number(cells[0]), cells);
  }
  return map;
}
