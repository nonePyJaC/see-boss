<script setup>
/**
 * 线下房间页 —— 新 UI。
 *
 * 数据层全部走 room-repo（/api/room/*），房间逻辑在服务端，
 * 这里只做渲染和发动作，不持有任何计分状态。
 *
 * UI 依据（2026-09-24 定稿）：
 *   - 圆形头像 + 昵称 + 数字，没有白卡片，没有空位占位
 *   - 四列布局，8 人不滚动 *   - 「我」= 浅金描边；房主 = 👑；回合者 = 红圈 + 呼吸脉冲（所有人屏幕上都能看到）
 *   - 操作栏：收 / 过|跟N / 加倍 / 弃
 *   - 加倍：单击和长按都开弹窗（不提供「直接下 1 倍小麦」的快捷，防误触）
 *   - 收池：二次确认；有人归零时文案要点名
 *   - 数字只有数字，不带「瓜子」后缀
 */

import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { roomRepo } from '../data/room-repo.js'
import { accountRepo } from '../data/account-repo.js'
import { useHamsters } from '../composables/useHamsters.js'

const route = useRoute()
const router = useRouter()
const { uriFor } = useHamsters()

/** 不进 keep-alive：房间页每次进都该重新拉状态，
 *  缓存实例会让「大厅点加入另一个房间」时还显示上一个房间的数据。 */
defineOptions({ name: 'OfflineRoomView' })

const uid = accountRepo.getUid()
/** 房间号：跟着路由走。不能只读一次 —— 同一组件实例里换房间（大厅点加入）
 *  setup 不会重跑，写死就读到旧房间号了（踩过：页面还显示上一个房间）。 */
const ROOM = computed(() => route.query.room || route.params.roomNo || '')

/** 当前实际在看的房间号，供 pull/动作用 */
const roomId = () => ROOM.value
// ── 状态 ──
const snap = ref(null)          // 最近一次房间快照
const me = ref(null)            // 账号（金瓜子等）
const locked = ref(true)        // 锁定位：true=房主可点玩家设小麦位
const gate = ref('')            // 挡屏文案（连不上/未登录）
const toastMsg = ref('')
const showToast = ref(false)

// 弹窗
const sheetOpen = ref(false)    // 加注弹窗
const settleOpen = ref(false)   // 结算弹窗
const logOpen = ref(false)      // 下注流水弹窗
const raisePreview = ref(0)
const customInput = ref('')
const inputClamped = ref(false)
const raiseNeed = ref(0)
const raiseMax = ref(0)

let watcher = null
let toastTimer = null
let longPressTimer = null
let longPressFired = false

const d = computed(() => snap.value?.data ?? null)
const seats = computed(() => d.value?.seats ?? [])
const isHost = computed(() => d.value?.hostUid === uid)

/** 花生节拍器：翻牌前 0 / 翻牌 3 / 转牌 4 / 河牌 5 */
const STAGE_PEANUTS = { preflop: 0, flop: 3, turn: 4, river: 5 }
const peanutCount = computed(() => STAGE_PEANUTS[d.value?.stage] ?? 0)

const myActs = computed(() => d.value?.avail ?? [])
const has = (t) => myActs.value.some((a) => a.type === t)

const toCall = computed(() => d.value?.toCall ?? 0)
const zeroedNames = computed(() =>
  seats.value.filter((s) => s.seeds <= 0).map((s) => s.nickname))

const mySeat = computed(() => seats.value.find((s) => s.uid === uid) || null)
const mySeeds = computed(() => mySeat.value?.seeds ?? 0)

/** 1/2/5/10/20 倍小麦 */
const presets = computed(() => {
  const sb = d.value?.smallBlind || 100
  return [1, 2, 5, 10, 20].map((x) => ({ x, v: sb * x }))
})

function toast(m) {
  toastMsg.value = m
  showToast.value = true
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { showToast.value = false }, 2200)
}

function avatarOf(seat) {
  return uriFor(seat.uid || seat.nickname || 'x')
}

// ── 拉状态 ──
async function pull() {
  const r = await roomRepo.roomState(roomId())
  if (!r.ok) {
    gate.value = r.error || '连不上房间'
    return
  }
  gate.value = ''
  snap.value = r
  // 结算弹窗只在有人归零、且本手已收掉时出现
  if (r.data.settlePending) settleOpen.value = true
}

function onPollError(r) {
  gate.value = r.error || '连不上房间'
}

