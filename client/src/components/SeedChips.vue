/**
 * SeedChips — 瓜子数量展示
 *
 * 统一形式：一颗瓜子图标 + ×N 数量。不再按面值拆分成多摞。
 * 例：2,980 → [瓜子图标] ×2,980
 *
 * props:
 *   value  要展示的瓜子数
 *   size   瓜子图标尺寸 px
 */
<script setup>
import { computed } from 'vue'
import { seedSVG, svgToDataURI } from '@shared/assets/visuals.mjs'

const props = defineProps({
  value: { type: Number, default: 0 },
  size: { type: Number, default: 18 },
})

const formatted = computed(() => Math.max(0, Math.floor(props.value)).toLocaleString('zh-CN'))

const seedURI = computed(() =>
  svgToDataURI(seedSVG({ size: props.size, color: '#A1887F', face: null }))
)
</script>

<template>
  <span class="seed-num">
    <img :src="seedURI" alt="" class="seed" :style="{ width: size + 'px', height: size + 'px' }" />
    <b>×{{ formatted }}</b>
  </span>
</template>

<style scoped>
.seed-num {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  vertical-align: middle;
  min-width: 0;
}

.seed {
  display: block;
  flex-shrink: 0;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.2));
}

.seed-num b {
  font-weight: 800;
  white-space: nowrap;
}
</style>
