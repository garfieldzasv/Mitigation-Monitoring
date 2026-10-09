<script setup lang="ts">
import InfoTip from "../common/InfoTip.vue";

/**
 * Where the review window's figures come from and how far off they can be, for the people reviewing a
 * fight (docs/DESIGN.md 8.1): an icon whose tooltip gives, for each figure, its source and its measured
 * error, without the calculation behind it.
 */
</script>

<template>
  <InfoTip class="calc-notes" panel-class="calc-notes-panel" label="数据来源与误差">
    <h4>减伤率</h4>
    <p><span class="k">来源</span>受击那一刻身上的减伤效果，加上格挡、招架。职业技能的数值取自游戏数据里的技能说明；副本机制的减伤和格挡、招架取自游戏日志。易伤、增伤不算在内。</p>
    <p><span class="k">误差</span>带 <b>?</b> 时有数值未知的减伤，实际减伤更高。</p>

    <h4>盾吸收</h4>
    <p><span class="k">来源</span>游戏日志不记录每一下吸收了多少，只记录身上剩余护盾占最大 HP 的整数百分比。取受击前后两条护盾记录，其间挂上的盾按挂盾那一行计入；记录分不开的几下合为一行，只给合计。</p>
    <p><span class="k">误差</span>两条记录各取整到整数百分比，误差约为最大 HP 的 1%。标 <b>≥</b> 的只知道下限（其间挂上了量不明的盾），标 <b>≤</b> 的只知道上限（其间有盾到期或提前消失），<b>?</b> 为日志里定不出。</p>

    <h4>盾量、剩余与穿盾</h4>
    <p><span class="k">来源</span>盾量和剩余取受击前后的护盾记录；穿盾就是这一下的伤害，由日志直接给出。</p>
    <p><span class="k">误差</span>穿盾没有误差；盾量和剩余各取整到整数百分比，误差约为最大 HP 的 1%。</p>

    <h4>未减伤估算</h4>
    <p><span class="k">来源</span>由实际伤害、盾吸收和减伤率反推，除掉易伤（数值取自游戏日志）。几下合为一行、各下减伤不同时给范围。</p>
    <p><span class="k">误差</span>有盾时与盾吸收相同。标 <b>≥</b> 的实际更高（有数值未知的减伤，或盾吸收只知道下限），标 <b>≤</b> 的实际更低（含数值不明的易伤，或盾吸收只知道上限）。</p>

    <h4>未生效</h4>
    <p><span class="k">来源</span>这一下没有结算记录，并且之后的 HP 记录显示伤害没有扣到 HP 上（其间没有治疗），视为没有打到，不计入合计。</p>
    <p><span class="k">误差</span>HP 记录本身没有误差。同一时刻还有别的受击扣血时，没打到的那一下也可能算作生效。</p>

    <h4>受击后 HP</h4>
    <p><span class="k">来源</span>这一下结算时记录的 HP；没有结算记录时不显示。</p>
    <p><span class="k">误差</span>没有误差。</p>

    <h4>队伍减伤状态</h4>
    <p><span class="k">来源</span>有哪些技能、复唱时间和可积蓄次数取自游戏数据，按队员的等级；什么时候用过取自游戏日志里他的技能记录；生效中按这次施放挂上的状态，与时间轴相同。</p>
    <p><span class="k">误差</span>“可用”只表示复唱已转好，忠义、蛇胆、以太超流、魔力和小仙女是否在场日志里没有，不计入。开打 30 秒以前用过、开打时效果已结束的技能存档里没有，显示为可用。</p>
  </InfoTip>
</template>

<style scoped>
h4 {
  margin: 8px 0 2px;
  font-size: 12px;
  color: var(--accent);
}
h4:first-child {
  margin-top: 0;
}
p {
  margin: 0;
}
p + p {
  margin-top: 2px;
}
.k {
  margin-right: 6px;
  color: var(--text-dim);
}
b {
  font-family: var(--mono);
}
</style>