// ── 操作 ──
function act(type, amount) {
  return roomRepo.roomAction(roomId(), type, amount).then(pull)
}

/** 收池：二次确认。收回不可逆，必须先问。 */
function confirmCollect() {
  const pot = d.value?.pot ?? 0
  let msg = '收走公共池 ' + pot + '？收掉后本手结束'
  if (zeroedNames.value.length) {
    msg += '，并触发结算（' + zeroedNames.value.join('、') + ' 已归零）'
  }
  if (!confirm(msg)) return
  act('collect').then((x) => { if (!x.ok) toast(x.error) })
}

function confirmFold() {
  if (!confirm('确定弃牌？')) return
  act('fold')
}

/** 锁定位切换（房主） */
function toggleLock() {
  locked.value = !locked.value
  toast(locked.value ? '已开锁：点玩家设小麦位' : '已关锁')
}

/** 点玩家设小麦位（房主 + 锁定位） */
function tapSeat(seat) {
  if (!locked.value) return toast('先开锁才能设置小麦位')
  if (!isHost.value) return toast('只有房主能设置')
  const i = seats.value.findIndex((s) => s.uid === seat.uid)
  roomRepo.startRoom(roomId(), i).then((x) => {
    toast(x.ok ? '小麦位已设置' : x.error)
    if (x.ok) pull()
  })
}

// ── 加注弹窗 ──
function openSheet() {
  if (!d.value) { toast('房间状态还没加载'); return }
  raiseNeed.value = toCall.value
  raiseMax.value = Math.max(0, mySeeds.value - toCall.value)
  customInput.value = ''
  inputClamped.value = false
  updatePreview(presets.value[0]?.v ?? 0, false)
  sheetOpen.value = true
}

function updatePreview(extra, clamped) {
  const allin = clamped || extra >= raiseMax.value
  raisePreview.value = Math.min(raiseNeed.value + extra, mySeeds.value)
  inputClamped.value = !!clamped || allin
}

function pickPreset(v) { doRaise(v) }

function onCustomInput() {
  let v = Number(customInput.value)
  if (!Number.isFinite(v) || v <= 0) v = 0
  v = Math.floor(v)
  const clamped = v > raiseMax.value
  if (clamped) {
    v = raiseMax.value
    customInput.value = String(v)
  }
  updatePreview(v, clamped)
}

function submitCustom() {
  const v = Number(customInput.value)
  if (!Number.isFinite(v) || v <= 0) return toast('请输入有效数额')
  doRaise(v)
}

function allIn() { doRaise(raiseMax.value) }

function doRaise(extra) {
  const e = Math.min(extra, raiseMax.value)
  if (e <= 0) return toast('至少加 1 倍小麦')
  sheetOpen.value = false
  act('raise', e).then((x) => {
    if (x.ok) toast('跟 ' + raiseNeed.value + ' + 加 ' + e + ' = ' + (raiseNeed.value + e))
    else toast(x.error)
  })
}

/**
 * 加倍按钮的长按。
 * 单击和长按都要开弹窗 —— 用户明确要求两种手势都给弹窗，
 * 所以长按触发后置个标记，让紧随其后的 click 别重复开。
 *
 * 注意 disabled 的 button 依然会收 pointerdown（HTML 的 disabled
 * 只拦 click/mouse 系列，不拦 pointer 系列），所以这里必须自己判一次。
 */
function onLongPressStart(e) {
  const btn = e?.currentTarget
  if (btn?.disabled) return
  longPressFired = false
  clearTimeout(longPressTimer)
  longPressTimer = setTimeout(() => {
    longPressFired = true
    openSheet()
  }, 500)
}

function onLongPressEnd() { clearTimeout(longPressTimer) }

function onRaiseClick(e) {
  // disabled 的按钮 Vue 不会派发 click，但长按可能已经开过
  if (longPressFired) { longPressFired = false; return }
  openSheet()
}

// ── 结算 ──
function settle(action) {
  roomRepo.settleRoom(roomId(), action).then((x) => {
    if (!x.ok) return toast(x.error)
    settleOpen.value = false
    if (action === 'disband') router.replace('/lobby')
    else pull()
  })
}

onMounted(async () => {
  const m = await accountRepo.me()
  me.value = m.data
  if (!m.data?.loggedIn) { gate.value = '未登录'; return }
  await pull()
  watcher = roomRepo.watchRoom(roomId(), pull, onPollError)
})

