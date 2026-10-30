<script setup>
import { computed } from 'vue'
import MahjongTile from './MahjongTile.vue'
import MahjongMelds from './MahjongMelds.vue'
import { resultBreakdown } from '../lib/mahjong-result.mjs'
import { sortedHand, tileInfo } from '../lib/mahjong-view.mjs'

const props = defineProps({ winner: { type: Object, required: true }, nickname: { type: String, required: true }, double: Boolean })
const detail = computed(() => resultBreakdown(props.winner.score))
const melds = computed(() => props.winner.hand?.melds ?? [])
const flowers = computed(() => props.winner.hand?.flowers ?? [])
const hand = computed(() => sortedHand(props.winner.hand?.concealed ?? [], props.winner.hand?.winTile))
</script>

<template>
  <section class="winner" :aria-label="`${nickname}的胡牌明细`">
    <div class="winner-tiles-panel">
      <h3>{{ nickname }} 胡牌</h3>
      <div class="tile-label">手牌 <span v-if="winner.hand?.winTile">· 胡牌张单独标记</span></div>
      <div class="winner-tiles"><span v-for="tile in hand" :key="tile.index" class="result-tile" :class="{ 'result-tile--win': tile.drawn }" :aria-label="`${tileInfo(tile.code).name}${tile.drawn ? '，胡牌张' : ''}`"><MahjongTile :code="tile.code" :highlight="tile.drawn" /></span></div>
      <div v-if="melds.length" class="tile-label">碰杠与花杠</div>
      <MahjongMelds v-if="melds.length" class="winner-groups" :melds="melds" :owner="winner.seat" reveal-concealed show-labels />
      <div v-if="flowers.length" class="tile-label">花牌</div>
      <MahjongMelds v-if="flowers.length" class="winner-groups" :flowers="flowers" :owner="winner.seat" />
      <div v-if="!melds.length && !flowers.length" class="empty">无副露及花牌</div>
    </div>
    <div class="winner-score">
      <div class="score-summary"><span>合计 <b>{{ detail.total }} 花</b></span><small>倍率 ×{{ double ? 2 : 1 }} · 每份 {{ detail.total * (double ? 2 : 1) }} 瓜子</small></div>
      <div class="score-rows">
        <div v-if="!detail.types.length" class="score-line"><span>牌型</span><b>0 花</b></div>
        <div v-for="(item, i) in detail.types" :key="`type${i}`" class="score-line"><span>{{ item.label }}</span><b>{{ item.value }} 花</b></div>
        <div class="score-line subtotal"><span>牌型小计</span><b>{{ detail.typeTotal }} 花</b></div>
        <div class="score-line"><span>硬花 {{ detail.hardCount }} 张</span><b>{{ detail.hard }} 花</b></div>
        <div v-if="!detail.soft.length" class="score-line"><span>软花</span><b>0 花</b></div>
        <div v-for="item in detail.soft" :key="item.label" class="score-line"><span>软花 · {{ item.label }}</span><b>{{ item.value }} 花</b></div>
        <div class="score-line subtotal"><span>软花小计</span><b>{{ detail.softTotal }} 花</b></div>
        <div v-for="(item, i) in detail.bonuses" :key="`bonus${i}`" class="score-line"><span>{{ item.label }}</span><b>{{ item.value }} 花</b></div>
        <div class="score-line subtotal"><span>加成小计</span><b>{{ detail.bonusTotal }} 花</b></div>
        <small>实际收付见下方及流水</small>
      </div>
    </div>
  </section>
</template>

<style scoped>
.winner { display: grid; grid-template-columns: minmax(0, 68fr) minmax(0, 32fr); gap: 8px; min-height: 0; height: 100%; text-align: left; font-size: clamp(10px, 1.5vw, 12px); }
.winner-tiles-panel, .winner-score { min-width: 0; min-height: 0; border-radius: 9px; background: #f5f1df; padding: 7px 9px; }
.winner-tiles-panel { overflow: auto; }
h3 { margin: 0 0 2px; color: #275f43; font-size: clamp(12px, 1.8vw, 15px); }
.tile-label { color: #85755c; font-size: 10px; font-weight: 800; margin: 4px 0 1px; }
.winner-tiles { --tile-w: clamp(18px, min(3.6vw, 6.5vh), 32px); --tile-h: calc(var(--tile-w) * 1.37); display: flex; flex-wrap: wrap; align-items: end; gap: 1px; }
.result-tile { display: inline-flex; }
.result-tile--win { margin-left: 5px; border-radius: 4px; box-shadow: 0 0 0 2px #d8ae4c; }
.winner-groups { --tile-w: clamp(16px, min(3vw, 5.8vh), 28px); --tile-h: calc(var(--tile-w) * 1.37); justify-content: flex-start; }
.empty { margin-top: 5px; color: #8c816e; }
.winner-score { display: flex; flex-direction: column; }
.score-summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; color: #276e48; font-weight: 900; border-bottom: 1px solid #ded6be; padding-bottom: 3px; }
.score-summary b { font-size: clamp(14px, 2vw, 18px); }
.score-summary small { color: #8b785f; font-weight: 700; }
.score-rows { overflow: auto; min-height: 0; padding-top: 2px; }
.score-line { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
.score-line b { font-weight: 700; white-space: nowrap; }
.subtotal { color: #665b46; }
.score-rows small { display: block; margin-top: 3px; color: #8b785f; }
</style>
