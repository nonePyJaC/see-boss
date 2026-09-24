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

import { ref, computed, watch, reactive, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { roomRepo } from '../data/room-repo.js'
import { accountRepo } from '../data/account-repo.js'
import { useHamsters } from '../composables/useHamsters.js'
import RoomQR from '../components/RoomQR.vue'
import { askConfirm } from '../composables/useConfirm.js'

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
const adjustMode = ref(true)    // 调整模式：true=可设小麦位/拖拽（开锁），false=锁定准备开始
const gate = ref('')            // 挡屏文案（连不上/未登录）
const toastMsg = ref('')
const showToast = ref(false)

// 弹窗
const sheetOpen = ref(false)    // 加注弹窗
const settleOpen = ref(false)   // 结算弹窗
const logOpen = ref(false)      // 下注流水弹窗
const inviteOpen = ref(false)   // 邀请二维码弹窗
const orderMode = ref(false)    // 拖拽换座模式（房主 + 开锁）
const giveOpen = ref(false)     // 暂停中「出瓜子」弹窗
const giveAmount = ref('')      // 出多少（进公共池）
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

/** 邀请二维码的落地地址：/#/join/<房间号>?mode=offline。
 *  JoinView 会真调 /api/room/join 入座，所以别人扫完直接进。 */
function inviteURL() {
  return location.origin + location.pathname + '#/join/' + roomId() + '?mode=offline'
}

function openInvite() {
  if (!roomId()) return toast('房间号还没拿到')
  inviteOpen.value = true
}

async function copyInvite() {
  const url = inviteURL()
  try {
    await navigator.clipboard.writeText(url)
    toast('链接已复制')
  } catch {
    // 微信里 clipboard API 常被禁，退回让用户手动选
    toast('复制失败，请手动记下房间号 ' + roomId())
  }
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
  // 结算弹窗跟着 settlePending 双向同步：房主重置/解散后
  // settlePending 变 false，非房主的「等待房主结算」蒙层必须
  // 一起收掉。之前只置 true 不置 false，非房主蒙层卡死整局
  // （实测踩过）。
  settleOpen.value = !!r.data.settlePending
}

function onPollError(r) {
  gate.value = r.error || '连不上房间'
}

// ── 操作 ──
function act(type, amount) {
  return roomRepo.roomAction(roomId(), type, amount).then(pull)
}

/** 收池：二次确认。收回不可逆，必须先问。
 *  用页面内的确认框而不是 window.confirm —— 部分手机浏览器
 *  （iOS 微信 WebView 等）会把原生 confirm 渲染成带「确定/离开页面」
 *  的系统弹窗，看着像要跳出应用，容易误点。 */
function confirmCollect() {
  const pot = d.value?.pot ?? 0
  let msg = '收走公共池 ' + pot + '？收掉后本手结束'
  if (zeroedNames.value.length) {
    msg += '，并触发结算（' + zeroedNames.value.join('、') + ' 已归零）'
  }
  askConfirm({ title: '收池', msg, okText: '收' }).then((yes) => {
    if (!yes) return
    act('collect').then((x) => { if (!x.ok) toast(x.error) })
  })
}

function confirmFold() {
  askConfirm({ title: '弃牌', msg: '确定弃牌？本手不再参与', okText: '弃牌' }).then((yes) => {
    if (!yes) return
    act('fold')
  })
}

/**
 * 房主的桌上控制：锁 / 排序 / 开始|暂停|继续。
 *
 * 状态机（2026-09-24 定稿）：
 *
 *   未开局（建房后 / 结算重置后）
 *     · 锁可点 → 开锁 → 设小麦位 + 拖拽排序 → 关锁 → 点「开始」
 *     · 开始 = 按当前小麦位自动下大小麦，进入对局
 *
 *   对局中
 *     · 锁不可点（正在打，改了顺序/小麦位回合就算乱了）
 *     · 按钮变「暂停」→ 点它进暂停态
 *
 *   暂停中
 *     · 锁又可点 → 开锁 → 改小麦位 / 排序 → 关锁 → 点「继续」
 *     · 继续 = 原样恢复（currentBet / turnUid / 已表态 全部保留）
 *
 *   有人归零结算后 → 回到未开局态，按钮变回「开始」
 *
 * 开锁的前置条件 = 不在回合中（未开局 或 暂停）。
 */

/** 能不能开锁：未开局，或暂停中。对局中不行 */
const canLock = computed(() => {
  if (!isHost.value || !d.value) return false
  if (d.value.paused) return true
  // 没有回合者 + 本手没结束 = 还没开局
  return !d.value.turnUid && !d.value.finished
})

/** 房主主按钮：开始 / 暂停 / 继续 */
const hostAction = computed(() => {
  if (!d.value) return 'start'
  if (d.value.paused) return 'resume'
  if (d.value.finished) return 'start'
  // 有回合者 = 正在打
  if (d.value.turnUid) return 'pause'
  return 'start'
})

function toggleLock() {
  if (!canLock.value) {
    return toast('对局中不能改，先暂停')
  }
  adjustMode.value = !adjustMode.value
  orderMode.value = false
  resetDrag()
  toast(adjustMode.value ? '已开锁：可设小麦位、可拖动换座' : '已关锁：点「开始/继续」')
}

/** 拖拽换座模式开关（房主 + 开锁状态） */
function toggleOrder() {
  if (!isHost.value) return toast('只有房主能调整座位')
  if (!adjustMode.value) return toast('先开锁才能调整座位')
  orderMode.value = !orderMode.value
  if (!orderMode.value) resetDrag()
}

function resetDrag() {
  drag.uid = ''
  drag.active = false
  drag.target = ''
}

/**
 * 点玩家设小麦位（房主 + 开锁 + 未开局）。
 *
 * 未开局时 /start 就是「设小麦位并下盲注」，所以点完会直接进入对局 ——
 * 这是预期行为：桌边人坐好了，房主点一个人当小麦，立刻开局。
 * 暂停中不让点（盲注已下，改了下一个该谁动就乱了）。
 */
function tapSeat(seat) {
  if (!isHost.value) return toast('只有房主能设置')
  if (!adjustMode.value) return toast('先开锁才能设置小麦位')
  if (d.value?.paused) return toast('暂停中不能改小麦位')
  const i = seats.value.findIndex((s) => s.uid === seat.uid)
  roomRepo.startRoom(roomId(), i).then((x) => {
    if (x.ok) {
      // 开局后自动关锁，锁图标变灰不可点，主按钮变「暂停」
      adjustMode.value = false
      orderMode.value = false
      resetDrag()
      toast('小麦位已设置，已开局')
      pull()
    } else {
      toast(x.error || '设置失败')
    }
  })
}

/** 房主主按钮：开始 / 暂停 / 继续 */
function hostMainAction() {
  const a = hostAction.value
  if (a === 'start') {
    if (!isHost.value) return toast('只有房主能开局')
    if (adjustMode.value) return toast('先关锁再开始')
    // 已经有人被点成小麦了就用他，否则默认第一个
    const sb = seats.value.findIndex((s) => s.blind === 'sb')
    roomRepo.startRoom(roomId(), sb >= 0 ? sb : 0).then((x) => {
      if (x.ok) {
        toast('已开局，小麦位自动下注')
        pull()
      } else {
        toast(x.error)
      }
    })
    return
  }
  // pause / resume 同一个接口，服务端按当前 paused 状态切换
  roomRepo.pauseRoom(roomId()).then((x) => {
    if (!x.ok) return toast(x.error)
    // 继续时池子为空 → 服务端不直接开局，先回来问房主
    // 「池子为空，是否开启新一轮」。确认后带 confirmNextHand 再调一次。
    if (x.data?.needConfirmNextHand) {
      askConfirm({
        title: '继续',
        msg: '当前池子为空，是否开启新的一轮？',
        okText: '开新一轮',
      }).then((yes) => {
        if (!yes) return pull()   // 取消 → 停在暂停态
        roomRepo.pauseRoom(roomId(), { confirmNextHand: true }).then((y) => {
          if (y.ok) {
            adjustMode.value = false; orderMode.value = false; resetDrag()
            pull()
          } else toast(y.error)
        })
      })
      return
    }
    // 继续时池子有值 → 服务端不直接回滚，先回来问房主
    // 「池子有 xxx 瓜子，即将回到 X 的行动位」。确认后带 confirmRollback 再调一次。
    if (x.data?.needConfirmRollback) {
      const pot = x.data.rollbackPot ?? 0
      const who = x.data.rollbackTurnName
      askConfirm({
        title: '继续',
        msg: who
          ? `当前池子有 ${pot} 瓜子，即将回到 ${who} 的行动位`
          : `当前池子有 ${pot} 瓜子，继续本局？`,
        okText: who ? '回滚' : '继续',
      }).then((yes) => {
        if (!yes) return pull()   // 取消 → 停在暂停态
        roomRepo.pauseRoom(roomId(), { confirmRollback: true }).then((y) => {
          if (y.ok) {
            adjustMode.value = false; orderMode.value = false; resetDrag()
            pull()
          } else toast(y.error)
        })
      })
      return
    }
    toast(a === 'pause' ? '已暂停' : '已继续')
    // 恢复对局时自动关锁，免得房主忘了还停在调整模式
    if (a === 'resume') { adjustMode.value = false; orderMode.value = false; resetDrag() }
    pull()
  })
}

// ── 拖拽换座 ──
// 用 Pointer Events 而不是 HTML5 drag&drop：后者在 iOS Safari /
// 微信 WebView 上根本不触发，Pointer Events 一套 API 同时覆盖
// 鼠标、手指、触控笔。
const drag = reactive({ uid: '', active: false, target: '', x: 0, y: 0 })
const DRAG_THRESHOLD = 8 // px，超过才算「真拖动」，否则算点击

function onSeatPointerDown(e, seat) {
  if (!orderMode.value || !isHost.value) return
  drag.uid = seat.uid
  drag.x = e.clientX
  drag.y = e.clientY
  drag.active = false
  drag.target = ''
  // 让后续 move/up 都发到这张卡上，手指移出卡片也不丢事件
  e.currentTarget?.setPointerCapture?.(e.pointerId)
}

function onSeatPointerMove(e) {
  if (!drag.uid) return
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return
    drag.active = true
  }
  // 找出手指下方的卡片
  const el = document.elementFromPoint(e.clientX, e.clientY)
  const card = el?.closest?.('.seat')
  drag.target = card?.dataset?.uid && card.dataset.uid !== drag.uid ? card.dataset.uid : ''
}