/** 换了房间号（大厅点加入）就重开轮询，别接着拉旧房间 */
watch(ROOM, async (next, prev) => {
  if (!next || next === prev) return
  watcher?.stop()
  settleOpen.value = false
  snap.value = null
  await pull()
  watcher = roomRepo.watchRoom(roomId(), pull, onPollError)
})

onUnmounted(() => {
  watcher?.stop()
  clearTimeout(toastTimer)
  clearTimeout(longPressTimer)
})
</script>

<template>
  <div v-if="d" class="page" :class="{ locked }">
    <div class="topbar">
      <button class="back" @click="router.back()">←</button>
      <div class="room-tag">
        <span class="no">{{ d.id }}</span>
        <span v-if="isHost" class="host">房主</span>
      </div>
      <div class="spacer"></div>
      <button v-if="isHost" class="iconbtn" :class="locked ? 'locked' : 'unlocked'" @click="toggleLock">
        {{ locked ? '🔒' : '🔓' }}
      </button>
    </div>

    <div class="roundbar">
      第 {{ d.roundNo }} 局 · 小麦 <b>{{ d.smallBlind }}</b> / 大麦 <b>{{ d.bigBlind }}</b>
    </div>

    <!-- 公共池：点一下看下注流水 -->
    <div class="pool" @click="logOpen = true">
      <div class="pool-head">
        <span class="nut">🥜</span>
        <span class="num">{{ d.pot }}</span>
        <span class="lbl">公共池</span>
      </div>
      <div class="peanuts">
        <i v-for="i in 5" :key="i" class="peanut" :class="{ on: i <= peanutCount }"></i>
      </div>
      <!-- 每人当前下注 -->
      <div class="bets">
        <div v-for="s in seats" :key="s.uid" class="bet-row" :class="{ folded: s.folded }">
          <i class="dot" :class="s.blind === 'sb' ? 'sb' : s.blind === 'bb' ? 'bb' : ''"></i>
          <span class="nm">{{ s.nickname }}</span>
          <span class="val">{{ s.bet }}</span>
        </div>
      </div>
      <div v-if="d.paused" class="paused">已暂停 · 等待房主操作</div>
    </div>

    <!-- 四列座位，8 人不滚动 -->
    <div class="table">
      <div v-for="s in seats" :key="s.uid" class="seat"
           :class="{ me: s.uid === uid, turn: s.uid === d.turnUid, folded: s.folded }"
           @click="tapSeat(s)">
        <div class="avatar"><img :src="avatarOf(s)" alt="" /></div>
        <span v-if="s.uid === uid" class="tag me">我</span>
        <span v-if="s.isHost" class="tag host">👑</span>
        <span v-if="s.blind === 'sb'" class="tag sb">小麦</span>
        <span v-if="s.blind === 'bb'" class="tag bb">大麦</span>
        <div class="seat-name">{{ s.nickname }}</div>
        <div class="seat-nums">
          <span class="g"><i class="i gold"></i>{{ s.goldSeeds }}</span>
          <span class="g"><i class="i seed"></i><span class="s">{{ s.seeds }}</span></span>
        </div>
      </div>
    </div>

    <!-- 操作栏 -->
    <div class="actionbar">
      <button class="collect" :disabled="!has('collect')" @click="confirmCollect">收</button>
      <button class="mid" :disabled="!has(toCall > 0 ? 'call' : 'check')"
              @click="toCall > 0 ? act('call') : act('check')">
        {{ toCall > 0 ? '跟 ' + toCall : '过' }}
      </button>
      <button class="raise" :disabled="!has('raise')"
              @click="onRaiseClick"
              @pointerdown="onLongPressStart"
              @pointerup="onLongPressEnd"
              @pointercancel="onLongPressEnd"
              @pointerleave="onLongPressEnd">加倍</button>
      <button class="fold" :disabled="!has('fold')" @click="confirmFold">弃牌</button>
    </div>
  </div>

  <!-- 挡屏 -->
  <div v-else-if="gate" class="gate">
    <h2>{{ gate }}</h2>
    <p v-if="ROOM">房间号 {{ ROOM }}</p>
    <button class="btn" @click="pull">重试</button>
  </div>

  <!-- 加注弹窗 -->
  <div v-if="sheetOpen" class="mask" @click.self="sheetOpen = false">
    <div class="sheet">
      <h3>{{ raiseNeed > 0 ? '跟注 + 加注' : '加注' }}</h3>
      <div class="need">
        <template v-if="raiseNeed > 0">需跟 <b>{{ raiseNeed }}</b>，再加注下列数额</template>
        <template v-else>当前已平注，直接加注</template>
      </div>
      <div class="preview" :class="{ allin: inputClamped }">共下 {{ raisePreview }}</div>
      <div class="grid">
        <button v-for="p in presets" :key="p.x" @click="pickPreset(p.v)">
          {{ p.v }}<span class="x">{{ p.x }}倍</span>
        </button>
        <button class="allin" :class="{ hot: inputClamped }" @click="allIn">
          All in<span class="x">{{ raiseMax }}</span>
        </button>
      </div>
      <div class="row">
        <input v-model="customInput" type="number" placeholder="自定义追加"
               :class="{ hot: inputClamped }" @input="onCustomInput" />
        <button class="ok" @click="submitCustom">确定</button>
      </div>
      <button class="cancel" @click="sheetOpen = false">取消</button>
    </div>
  </div>

  <!-- 结算弹窗（仅房主可操作，其他人蒙层等待） -->
  <div v-if="settleOpen" class="mask settle">
    <div class="box">
      <h3>本局结束</h3>
      <div class="who">{{ zeroedNames.join('、') }} 瓜子归零</div>
      <template v-if="isHost">
        <button class="b1" @click="settle('restart')">结算并重开</button>
        <button class="b2" @click="settle('disband')">结算并解散</button>
        <button class="b3" @click="settle('pause')">暂停</button>
      </template>
      <button v-else class="b2" disabled>等待房主结算…</button>
    </div>
  </div>

  <!-- 下注流水弹窗 -->
  <div v-if="logOpen" class="mask" @click.self="logOpen = false">
    <div class="sheet">
      <h3>下注流水</h3>
      <div class="loglist">
        <div v-for="(l, i) in (d && d.actionLog ? d.actionLog : [])" :key="i" class="logrow">
          <span>{{ l.nickname }}</span><span class="t">{{ l.type }}</span>
        </div>
        <div v-if="!(d && d.actionLog && d.actionLog.length)" class="logrow">本手还没有下注</div>
      </div>
      <button class="cancel" @click="logOpen = false">关闭</button>
    </div>
  </div>

  <div class="toast" :class="{ show: showToast }">{{ toastMsg }}</div>
