<script setup>
import { computed, ref, watch } from 'vue'
import { tileInfo, tileUrl } from '../lib/mahjong-view.mjs'

const props = defineProps({ code: { type: String, required: true }, highlight: Boolean, sideways: Boolean })
const broken = ref(false)
watch(() => props.code, () => { broken.value = false })
const info = computed(() => tileInfo(props.code))
const src = computed(() => tileUrl(props.code))
</script>

<template>
  <span class="tile" :class="{ 'tile--highlight': highlight, 'tile--sideways': sideways }" :aria-label="info.name">
    <img v-if="src && !broken" :src="src" :alt="info.name" draggable="false" @error="broken = true" />
    <span v-else class="tile-fallback">{{ info.name }}</span>
  </span>
</template>

<style scoped>
.tile { display: inline-flex; position: relative; align-items: center; justify-content: center; width: var(--tile-w, 24px); height: var(--tile-h, 33px); flex: none; border-radius: 4px; }
.tile img { display: block; width: var(--tile-w, 24px); height: var(--tile-h, 33px); object-fit: contain; }
.tile--highlight { background: #ffe677; outline: 2px solid #ffd84e; box-shadow: 0 0 11px #ffda59; z-index: 2; }
.tile--sideways { width: var(--tile-h, 33px); height: var(--tile-w, 24px); align-self: end; }
.tile--sideways img { transform: rotate(90deg); flex: none; }
.tile-fallback { display: grid; place-items: center; width: 100%; height: 100%; border-radius: 4px; background: #fff8dc; color: #234939; font-size: clamp(8px, 1.8vw, 14px); font-weight: 800; line-height: 1; }
</style>