async function onSeatPointerUp() {
  if (!drag.uid) return
  const from = drag.uid
  const to = drag.target
  drag.uid = ''
  drag.active = false
  drag.target = ''
  if (!to || to === from) return

  const order = seats.value.map((s) => s.uid)
  const i = order.indexOf(from)
  const j = order.indexOf(to)
  if (i < 0 || j < 0) return
  order.splice(i, 1)
  order.splice(j, 0, from)
  const r = await roomRepo.reorderSeats(roomId(), order)
  if (r.ok) {
    toast('座位已调整')
    pull()
  } else {
    toast(r.error || '调整座位失败')
  }
}

function onSeatPointerCancel() {
  drag.uid = ''
  drag.active = false
  drag.target = ''
}

// ── 暂停中「出瓜子」──
// 暂停态所有人操作栏只有「收 / 出」两个中性键。出 = 把手上的瓜子
// 投进公共池（不指定接收人）。分池靠「收（池→人）+ 出（人→池）」
// 自由组合：该给谁补多少，由被补的人自己点收拿走。
const giveMax = computed(() => mySeeds.value)

function openGive() {
  if (!d.value?.paused) return toast('只有暂停中才能出瓜子')
  giveAmount.value = ''
  giveOpen.value = true
}

function submitGive() {
  const amt = Math.floor(Number(giveAmount.value))
  if (!Number.isFinite(amt) || amt <= 0) return toast('出多少要大于 0')
  if (amt > giveMax.value) return toast('手上只有 ' + giveMax.value)
  roomRepo.roomAction(roomId(), 'give', amt).then((x) => {
    if (!x.ok) return toast(x.error)
    giveOpen.value = false
    toast('已出 ' + amt + ' 进池子')
    pull()
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
  // 手上瓜子不够平注时，「加注」唯一的可能就是全下 ——
  // 直接当 call-allin 打出去，别让弹窗变成死路。
  // 「all in 不需要做判断，手上有多少下多少」（实测口径）。
  if (raiseMax.value <= 0) {
    sheetOpen.value = false
    return act('call').then((x) => {
      if (x.ok) toast('全下 ' + mySeeds.value)
      else toast(x.error)
    })
  }
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
  <div v-if="d" class="page">
    <div class="topbar">
      <button class="back" @click="router.back()">←</button>
      <!-- 房间号可点 → 弹邀请二维码 -->
      <button class="room-tag" @click="openInvite">
        <span class="no">{{ d.id }}</span>
        <span v-if="isHost" class="host">房主</span>
        <span class="qricon" title="扫码邀请">▣</span>
      </button>
      <div class="spacer"></div>
      <!-- 房主：排序 + 锁 + 开始|暂停|继续
           adjustMode=true（开锁）→ ⇅ 可点，锁图标显示 🔓
           adjustMode=false（关锁）→ ⇅ 藏起来，锁图标显示 🔒       -->
      <template v-if="isHost">
        <button v-if="adjustMode && canLock" class="iconbtn" :class="orderMode ? 'on' : 'unlocked'"
                @click="toggleOrder">
          {{ orderMode ? '✓' : '⇅' }}
        </button>
        <button class="iconbtn" :class="canLock ? (adjustMode ? 'unlocked' : 'locked') : 'disabled'"
                @click="toggleLock">
          {{ adjustMode ? '🔓' : '🔒' }}
        </button>
        <button class="startbtn" :class="hostAction" @click="hostMainAction">
          {{ hostAction === 'start' ? '开始' : hostAction === 'pause' ? '暂停' : '继续' }}
        </button>
      </template>
    </div>

    <div v-if="isHost && adjustMode && canLock" class="lockbar">
      {{ orderMode ? '拖动卡片换座位，点 ✓ 完成' : '点玩家设小麦位，点 ⇅ 换座位' }}
    </div>
    <div v-else-if="d.paused" class="lockbar paused-bar">已暂停 · 房主可开锁调整</div>

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
    <div class="table" :class="{ ordering: orderMode }">
      <div v-for="s in seats" :key="s.uid" class="seat"
           :class="{ me: s.uid === uid, turn: s.uid === d.turnUid, folded: s.folded,
                     dragging: orderMode && drag.uid === s.uid && drag.active,
                     over: orderMode && drag.target === s.uid }"
           :data-uid="s.uid"
           @click="tapSeat(s)"
           @pointerdown="onSeatPointerDown($event, s)"
           @pointermove="onSeatPointerMove"
           @pointerup="onSeatPointerUp"
           @pointercancel="onSeatPointerCancel">
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

    <!-- 操作栏：暂停态只有「收 / 出」，正常态是 收/跟|过/加倍/弃 -->
    <div v-if="d.paused" class="actionbar actionbar--paused">
      <button class="collect" :disabled="!has('collect')" @click="confirmCollect">收</button>
      <button class="give" :disabled="!has('give')" @click="openGive">出</button>
    </div>
    <div v-else class="actionbar">
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

  <!-- 邀请二维码弹窗 -->
  <div v-if="inviteOpen" class="mask" @click.self="inviteOpen = false">
    <div class="sheet invite">
      <h3>邀请加入</h3>
      <p class="invite-tip">扫码或把房间号发给朋友</p>
      <RoomQR :room-no="roomId()" :size="200" mode="offline" />
      <div class="invite-no">{{ roomId() }}</div>
      <button class="ok" @click="copyInvite">复制链接</button>
      <button class="cancel" @click="inviteOpen = false">关闭</button>
    </div>
  </div>

  <!-- 暂停中「出瓜子」弹窗：投进公共池，谁该补谁自己收 -->
  <div v-if="giveOpen" class="mask" @click.self="giveOpen = false">
    <div class="sheet">
      <h3>出瓜子进池子</h3>
      <p class="hint">我手上有 {{ giveMax }}，出到公共池；该补的人自己收走</p>
      <div class="row">
        <input v-model="giveAmount" type="number" min="1" :max="giveMax" placeholder="数量" />
        <button class="ok" @click="submitGive">确定</button>
      </div>
      <button class="cancel" @click="giveOpen = false">取消</button>
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
.room-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  padding: 4px 6px;
  border-radius: 10px;
  cursor: pointer;
}
.room-tag:active { background: rgba(255, 255, 255, .6); }
.room-tag .no { font-size: 17px; font-weight: 900; }
.room-tag .host {
  font-size: 10px; font-weight: 800; color: #fff; background: var(--c-primary);
  padding: 2px 7px; border-radius: 7px;
}
/* 房间号旁边的扫码图标：二维码入口藏得太深，实测没人找到 */
.room-tag .qricon {
  font-size: 14px;
  color: var(--c-primary-dark);
  margin-left: 2px;
}
.topbar .spacer { flex: 1; }
.iconbtn {
  width: 38px; height: 38px; border: none; border-radius: 50%; font-size: 17px;
  cursor: pointer; background: var(--c-card); box-shadow: 0 2px 0 var(--c-border);
}
.iconbtn.locked { color: var(--c-success); }
.iconbtn.unlocked { color: var(--c-text-light); }
.iconbtn.on { color: var(--c-primary-dark); background: #fff6e0; }
.iconbtn.disabled { opacity: .35; cursor: not-allowed; }
/* 关锁后出现的「开始」按钮 */
.startbtn {
  height: 38px;
  padding: 0 15px;
  border: none;
  border-radius: 19px;
  font-size: 14px;
  font-weight: 900;
  cursor: pointer;
  box-shadow: 0 3px 0 rgba(0, 0, 0, .18);
}
.startbtn:active { transform: translateY(2px); box-shadow: none; }
.startbtn.start {
  background: linear-gradient(180deg, var(--c-primary) 0%, var(--c-primary-dark) 100%);
  color: #fff;
}
.startbtn.pause {
  background: linear-gradient(180deg, #ffb74d 0%, #f57c00 100%);
  color: #fff;
}
.startbtn.resume {
  background: linear-gradient(180deg, #81c784 0%, #43a047 100%);
  color: #fff;
}
/* 开锁时的一行提示 */
.lockbar {
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--c-primary-dark);
  background: #fff6e0;
  border-radius: 9px;
  margin: 0 14px 8px;
  padding: 5px 10px;
}
.lockbar.paused-bar {
  color: #e65100;
  background: #fff3e0;
}
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
/* 拖拽换座 */
.table.ordering .seat { cursor: grab; }
.seat.dragging { opacity: .4; }
.seat.dragging .avatar { transform: scale(1.1); }
.seat.over .avatar { border-color: var(--c-primary); box-shadow: 0 0 0 4px rgba(246, 166, 35, .3); }
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

/* 暂停态：只有两个按钮，各占一半 */
.actionbar--paused { grid-template-columns: 1fr 1fr; }
.actionbar button.give {
  background: linear-gradient(180deg, #81c784 0%, #43a047 100%);
  color: #fff; box-shadow: 0 4px 0 #2e7d32;
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

/* 「出瓜子」弹窗 */
.give-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
.give-list button {
  height: 48px;
  border: 2px solid var(--c-border);
  border-radius: 14px;
  background: var(--c-card);
  font-size: 14px;
  font-weight: 800;
  color: var(--c-text);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}
.give-list button.on {
  border-color: var(--c-primary);
  background: #fff6e0;
  color: var(--c-primary-dark);
}
.give-list button .x { font-size: 10px; font-weight: 700; color: var(--c-text-light); }
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

/* 邀请弹窗 */
.invite { text-align: center; }
.invite-tip { margin: 0 0 14px; font-size: 13px; color: var(--c-text-light); }
.invite-no {
  margin: 14px 0 12px; font-size: 28px; font-weight: 900; letter-spacing: 6px;
  color: var(--c-primary-dark);
}
.invite .ok {
  width: 100%; height: 46px; border: none; border-radius: 14px;
  background: var(--c-primary); color: #fff; font-weight: 800; font-size: 15px;
  cursor: pointer;
}
</style>