</template>

<style scoped>
/* 配色变量在 client/src/styles/main.css 的 :root 里全局定义，这里直接用 */

.page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  max-width: 480px;
  margin: 0 auto;
  background: linear-gradient(160deg, var(--c-bg) 0%, var(--c-bg-deep) 100%);
}

.topbar { height: 52px; display: flex; align-items: center; gap: 8px; padding: 0 12px; }
.back {
  width: 38px; height: 38px; border: none; border-radius: 50%;
  background: var(--c-card); font-size: 22px; line-height: 1; cursor: pointer;
  box-shadow: 0 2px 0 var(--c-border);
}
.room-tag { display: flex; align-items: center; gap: 6px; }
.room-tag .no { font-size: 17px; font-weight: 900; }
.room-tag .host {
  font-size: 10px; font-weight: 800; color: #fff; background: var(--c-primary);
  padding: 2px 7px; border-radius: 7px;
}
.topbar .spacer { flex: 1; }
.iconbtn {
  width: 38px; height: 38px; border: none; border-radius: 50%; font-size: 17px;
  cursor: pointer; background: var(--c-card); box-shadow: 0 2px 0 var(--c-border);
}
.iconbtn.locked { color: var(--c-success); }
.iconbtn.unlocked { color: var(--c-text-light); }
.roundbar { text-align: center; font-size: 12px; color: var(--c-text-light); padding: 2px 0 8px; }
.roundbar b { color: var(--c-text); }

