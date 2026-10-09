import type { LogBatches } from "./logImport";

/** Bytes read at a time: a Network log is 50~160 MB, and one slice's lines go through the engine in one go. */
const SLICE_BYTES = 4 << 20;

/**
 * A log file's lines in batches, one per slice of the file (docs/DESIGN.md 9.5): never read whole, UTF-8 decoded across
 * slice boundaries, each line split on "|" (its trailing hash is the archive codec's to drop). Each pass reports how
 * far it has read.
 */
export function blobBatches(blob: Blob, onProgress?: (read: number, total: number) => void, sliceBytes = SLICE_BYTES): LogBatches {
  return async function* () {
    const decoder = new TextDecoder("utf-8");
    let rest = "";
    for (let at = 0; at < blob.size; at += sliceBytes) {
      const lines = (rest + decoder.decode(await blob.slice(at, at + sliceBytes).arrayBuffer(), { stream: true })).split("\n");
      rest = lines.pop() ?? "";
      onProgress?.(Math.min(blob.size, at + sliceBytes), blob.size);
      yield split(lines);
    }
    const tail = rest + decoder.decode();
    if (tail) yield split([tail]);
  };
}

const split = (lines: readonly string[]) =>
  lines
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .filter((l) => l.length > 0)
    .map((l) => l.split("|"));
