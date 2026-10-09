/**
 * A value that may change with character level: a constant, or breakpoints `[[minLevel, value], ...]` in ascending
 * level, the last one at or below the level applying (as in Skills Monitoring).
 */
export type LevelValue = number | readonly (readonly [minLevel: number, value: number])[];

export const MAX_LEVEL = 100;

export function evalLevelValue(value: LevelValue, level: number): number {
  if (typeof value === "number") return value;
  let result = value[0]?.[1] ?? 0;
  for (const [minLevel, v] of value) {
    if (level >= minLevel) result = v;
    else break;
  }
  return result;
}

/** Per-level samples (index 0 = level 1) → the smallest equivalent LevelValue. */
export function compressLevelSamples(samples: readonly number[]): LevelValue {
  const points: [number, number][] = [];
  samples.forEach((v, i) => {
    if (points.length === 0 || points[points.length - 1]![1] !== v) points.push([i + 1, v]);
  });
  return points.length === 1 ? points[0]![1] : points;
}
