<script setup>
/**
 * 扫码加入页
 *
 * 从房间二维码落地：/#/join/<房间号>?mode=offline|online
 *
 * 2026-09-24：原来这里只 push 一个 query 就完事，靠目标页自己去 join，
 * 而目标页的旧实现读的是 CloudBase 的 room_members。现在改成在这里就
 * 真调 /api/room/join 入座，成功再进房间页 —— 房间不存在/已满当场就能报。
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { hamsterDataURI, getHamster } from '@shared/assets/hamsters.mjs'
import { useUser } from '../stores/user.js'
import { roomRepo } from '../data/room-repo.js'

const route = useRoute()
const router = useRouter()
const { user, refresh } = useUser()

// 直接打开这个 URL（扫码）时 user store 可能是空的，自己拉一次
onMounted(async () => {
  if (!user.value) await refresh()
})

const roomNo = computed(() => String(route.params.roomNo ?? '').trim())
const mode = computed(() => (route.query.mode === 'offline' ? 'offline' : 'online'))
const valid = computed(() => /^\d{6}$/.test(roomNo.value))

const avatarURI = computed(() => hamsterDataURI(getHamster(user.value?.avatar ?? 1), 72))

// ── 加入 ──
const joining = ref(false)
const joinError = ref('')

async function enter() {
  if (!valid.value) return
  joining.value = true
  joinError.value = ''
  try {
    // 先确保拿的是当前 uid 的档案。store 是本地缓存，同会话里换过 uid
    // （比如另一个人扫了码）时不刷新就会拿上一个身份去入座。
    if (!user.value) await refresh()
    const r = await roomRepo.joinRoom(roomNo.value, {
      nickname: user.value?.nickname || user.value?.account || '匿名',
      avatar: user.value?.avatar ?? 1,
    })
    if (!r.ok) {
      joinError.value = r.error || '加入失败'
      return
    }
    router.push({
      path: mode.value === 'offline' ? '/room/offline' : '/room/online',
      query: { room: roomNo.value },
    })
  } finally {
    joining.value = false
  }
}

// ── 二维码：把这个页自己的地址编出来，方便下一个人接着扫 ──
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
        <button class="btn" :disabled="joining" @click="enter">
          {{ joining ? '加入中…' : '进入房间' }}
        </button>
        <p v-if="joinError" class="join-error">{{ joinError }}</p>
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
