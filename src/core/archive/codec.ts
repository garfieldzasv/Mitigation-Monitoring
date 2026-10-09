import { isPlayerId } from "../combatants/registry";
/**
 * Raw log lines ⇄ stored chunks. Lines are joined with "|" and "\n" and gzipped with
 * CompressionStream (available in ACT's CEF, docs/DESIGN.md 11.2); without it they are stored as
 * plain text, which decoding tells apart by the gzip magic bytes.
 */

import { LineType, StatusListField } from "../logline/fields";

/** A raw OverlayPlugin line ends with a 16-hex-digit hash nobody reads; dropping it saves ~17 bytes a line. */
export function withoutHash(line: readonly string[]): readonly string[] {
  const last = line[line.length - 1];
  return last !== undefined && /^[0-9a-f]{16}$/.test(last) ? line.slice(0, -1) : line;
}

/**
 * The form a raw line is archived in, or undefined when it is not archived. 38 lines are the bulk of
 * a raid's log (about 2.7× the 37 lines) and only their HP and shield are read, for players: those
 * are kept up to the shield field (docs/DESIGN.md 5.6).
 */
export function archivedForm(line: readonly string[]): readonly string[] | undefined {
  if (line[0] === LineType.StatusList)
    return isPlayerId(line[StatusListField.targetId] ?? "") ? line.slice(0, StatusListField.shieldPercent + 1) : undefined;
  return line;
}

export async function encodeLines(lines: readonly (readonly string[])[]): Promise<Blob> {
  const text = new Blob([lines.map((l) => l.join("|")).join("\n")]);
  if (typeof CompressionStream === "undefined") return text;
  return new Response(text.stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

async function decodeOne(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }
  return blob.text();
}

export async function decodeLines(chunks: readonly Blob[]): Promise<string[][]> {
  const lines: string[][] = [];
  for (const chunk of chunks) {
    const text = await decodeOne(chunk);
    if (!text) continue;
    for (const l of text.split("\n")) if (l) lines.push(l.split("|"));
  }
  return lines;
}