.pool {
  margin: 0 14px 12px; padding: 14px 16px 16px; background: var(--c-card);
  border-radius: 22px; cursor: pointer;
  box-shadow: 0 4px 0 var(--c-border), 0 8px 20px rgba(224, 137, 0, .07);
}
.pool-head { display: flex; align-items: baseline; justify-content: center; gap: 9px; }
.pool-head .nut { font-size: 24px; }
.pool-head .num { font-size: 32px; font-weight: 900; color: var(--c-primary-dark); line-height: 1; }
.pool-head .lbl { font-size: 13px; color: var(--c-text-light); }
.peanuts { display: flex; justify-content: center; gap: 6px; margin-top: 9px; height: 12px; }
.peanut { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--c-border); }
.peanut.on { background: var(--c-gold); border-color: var(--c-primary-dark); }
.bets { margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; }
.bet-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.bet-row .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-border); }
.bet-row .dot.sb { background: var(--c-gold); }
.bet-row .dot.bb { background: var(--c-secondary); }
.bet-row .nm { color: var(--c-text-light); }
.bet-row .val { font-weight: 800; margin-left: auto; }
.bet-row.folded { opacity: .4; }
.paused {
  text-align: center; font-size: 12px; font-weight: 800; color: var(--c-danger);
  background: #ffebee; border-radius: 8px; padding: 4px 8px; margin-top: 10px;
}

