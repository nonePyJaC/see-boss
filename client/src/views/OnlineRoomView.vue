<script setup>
/**
 * 线上对局房间 —— 服务端权威版
 *
 * 架构说明（V1 规格落地）：
 *   牌局只跑在服务端（server/index.js），本页只渲染状态投影 + 发动作。
 *   浏览器本地不再持有引擎，断线刷新靠 seatToken 重连回同一座位。
 *
 * 身份：uid 只是设备资料；座位身份 = localStorage 里按房间号存的
 *   { seatId, seatToken }（hamster-poker:seat:<roomId>）。
 *   令牌丢了/座位没了 → 只能旁观，等两手之间再入座。
 *
 * 状态机（看服务端投影，不自造阶段）：
 *   无 state / phase=idle          → 等人：座位表 + 二维码 + 房主开局
 *   !finished                      → 对局中：牌桌 + 动作 + 倒计时
 *   finished                       → 摊牌结果 + 下一手/终局面板
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { hamsterDataURI, getHamster } from '@shared/assets/hamsters.mjs'
import { cardSVG, svgToDataURI } from '@shared/assets/visuals.mjs'
import { useUser } from '../stores/user.js'
import SeedChips from '../components/SeedChips.vue'
import RoomQR from '../components/RoomQR.vue'
import JoinRoomPanel from '../components/JoinRoomPanel.vue'
import { askConfirm } from '../composables/useConfirm.js'
import {
  roomRepo,
  createOnlineRoom, joinRoom, onlineState, onlineAction,
  onlineExtendTurn, onlineReset, onlineLeave, startRoom,
  addAi, removeAi,
  loadSeatCred, saveSeatCred, clearSeatCred,
} from '../data/room-repo.js'
import { ACTION_LABEL } from '@shared/logic/betting.mjs'
import { evaluate } from '@shared/logic/hand-evaluator.mjs'
import { potLayerView } from '../lib/pot-layer-view.js'

defineOptions({ name: 'OnlineRoomView' })

const router = useRouter()
const route = useRoute()
const { user, refresh } = useUser()

/** 目标房间：?room=N（在房内）或 ?join=N（注册回跳/直达链接） */
const ROOM = computed(() => String(route.query.room || route.query.join || '').trim())

// ── 页面模式：setup（建房表单）| room（在房/旁观）| gone（房间失效）──
const mode = ref(ROOM.value ? 'room' : 'setup')
/** 顶部房间信息：默认折叠，点开才显示盲注/二维码 */
const headOpen = ref(false)
/** 二维码点击放大 */
const qrZoom = ref(false)

// ── 建房表单 ──
const setupTab = ref('create')        // create | join
const createCode = ref('')
const initialSeeds = ref(3000)
const customSeeds = ref('')
const smallBlind = ref(10)
const bigBlind = ref(20)
const gameType = ref('long')
const createBusy = ref(false)
const createError = ref('')

// 盲注联动（与线下入口同口径）：只填小麦，大麦 = 小麦 × 2；
// 大麦上限 = 初始瓜子 ÷ 10（至少留 10 个大麦），换入场数自动收敛。
const formSeeds = computed(() => {
  const c = Number(customSeeds.value)
  return Number.isFinite(c) && c > 0 ? Math.floor(c) : initialSeeds.value
})
const bbMax = computed(() => Math.max(2, Math.floor(formSeeds.value / 10)))
const formSettingError = computed(() => {
  if (!(formSeeds.value > 0)) return '初始瓜子要大于 0'
  if (!(smallBlind.value > 0)) return '小麦要大于 0'
  if (bigBlind.value % 2 !== 0) return '大麦必须是偶数（小麦 = 大麦 ÷ 2）'
  if (bigBlind.value <= smallBlind.value) return '大麦必须大于小麦'
  if (bigBlind.value > bbMax.value) return `大麦不能超过 ${bbMax.value}（初始瓜子 ÷ 10，至少留 10 个大麦）`
  return ''
})
function onBlindInput() {
  const sb = Math.floor(Number(smallBlind.value))
  if (Number.isFinite(sb) && sb > 0) bigBlind.value = sb * 2
}
watch(formSeeds, () => {
  if (bigBlind.value > bbMax.value) {
    const bb = Math.max(2, bbMax.value - (bbMax.value % 2))
    bigBlind.value = bb
    smallBlind.value = bb / 2
  }
})

// ── 房间状态（全部来自服务端投影）──
const d = ref(null)
const cred = ref(null)            // { seatId, seatToken } | null
const offline = ref(false)        // 连续轮询失败 → 断线横幅（绝不自动离开）
const gate = ref('')              // 房间不存在/令牌失效等致命态文案
const joinDenied = ref('')        // ROOM_FULL 之类 → 不再自动重试
const curRoom = ref('')           // 当前已绑定的房号（防重复绑定）

let watcher = null
let joinBusy = false

const seats = computed(() => d.value?.seats ?? [])
// 以服务端认证后的 isMe 为准；本地 seatId 只用于随请求提交，不能证明令牌有效。
const mySeat = computed(() => seats.value.find((s) => s.isMe) ?? null)
const mySeatId = computed(() => mySeat.value?.uid ?? null)
/** 有座位 = 参与者视角；没有 = 旁观者投影 */
const isSpectator = computed(() => !!d.value && !mySeat.value)
const isHost = computed(() => !!d.value && !!mySeatId.value && d.value.hostUid === mySeatId.value)
const inHand = computed(() => !!d.value && !d.value.finished && d.value.phase !== 'idle')
const handFinished = computed(() => !!d.value?.finished)
const myCards = computed(() => d.value?.myCards ?? [])
const avail = computed(() => d.value?.avail ?? [])
const isMyTurn = computed(() => isSpectator.value === false && !!d.value && d.value.turnUid === mySeatId.value && !d.value.finished)
const aliveCount = computed(() => seats.value.filter((s) => (s.seeds ?? 0) > 0).length)
/** 终局：本手结束后只剩 ≤1 个有筹码座位 → 房主重开或解散 */
const matchOver = computed(() => handFinished.value && aliveCount.value < 2)
const canStartNext = computed(() => handFinished.value && aliveCount.value >= 2)

/** 椭圆桌座位顺序：我在最底部，其余按座位（行动）顺序顺时针铺开 */
const ovalSeats = computed(() => {
  const arr = seats.value
  const myIdx = arr.findIndex((s) => s.uid === mySeatId.value)
  if (myIdx <= 0) return arr
  return [...arr.slice(myIdx), ...arr.slice(0, myIdx)]
})
/** 第 i 个座位在椭圆上的位置（90° = 底部，顺时针 = 行动顺序） */
function ovalStyle(i, n) {
  const a = ((90 + (360 / n) * i) * Math.PI) / 180
  return { left: (50 + 40 * Math.cos(a)) + '%', top: (50 + 40 * Math.sin(a)) + '%' }
}

const PHASE_LABEL = {
  idle: '等待开始', preflop: '翻牌前', flop: '翻牌圈',
  turn: '转牌圈', river: '河牌圈', showdown: '摊牌',
}
const phaseLabel = computed(() => PHASE_LABEL[d.value?.phase] ?? '')

// ── 倒计时：deadlineAt 是服务端给的绝对时间，本地只做展示 ──
const nowTick = ref(Date.now())
let ticker = null
const secsLeft = computed(() => {
  const t = d.value?.deadlineAt
  if (!t || d.value?.finished) return null
  return Math.max(0, Math.ceil((t - nowTick.value) / 1000))
})
const turnSeat = computed(() => seats.value.find((s) => s.uid === d.value?.turnUid) ?? null)

// ── 行动流水：只显示当前下注轮 ──
const recentActions = computed(() => {
  const st = d.value
  if (!st) return []
  const log = (st.actionLog ?? []).filter((a) => a.phase === st.phase)
  return log.slice(-6).reverse()
})
const lastAggression = computed(() => {
  const st = d.value
  if (!st) return null
  return [...(st.actionLog ?? [])].reverse()
    .find((a) => a.type === 'raise' || a.type === 'bet' || a.type === 'allin') ?? null
})
const lastActionByUid = computed(() => {
  const map = {}
  for (const a of d.value?.actionLog ?? []) map[a.uid] = a
  return map
})

