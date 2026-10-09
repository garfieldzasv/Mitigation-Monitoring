/** Something HpChart marks on the time axis under the curve. */
export interface ChartMark {
  key: string;
  time: number;
  kind: "hit" | "heal" | "cast" | "death";
  /** Bar height as a share of max HP: damage for hits, effective healing for heals. */
  share: number;
  /** Heals: overheal share, drawn lighter on top of the bar. */
  extra?: number;
  label: string;
}
