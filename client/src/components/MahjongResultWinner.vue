<script setup>
import { computed } from 'vue'
import MahjongTile from './MahjongTile.vue'
import MahjongMelds from './MahjongMelds.vue'
import { resultBreakdown } from '../lib/mahjong-result.mjs'

const props = defineProps({ winner: { type: Object, required: true }, nickname: { type: String, required: true }, double: Boolean })
const detail = computed(() => resultBreakdown(props.winner.score))
const melds = computed(() => props.winner.hand?.melds ?? [])
const flowers = computed(() => props.winner.hand?.flowers ?? [])
</script>

<template>
  <section class="winner" :aria-label="`${nickname}的胡牌明细`">
    <h3>{{ nickname }} 胡牌</h3>
    <div class="tile-label">手牌（含胡牌张）</div>
    <div class="winner-tiles"><MahjongTile v-for="(tile, i) in winner.hand?.concealed ?? []" :key="i" :code="tile" /></div>
    <div class="tile-label">碰、杠及花杠</div>
    <MahjongMelds v-if="melds.length" class="winner-groups" :melds="melds" :owner="winner.seat" reveal-concealed show-labels />
    <div v-else class="empty">无</div>
    <div class="tile-label">花牌</div>
    <MahjongMelds v-if="flowers.length" class="winner-groups" :flowers="flowers" :owner="winner.seat" />
    <div v-else class="empty">无</div>
    <div class="score-detail">
      <div class="score-title">牌型明细</div>
      <div v-if="!detail.types.length" class="score-line"><span>无</span><b>0 花</b></div>
      <div v-for="(item, i) in detail.types" :key="i" class="score-line"><span>{{ item.label }}</span><b>{{ item.value }} 花</b></div>
      <div class="score-line subtotal"><span>牌型小计</span><b>{{ detail.typeTotal }} 花</b></div>
      <div class="score-line"><span>硬花 {{ detail.hardCount }} 张</span><b>{{ detail.hard }} 花</b></div>
      <div class="score-title">软花明细</div>
      <div v-if="!detail.soft.length" class="score-line"><span>无</span><b>0 花</b></div>
      <div v-for="item in detail.soft" :key="item.label" class="score-line"><span>{{ item.label }}</span><b>{{ item.value }} 花</b></div>
      <div class="score-line subtotal"><span>软花小计</span><b>{{ detail.softTotal }} 花</b></div>
      <div class="score-line total"><span>合计花数</span><b>{{ detail.total }} 花</b></div>
      <div class="score-line"><span>当局倍率</span><b>× {{ double ? 2 : 1 }}</b></div>
      <div class="score-line"><span>翻倍后的一份</span><b>{{ detail.total * (double ? 2 : 1) }} 瓜子</b></div>
      <small>实际收付以本手流水为准</small>
    </div>
  </section>
</template>

<style scoped>
.winner { padding: 10px; border-radius: 10px; background: #f5f1df; text-align: left; font-size: 12px; }
.winner + .winner { margin-top: 9px; }
h3 { margin: 0 0 6px; color: #275f43; font-size: 15px; }
.tile-label { color: #85755c; font-size: 11px; font-weight: 800; margin: 6px 0 3px; }
.winner-tiles, .winner-groups { --tile-w: clamp(21px, 3.2vw, 30px); --tile-h: calc(var(--tile-w) * 1.37); }
.winner-tiles { display: flex; flex-wrap: wrap; align-items: end; }
.winner-groups { justify-content: flex-start; }
.empty { color: #8c816e; }
.score-detail { margin-top: 8px; border-top: 1px solid #ded6be; padding-top: 3px; }
.score-title { color: #8b7858; font-weight: 800; margin-top: 5px; }
.score-line { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
.score-line b { font-weight: 700; white-space: nowrap; }
.subtotal { color: #665b46; }
.total { margin-top: 4px; padding-top: 5px; border-top: 1px solid #ded6be; color: #276e48; font-weight: 900; }
.score-detail small { display: block; margin-top: 5px; color: #8b785f; }
</style>
