<script setup>
import MahjongTile from './MahjongTile.vue'
import { sidewaysIndex } from '../lib/mahjong-view.mjs'

defineProps({ melds: { type: Array, default: () => [] }, flowers: { type: Array, default: () => [] },
  owner: { type: Number, required: true }, selected: { type: String, default: '' }, vertical: Boolean, revealConcealed: Boolean, showLabels: Boolean })
const meldLabel = (type) => ({ ankong: '暗杠', huagang: '花杠', pong: '碰', kong: '直杠', pongkong: '补杠' })[type] ?? '杠'
</script>

<template>
  <div class="groups" :class="{ 'groups--vertical': vertical }" :aria-label="`座位 ${owner + 1} 的碰杠和花`">
    <div v-for="(meld, mi) in melds" :key="`m${mi}`" class="meld" :class="{ 'meld--labelled': showLabels }" :title="meldLabel(meld.type)" :data-kind="meldLabel(meld.type)" :aria-label="meldLabel(meld.type)">
      <MahjongTile v-for="(tile, ti) in meld.tiles" :key="ti"
        :code="meld.type === 'ankong' && ti > 0 && !revealConcealed ? 'back' : tile"
        :highlight="tile === selected && !(meld.type === 'ankong' && ti > 0 && !revealConcealed)"
        :sideways="vertical ? sidewaysIndex(meld, owner) !== ti : sidewaysIndex(meld, owner) === ti" />
    </div>
    <div v-if="flowers.length" class="flowers" title="花牌">
      <MahjongTile v-for="(tile, i) in flowers" :key="`f${i}`" :code="tile" :highlight="tile === selected" :sideways="vertical" />
    </div>
  </div>
</template>

<style scoped>
.groups { display: flex; justify-content: flex-end; align-items: flex-end; flex-wrap: wrap; gap: 3px; max-width: 100%; }
.meld, .flowers { display: inline-flex; align-items: flex-end; white-space: nowrap; gap: 0; }
.flowers { max-width: 100%; flex-wrap: wrap; }
.meld--labelled { position: relative; margin-top: 15px; }
.meld--labelled::before { position: absolute; left: 2px; top: -15px; content: attr(data-kind); color: #86765c; font-size: 10px; font-weight: 700; }
.groups--vertical { flex-direction: column; flex-wrap: nowrap; align-items: flex-end; }
.groups--vertical .meld, .groups--vertical .flowers { flex-direction: column; flex-wrap: nowrap; }
</style>