// 结算奖池层视图：分类标签与实际到账分离，金额只来自权威 awards（pot-layer-view.js）
const resultLayerViews = computed(() =>
  (d.value?.result?.potLayers ?? []).map((layer, index) => ({ layer, view: potLayerView(layer, index) })),
)
function historyLayerViews(record) {
  return (record?.result?.potLayers ?? []).map((layer, index) => ({ layer, view: potLayerView(layer, index) }))
}

/** 我的牌型预览（公共牌 ≥3 张才算得出来） */
const myHandName = computed(() => {
  const cards = myCards.value
  const board = d.value?.communityCards ?? []
  if (cards.length < 2 || board.length < 3) return ''
  return evaluate([...cards, ...board], d.value?.gameType ?? 'long').name
})

// ── 加注弹窗 ──
const raiseOpen = ref(false)
const raiseInput = ref('')
const raiseError = ref('')
const raiseMin = computed(() => (d.value?.currentBet ?? 0) + (d.value?.minRaise ?? 0))
const raiseMax = computed(() => (mySeat.value?.bet ?? 0) + (mySeat.value?.seeds ?? 0))

/** 底部三个按钮：弃牌 / 动态「过·跟」 / 加注（仿线下） */
const foldAction = computed(() => avail.value.find((a) => a.type === 'fold') ?? null)
const midAction = computed(() => {
  const a = avail.value
  const check = a.find((x) => x.type === 'check')
  if (check) return { type: 'check', label: '过' }
  const call = a.find((x) => x.type === 'call')
  if (call) return { type: 'call', amount: call.amount, label: `跟 ${call.amount}` }
  return null
})
const canRaise = computed(() => avail.value.some((a) => a.type === 'raise' || a.type === 'allin'))

/** 全下是否够不到最小加注额（只能 all-in，不能常规加注） */
const raiseAllInOnly = computed(() => raiseMin.value >= raiseMax.value)

/** 弹窗范围提示：常规加注给区间；只能全下时直说 */
const raiseRangeText = computed(() => {
  if (raiseAllInOnly.value) {
    return `筹码不足最小加注额，只能全下 ${raiseMax.value}`
  }
  return `可设范围 ${raiseMin.value} ~ ${raiseMax.value}`
})

/** 弹窗快捷档位：最小 / 半池 / 满池 / 全下（池底按含跟注的标准公式折算） */
const quickRaiseTargets = computed(() => {
  const st = d.value
  if (!st || !canRaise.value) return []
  const minFull = raiseMin.value
  const max = raiseMax.value
  if (!(max > 0)) return []
  // 够不到最小加注额 → 只给全下（引擎也只在此时提供 allin）
  if (minFull >= max) return [{ label: '全下', v: max, allin: true }]
  const call = Math.max(0, (st.currentBet ?? 0) - (mySeat.value?.bet ?? 0))
  const pot = st.pot ?? 0
  const of = (f) => Math.min(max, Math.max(minFull, Math.round((pot + call) * f + (st.currentBet ?? 0) + call)))
  const list = [
    { label: '最小', v: minFull },
    { label: '半池', v: of(0.5) },
    { label: '满池', v: of(1) },
    { label: '全下', v: max, allin: true },
  ]
  // 去重：同额只留一个；撞车时全下标签优先（数额 = 全部筹码时更准确）
  const byValue = new Map()
  for (const x of list) {
    const prev = byValue.get(x.v)
    if (!prev || (x.allin && !prev.allin)) byValue.set(x.v, x)
  }
  return [...byValue.values()].sort((a, b) => a.v - b.v)
})

function openRaise() {
  // 默认填「合法下限」：常规加注填最小额；只能全下时直接填全下额
  raiseInput.value = String(Math.min(raiseMin.value, raiseMax.value))
  raiseError.value = ''
  raiseOpen.value = true
}
function confirmRaise() {
  const n = Number(raiseInput.value)
  const max = raiseMax.value
  if (!Number.isFinite(n) || n <= 0) { raiseError.value = '金额无效'; return }
  if (raiseAllInOnly.value) {
    if (n !== max) { raiseError.value = `不足最小加注额，只能全下 ${max}`; return }
    raiseOpen.value = false
    act('allin')
    return
  }
  if (n < raiseMin.value) { raiseError.value = `不能小于 ${raiseMin.value}`; return }
  if (n > max) { raiseError.value = `不能超过 ${max}`; return }
  raiseOpen.value = false
  // 恰好等于全部筹码 → 走 allin（语义更准，引擎也按全下处理）
  if (n === max) act('allin')
  else act('raise', n)
}

function actionLabel(a) {
  const base = ACTION_LABEL[a.type] ?? a.type
  if (a.type === 'fold' || a.type === 'check') return base
  return `${base} ${a.amount}`
}
function avatarURI(id) { return hamsterDataURI(getHamster(id), 64) }
function cardURI(code, faceDown = false) { return svgToDataURI(cardSVG(code, 60, faceDown)) }
function resultNames(uids = []) {
  const hands = d.value?.result?.hands ?? []
  return uids.map((uid) => hands.find((h) => h.uid === uid)?.nickname).filter(Boolean).join('、') || '无'
}
function historyNames(record, uids = []) {
  const hands = record?.result?.hands ?? []
  return uids.map((uid) => hands.find((h) => h.uid === uid)?.nickname).filter(Boolean).join('、') || '无'
}
function rankLabel(value) {
  return ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 1: 'A' })[value] ?? String(value)
}
function handSummary(hand) {
  if (!hand) return ''
  const k = hand.kickers ?? []
  if (hand.name === '两对' && k.length >= 3) return `两对（${rankLabel(k[0])}、${rankLabel(k[1])}；${rankLabel(k[2])} 踢脚）`
  if (hand.name === '一对' && k.length > 1) return `一对（${rankLabel(k[0])}；${k.slice(1).map(rankLabel).join('、')} 踢脚）`
  if (hand.name === '三条' && k.length > 1) return `三条（${rankLabel(k[0])}；${k.slice(1).map(rankLabel).join('、')} 踢脚）`
  if (hand.name === '葫芦' && k.length > 1) return `葫芦（${rankLabel(k[0])} 带 ${rankLabel(k[1])}）`
  if (k.length) return `${hand.name}（${k.map(rankLabel).join('、')}）`
  return hand.name
}
function historyFinance(hand) {
  const invested = Number(hand?.totalBet)
  const won = Number(hand?.won) || 0
  if (!Number.isSafeInteger(invested) || invested < 0) return '投入数据暂缺'
  const net = won - invested
  return `投入 ${invested} · 获奖 ${won} · 净盈亏 ${net > 0 ? '+' : ''}${net}`
}
function resultFinance(hand) {
  const seatTotal = Number(seats.value.find((seat) => seat.uid === hand.uid)?.totalBet)
  const resultTotal = Number(hand.totalBet)
  const invested = [resultTotal, seatTotal].find((amount) => Number.isSafeInteger(amount) && amount > 0)
  if (invested === undefined) return null
  const gross = Math.max(0, Number(hand.won) || 0)
  return { invested, returned: Math.min(gross, invested), net: gross - invested }
}
function bothHoleCardsUsed(hand) {
  return hand.hole?.length === 2 && hand.hole.every((card) => hand.cards?.includes(card))
}

// ── 拉状态 / 轮询 ──
function onState(r) {
  if (!r.ok) {
    // 房间没了：清凭证，挡屏提示（绝不静默重建身份）
    if (r.code === 'ROOM_NOT_FOUND') onRoomGone()
    return
  }
  if (d.value && (r.data?.rev ?? 0) < (d.value.rev ?? 0)) return
  offline.value = false
  d.value = r.data
  // 凭证对应座位不存在了（被移除/换房）：清掉本地令牌转旁观，
  // 两手之间会自动重新入座（§7.1）。
  if (cred.value && !mySeat.value) {
    clearSeatCred(ROOM.value)
    cred.value = null
  }
  // 旁观者：两手之间尝试入座（进行中 join 会被拒，下一轮 poll 再试）
  if (!cred.value && !joinDenied.value) void joinOnce()
}

function onPollError() {
  // 规格 §7.1：断线只显示断线状态，不自动离开
  offline.value = true
}

function onRoomGone() {
  // 空房号的 ROOM_NOT_FOUND 不算致命（setup→room 的竞态期可能打空串）
  if (!ROOM.value) return
  clearSeatCred(ROOM.value)
  cred.value = null
  watcher?.stop()
  gate.value = '房间不存在或已解散'
  mode.value = 'gone'
}

