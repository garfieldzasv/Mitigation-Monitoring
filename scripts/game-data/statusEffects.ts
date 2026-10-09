/**
 * What a damage status's description says about which damage it changes and which of its put-on line's modifier
 * bytes is its value (docs/DESIGN.md 5.5). Rules on the CN Status sheet's text, the same for
 * every status; the value itself comes from the log.
 */

/** Which damage the effect covers: "" all; one damage type; one element; or a condition the log cannot check. */
export type EffectScope = "" | "physical" | "magical" | "conditional" | "fire" | "ice" | "wind" | "earth" | "lightning" | "water";

/**
 * Which put-on byte is the value. "first": the LogGuide's damage modifier byte (the flags' second from the right);
 * "sign": the description has other modifiers, all of the other sign — the one byte of this effect's sign;
 * "none": another modifier of the same sign, so the bytes cannot tell which is which.
 */
export type ByteRule = "first" | "sign" | "none";

type Kind = "takenUp" | "takenDown" | "dealtUp" | "dealtDown";

/** Modifiers a status can carry, with the sign of their byte. */
const MODIFIERS: readonly { kind: Kind | "other"; sign: 1 | -1; re: RegExp }[] = [
  { kind: "takenUp", sign: 1, re: /(受到|所受|被攻击时).{0,12}伤害(增加|提高)/ },
  { kind: "takenDown", sign: -1, re: /(受到|所受).{0,12}伤害(减少|减轻)|减轻所受到的.{0,8}伤害|降低受到的伤害/ },
  { kind: "dealtUp", sign: 1, re: /造成的.{0,4}伤害提高|攻击力提高/ },
  { kind: "dealtDown", sign: -1, re: /造成的.{0,4}伤害降低|攻击力降低/ },
  { kind: "other", sign: 1, re: /(治疗|恢复).{0,8}(效果|量|魔法).{0,4}(提高|增加)|(体力最大值|最大体力)(值)?(提高|增加)/ },
  { kind: "other", sign: -1, re: /(治疗|恢复).{0,8}(效果|量|魔法).{0,4}(降低|减少)|(体力最大值|最大体力)(值)?降低/ },
];

/**
 * A condition the log cannot check: where others stand, the direction of the hit, particular attacks, light / dark /
 * polarity. Looked for in the effect's own clause and in a clause just before it that sets a condition (…时).
 */
const CONDITION = /接近|远离|距离|方向|特定|部分攻击|因子|极性|(光|暗)属性/;
const ELEMENTS: Readonly<Record<string, EffectScope>> = { 火: "fire", 冰: "ice", 风: "wind", 土: "earth", 雷: "lightning", 水: "water" };

const plain = (text: string) => text.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
const sentences = (text: string) => text.split(/[。；！\n]/).filter(Boolean);
const clauses = (sentence: string) => sentence.split(/[，、]|并且|同时|另外|但是|但/).filter(Boolean);

/** Scope and byte rule of a status of this kind, from its description. */
export function damageEffect(description: string, kind: Kind): { scope: EffectScope; byte: ByteRule } {
  const text = plain(description);
  const own = MODIFIERS.find((m) => m.kind === kind)!;
  let scope: EffectScope | undefined;
  const others: (1 | -1)[] = [];
  for (const sentence of sentences(text)) {
    const parts = clauses(sentence);
    for (const [i, clause] of parts.entries()) {
      for (const m of MODIFIERS) {
        if (!m.re.test(clause)) continue;
        if (m !== own) {
          others.push(m.sign);
          continue;
        }
        if (scope !== undefined) continue; // the first clause of its own says it
        const element = /(火|冰|风|土|雷|水)属性/.exec(clause)?.[1];
        const physical = /物理/.test(clause);
        const magical = /魔法/.test(clause);
        const lead = i > 0 && parts[i - 1]!.endsWith("时") ? parts[i - 1]! : "";
        scope = CONDITION.test(clause) || CONDITION.test(lead)
          ? "conditional"
          : element
            ? ELEMENTS[element]!
            : physical !== magical
              ? physical
                ? "physical"
                : "magical"
              : "";
      }
    }
  }
  const byte: ByteRule = others.length === 0 ? "first" : others.includes(own.sign) ? "none" : "sign";
  return { scope: scope ?? "", byte };
}