/* 四列：8 人也放得下，不用滚 */
.table {
  flex: 1 1 auto; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 0;
  padding: 4px 8px 10px; align-content: start; overflow-y: auto; min-height: 0;
}
.seat {
  position: relative; display: flex; flex-direction: column; align-items: center;
  gap: 3px; cursor: pointer;
}
.avatar {
  width: 58px; height: 58px; border-radius: 50%; border: 3px solid var(--c-border);
  background: var(--c-card); display: flex; align-items: center; justify-content: center;
  transition: transform .12s, border-color .2s, box-shadow .2s;
}
.avatar img { width: 100%; height: 100%; border-radius: 50%; display: block; }
/* 「我」= 浅金描边 */
.seat.me .avatar { border-color: var(--c-accent); box-shadow: 0 0 0 3px rgba(255, 213, 79, .28); }
/* 回合者 = 红圈 + 呼吸脉冲，所有人屏幕上都能看到 */
.seat.turn .avatar { border-color: var(--c-danger); animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 83, 80, .5); }
  50% { transform: scale(1.07); box-shadow: 0 0 0 9px rgba(239, 83, 80, 0); }
}
.seat.folded .avatar { opacity: .45; filter: grayscale(1); }
.seat-name {
  font-size: 12px; font-weight: 700; max-width: 76px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; text-align: center;
}
.seat-nums { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--c-text-light); }
.seat-nums .g { display: flex; align-items: center; gap: 3px; }
.seat-nums .i { width: 9px; height: 9px; border-radius: 50%; }
.seat-nums .i.gold { background: var(--c-gold); }
.seat-nums .i.seed { background: #c9ae85; }
.seat-nums .s { font-weight: 800; color: var(--c-text); font-size: 12px; }
.tag {
  position: absolute; font-size: 9px; font-weight: 800; padding: 1.5px 6px;
  border-radius: 6px; white-space: nowrap;
}
.tag.me {
  left: 50%; transform: translateX(-50%); bottom: 46px;
  background: var(--c-accent); color: #7a5b00;
}
.tag.host { top: -3px; right: 8px; font-size: 14px; background: none; }
.tag.sb { left: 6px; bottom: 46px; background: var(--c-primary); color: #fff; }
.tag.bb { left: 6px; bottom: 46px; background: var(--c-secondary); color: #fff; }
.seat.turn::after {
  content: "决策中"; position: absolute; top: -3px; left: 50%; transform: translateX(-50%);
  background: var(--c-danger); color: #fff; font-size: 9px; font-weight: 800;
  padding: 1.5px 6px; border-radius: 6px;
}

.actionbar { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 7px; padding: 6px 14px 16px; }
.actionbar button {
  height: 60px; border: none; border-radius: 50%; font-size: 15px; font-weight: 800;
  cursor: pointer; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 1px; transition: transform .08s, box-shadow .08s;
}
.actionbar button:active { transform: translateY(3px); box-shadow: none; }
.actionbar button:disabled { opacity: .4; }
.actionbar button.collect {
  background: linear-gradient(180deg, var(--c-primary) 0%, var(--c-primary-dark) 100%);
  color: #fff; box-shadow: 0 4px 0 #c77a00;
}
.actionbar button.mid {
  background: var(--c-card); color: var(--c-primary-dark); box-shadow: 0 4px 0 var(--c-border);
}
.actionbar button.raise {
  background: linear-gradient(180deg, #ffd54f 0%, #ffb300 100%);
  color: #7a5b00; box-shadow: 0 4px 0 #d89b00;
}
.actionbar button.fold {
  background: #e8dcc4; color: var(--c-text-light); box-shadow: 0 4px 0 #cdbe9e;
}

.gate {
  min-height: 100dvh; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 10px; background: var(--c-bg); color: var(--c-text);
}
.gate h2 { font-size: 20px; margin: 0; }
.gate p { color: var(--c-text-light); margin: 0; }
.gate .btn {
  margin-top: 12px; padding: 10px 26px; border: none; border-radius: 14px;
  background: var(--c-primary); color: #fff; font-weight: 800; cursor: pointer;
}

.mask {
  position: fixed; inset: 0; background: rgba(93, 64, 55, .5); display: flex;
  align-items: flex-end; justify-content: center; z-index: 20;
}
.sheet {
  width: 100%; max-width: 480px; background: var(--c-bg); border-radius: 26px 26px 0 0;
  padding: 20px 18px 24px; animation: up .22s ease-out;
}
@keyframes up { from { transform: translateY(30px); opacity: .3; } to { transform: none; opacity: 1; } }
.sheet h3 { margin: 0 0 6px; font-size: 17px; text-align: center; }
.need { text-align: center; font-size: 13px; color: var(--c-text-light); margin-bottom: 10px; }
.need b { color: var(--c-danger); }
.preview { text-align: center; font-size: 26px; font-weight: 900; color: var(--c-primary-dark); padding: 8px 0 14px; }
.preview.allin { color: var(--c-danger); }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.grid button {
  height: 54px; border: none; border-radius: 14px; background: var(--c-card);
  font-size: 17px; font-weight: 900; color: var(--c-primary-dark); cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  box-shadow: 0 3px 0 var(--c-border);
}
.grid button .x { font-size: 10px; font-weight: 700; color: var(--c-text-light); }
.grid button.allin {
  background: linear-gradient(180deg, #ffd54f 0%, #ffb300 100%);
  color: #7a5b00; box-shadow: 0 3px 0 #d89b00;
}
.grid button.allin.hot {
  background: linear-gradient(180deg, #ef5350 0%, #d32f2f 100%);
  color: #fff; box-shadow: 0 3px 0 #b71c1c;
}
.row { display: flex; gap: 8px; margin-top: 12px; }
.row input {
  flex: 1; height: 46px; border: 2px solid var(--c-border); border-radius: 14px;
  padding: 0 14px; font-size: 16px; font-weight: 800; background: var(--c-card);
  color: var(--c-text); text-align: center;
}
.row input.hot { border-color: var(--c-danger); color: var(--c-danger); }
.row .ok {
  width: 88px; height: 46px; border: none; border-radius: 14px; background: var(--c-primary);
  color: #fff; font-weight: 800; font-size: 15px; cursor: pointer;
}
.cancel {
  width: 100%; margin-top: 12px; height: 44px; border: none; border-radius: 14px;
  background: transparent; color: var(--c-text-light); font-weight: 700; cursor: pointer;
}

.settle .box {
  width: 86%; max-width: 360px; margin: auto; background: var(--c-bg);
  border-radius: 24px; padding: 24px 20px; text-align: center;
}
.settle h3 { margin: 0 0 8px; font-size: 19px; }
.settle .who { font-size: 14px; color: var(--c-danger); font-weight: 700; margin-bottom: 18px; }
.settle button {
  display: block; width: 100%; height: 48px; margin-bottom: 10px; border: none;
  border-radius: 14px; font-size: 15px; font-weight: 800; cursor: pointer;
}
.settle .b1 {
  background: linear-gradient(180deg, var(--c-primary) 0%, var(--c-primary-dark) 100%);
  color: #fff;
}
.settle .b2 { background: #e8dcc4; color: var(--c-text-light); }
.settle .b3 { background: var(--c-card); color: var(--c-text); box-shadow: 0 2px 0 var(--c-border); }

.loglist { max-height: 46vh; overflow-y: auto; }
.logrow {
  display: flex; justify-content: space-between; padding: 10px 4px;
  border-bottom: 1px solid var(--c-border); font-size: 14px;
}
.logrow .t { font-weight: 800; color: var(--c-primary-dark); }

.toast {
  position: fixed; left: 50%; bottom: 104px; transform: translateX(-50%);
  background: rgba(93, 64, 55, .94); color: #fff; font-size: 13px; padding: 9px 16px;
  border-radius: 12px; opacity: 0; transition: opacity .2s; pointer-events: none;
  z-index: 30; max-width: 78%;
}
.toast.show { opacity: 1; }
</style>