async function pull() {
  const r = await onlineState(ROOM.value, cred.value)
  onState(r)
}

/** 旁观者入座尝试：两手之间才调；进行中会拿到 HAND_IN_PROGRESS 继续旁观 */
async function joinOnce() {
  if (joinBusy || !ROOM.value) return
  const canSeat = !d.value || d.value.finished || d.value.phase === 'idle'
  if (!canSeat) return
  joinBusy = true
  try {
    const r = await joinRoom(ROOM.value, {
      nickname: user.value?.nickname || user.value?.account || '匿名',
      avatar: user.value?.avatar ?? 1,
    }, cred.value)
    if (r.ok && r.data?.seatToken) {
      cred.value = { seatId: r.data.seatId, seatToken: r.data.seatToken }
      saveSeatCred(ROOM.value, r.data)
      d.value = r.data
    } else if (r.code === 'ROOM_FULL' || r.code === 'ROOM_NOT_FOUND') {
      joinDenied.value = r.error || '无法入座'
      if (r.code === 'ROOM_NOT_FOUND') onRoomGone()
    }
    // HAND_IN_PROGRESS / 其它 → 保持旁观
  } finally {
    joinBusy = false
  }
}

// ── 建房 ──
async function createRoom() {
  const seeds = formSeeds.value
  if (formSettingError.value) { createError.value = formSettingError.value; return }
  if (!createCode.value.trim()) { createError.value = '请输入创建码'; return }
  createBusy.value = true
  createError.value = ''
  try {
    const r = await createOnlineRoom({
      mode: 'online',
      gameType: gameType.value,
      smallBlind: smallBlind.value,
      bigBlind: bigBlind.value,
      initialSeeds: seeds,
    }, {
      nickname: user.value?.nickname || '房主',
      avatar: user.value?.avatar ?? 1,
    }, createCode.value.trim())
    if (!r.ok) { createError.value = r.error || '创建失败'; return }
    cred.value = { seatId: r.data.seatId, seatToken: r.data.seatToken }
    saveSeatCred(r.data.id, r.data)
    d.value = r.data
    curRoom.value = r.data.id       // 先占位，ROOM watcher 看到同号就不再重复绑定
    // 必须 await：route.query 更新是异步的，不等就拿 ROOM.value 起轮询，
    // 第一拍会拿空房号打 /state → ROOM_NOT_FOUND 误弹「房间不存在」
    await router.replace({ path: '/room/online', query: { room: r.data.id } })
    mode.value = 'room'
    startWatch()
  } finally {
    createBusy.value = false
  }
}

// ── 开局 / 动作 / 续时 / 重置 / 离开 ──
async function startHand() {
  const r = await startRoom(ROOM.value, undefined, cred.value)
  if (r.ok) d.value = r.data
}

async function act(type, amount) {
  if (!d.value || !cred.value) return
  const r = await onlineAction(
    ROOM.value, cred.value, d.value.handId, d.value.turnSeq, type, amount,
  )
  if (r.ok) { d.value = r.data; return }
  // 过期请求：拉最新状态就行，别提示用户看不懂的机器码
  if (r.code === 'STALE_HAND' || r.code === 'STALE_TURN') { await pull(); return }
  raiseError.value = ''
  toast(r.error || '操作失败')
}

async function extendTurn() {
  if (!d.value || !cred.value) return
  const r = await onlineExtendTurn(ROOM.value, cred.value, d.value.handId, d.value.turnSeq)
  if (r.ok) { d.value = r.data; return }
  if (r.code === 'STALE_HAND' || r.code === 'STALE_TURN') { await pull(); return }
  toast(r.error || '续时失败')
}

/** 加一个 AI：仅房主、仅两手之间（进行中服务端会拒） */
const aiBusy = ref(false)
async function addAiSeat() {
  if (aiBusy.value || !cred.value) return
  aiBusy.value = true
  try {
    const r = await addAi(ROOM.value, cred.value)
    if (r.ok) { d.value = r.data; return }
    if (r.code === 'STALE_HAND') { await pull(); return }
    toast(r.error || '添加失败')
  } finally {
    aiBusy.value = false
  }
}

/** 移除 AI 座位：仅房主、仅两手之间 */
async function removeAiSeat(seat) {
  const yes = await askConfirm({
    title: '移除 AI', msg: `确定移除「${seat.nickname}」？`, okText: '移除',
  })
  if (!yes) return
  const r = await removeAi(ROOM.value, seat.uid, cred.value)
  if (r.ok) { d.value = r.data; return }
  toast(r.error || '移除失败')
}

/** 终局重开：全员筹码回默认（两手之间、仅房主） */
async function resetTable() {
  const r = await onlineReset(ROOM.value, cred.value)
  if (r.ok) { d.value = r.data; return }
  toast(r.error || '重置失败')
}

function leave() {
  const msg = isHost.value
    ? '你是房主，离开会解散整个房间'
    : '确定离开？本手若在打会立即弃牌'
  askConfirm({ title: '离开房间', msg, okText: '离开' }).then(async (yes) => {
    if (!yes) return
    if (cred.value) await onlineLeave(ROOM.value, cred.value)
    clearSeatCred(ROOM.value)
    cred.value = null
    watcher?.stop()
    router.push('/lobby')
  })
}

// ── 通用 ──
const toastMsg = ref('')
const showToast = ref(false)
let toastTimer = null
function toast(m) {
  toastMsg.value = m
  showToast.value = true
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { showToast.value = false }, 2200)
}

function startWatch() {
  watcher?.stop()
  watcher = roomRepo.watchRoom(ROOM.value, onState, onPollError, () => cred.value, roomRepo.ONLINE_POLL_INTERVAL)
}

/**
 * 绑定一个新房间：重置全部会话态 → 拉一次状态 → 起轮询。
 * 从 setup 页/列表点「加入」走同路由 push，组件不 remount，
 * onMounted 不会重跑 —— 必须靠 ROOM watcher 触发这个绑定，
 * 否则点了没反应（踩过：URL 变了但页面还停在建房表单）。
 */
async function bindRoom(no) {
  watcher?.stop()
  watcher = null
  curRoom.value = no
  d.value = null
  offline.value = false
  gate.value = ''
  joinDenied.value = ''
  cred.value = loadSeatCred(no)
  mode.value = 'room'
  await pull()
  startWatch()
}

watch(ROOM, (now, old) => {
  if (!now || now === old || now === curRoom.value) return
  void bindRoom(now)
})

onMounted(async () => {
  await refresh()
  if (!user.value?.loggedIn) {
    router.replace({
      path: '/register',
      query: { redirect: route.fullPath },
    })
    return
  }
  // 倒计时 ticker 无条件启动：setup 表单里没有房间，但建房后马上要显示
  // 倒计时 —— 之前放在下面那行 return 之后，从建房表单进来的流程永远
  // 不会启动，倒计时数字冻结在打开页面那一刻（踩过：显示 249s 且不动）。
  ticker = setInterval(() => { nowTick.value = Date.now() }, 500)
  if (!ROOM.value) return   // 留在 setup 表单
  curRoom.value = ROOM.value
  cred.value = loadSeatCred(ROOM.value)
  // 无凭证就先拉一次旁观投影；两手之间 joinOnce 会补座
  await pull()
  startWatch()
})

onUnmounted(() => {
  watcher?.stop()
  clearInterval(ticker)
  clearTimeout(toastTimer)
})
</script>

