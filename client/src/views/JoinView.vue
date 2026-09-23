<script setup>
/**
 * 扫码加入页
 *
 * 从二维码落地：/#/join/<房间号>?mode=online|offline
 *
 * 二维码逻辑直接内联在这里，不拆成独立组件 —— 本项目依赖的
 * @vitejs/plugin-vue 在部分 SFC 结构下会丢失 script 块，内联最稳。
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { hamsterDataURI, getHamster } from '@shared/assets/hamsters.mjs'
import { useUser } from '../stores/user.js'

const route = useRoute()
const router = useRouter()
const { user } = useUser()

if (!user.value) {
  router.replace({ path: '/register', query: { redirect: route.fullPath } })
}

const roomNo = computed(() => String(route.params.roomNo ?? ''))
const mode = computed(() => (route.query.mode === 'offline' ? 'offline' : 'online'))
const valid = computed(() => /^\d{6}$/.test(roomNo.value))

const avatarURI = computed(() => hamsterDataURI(getHamster(user.value?.avatar ?? 1), 72))

// ── 二维码 ──
const qrURI = ref('')
const qrFailed = ref(false)

onMounted(async () => {
  if (!valid.value) return
  try {
    // 动态 import：qrcode 是 CJS 包，运行时取 default 最稳
    const mod = await import('qrcode')
    const QRCode = mod.default ?? mod
    // hash 路由：直接拼 hash，避免依赖 history 路由的后端 rewrite
    const url = location.origin + location.pathname + '#/join/' + roomNo.value + '?mode=' + mode.value
    qrURI.value = await QRCode.toDataURL(url, {
      width: 168,
      margin: 1,
      color: { dark: '#5D4037', light: '#FFFFFFFF' },
      errorCorrectionLevel: 'M',
    })
  } catch (e) {
    console.error('[JoinView] 二维码生成失败', e)
    qrFailed.value = true
  }
})

function enter() {
  if (!valid.value) return
  // 真实入座：joinRoom 会把本成员写进 room_members，
  // 并把房间号通过 query 传给目标页（目标页据此拉取该房间快照）
  router.push({
    path: mode.value === 'offline' ? '/room/offline' : '/room/online',
    query: { join: roomNo.value },
  })
}
</script>

<template>
  <div class="page join" v-if="user">
    <div class="card join-card">
      <div class="avatar join-avatar">
        <img :src="avatarURI" :alt="user.nickname" />
      </div>

      <h1 class="join-title">加入房间</h1>

      <template v-if="valid">
        <!-- 二维码：同 WiFi 扫码直接进房间 -->
        <div class="join-qr">
          <img v-if="qrURI" :src="qrURI" width="168" height="168" alt="房间二维码" />
          <div v-else-if="qrFailed" class="qr-fallback">
            <span class="qr-no">{{ roomNo }}</span>
            <span class="qr-tip">二维码生成失败，请手动输入房间号</span>
          </div>
          <div v-else class="qr-loading">生成中</div>
        </div>

        <div class="room-no">{{ roomNo }}</div>
        <p class="text-sm text-light">
          {{ mode === 'offline' ? '线下计分房间' : '线上对局房间' }}
        </p>
        <p class="join-me">
          以 <b>{{ user.nickname }}</b> 的身份加入
        </p>
        <button class="btn" @click="enter">进入房间</button>
      </template>

      <template v-else>
        <p class="join-error">房间号无效</p>
        <button class="btn btn--ghost" @click="router.push('/lobby')">返回大厅</button>
      </template>
    </div>

    <p class="join-tip text-sm text-light">
      线上模式仅供娱乐，瓜子为虚拟计分，退出后不保留任何记录
    </p>
  </div>
</template>

<style scoped>
.join {
  padding: 24px 20px calc(24px + var(--sab));
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
}

.join-card {
  width: 100%;
  max-width: 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
  padding: 28px 22px;
}

.join-avatar {
  width: 72px;
  height: 72px;
}

.join-title {
  margin: 0;
  font-size: 22px;
  color: var(--c-primary-dark);
}

.join-qr {
  display: grid;
  place-items: center;
  background: #fff;
  border: 2px solid var(--c-border);
  border-radius: 14px;
  padding: 6px;
  line-height: 0;
}

.join-qr img {
  display: block;
  border-radius: 8px;
}

.qr-loading {
  font-size: 12px;
  color: var(--c-text-light);
  padding: 70px 40px;
  line-height: 1.4;
}

.qr-fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 30px 20px;
  line-height: 1.5;
}

.qr-no {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 4px;
  color: var(--c-primary-dark);
}

.qr-tip {
  font-size: 11px;
  color: var(--c-danger);
}

.room-no {
  font-size: 34px;
  font-weight: 800;
  letter-spacing: 6px;
  color: var(--c-text);
}

.join-me {
  margin: 0;
  font-size: 14px;
  color: var(--c-text-light);
}

.join-me b {
  color: var(--c-primary-dark);
}

.join-error {
  margin: 0;
  font-size: 15px;
  color: var(--c-danger);
  font-weight: 700;
}

.join-tip {
  text-align: center;
  margin: 0;
  max-width: 300px;
  line-height: 1.5;
}
</style>
