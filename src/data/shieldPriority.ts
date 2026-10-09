/**
 * The order barriers absorb damage in, first to last (docs/DESIGN.md 5.6).
 *
 * Source: Himenyan Biwaco, 「075.バリア消費の優先度 - Barrier consumption priority」, The Lodestone, 2025-09-18,
 * patch 7.31 (https://jp.finalfantasyxiv.com/lodestone/character/34801907/blog/5607030/). Tested in game: two
 * barriers put on at once under an unmitigable DoT (天獄編2層 unsynced), the one that breaks first ranks higher,
 * pairs ordered by bisection; which was put on first, and whose barrier it is, did not change the order. Earlier,
 * Omochi Kinako (2022-01) found ブラックナイト > ハイマ > パンハイマ whatever the order or size.
 *
 * A barrier is told by its status name (as the source does): every status ID with that name in the game data has
 * its rank (the IDs below: the global client's Japanese Status sheet, matched by name). Same rank: barriers that
 * cannot be on one player together (self-only ones of different jobs). The source's list was transcribed by
 * consolegameswiki "Barrier" with 激励 and 鼓舞 swapped; this follows the source (激励 23, 鼓舞 25).
 *
 * 守护纹 below level 84 ranks 11 (consolegameswiki "Barrier": its rank changes with the level-84 trait アルケイン
 * クレスト効果アップ; the source left the lower-level barrier out). Barriers neither source names (duty mechanics,
 * field content such as Occult Crescent, Blue Mage, PvP, removed actions) have no known rank: they come after
 * all of these, in the order they were put on.
 */
interface Barrier {
  rank: number;
  /** CN status name / the source's Japanese name. */
  name: string;
  ids: readonly number[];
  /** Below this level the barrier ranks `lowerRank` instead. */
  fromLevel?: number;
  lowerRank?: number;
}

export const BARRIER_PRIORITY: readonly Barrier[] = [
  { rank: 1, name: "坦培拉涂层 / テンペラコート", ids: [3686, 4114] },
  { rank: 1, name: "守护纹 / 守護のクレスト", ids: [2596, 2597, 2861], fromLevel: 84, lowerRank: 11 },
  { rank: 2, name: "油性坦培拉涂层 / テンペラグラッサ", ids: [3687, 4115] },
  { rank: 3, name: "至黑之夜 / ブラックナイト", ids: [1178, 1308] },
  { rank: 4, name: "均衡诊断 / エウクラシア・ディアグノシス", ids: [2607, 2865, 3109] },
  { rank: 5, name: "输血 / ハイマ", ids: [2612, 2869, 3110] },
  { rank: 6, name: "泛输血 / パンハイマ", ids: [2613] },
  { rank: 7, name: "残暴弹 / ブルータルシェル", ids: [1898, 1997] },
  { rank: 8, name: "原初的血烟 / 原初の血煙", ids: [2680, 3031] },
  { rank: 9, name: "极致护盾 / エクストリームガード［バリア］", ids: [3830] },
  { rank: 10, name: "神爱抚 / ディヴァインカレス［バリア］", ids: [3903] },
  { rank: 11, name: "魔罩 / マバリア", ids: [168] },
  { rank: 11, name: "残影 / 残影", ids: [488, 2011] },
  { rank: 12, name: "神祝祷 / ディヴァインベニゾン", ids: [1218, 1404] },
  { rank: 13, name: "天星交错 / 星天交差", ids: [1889, 4040] },
  { rank: 14, name: "建筑神之塔 / ビエルゴの塔", ids: [3892] },
  { rank: 15, name: "均衡预后 / エウクラシア・プログノシス", ids: [2609, 2866] },
  { rank: 16, name: "炽天的幕帘 / セラフィックヴェール", ids: [1917, 2040, 3097] },
  { rank: 17, name: "整体盾 / ホーリズム［バリア］", ids: [3365] },
  { rank: 18, name: "守护之光 / 守りの光", ids: [2702, 3224] },
  { rank: 19, name: "摆脱 / シェイクオフ", ids: [1457, 1993] },
  { rank: 20, name: "圣光幕帘 / ディヴァインヴェール", ids: [1362, 2168] },
  { rank: 21, name: "中间学派 / ニュートラルセクト", ids: [1921, 3988] },
  { rank: 22, name: "即兴表演结束 / インプロビゼーション・フィニッシュ", ids: [2697] },
  { rank: 23, name: "激励 / 激励", ids: [1918] },
  { rank: 24, name: "齐衡诊断 / エウクラシア・ディアグノシス［強］", ids: [2608] },
  { rank: 25, name: "鼓舞 / 鼓舞", ids: [297, 1331, 3087] },
];

/** After every ranked barrier: one neither source names. */
export const UNRANKED_BARRIER = 100;

const BY_ID: ReadonlyMap<number, Barrier> = new Map(BARRIER_PRIORITY.flatMap((b) => b.ids.map((id) => [id, b] as const)));

/** Where a barrier stands in the order (lower first), for its holder at `level` (0: not known, taken as the highest). */
export function barrierRank(statusId: number, level: number): number {
  const b = BY_ID.get(statusId);
  if (!b) return UNRANKED_BARRIER;
  return b.fromLevel !== undefined && level > 0 && level < b.fromLevel ? (b.lowerRank ?? b.rank) : b.rank;
}