<template>
  <div class="page online" v-if="user">
    <!-- ═══ 断线横幅：任何阶段都可能浮出来 ═══ -->
    <div v-if="offline && mode === 'room'" class="net-banner">连接中断，正在重连…</div>

    <!-- ═══ 建房表单 ═══ -->
    <template v-if="mode === 'setup'">
      <header class="head">
        <button class="back-btn" @click="router.back()">‹</button>
        <h1>线上对局</h1>
        <div class="head-space"></div>
      </header>

      <!-- 两个 tab：创建 / 加入 -->
      <div class="tabs">
        <button :class="{ on: setupTab === 'create' }" @click="setupTab = 'create'">创建房间</button>
        <button :class="{ on: setupTab === 'join' }" @click="setupTab = 'join'">加入房间</button>
      </div>

      <div v-if="setupTab === 'create'" class="card config">
        <label class="field-label">创建码</label>
        <input
          v-model="createCode" class="input" type="password"
          placeholder="房间创建授权码" inputmode="numeric"
        />

        <label class="field-label">游戏类型</label>
        <div class="chip-row">
          <button :class="{ on: gameType === 'long' }" @click="gameType = 'long'">德州长牌</button>
          <button :class="{ on: gameType === 'short' }" @click="gameType = 'short'">德州短牌</button>
        </div>
        <p class="text-sm text-light" v-if="gameType === 'short'">
          短牌去掉 2-5 共 36 张；同花 &gt; 葫芦，A 可当 5
        </p>

        <label class="field-label">初始瓜子</label>
        <div class="chip-row">
          <button
            v-for="v in [3000, 5000]"
            :key="v"
            :class="{ on: initialSeeds === v && !customSeeds }"
            @click="initialSeeds = v; customSeeds = ''"
          >
            {{ v }}
          </button>
        </div>
        <input v-model="customSeeds" class="input" type="number" placeholder="自定义初始瓜子" />

        <label class="field-label">盲注</label>
        <div class="blind-row">
          <div class="blind-item">
            <span>小麦</span>
            <input v-model.number="smallBlind" class="input" type="number" min="1" @input="onBlindInput" />
          </div>
          <div class="blind-item">
            <span>大麦</span>
            <input class="input" type="number" :value="bigBlind" readonly />
          </div>
        </div>
        <p class="text-sm text-light" style="margin: 0">
          填小麦自动算大麦（× 2）；大麦上限 {{ bbMax }}（初始瓜子 ÷ 10，至少留 10 个大麦）
        </p>

        <p v-if="formSettingError" class="join-error">{{ formSettingError }}</p>
        <p v-else-if="createError" class="join-error">{{ createError }}</p>
        <button class="btn" :disabled="createBusy" @click="createRoom">
          {{ createBusy ? '创建中…' : '创建房间' }}
        </button>
      </div>

      <!-- 加入：房间列表 + 我的房间 + 输号加入 -->
      <div v-else class="card config">
        <JoinRoomPanel mode="online" />
      </div>
    </template>

    <!-- ═══ 房间已失效 ═══ -->
    <template v-else-if="mode === 'gone'">
      <div class="card config" style="margin-top: 40px">
        <p class="gone-text">{{ gate }}</p>
        <button class="btn" @click="router.replace('/lobby')">回大厅</button>
      </div>
    </template>

    <!-- ═══ 在房内（含旁观）═══ -->
    <template v-else-if="d">
      <!-- 顶栏：默认折叠成一条，退出图标在左；点开才看盲注/二维码 -->
      <header class="room-head card">
        <div class="rh-bar">
          <button class="exit-btn" title="离开房间" @click="leave">✕</button>
          <div class="rh-title">
            <span class="room-no">房间 {{ d.id }}</span>
            <span class="rh-sub text-sm text-light">
              {{ d.seats.length }} 人<template v-if="d.handId > 0"> · 第 {{ d.handId }} 手</template>
            </span>
          </div>
          <button class="rh-toggle" @click="headOpen = !headOpen">
            {{ headOpen ? '收起 ⌃' : '详情 ⌄' }}
          </button>
        </div>
        <div v-if="headOpen" class="rh-more">
          <div class="text-sm text-light">
            {{ d.gameType === 'short' ? '短牌' : '长牌' }} · 小麦 {{ d.smallBlind }} / 大麦 {{ d.bigBlind }}
          </div>
          <div class="rh-qr" @click="qrZoom = true">
            <RoomQR :roomNo="d.id" mode="online" :size="96" />
            <span class="text-sm text-light">点二维码放大邀请</span>
          </div>
        </div>
      </header>

      <!-- 旁观横幅：无座位（旁观者 / 座位被移除 / 超时者等同视角） -->
      <div v-if="isSpectator" class="spec-banner">
        旁观中 · {{ joinDenied || '两手之间自动入座' }}
      </div>
      <!-- 归零座位：终局前不再参与，只能等房主重置整桌 -->
      <div v-else-if="mySeat && mySeat.seeds <= 0 && !mySeat.allIn" class="spec-banner">
        筹码归零 · 旁观中（等房主终局重开或解散）
      </div>
      <!-- 超时弃牌/本手失格：folded 但看不到自己底牌 = 本手旁观，下一手正常回座 -->
      <div v-else-if="inHand && mySeat && mySeat.folded && !myCards.length" class="spec-banner">
        本手旁观中 · 下一手自动入座
      </div>

      <!-- ── 等人 / 两手之间 ── -->
      <template v-if="!inHand && !handFinished">
        <div class="seat-list">
          <div v-for="s in seats" :key="s.uid" class="seat card" :class="{ me: s.isMe }">
            <div class="avatar avatar--seat"><img :src="avatarURI(s.avatar)" :alt="s.nickname" /></div>
            <div class="o-info">
              <div class="o-top">
                <span class="s-name">
                  {{ s.nickname }}
                  <span v-if="s.isMe" class="me-tag">我</span>
                  <span v-if="s.isHost" class="tag-mini">👑</span>
                  <span v-if="s.isAI" class="ai-tag">AI</span>
                </span>
              </div>
              <div class="s-seeds"><seed-chips :value="s.seeds" :size="14" /></div>
              <div class="s-sub" v-if="s.isAI && s.styleLabel">性格 · {{ s.styleLabel }}</div>
            </div>
            <!-- 房主管理 AI：只能移除 AI 座位，真人只能自己离开 -->
            <button
              v-if="isHost && s.isAI" class="ai-remove" title="移除 AI"
              @click="removeAiSeat(s)"
            >×</button>
          </div>
        </div>

        <!-- AI 填充：房主在等人/两手之间逐个添加，真人 AI 合计 ≤8 -->
        <div class="ai-add-row" v-if="isHost && seats.length < 8">
          <button class="btn btn--ghost btn--sm" :disabled="aiBusy" @click="addAiSeat">
            + 加一个 AI（{{ seats.length }}/8）
          </button>
        </div>

        <div class="wait-actions">
          <button v-if="isHost" class="btn" :disabled="aliveCount < 2" @click="startHand">
            {{ d.handId > 0 ? '开始下一手' : '开始对局' }}（{{ seats.length }} 人）
          </button>
          <p v-else class="wait-hint text-sm text-light">等待房主开始（退出点左上角 ✕）</p>
        </div>
      </template>

      <!-- ── 对局中 ── -->
      <template v-else-if="inHand">
        <!-- 中间区：椭圆牌桌 —— 我在底部，行动顺序顺时针，庄/小/大盲位可辨 -->
        <div class="table-zone">
          <div class="oval">
            <!-- 中心：奖池 + 公共牌 + 行动提示（唯一的倒计时显示位） -->
            <div class="oval-center">
              <div class="pot-row">
                <span class="pot-label">奖池</span>
                <seed-chips :value="d.pot" :size="16" />
                <span class="phase-tag">{{ phaseLabel }}</span>
              </div>
              <div class="community">
                <img
                  v-for="(c, i) in d.communityCards" :key="i"
                  :src="cardURI(c)" class="comm-card"
                  :style="{ animationDelay: i * 0.08 + 's' }" alt=""
                />
                <div v-for="i in (5 - d.communityCards.length)" :key="'p' + i" class="comm-slot"></div>
              </div>
              <div class="turn-hint" v-if="isMyTurn">
                该你了<span v-if="secsLeft !== null"> · {{ secsLeft }}s</span>
              </div>
              <div class="turn-hint muted" v-else>
                等待 {{ turnSeat?.nickname ?? '...' }}
                <span v-if="secsLeft !== null"> · {{ secsLeft }}s</span>
              </div>
            </div>

            <!-- 座位环绕椭圆 -->
            <div
              v-for="(s, i) in ovalSeats" :key="s.uid"
              class="oval-seat"
              :class="{
                me: s.isMe,
                turn: s.uid === d.turnUid,
                folded: s.folded,
                out: s.seeds <= 0 && !s.allIn && !s.folded,
              }"
              :style="ovalStyle(i, ovalSeats.length)"
            >
              <div class="os-avatar">
                <img :src="avatarURI(s.avatar)" :alt="s.nickname" />
                <!-- 位置标记：庄 / 小盲 / 大盲（优先级 庄 > 小 > 大） -->
                <span v-if="s.uid === d.dealerUid" class="os-badge d" title="庄家位">庄</span>
                <span v-else-if="s.uid === d.sbUid" class="os-badge sb" title="小麦位">小</span>
                <span v-else-if="s.uid === d.bbUid" class="os-badge bb" title="大麦位">大</span>
              </div>
              <div class="os-name">
                {{ s.nickname }}
                <span v-if="s.isMe" class="me-tag">我</span>
                <span v-if="s.isAI" class="ai-tag">AI</span>
              </div>
              <div class="os-seeds"><seed-chips :value="s.seeds" :size="11" /></div>
              <div class="os-act">
                <template v-if="s.seeds <= 0 && !s.allIn && !s.folded">
                  <span class="p-idle">旁观</span>
                </template>
                <template v-else-if="s.folded">
                  <span class="p-idle">已弃牌</span>
                </template>
                <template v-else>
                  <span v-if="s.bet > 0" class="p-bet">已下 {{ s.bet }}</span>
                  <span v-else-if="lastActionByUid[s.uid]">{{ actionLabel(lastActionByUid[s.uid]) }}</span>
                  <span v-else class="p-idle">等待</span>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部操作区：贴底不随内容滚动 -->
        <div class="action-zone">
          <div class="action-log" v-if="recentActions.length">
            <span
              v-for="a in recentActions" :key="a.at"
              class="log-item" :class="a.type"
            ><b>{{ a.nickname }}</b> {{ actionLabel(a) }}</span>
          </div>
          <div v-else-if="lastAggression && lastAggression.phase !== d.phase" class="agg-hint">
            本轮前 <b>{{ lastAggression.nickname }}</b> {{ actionLabel(lastAggression) }}
          </div>

          <!-- 我的底牌：服务端只在「本人 + 本手参与者 + 未失格」时才发 -->
          <div class="my-hand" v-if="myCards.length">
            <img
              v-for="(c, i) in myCards" :key="i"
              :src="cardURI(c)" class="hole-card"
              :style="{ animationDelay: i * 0.12 + 's' }" alt=""
            />
            <span v-if="myHandName" class="hand-name">{{ myHandName }}</span>
          </div>

          <!-- 我的回合：续时按钮（倒计时只在牌桌中心显示，不重复） -->
          <div class="turn-bar" v-if="isMyTurn && d.deadlineAt">
            <button
              class="btn btn--ghost btn--sm"
              :disabled="!d.canExtendTurn" @click="extendTurn"
            >
              {{ d.canExtendTurn ? '续时 +120s' : '本回合已续时' }}
            </button>
          </div>

          <!-- 操作按钮：三键制（仿线下）—— 弃牌 / 动态「过·跟」 / 加注弹窗 -->
          <div class="actions" v-if="avail.length">
            <button
              v-if="foldAction" class="btn act-btn btn--danger"
              @click="act('fold')"
            >弃牌</button>
            <button
              v-if="midAction" class="btn act-btn"
              :class="{ 'btn--ghost': midAction.type === 'check' }"
              @click="act(midAction.type, midAction.amount)"
            >{{ midAction.label }}</button>
            <button
              v-if="canRaise" class="btn act-btn"
              @click="openRaise"
            >加注</button>
          </div>

          <div class="zone-foot" v-if="!avail.length && turnSeat && !d.finished">
            <span class="wait-turn">等待 {{ turnSeat.nickname }} 行动</span>
          </div>
        </div>
      </template>

      <!-- ── 摊牌 / 两手之间 ── -->
      <template v-else-if="handFinished">
        <div class="result-wrap" v-if="d.result">
          <h2 class="res-title">摊 牌</h2>
          <div class="res-pot">
            <span class="res-pot-label">奖池</span>
            <seed-chips :value="d.result.pot" :size="20" />
          </div>
          <div class="res-accounting-note">获奖总额是奖池毛额（含投入返还）；净盈亏 = 获奖总额 − 本手投入</div>
          <div class="res-board" v-if="d.communityCards?.length">
            <span>公共牌</span>
            <img v-for="card in d.communityCards" :key="card" :src="cardURI(card)" alt="" />
          </div>
          <div class="res-pots" v-if="d.result.potLayers?.length">
            <div class="res-pots-title">奖池分层、派彩与未匹配退回</div>
            <div class="res-pot-layer" v-for="({ layer, view }, index) in resultLayerViews" :key="index">
              <div class="res-pot-layer-head">
                <strong>{{ view.title }}</strong>
                <seed-chips :value="layer.amount" :size="14" />
              </div>
              <div class="res-pot-layer-detail">出资：{{ resultNames(view.contributorUids) }}</div>
              <div v-if="view.uncalledReturn" class="res-pot-layer-detail">退回对象：{{ resultNames(view.recipientUids) }}</div>
              <div v-else class="res-pot-layer-detail">可争夺：{{ resultNames(view.eligibleUids) }}</div>
              <div class="res-layer-awards">
                <span class="res-layer-label">{{ view.awardLabel }}：</span>
                <span class="res-layer-award" v-for="award in view.awards" :key="award.uid">
                  {{ resultNames([award.uid]) }} +{{ award.amount }}
                </span>
                <span v-if="!view.hasAwards" class="res-layer-empty">{{ view.emptyAwardsLabel }}</span>
              </div>
            </div>
          </div>
          <div class="res-list">
            <div
              v-for="h in d.result.hands" :key="h.uid"
              class="res-row" :class="{ winner: h.isWinner, folded: h.folded }"
            >
              <div class="avatar avatar--sm">
                <img :src="avatarURI(seats.find(s => s.uid === h.uid)?.avatar ?? 1)" alt="" />
              </div>
              <div class="grow">
                <div class="r-name">
                  {{ h.nickname }}
                  <span v-if="h.uid === mySeatId" class="me-tag">我</span>
                  <span v-if="h.folded" class="folded-tag">已弃牌</span>
                </div>
                <div class="r-hand-name" v-if="h.hand">{{ handSummary(h.hand) }}</div>
                <div class="r-finance" v-if="resultFinance(h)">
                  <span>本手投入 {{ resultFinance(h).invested }}</span>
                  <span>投入返还 {{ resultFinance(h).returned }}</span>
                  <span v-if="resultFinance(h).net > 0" class="r-net--win">净盈利 +{{ resultFinance(h).net }}</span>
                  <span v-else-if="resultFinance(h).net < 0" class="r-net--loss">净亏损 {{ resultFinance(h).net }}</span>
                  <span v-else class="r-net--even">净盈亏 0</span>
                </div>
                <div class="r-finance r-finance--missing" v-else>本手投入数据暂缺</div>
              </div>
              <div class="r-won"><span>获奖总额</span><seed-chips :value="h.won ?? 0" :size="16" /></div>
            </div>
          </div>
          <div class="res-cards" v-for="h in d.result.hands.filter(x => !x.folded && x.cards?.length === 5 && x.hole?.length === 2)" :key="'c'+h.uid">
            <div class="res-cards-name">{{ h.nickname }} 的最佳五张 · {{ handSummary(h.hand) }} · 金圈标出底牌</div>
            <div class="res-cards-row">
              <span
                v-for="(c, i) in h.cards" :key="i"
                class="res-card-wrap" :class="{ 'res-card-wrap--hole': h.hole.includes(c) }"
              >
                <img :src="cardURI(c)" class="res-card" alt="" />
                <span v-if="h.hole.includes(c)" class="res-card-mark">底牌</span>
              </span>
            </div>
            <div class="res-hole-cards" v-if="!bothHoleCardsUsed(h)">
              <span class="res-hole-label">{{ h.uid === mySeatId ? '你的两张底牌' : `${h.nickname} 的两张底牌` }}</span>
              <span class="res-hole-note">与上方重复的是同一张牌，不是重复发牌</span>
              <div class="res-cards-row">
                <span v-for="c in h.hole" :key="'hole'+c" class="res-card-wrap res-card-wrap--hole">
                  <img :src="cardURI(c)" class="res-card" alt="" />
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 终局：只剩 ≤1 个有筹码座位 → 房主选重开或解散 -->
        <div class="final-panel card" v-if="matchOver">
          <h3 class="dlg-title">本局结束</h3>
          <p class="text-sm text-light" style="text-align:center">
            {{ aliveCount === 1 ? `胜者：${seats.find(s => s.seeds > 0)?.nickname}` : '无人有剩余筹码' }}
          </p>
          <template v-if="isHost">
            <button class="btn" @click="resetTable">重置筹码再开一局</button>
            <button class="btn btn--ghost" @click="leave">解散房间</button>
          </template>
          <p v-else class="wait-hint text-sm text-light">等待房主重开或解散</p>
        </div>

        <!-- 常规两手之间：还能打，房主点下一手 / 补 AI -->
        <div class="wait-actions" v-else-if="canStartNext || isSpectator">
          <div class="ai-add-row" v-if="isHost && seats.length < 8">
            <button class="btn btn--ghost btn--sm" :disabled="aiBusy" @click="addAiSeat">
              + 加一个 AI（{{ seats.length }}/8）
            </button>
          </div>
          <button v-if="isHost" class="btn" @click="startHand">开始下一手</button>
          <p v-else-if="!isSpectator" class="wait-hint text-sm text-light">等待房主开始下一手</p>
        </div>
      </template>
    </template>

    <!-- 加载中 / 拉不到状态 -->
    <div v-else class="card config" style="margin-top: 40px">
      <p class="gone-text">连接中…</p>
    </div>

    <details class="hand-history" v-if="mode === 'room' && d?.recentHands?.length">
      <summary>查看最近 {{ d.recentHands.length }} 手记录（房间仅保留最近 3 手）</summary>
      <article class="history-hand" v-for="hand in d.recentHands" :key="hand.handId">
        <h3>第 {{ hand.handId }} 手 · {{ hand.gameType === 'short' ? '短牌' : '长牌' }} · 大盲 {{ hand.bigBlind }} · 奖池 {{ hand.result.pot }}</h3>
        <div class="history-board" v-if="hand.communityCards.length">
          <span>公共牌</span>
          <img v-for="card in hand.communityCards" :key="card" :src="cardURI(card)" alt="" />
        </div>
        <div class="history-player" v-for="player in hand.result.hands" :key="player.uid" :class="{ folded: player.folded }">
          <strong>{{ player.nickname }}{{ player.folded ? '（已弃牌）' : '' }}</strong>
          <span v-if="player.hand">{{ handSummary(player.hand) }}</span>
          <span>{{ historyFinance(player) }}</span>
          <div class="history-cards" v-if="!player.folded && player.cards?.length === 5">
            <img v-for="card in player.cards" :key="card" :src="cardURI(card)" :class="{ 'history-hole': player.hole?.includes(card) }" alt="" />
            <span v-if="player.hole?.length === 2">底牌 {{ player.hole.join('、') }}</span>
          </div>
        </div>
        <div class="history-pot" v-for="({ layer, view }, index) in historyLayerViews(hand)" :key="index">
          <b>{{ view.title }} {{ layer.amount }}</b>
          <span v-if="view.uncalledReturn">出资 {{ historyNames(hand, view.contributorUids) }}；退回 {{ historyNames(hand, view.recipientUids) }}</span>
          <span v-else>出资 {{ historyNames(hand, view.contributorUids) }}；可争夺 {{ historyNames(hand, view.eligibleUids) }}</span>
          <span v-if="view.hasAwards">{{ view.awardLabel }} {{ view.awards.map(award => `${historyNames(hand, [award.uid])} +${award.amount}`).join('、') }}</span>
          <span v-else>{{ view.awardLabel }} {{ view.emptyAwardsLabel }}</span>
        </div>
        <ol class="history-actions">
          <li v-for="action in hand.actionLog" :key="`${action.at}-${action.uid}`">
            {{ action.nickname }} · {{ action.phase }} · {{ actionLabel(action) }}
          </li>
        </ol>
      </article>
      <p class="history-note">只保存在当前房间内存；房主重置、解散或服务重启后会清空，不写账号历史。</p>
    </details>

    <!-- 加注弹窗：快捷倍数（最小/半池/满池/全下）+ 自定义 -->
    <div v-if="raiseOpen" class="mask" @click.self="raiseOpen = false">
      <div class="dialog raise-dialog">
        <h3 class="dlg-title">加注</h3>
        <p class="raise-range">{{ raiseRangeText }}</p>
        <div class="quick-grid">
          <button
            v-for="q in quickRaiseTargets" :key="q.label"
            class="quick-btn" :class="{ allin: q.allin }"
            @click="raiseInput = String(q.v)"
          >
            <em>{{ q.label }}</em>
            <span>{{ q.v }}</span>
          </button>
        </div>
        <div class="raise-input-row">
          <input v-model.number="raiseInput" class="input raise-input" type="number" inputmode="numeric" />
          <button class="btn raise-ok" @click="confirmRaise">确定</button>
        </div>
        <p v-if="raiseError" class="raise-error">{{ raiseError }}</p>
      </div>
    </div>

    <!-- 二维码放大：面对面邀请用 -->
    <div v-if="qrZoom && d" class="mask" @click.self="qrZoom = false">
      <div class="dialog qr-dialog">
        <h3 class="dlg-title">邀请加入</h3>
        <RoomQR :roomNo="d.id" mode="online" :size="220" />
        <p class="text-sm text-light" style="text-align: center; margin: 0">房间号 {{ d.id }}</p>
        <button class="btn" @click="qrZoom = false">关闭</button>
      </div>
    </div>

    <!-- toast -->
    <div v-if="showToast" class="toast">{{ toastMsg }}</div>
  </div>
