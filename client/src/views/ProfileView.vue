<script setup>
/**
 * 个人中心：金瓜子统计
 * - 每仓鼠一行（哪个仓鼠给了你几颗）
 * - 长按具体行清空重置（双方同时清，避免坏账）
 */
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { hamsterDataURI, getHamster } from '@shared/assets/hamsters.mjs'
import { goldenSeedSVG, svgToDataURI } from '@shared/assets/visuals.mjs'
import { useUser } from '../stores/user.js'

const router = useRouter()
const { user, goldenSeeds, ledgerRows, clearLedgerRow, resetAll } = useUser()

const LONG_PRESS_MS = 550
let pressTimer = null
const pressingUid = ref(null)
const clearingUid = ref(null)
const confirmReset = ref(false)
const toast = ref('')
let toastTimer = null

function showToast(msg) {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 1800)
}

const goldURI = svgToDataURI(goldenSeedSVG(24))
const emptyText = computed(() => (ledgerRows.value.length === 0 ? '还没有金瓜子记录' : ''))

function avatarOf(id) {
  return hamsterDataURI(getHamster(id), 56)
}

/** 长按开始 */
function onPressStart(row) {
  pressingUid.value = row.uid
  pressTimer = setTimeout(() => {
    pressingUid.value = null
    doClear(row)
  }, LONG_PRESS_MS)
}

/** 长按取消（松手/滑动） */
function onPressEnd() {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = null
  pressingUid.value = null
}

/**
 * 清空某一行
 * 本地先清；云端同时清对方的账本（RPC 单事务，避免坏账）
 */
async function doClear(row) {
  clearingUid.value = row.uid
  try {
    await clearLedgerRow(row.uid)
  } catch (e) {
    showToast('清空失败：' + (e?.message ?? e))
  } finally {
    clearingUid.value = null
  }
}

async function doResetAll() {
  await resetAll()
  router.replace('/register')
}

if (!user.value) router.replace('/register')
</script>

<template>
  <div v-if="user" class="page profile">
    <header class="prof-head">
      <button class="back-btn" @click="router.back()">‹</button>
      <h1>我的金瓜子</h1>
      <div class="head-total">
        <img :src="goldURI" alt="" />
        <span>{{ goldenSeeds }}</span>
      </div>
    </header>

    <p class="hint text-sm text-light">哪个仓鼠给了你几颗 · 长按某行可清空重置（双方同时清）</p>

    <transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>

    <div class="ledger">
      <div v-for="row in ledgerRows" :key="row.uid" class="ledger-row card"
           :class="{ pressing: pressingUid === row.uid, clearing: clearingUid === row.uid }"
           @pointerdown="onPressStart(row)"
           @pointerup="onPressEnd"
           @pointerleave="onPressEnd"
           @pointercancel="onPressEnd">
        <div class="avatar">
          <img :src="avatarOf(row.avatar)" :alt="row.nickname" />
        </div>
        <div class="grow">
          <div class="peer-name">{{ row.nickname }}</div>
          <div class="peer-detail text-sm text-light">
            {{ row.count > 0 ? '他给了你' : '你给了他' }} {{ Math.abs(row.count) }} 颗
          </div>
        </div>
        <div class="count" :class="{ negative: row.count < 0 }">
          {{ row.count > 0 ? '+' : '' }}{{ row.count }}
        </div>
      </div>

      <p v-if="emptyText" class="empty text-center text-light">{{ emptyText }}</p>
    </div>

    <div class="profile-foot">
      <button class="btn btn--ghost btn--sm" @click="confirmReset = true">
        清空全部数据
      </button>
    </div>

    <!-- 清空确认 -->
    <div v-if="confirmReset" class="mask" @click.self="confirmReset = false">
      <div class="dialog">
        <h3 class="dlg-title">确认清空？</h3>
        <p class="text-sm text-light">
          将退出登录并抹掉本机身份。金瓜子绑在账号名上，用同名账号还能登回来。
        </p>
        <div class="row" style="margin-top: 18px">
          <button class="btn btn--ghost grow" @click="confirmReset = false">取消</button>
          <button class="btn btn--danger grow" @click="doResetAll">确认清空</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile {
  padding: calc(12px + var(--sat)) 16px calc(16px + var(--sab));
  gap: 12px;
}

.prof-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.prof-head h1 {
  font-size: 19px;
  margin: 0;
  flex: 1;
}

.back-btn {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--c-border);
  font-size: 22px;
  line-height: 1;
  color: var(--c-text-light);
  cursor: pointer;
}

.head-total {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 20px;
  font-weight: 800;
  color: var(--c-primary-dark);
}

.head-total img {
  width: 22px;
  height: 22px;
}

.hint {
  margin: 0;
}

.ledger {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  align-content: start;
}

.ledger-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  cursor: pointer;
  transition: transform 0.1s, background 0.1s;
}

.ledger-row.pressing {
  transform: scale(0.97);
  background: #FFF3E0;
}

.ledger-row .avatar {
  width: 44px;
  height: 44px;
}

.peer-name {
  font-weight: 700;
  font-size: 15px;
}

.count {
  font-size: 20px;
  font-weight: 800;
  color: var(--c-success);
}

.count.negative {
  color: var(--c-danger);
}

.ledger-row.clearing {
  opacity: 0.5;
  pointer-events: none;
}

.empty {
  padding: 40px 0;
  font-size: 14px;
}

.profile-foot {
  text-align: center;
  padding-bottom: 8px;
}

.toast {
  position: fixed;
  left: 50%;
  top: 20%;
  transform: translateX(-50%);
  background: rgba(93, 64, 55, 0.9);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  padding: 10px 20px;
  border-radius: 20px;
  z-index: 200;
  white-space: nowrap;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
}

.dlg-title {
  margin: 0 0 8px;
  font-size: 18px;
}
</style>
