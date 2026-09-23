/**
 * 房间加入二维码
 *
 * 动态 import qrcode（CJS 包，静态默认导入在部分构建环境下不可靠），
 * 把加入链接编码成 dataURI。同 WiFi 下扫码直接进房间。
 */
<script setup>
import { ref, watch, onMounted } from 'vue'

const props = defineProps({
  roomNo: { type: String, required: true },
  size: { type: Number, default: 132 },
  mode: { type: String, default: 'online' },
})

const dataURI = ref('')
const failed = ref(false)

async function render() {
  if (!props.roomNo) return
  failed.value = false
  try {
    const mod = await import('qrcode')
    const QRCode = mod.default ?? mod
    if (typeof QRCode?.toDataURL !== 'function') {
      throw new Error('qrcode.toDataURL unavailable')
    }
    const url = location.origin + location.pathname + '#/join/' + props.roomNo + '?mode=' + props.mode
    dataURI.value = await QRCode.toDataURL(url, {
      width: props.size,
      margin: 1,
      color: { dark: '#5D4037', light: '#FFFFFFFF' },
      errorCorrectionLevel: 'M',
    })
  } catch (e) {
    console.error('[RoomQR] failed', e)
    failed.value = true
  }
}

onMounted(render)
watch(() => props.roomNo, render)
</script>

<template>
  <div class="room-qr">
    <img v-if="dataURI" :src="dataURI" :width="size" :height="size" alt="房间二维码" class="qr-img" />
    <div v-else-if="failed" class="qr-fallback">
      <span class="qr-no">{{ roomNo }}</span>
      <span class="qr-tip">二维码生成失败</span>
    </div>
    <div v-else class="qr-loading">生成中</div>
  </div>
</template>

<style scoped>
.room-qr {
  display: grid;
  place-items: center;
  background: #fff;
  border-radius: 10px;
  padding: 3px;
  flex-shrink: 0;
  line-height: 0;
}

.qr-img {
  display: block;
  border-radius: 7px;
}

.qr-loading {
  font-size: 10px;
  color: #8d6e63;
  padding: 18px;
  line-height: 1.4;
}

.qr-fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px;
  line-height: 1.4;
}

.qr-no {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 2px;
  color: #e08900;
}

.qr-tip {
  font-size: 9px;
  color: #ef5350;
}
</style>