</template>

<style scoped>
.online {
  padding: calc(12px + var(--sat)) 14px calc(14px + var(--sab));
  gap: 10px;
}

.head { display: flex; align-items: center; gap: 10px; }
.head h1 { font-size: 19px; margin: 0; flex: 1; }
.head-space { width: 36px; }
.back-btn {
  width: 36px; height: 36px; border: 2px solid var(--c-border); border-radius: 50%;
  background: #fff; font-size: 22px; line-height: 1; color: var(--c-text-light); cursor: pointer;
}

.config { display: flex; flex-direction: column; gap: 10px; }
.field-label { font-size: 13px; font-weight: 700; color: var(--c-text-light); margin-top: 4px; }
.chip-row { display: flex; gap: 8px; }
.chip-row button {
  flex: 1; height: 44px; border: 2px solid var(--c-border); border-radius: 12px;
  background: #fff; font-size: 15px; font-weight: 700; color: var(--c-text-light); cursor: pointer;
}
.chip-row button.on { border-color: var(--c-primary); background: #fff3e0; color: var(--c-primary-dark); }
.blind-row { display: flex; gap: 10px; }
.blind-item { flex: 1; display: flex; align-items: center; gap: 8px; }
.blind-item span { font-size: 13px; color: var(--c-text-light); white-space: nowrap; }
.join-error { font-size: 15px; color: var(--c-danger); font-weight: 700; text-align: center; margin: 0; }
.gone-text { text-align: center; font-size: 15px; font-weight: 700; color: var(--c-text); }

/* ── 顶栏：折叠条 + 展开详情 ── */
.room-head { padding: 8px 10px; }
.rh-bar { display: flex; align-items: center; gap: 10px; }
.exit-btn {
  width: 34px; height: 34px; flex-shrink: 0; border-radius: 50%;
  border: 2px solid var(--c-border); background: var(--c-card);
  color: var(--c-text-light); font-size: 16px; line-height: 1; cursor: pointer;
}
.exit-btn:active { background: #ffebee; color: var(--c-danger); border-color: var(--c-danger); }
.rh-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.room-no { font-size: 17px; font-weight: 800; }
.rh-sub { white-space: nowrap; }
.rh-toggle {
  flex-shrink: 0; border: none; background: none; cursor: pointer;
  font-size: 12px; font-weight: 700; color: var(--c-text-light);
  padding: 6px 8px; border-radius: 8px;
}
.rh-toggle:active { background: var(--c-bg); }
.rh-more {
  display: flex; flex-direction: column; gap: 10px; padding: 10px 6px 4px;
  border-top: 1px dashed var(--c-border); margin-top: 8px;
}
.rh-qr { display: flex; align-items: center; gap: 12px; cursor: pointer; }
.rh-qr :deep(svg), .rh-qr :deep(canvas), .rh-qr :deep(img) { border-radius: 10px; }

/* 等人区座位：自适应网格，手机上两列、大屏自动铺开 */
.seat-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.seat {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border-radius: 14px; min-width: 0; overflow: hidden;
}
.seat.me { border-color: var(--c-primary); background: #fffdf7; }
.avatar--seat { width: 40px; height: 40px; border-width: 2px; flex-shrink: 0; }
.s-name {
  font-weight: 700; font-size: 14px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.s-seeds { font-size: 13px; font-weight: 800; color: var(--c-primary-dark); line-height: 1.2; }
.s-sub { font-size: 10px; color: var(--c-text-light); opacity: 0.7; margin-top: 1px; }
.me-tag { font-size: 10px; background: var(--c-primary); color: #fff; padding: 1px 6px; border-radius: 6px; }
.tag-mini { font-size: 10px; }
.ai-tag {
  font-size: 9px; background: var(--c-primary-dark); color: #fff;
  padding: 1px 5px; border-radius: 5px; white-space: nowrap;
}
.ai-remove {
  flex-shrink: 0; width: 18px; height: 18px; border: none; border-radius: 50%;
  background: var(--c-danger, #d05050); color: #fff; font-size: 12px;
  line-height: 1; cursor: pointer; padding: 0;
}
.ai-add-row { display: flex; justify-content: center; margin-top: 10px; }

.tabs { display: flex; gap: 8px; }
.tabs button {
  flex: 1; height: 42px; border: 2px solid var(--c-border); border-radius: 12px;
  background: var(--c-card); font-size: 15px; font-weight: 800;
  color: var(--c-text-light); cursor: pointer;
}
.tabs button.on { border-color: var(--c-primary); background: #fff6e0; color: var(--c-primary-dark); }

.wait-actions { margin-top: auto; display: flex; flex-direction: column; gap: 10px; }
.wait-hint { text-align: center; margin: 0; }

.net-banner {
  position: sticky; top: 0; z-index: 5;
  background: #ffebee; border: 1px solid var(--c-danger); color: var(--c-danger);
  border-radius: 10px; padding: 6px 12px; font-size: 12px; font-weight: 700;
  text-align: center;
}
.spec-banner {
  background: #fff8e1; border: 1px solid var(--c-accent); color: var(--c-text-light);
  border-radius: 10px; padding: 6px 12px; font-size: 12px; text-align: center;
}
.extend-row { display: flex; justify-content: center; }
.leave-row { display: flex; justify-content: center; margin-top: 4px; }

/* ── 牌桌中心（浅色桌面 → 深色文字） ── */
.pot-row { display: flex; align-items: center; gap: 8px; }
.pot-label { color: #6d4c41; font-size: 12px; font-weight: 700; opacity: 0.9; }
.pot-row :deep(.seed-num b) { color: #5d4037; font-size: 17px; }
.phase-tag { font-size: 10px; background: rgba(109, 76, 65, 0.12); color: #6d4c41; padding: 2px 7px; border-radius: 8px; }
.community { display: flex; gap: 4px; justify-content: center; min-height: 56px; align-items: center; }
.comm-card { width: 39px; height: 55px; border-radius: 6px; animation: deal-in 0.35s ease-out both; }
.comm-slot { width: 39px; height: 55px; border: 1.5px dashed rgba(109, 76, 65, 0.25); border-radius: 6px; }
@keyframes deal-in {
  from { transform: translateY(-30px) rotate(-8deg); opacity: 0; }
  to { transform: translateY(0) rotate(0); opacity: 1; }
}
.turn-hint { color: #5d4037; font-size: 14px; font-weight: 800; }
.turn-hint.muted { opacity: 0.75; font-weight: 600; }

/* ── 行动流水 ── */
.action-log {
  display: flex; gap: 6px; flex-wrap: wrap; justify-content: center;
  min-height: 22px; max-height: 48px; overflow: hidden;
}
.log-item {
  font-size: 11px; background: #fff; border: 1px solid var(--c-border);
  border-radius: 8px; padding: 2px 7px; color: var(--c-text-light);
  animation: log-in 0.25s ease-out;
}
.log-item b { color: var(--c-text); }
.log-item.raise, .log-item.bet { background: #fff3e0; border-color: var(--c-primary); color: var(--c-primary-dark); }
.log-item.fold { opacity: 0.55; text-decoration: line-through; }
.log-item.allin { background: #ffebee; border-color: var(--c-danger); color: var(--c-danger); font-weight: 700; }
@keyframes log-in { from { transform: translateY(-6px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.agg-hint {
  text-align: center; font-size: 11px; color: var(--c-primary-dark);
  background: #fff3e0; border: 1px solid var(--c-primary); border-radius: 8px;
  padding: 3px 10px; align-self: center; max-width: 100%;
}
.agg-hint b { font-weight: 800; }

.my-hand { display: flex; gap: 10px; justify-content: center; align-items: center; padding: 2px 0; }
.hole-card {
  width: 64px; height: 90px; border-radius: 8px;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15); animation: deal-in 0.4s ease-out both;
}
.hand-name {
  font-size: 13px; font-weight: 800; color: var(--c-primary-dark);
  background: #fff; border: 2px solid var(--c-primary); border-radius: 10px;
  padding: 3px 10px; white-space: nowrap;
}

/* ── 对局中：浅色椭圆桌（仿线下），无方框座位 ── */
.table-zone { display: flex; flex: 1; min-height: 0; }
.oval {
  position: relative; flex: 1;
  min-height: min(440px, 58vh);
  margin: 8px 2px;
  border-radius: 50% / 47%;
  background: radial-gradient(ellipse at 50% 42%, #fdf6e9 0%, #f5e6cb 64%, #ecd9b6 100%);
  border: 3px solid #dfc79c;
  box-shadow: inset 0 3px 14px rgba(160, 120, 60, 0.12);
}
.oval-center {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  max-width: 64%;
}
/* 无方框座位：头像 + 名字 + 筹码，头像角上挂位置标记 */
.oval-seat {
  position: absolute; transform: translate(-50%, -50%); z-index: 2;
  width: 70px; display: flex; flex-direction: column; align-items: center; gap: 2px;
  cursor: default;
}
.os-avatar {
  position: relative; width: 46px; height: 46px; border-radius: 50%;
  border: 3px solid var(--c-card); background: var(--c-card);
  box-shadow: 0 2px 6px rgba(93, 64, 55, 0.18);
}
.os-avatar img { width: 100%; height: 100%; border-radius: 50%; display: block; }
.oval-seat.me .os-avatar { border-color: var(--c-accent); box-shadow: 0 0 0 3px rgba(255, 213, 79, 0.4); }
.oval-seat.turn .os-avatar {
  border-color: var(--c-danger);
  animation: pulse 1.1s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 83, 80, 0.5); }
  50% { box-shadow: 0 0 0 9px rgba(239, 83, 80, 0); }
}
.oval-seat.folded { opacity: 0.45; }
.oval-seat.folded .os-avatar img { filter: grayscale(1); }
.oval-seat.out { opacity: 0.6; }
.os-badge {
  position: absolute; top: -6px; right: -8px; width: 17px; height: 17px;
  border-radius: 50%; border: 1.5px solid #fff; color: #fff;
  font-size: 9px; font-weight: 800; display: grid; place-items: center;
  z-index: 1;
}
.os-badge.d { background: #c9a227; }
.os-badge.sb { background: #3b82c4; }
.os-badge.bb { background: #c0392b; }
.os-name {
  font-size: 11px; font-weight: 800; max-width: 100%; color: #5d4037;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  display: flex; align-items: center; gap: 2px;
}
.os-name .me-tag { font-size: 8px; padding: 0 3px; border-radius: 4px; }
.os-name .ai-tag { font-size: 8px; padding: 0 3px; border-radius: 4px; background: #a1887f; }
.os-seeds { font-size: 10px; font-weight: 800; color: #8d6e63; line-height: 1.1; }
.os-seeds :deep(.seed-num b) { color: #8d6e63; }
.os-act {
  font-size: 9px; color: #a1887f; max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2;
}
.p-bet { color: var(--c-primary-dark); font-weight: 700; }
.p-idle { opacity: 0.7; }

.o-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.o-top { display: flex; align-items: center; gap: 4px; min-width: 0; }

.action-zone {
  position: sticky; bottom: 6px; z-index: 3;
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px; border-radius: 18px;
  background: var(--c-card); border: 2px solid var(--c-border);
  box-shadow: 0 -4px 18px rgba(93, 64, 55, 0.12);
}
.turn-bar { display: flex; align-items: center; justify-content: center; gap: 10px; }
.zone-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wait-turn { font-size: 12px; color: var(--c-text-light); }

.actions { display: flex; gap: 8px; }
.act-btn { flex: 1; font-size: 15px; padding: 0 8px; height: 46px; }

/* ── 加注弹窗：快捷倍数 + 自定义，留白充足 ── */
.raise-dialog { display: flex; flex-direction: column; gap: 14px; padding: 22px 20px; }
.raise-range { margin: 0; font-size: 13px; color: var(--c-text-light); text-align: center; }
.quick-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.quick-btn {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  min-height: 56px; border: 2px solid var(--c-primary); border-radius: 14px;
  background: #fff3e0; color: var(--c-primary-dark); cursor: pointer;
}
.quick-btn:active { transform: scale(0.96); }
.quick-btn em { font-style: normal; font-size: 14px; font-weight: 800; }
.quick-btn span { font-size: 12px; font-weight: 700; opacity: 0.7; }
.quick-btn.allin { background: #ffebee; border-color: var(--c-danger); color: var(--c-danger); }
.qr-dialog {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 22px 20px;
}
.raise-input-row { display: flex; gap: 10px; }
.raise-input { flex: 1; height: 48px; font-size: 18px; font-weight: 800; text-align: center; }
.raise-ok { width: 92px; height: 48px; font-size: 15px; }
.raise-error { margin: 0; font-size: 12px; color: var(--c-danger); text-align: center; font-weight: 700; }

/* ── 摊牌 / 终局 ── */
.result-wrap { display: flex; flex-direction: column; gap: 14px; }
.res-title { text-align: center; margin: 0; font-size: 24px; color: var(--c-primary-dark); letter-spacing: 4px; }
.res-pot {
  display: flex; align-items: center; justify-content: center; gap: 8px; padding: 10px;
  background: linear-gradient(160deg, #fff8e1, #ffecb3); border: 2px solid var(--c-accent); border-radius: 14px;
}
.res-pot-label { font-size: 13px; font-weight: 800; color: var(--c-text-light); }
.res-pot :deep(.seed-num b) { font-size: 20px; color: var(--c-primary-dark); }
.res-accounting-note { margin-top: -9px; text-align: center; color: #6d4c41; font-size: 11px; line-height: 1.4; }
.res-pots { display: flex; flex-direction: column; gap: 7px; }
.res-pots-title { text-align: center; font-size: 12px; font-weight: 800; color: var(--c-text-light); }
.res-pot-layer { padding: 9px 11px; border-radius: 12px; background: #fffdf6; border: 1px solid #eadbbd; }
.res-pot-layer-head { display: flex; align-items: center; justify-content: space-between; color: var(--c-primary-dark); font-size: 13px; }
.res-pot-layer-detail { margin-top: 3px; color: var(--c-text-light); font-size: 10px; line-height: 1.4; }
.res-layer-awards { display: flex; flex-wrap: wrap; gap: 4px 9px; margin-top: 5px; align-items: center; font-size: 10px; }
.res-layer-label { color: var(--c-text-light); font-weight: 700; }
.res-layer-award { color: var(--c-success); font-weight: 800; }
.res-layer-empty { color: var(--c-text-light); }
.res-list { display: flex; flex-direction: column; gap: 8px; }
.res-row {
  display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 14px;
  background: #fff; border: 2px solid var(--c-border);
}
.res-row.winner { background: #fff8e1; border-color: var(--c-accent); box-shadow: 0 2px 8px rgba(255, 193, 7, 0.25); }
.res-row.folded { opacity: 0.5; }
.r-name { font-weight: 700; font-size: 14px; display: flex; align-items: center; gap: 5px; }
.folded-tag { font-size: 10px; background: var(--c-border); color: #fff; padding: 1px 5px; border-radius: 5px; }
.r-hand-name { font-size: 14px; font-weight: 800; color: var(--c-primary-dark); margin-top: 2px; }
.r-finance { display: flex; flex-wrap: wrap; gap: 3px 5px; margin-top: 5px; color: #6d4c41; font-size: 10px; font-weight: 700; line-height: 1.4; }
.r-finance span { padding: 1px 5px; border-radius: 6px; background: rgba(109, 76, 65, 0.08); }
.r-finance--missing { color: var(--c-danger); }
.r-net--win { color: var(--c-success); font-weight: 800; }
.r-net--loss { color: var(--c-danger); font-weight: 800; }
.r-net--even { color: var(--c-text-light); font-weight: 700; }
.r-won { display: flex; align-items: center; gap: 3px; color: var(--c-success); font-size: 10px; font-weight: 800; white-space: nowrap; }
.r-won :deep(.seed-num b) { font-size: 15px; color: var(--c-success); }
.res-cards {
  text-align: center; padding: 12px;
  background: linear-gradient(160deg, #a1887f, #6d4c41); border-radius: 18px;
  box-shadow: inset 0 2px 12px rgba(0, 0, 0, 0.2);
}
.res-cards-name { font-size: 13px; font-weight: 700; color: #fff3e0; margin-bottom: 8px; opacity: 0.9; }
.res-cards-row { display: flex; gap: 6px; justify-content: center; }
.res-card-wrap { position: relative; display: inline-flex; padding: 2px; border: 2px solid transparent; border-radius: 10px; }
.res-card-wrap--hole { border-color: #ffca28; background: rgba(255, 224, 130, 0.34); box-shadow: 0 0 0 2px rgba(255, 202, 40, 0.75), 0 0 13px rgba(255, 193, 7, 0.85); }
.res-card { width: 52px; height: 73px; border-radius: 6px; box-shadow: 0 3px 8px rgba(0, 0, 0, 0.25); animation: deal-in 0.35s ease-out both; }
.res-card-wrap:nth-child(2) .res-card { animation-delay: 0.06s; }
.res-card-wrap:nth-child(3) .res-card { animation-delay: 0.12s; }
.res-card-wrap:nth-child(4) .res-card { animation-delay: 0.18s; }
.res-card-wrap:nth-child(5) .res-card { animation-delay: 0.24s; }
.res-card-mark { position: absolute; z-index: 1; left: 50%; bottom: -9px; transform: translateX(-50%); padding: 1px 5px; border-radius: 8px; background: #ffca28; color: #4e342e; font-size: 8px; font-weight: 900; white-space: nowrap; }
.res-hole-cards { margin-top: 13px; }
.res-hole-label, .res-hole-note { display: block; }
.res-hole-note { margin: 2px 0 7px; color: #fff3e0; font-size: 10px; opacity: 0.86; }
.res-hole-label { display: block; margin-bottom: 5px; color: #fff3e0; font-size: 10px; font-weight: 800; }
.res-board, .history-board, .history-cards { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 5px; }
.res-board { margin: 8px 0 12px; color: var(--c-text-light); font-size: 11px; font-weight: 700; }
.res-board img, .history-board img, .history-cards img { width: 34px; height: 48px; border-radius: 5px; box-shadow: 0 2px 5px rgba(0, 0, 0, .18); }
.hand-history { width: 100%; margin: 4px 0 18px; padding: 12px; border: 1px solid var(--c-border); border-radius: 14px; background: #fffaf0; }
.hand-history > summary { color: var(--c-primary-dark); font-weight: 800; cursor: pointer; }
.history-hand { padding: 12px 0; border-top: 1px solid var(--c-border); }
.history-hand h3 { margin: 0 0 8px; color: var(--c-text); font-size: 13px; }
.history-board { margin: 8px 0; }
.history-board > span { width: 100%; text-align: center; color: var(--c-text-light); font-size: 11px; }
.history-player { display: flex; flex-direction: column; gap: 3px; padding: 7px 0; border-top: 1px solid rgba(0, 0, 0, .06); font-size: 11px; }
.history-player.folded { opacity: .58; }
.history-cards { justify-content: flex-start; margin-top: 4px; }
.history-cards span { color: var(--c-text-light); font-size: 10px; }
.history-cards img.history-hole { outline: 2px solid #ffca28; outline-offset: 1px; }
.history-pot { display: flex; flex-direction: column; gap: 2px; padding: 7px; margin-top: 6px; border-radius: 8px; background: #fff3d5; font-size: 10px; }
.history-actions { max-height: 160px; overflow: auto; margin: 7px 0 0; padding-left: 20px; color: var(--c-text-light); font-size: 10px; }
.history-note { margin: 8px 0 0; color: var(--c-text-light); font-size: 10px; }

.final-panel { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
.dlg-title { margin: 0 0 8px; font-size: 18px; text-align: center; }

.toast {
  position: fixed; left: 50%; bottom: calc(30px + var(--sab)); transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.78); color: #fff; font-size: 13px;
  padding: 8px 16px; border-radius: 999px; z-index: 60; white-space: nowrap;
}
</style>
