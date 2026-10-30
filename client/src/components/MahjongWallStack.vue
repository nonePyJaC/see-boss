<script setup>
import { computed } from 'vue'

const props = defineProps({ count: { type: Number, required: true }, side: { type: String, required: true } })
const vertical = computed(() => props.side === 'left' || props.side === 'right')
const asset = computed(() => `${import.meta.env.BASE_URL}mahjong/walls/${vertical.value ? 'side' : 'top'}.svg`)
</script>

<template>
  <span class="wall-stack" :class="{ 'wall-stack--vertical': vertical }" :data-count="count">
    <img v-if="count === 2" class="wall-layer wall-layer--lower" :src="asset" alt="" draggable="false" />
    <img v-if="count > 0" class="wall-layer wall-layer--upper" :src="asset" alt="" draggable="false" />
  </span>
</template>

<style scoped>
.wall-stack { position: relative; display: block; flex: 0 0 calc(100% / 18); min-width: 0; min-height: 0; }
.wall-layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.wall-layer--lower { transform: translateY(3px); filter: brightness(.76); }
.wall-layer--upper { transform: translateY(-2px); }
.wall-stack--vertical .wall-layer--lower { transform: translateX(3px); }
.wall-stack--vertical .wall-layer--upper { transform: translateX(-2px); }
</style>
