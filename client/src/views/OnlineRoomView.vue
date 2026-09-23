<script setup>
/**
 * 线上对局房间 —— 完整德州扑克
 *
 * 架构说明：
 *   游戏逻辑全部来自 @shared/logic（纯函数，服务端/客户端共用）
 *   当前用本地状态机跑通完整流程；云端同步待 PG 实测后接入
 *
 * 流程：等人 → 房主开始 → 发牌 → 四轮下注（自动翻牌）→ 摊牌 → 结算
 */
import { ref, reactive, computed, nextTick, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { hamsterDataURI, getHamster } from '@shared/assets/hamsters.mjs'
import { cardSVG, svgToDataURI } from '@shared/assets/visuals.mjs'
import { useUser } from '../stores/user.js'
import SeedChips from '../components/SeedChips.vue'
import {
  initHand,
  dealHoleCards,
  applyAction,
  availableActions,
  raiseOptions,
  showdown,
  ACTION_LABEL,
  PHASE,
} from '@shared/logic/betting.mjs'
import { createShuffledDeck } from '@shared/logic/cards.mjs'
import { evaluate, HAND_NAME } from '@shared/logic/hand-evaluator.mjs'
import { buildSettlement } from '@shared/logic/settlement.mjs'

const router = useRouter()
const route = useRoute()
/**
 * 线上模式只用 user 的身份信息（uid/昵称/头像）。
 * 刻意不取 recordSeed / update：线上对局的瓜子是房间内临时计分，
 * 不累计、不落库、不产生金瓜子记录。规避法律风险。
 */
const { user } = useUser()
// 未登录：带 redirect 去注册页，注册完自动回到本页
if (!user.value) {
  const no = String(route.query.join ?? '').trim()
  router.replace({
    path: '/register',
    query: /^\d{6}$/.test(no) ? { redirect: '/room/online?join=' + no } : {},
  })
}

// ── 配置 ──
const stage = ref('setup') // setup | waiting | playing | settling
const initialSeeds = ref(3000)
const customSeeds = ref('')
const smallBlind = ref(10)
const bigBlind = ref(20)
const gameType = ref('long')

const roomNo = ref('')

/** 人数上限：8 人局 */
const MAX_SEATS = 8

/** 房间二维码 dataURI（动态 import qrcode，内联避免 SFC 拆分问题） */
const roomQRURI = ref('')

async function genRoomQR() {
  if (!roomNo.value) return
  try {
    const mod = await import('qrcode')
    const QRCode = mod.default ?? mod
    const url = location.origin + location.pathname + '#/join/' + roomNo.value + '?mode=online'
    roomQRURI.value = await QRCode.toDataURL(url, {
      width: 56,
      margin: 1,
      color: { dark: '#5D4037', light: '#FFFFFFFF' },
      errorCorrectionLevel: 'M',
    })
  } catch (e) {
    console.error('[OnlineRoomView] 二维码生成失败', e)
  }
}

// ── 座位 ──
const seats = reactive([])

// ── 牌局 ──
const gameState = ref(null)
const holeCards = ref({}) // uid → 2 张底牌（仅本人可见）
const showdownResult = ref(null) // 摊牌详情（含每人的牌型）
const dealing = ref(false)

const PHASE_LABEL = {
  idle: '等待开始',
  preflop: '翻牌前',
  flop: '翻牌圈',
  turn: '转牌圈',
  river: '河牌圈',
  showdown: '摊牌',
}

const me = computed(() => seats.find((s) => s.uid === user.value.uid))
const myCards = computed(() => holeCards.value[user.value.uid] ?? [])
const myActions = computed(() => {
  if (!gameState.value) return []
  return availableActions(gameState.value, user.value.uid)
})

/** 动态加注档位：随 currentBet / minRaise / 我的剩余筹码实时变化 */
const myRaiseOptions = computed(() => {
  if (!gameState.value || !isMyTurn.value) return []
  return raiseOptions(gameState.value, user.value.uid)
})

const isMyTurn = computed(() => gameState.value?.turnUid === user.value.uid)

/**
 * 行动流水：只显示当前下注轮的动作。
 *
 * 全部显示会刷屏 —— 一局打到河牌圈时，早期的翻牌前加注早被挤出屏幕，
 * 而那个加注额恰恰是判断当前局势的关键。所以按阶段过滤，只留本轮。
 */
const recentActions = computed(() => {
  const st = gameState.value
  if (!st) return []
  const log = st.actionLog.filter((a) => a.phase === st.phase)
  return log.slice(-6).reverse()
})

/** 上一轮的最后一次加注（翻牌前的大注在后续阶段仍是重要上下文） */
const lastAggression = computed(() => {
  const st = gameState.value
  if (!st) return null
  const agg = [...st.actionLog]
    .reverse()
    .find((a) => a.type === 'raise' || a.type === 'bet' || a.type === 'allin')
  return agg ?? null
})

/** 每个玩家的最后一条动作 */
const lastActionByUid = computed(() => {
  const map = {}
  for (const a of gameState.value?.actionLog ?? []) map[a.uid] = a
  return map
})

/** 我的牌型预览（7 张选 5 的最强组合） */
const myHandName = computed(() => {
  const cards = myCards.value
  const board = gameState.value?.communityCards ?? []
  if (cards.length < 2 || board.length < 3) return ''
  const h = evaluate([...cards, ...board], gameState.value.gameType)
  return HAND_NAME[h.type]
})

/** 自定义加注弹窗 */
const customRaiseOpen = ref(false)
const customRaiseValue = ref('')
const customRaiseError = ref('')

/** 自定义加注的最小/最大可设范围 */
const customRaiseRange = computed(() => {
  if (!gameState.value) return { min: 0, max: 0 }
  const seat = gameState.value.seats.find((s) => s.uid === user.value.uid)
  const min = gameState.value.currentBet + gameState.value.minRaise
  const max = (seat?.bet ?? 0) + (seat?.seeds ?? 0)
  return { min, max }
})

/** 自定义加注弹窗里的快捷金额（在合法范围内取整） */
const quickRaiseAmounts = computed(() => {
  const { min, max } = customRaiseRange.value
  const steps = [min]
  const base = Math.max(min, 10)
  for (const m of [1, 2, 5, 10]) {
    const v = Math.ceil((base * m) / 10) * 10
    if (v > min && v <= max && !steps.includes(v)) steps.push(v)
  }
  if (!steps.includes(max)) steps.push(max)
  return steps
})

function openCustomRaise() {
  const { min } = customRaiseRange.value
  customRaiseValue.value = String(min)
  customRaiseError.value = ''
  customRaiseOpen.value = true
}

function confirmCustomRaise() {
  const n = Number(customRaiseValue.value)
  const { min, max } = customRaiseRange.value
  // 用内联错误提示而不是 alert：alert 会阻塞事件流，导致弹窗状态错乱
  if (!Number.isFinite(n) || n < min) {
    customRaiseError.value = `不能小于 ${min}`
    return
  }
  if (n > max) {
    customRaiseError.value = `不能超过 ${max}`
    return
  }
  customRaiseError.value = ''
  customRaiseOpen.value = false
  act('raise', n)
}

/** 动作标签（含金额） */
function actionLabel(a) {
  const base = ACTION_LABEL[a.type] ?? a.type
  if (a.type === 'fold' || a.type === 'check') return base
  return `${base} ${a.amount}`
}

function avatarURI(id) {
  return hamsterDataURI(getHamster(id), 64)
}

function cardURI(code, faceDown = false) {
  return svgToDataURI(cardSVG(code, 60, faceDown))
}

// ── 创建房间 ──
function createRoom() {
  const seeds = customSeeds.value ? Number(customSeeds.value) : initialSeeds.value
  if (!Number.isFinite(seeds) || seeds <= 0) return alert('初始瓜子无效')
  if (bigBlind.value <= smallBlind.value) return alert('大麦必须大于小麦')

  seats.length = 0
  seats.push({
    uid: user.value.uid,
    nickname: user.value.nickname,
    avatar: user.value.avatar,
    seeds,
    isMe: true,
    isHost: true,
  })
  roomNo.value = String(Math.floor(100000 + Math.random() * 900000))
  stage.value = 'waiting'
  genRoomQR()
}

/** 模拟好友加入（真实环境由扫码/房间号触发） */
function addBot() {
  if (seats.length >= MAX_SEATS) return showToast(`最多 ${MAX_SEATS} 人`)
  const names = ['小瓜子', '大仓鼠', '毛毛', '团团', '豆豆', '麻薯', '布丁', '年糕', '花生', '松果']
  const used = new Set(seats.map((s) => s.nickname))
  const name = names.find((n) => !used.has(n))
  if (!name) return
  seats.push({
    uid: 'bot_' + Math.random().toString(36).slice(2, 8),
    nickname: name,
    avatar: Math.floor(Math.random() * 6) + 1,
    seeds: Number(customSeeds.value || initialSeeds.value),
    isMe: false,
    isBot: true,
  })
}

// ── 开始对局 ──
function startGame() {
  if (seats.length < 2) return alert('至少需要 2 名玩家')

  dealing.value = true
  const deck = createShuffledDeck(gameType.value)

  const players = seats.map((s) => ({
    uid: s.uid,
    nickname: s.nickname,
    avatar: s.avatar,
    seeds: s.seeds,
  }))

  const state = initHand({
    players,
    smallBlind: smallBlind.value,
    bigBlind: bigBlind.value,
    gameType: gameType.value,
    dealerUid: null,
    roundNo: 1,
    deck,
  })

  gameState.value = state
  holeCards.value = dealHoleCards(state)
  stage.value = 'playing'
  syncSeats()
  startStallWatch()

  setTimeout(() => (dealing.value = false), 600)
}

/** 把 gameState 的座位同步到本地 seats 数组 */
function syncSeats() {
  const gs = gameState.value
  if (!gs) return
  for (const s of seats) {
    const g = gs.seats.find((x) => x.uid === s.uid)
    if (g) {
      s.seeds = g.seeds
      s.bet = g.bet
      s.folded = g.folded
      s.allIn = g.allIn
      s.isTurn = g.isTurn
    }
  }
}

// ── 行动 ──
function act(type, amount) {
  if (!isMyTurn.value) return
  const r = applyAction(gameState.value, { uid: user.value.uid, type, amount })
  if (r.error) return alert(r.error)

  gameState.value = r.state
  syncSeats()

  if (r.state.finished) {
    finishHand()
  } else {
    maybeBotAct()
  }
}

/** 机器人自动行动（本地演示；真实环境由其他玩家操作） */
function maybeBotAct() {
  const uid = gameState.value.turnUid
  const seat = seats.find((s) => s.uid === uid)
  if (!seat?.isBot) return

  setTimeout(() => {
    const st = gameState.value
    if (!st || st.turnUid !== uid) return
    const acts = availableActions(st, uid)
    // 简单策略：能过牌就过牌，否则跟注
    const pick = acts.find((a) => a.type === 'check') ?? acts.find((a) => a.type === 'call') ?? acts[0]
    const r = applyAction(st, { uid, type: pick.type })
    if (r.error) return
    gameState.value = r.state
    syncSeats()
    if (r.state.finished) finishHand()
    else maybeBotAct()
  }, 900)
}

/**
 * 兜底轮询：防止 bot 的 setTimeout 因页面隐藏 / HMR / 切后台而丢失，
 * 导致轮到机器人时永远卡住。每 2 秒检查一次，超时未动就代替它行动。
 */
let stallWatch = null
let stallSince = 0

function startStallWatch() {
  stopStallWatch()
  stallWatch = setInterval(() => {
    const st = gameState.value
    if (!st || st.finished || stage.value !== 'playing') {
      stallSince = 0
      return
    }
    const uid = st.turnUid
    const seat = seats.find((s) => s.uid === uid)
    if (!uid || !seat?.isBot) {
      stallSince = 0
      return
    }
    // 该机器人行动但超过 4 秒没动 → 兜底代打
    if (!stallSince) stallSince = Date.now()
    if (Date.now() - stallSince < 4000) return

    stallSince = 0
    const acts = availableActions(st, uid)
    const pick = acts.find((a) => a.type === 'check') ?? acts.find((a) => a.type === 'call') ?? acts[0]
    const r = applyAction(st, { uid, type: pick.type })
    if (r.error) return
    gameState.value = r.state
    syncSeats()
    if (r.state.finished) finishHand()
  }, 2000)
}

function stopStallWatch() {
  if (stallWatch) clearInterval(stallWatch)
  stallWatch = null
  stallSince = 0
}

// ── 摊牌结算 ──
function finishHand() {
  const result = showdown(gameState.value, holeCards.value)
  showdownResult.value = result

  // 把赢的筹码加回座位
  for (const w of result.winnings) {
    const s = seats.find((x) => x.uid === w.uid)
    if (s) s.seeds += w.amount
  }

  syncSeats()
  stage.value = 'settling'
}

// ── 金瓜子结算 ──
const settlement = ref(null)

function checkSettlement() {
  const st = buildSettlement(seats)
  if (st.zeroed.length === 0) return null
  return st
}

/**
 * 线上模式不产生金瓜子。
 *
 * 刻意留空：线上对局的瓜子只是房间内临时计分，不累计、不落库。
 * 这样退出或重开时所有数据自然消失，不存在可被认定为赌博的累计收益。
 */
function payGoldenSeeds() {
  // no-op：线上模式零留存
}

/** 结算操作进行中：禁用按钮，避免重复点击 */
const settlingBusy = ref(false)

function settleAndRestart() {
  if (settlingBusy.value) return
  settlingBusy.value = true
  payGoldenSeeds()
  const seeds = Number(customSeeds.value || initialSeeds.value)
  for (const s of seats) s.seeds = seeds
  // 彻底清空上一局，恢复成刚进房间的样子
  gameState.value = null
  holeCards.value = {}
  showdownResult.value = null
  settlement.value = null
  stage.value = 'waiting'
  settlingBusy.value = false
}

function settleAndExit() {
  if (settlingBusy.value) return
  settlingBusy.value = true
  payGoldenSeeds()
  // 清空本房间所有对局数据，不写任何持久化状态
  resetRoom()
  stopStallWatch()
  router.push('/lobby')
}

/** 摊牌后点「继续」→ 检查是否触发金瓜子结算 */
function afterShowdown() {
  const st = checkSettlement()
  if (st) {
    settlement.value = st
    stage.value = 'settle-final'
  } else {
    nextHand()
  }
}

function nextHand() {
  const seeds = Number(customSeeds.value || initialSeeds.value)
  for (const s of seats) s.seeds = seeds
  gameState.value = null
  holeCards.value = {}
  showdownResult.value = null
  stage.value = 'waiting'
}

const phaseLabel = computed(() => PHASE_LABEL[gameState.value?.phase] ?? '')

/**
 * 离开页面时清空房间状态。
 * 用路由守卫而不是生命周期钩子：keep-alive 可能不触发 unmount/deactivate，
 * 导致下次从大厅进来还是上一个房间。
 */
function resetRoom() {
  stopStallWatch()
  stage.value = 'setup'
  seats.length = 0
  gameState.value = null
  holeCards.value = {}
  showdownResult.value = null
  settlement.value = null
  dealing.value = false
}

router.afterEach((to) => {
  if (to.name !== 'online-room') resetRoom()
})

// 组件卸载时也要停掉轮询，避免定时器泄漏
onUnmounted(stopStallWatch)
</script>

<template>
  <div class="page online" v-if="user">
    <!-- ═══ 房间设置 ═══ -->
    <template v-if="stage === 'setup'">
      <header class="head">
        <button class="back-btn" @click="router.back()">‹</button>
        <h1>线上对局</h1>
        <div class="head-space"></div>
      </header>

      <div class="card config">
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
          <div class="blind-item"><span>小麦</span><input v-model.number="smallBlind" class="input" type="number" /></div>
          <div class="blind-item"><span>大麦</span><input v-model.number="bigBlind" class="input" type="number" /></div>
        </div>

        <button class="btn" @click="createRoom">创建房间</button>
      </div>
    </template>

    <!-- ═══ 等人 / 开局 ═══ -->
    <template v-else-if="stage === 'waiting'">
      <header class="room-head card">
        <div class="row row--between">
          <div>
            <div class="room-no">房间 {{ roomNo }}</div>
            <div class="text-sm text-light">
              {{ gameType === 'short' ? '短牌' : '长牌' }} · 小麦 {{ smallBlind }} / 大麦 {{ bigBlind }}
            </div>
          </div>
          <div class="qr-box">
            <img v-if="roomQRURI" :src="roomQRURI" width="56" height="56" alt="房间二维码" />
            <span v-else class="qr-no-mini">{{ roomNo }}</span>
          </div>
        </div>
      </header>

      <!-- 座位：自适应网格，头像在左、瓜子数在右 -->
      <div class="seat-list">
        <div v-for="s in seats" :key="s.uid" class="seat card" :class="{ me: s.isMe }">
          <div class="avatar"><img :src="avatarURI(s.avatar)" :alt="s.nickname" /></div>
          <div class="o-info">
            <div class="o-top">
              <span class="s-name">
                {{ s.nickname }}
                <span v-if="s.isMe" class="me-tag">我</span>
              </span>
            </div>
            <div class="s-seeds"><seed-chips :value="s.seeds" :size="12" /></div>
          </div>
        </div>
      </div>

      <div class="wait-actions">
        <button class="btn btn--ghost" @click="addBot" :disabled="seats.length >= MAX_SEATS">
          加个好友（演示）
        </button>
        <button class="btn" @click="startGame" :disabled="seats.length < 2">开始对局</button>
      </div>
    </template>

    <!-- ═══ 对局中 ═══ -->
    <template v-else-if="stage === 'playing' && gameState">
      <!-- 桌面：公共牌 + 奖池 -->
      <div class="table">
        <div class="pot-row">
          <span class="pot-label">奖池</span>
          <seed-chips :value="gameState.pot" :size="18" />
          <span class="phase-tag">{{ phaseLabel }}</span>
        </div>

        <div class="community" :class="{ dealing }">
          <img
            v-for="(c, i) in gameState.communityCards"
            :key="i"
            :src="cardURI(c)"
            class="comm-card"
            :style="{ animationDelay: i * 0.08 + 's' }"
            alt=""
          />
          <div v-for="i in (5 - gameState.communityCards.length)" :key="'p'+i" class="comm-slot"></div>
        </div>

        <div class="turn-hint" v-if="isMyTurn">该你了</div>
        <div class="turn-hint muted" v-else>
          等待 {{ gameState.seats.find(s => s.uid === gameState.turnUid)?.nickname ?? '...' }}
        </div>
      </div>

      <!-- 行动流水：只显示当前下注轮；上一轮的加注单独提示 -->
      <div class="action-log" v-if="recentActions.length">
        <span
          v-for="a in recentActions"
          :key="a.at"
          class="log-item"
          :class="a.type"
        >
          <b>{{ a.nickname }}</b> {{ actionLabel(a) }}
        </span>
      </div>

      <!-- 上轮加注提示：翻牌前的大注在后续阶段仍是重要上下文 -->
      <div
        v-else-if="lastAggression && lastAggression.phase !== gameState.phase"
        class="agg-hint"
      >
        本轮前 <b>{{ lastAggression.nickname }}</b> {{ actionLabel(lastAggression) }}
      </div>

      <!-- 我的底牌 -->
      <div class="my-hand">
        <img
          v-for="(c, i) in myCards"
          :key="i"
          :src="cardURI(c)"
          class="hole-card"
          :style="{ animationDelay: i * 0.12 + 's' }"
          alt=""
        />
        <span v-if="myHandName" class="hand-name">{{ myHandName }}</span>
      </div>

      <!-- 其他玩家：紧凑横向卡片，一行 4 个，8 人局自动两行 -->
      <div class="others">
        <div
          v-for="s in gameState.seats.filter(x => x.uid !== user.uid)"
          :key="s.uid"
          class="other"
          :class="{ turn: s.isTurn, folded: s.folded }"
        >
          <div class="avatar avatar--sm"><img :src="avatarURI(s.avatar)" :alt="s.nickname" /></div>
          <div class="o-info">
            <div class="o-top">
              <span class="o-name">{{ s.nickname }}</span>
            </div>
            <div class="o-seeds"><seed-chips :value="s.seeds" :size="12" /></div>
            <div class="o-act">
              <span v-if="s.bet > 0" class="o-bet">已下 {{ s.bet }}</span>
              <span v-else-if="lastActionByUid[s.uid]">{{ actionLabel(lastActionByUid[s.uid]) }}</span>
              <span v-else class="o-idle">等待</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 操作区 -->
      <div class="actions">
        <button
          v-for="a in myActions"
          :key="a.type"
          class="btn act-btn"
          :class="{ 'btn--danger': a.type === 'fold', 'btn--ghost': a.type === 'check' }"
          @click="act(a.type, a.amount)"
        >
          {{ a.label }}
        </button>
      </div>

      <!-- 动态加注档位：5/10/20/50/100/500/全下，随当前注额实时变化 -->
      <div class="raise-bar" v-if="isMyTurn && myRaiseOptions.length">
        <span class="raise-hint">加注</span>
        <button
          v-for="o in myRaiseOptions"
          :key="o.targetTotal"
          class="raise-chip"
          :class="{ allin: o.isAllIn, off: !o.affordable }"
          :disabled="!o.affordable"
          @click="act('raise', o.targetTotal)"
        >
          <em>+{{ o.increment }}</em>
          <span>到 {{ o.targetTotal }}</span>
        </button>
        <button class="raise-chip custom" @click="openCustomRaise">
          <em>自定义</em>
          <span>输入金额</span>
        </button>
      </div>

      <!-- 自定义加注弹窗 -->
      <div v-if="customRaiseOpen" class="mask" @click.self="customRaiseOpen = false">
        <div class="dialog">
          <h3 class="dlg-title">自定义加注</h3>
          <p class="text-sm text-light" style="margin: 0 0 12px">
            可设范围 {{ customRaiseRange.min }} ~ {{ customRaiseRange.max }}
          </p>
          <div class="quick-grid">
            <button
              v-for="v in quickRaiseAmounts"
              :key="v"
              class="btn btn--sm"
              @click="customRaiseValue = String(v)"
            >
              {{ v }}
            </button>
          </div>
          <div class="row" style="margin-top: 12px">
            <input
              v-model.number="customRaiseValue"
              class="input grow"
              type="number"
              inputmode="numeric"
            />
            <button class="btn btn--sm" @click="confirmCustomRaise">确定</button>
          </div>
          <p v-if="customRaiseError" class="raise-error">{{ customRaiseError }}</p>
        </div>
      </div>
    </template>

    <!-- ═══ 摊牌 ═══ -->
    <template v-else-if="stage === 'settling' && showdownResult">
      <div class="result-wrap">
        <h2 class="res-title">摊 牌</h2>

        <div class="res-pot">
          <span class="res-pot-label">奖池</span>
          <seed-chips :value="showdownResult.pot" :size="20" />
        </div>

        <div class="res-list">
          <div
            v-for="h in showdownResult.hands"
            :key="h.uid"
            class="res-row"
            :class="{ winner: h.isWinner, folded: h.folded }"
          >
            <div class="avatar avatar--sm">
              <img :src="avatarURI(seats.find(s => s.uid === h.uid)?.avatar ?? 1)" alt="" />
            </div>

            <div class="grow">
              <div class="r-name">
                {{ h.nickname }}
                <span v-if="h.uid === user.uid" class="me-tag">我</span>
                <span v-if="h.folded" class="folded-tag">已弃牌</span>
              </div>
              <!-- 牌型名 -->
              <div class="r-hand-name" v-if="h.hand">{{ h.hand.name }}</div>
            </div>

            <!-- 赢得的瓜子 -->
            <div class="r-won" v-if="h.won > 0">
              <seed-chips :value="h.won" :size="16" />
            </div>
          </div>
        </div>

        <!-- 胜者的 5 张牌，居中放大展示 -->
        <div class="res-cards" v-for="h in showdownResult.hands.filter(x => x.isWinner)" :key="'c'+h.uid">
          <div class="res-cards-name">{{ h.nickname }} 的牌</div>
          <div class="res-cards-row">
            <img v-for="(c, i) in h.cards" :key="i" :src="cardURI(c)" class="res-card" alt="" />
          </div>
        </div>

        <button class="btn" @click="afterShowdown">继续</button>
      </div>
    </template>

    <!-- ═══ 本局结束（线上模式：仅房间内计分，零留存） ═══ -->
    <template v-else-if="stage === 'settle-final' && settlement">
      <div class="mask">
        <div class="dialog settle-dlg">
          <h3 class="dlg-title">本局结束</h3>
          <p class="text-sm">{{ settlement.zeroed.length }} 人瓜子归零</p>
          <div class="col" style="margin-top: 16px">
            <button class="btn" :disabled="settlingBusy" @click="settleAndRestart">重开一局</button>
            <button class="btn btn--ghost" :disabled="settlingBusy" @click="settleAndExit">退出房间</button>
          </div>
          <p class="disclaimer">
            线上模式仅供娱乐，瓜子为虚拟计分，退出后不保留任何记录
          </p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.online {
  padding: calc(12px + var(--sat)) 14px calc(14px + var(--sab));
  gap: 10px;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.head h1 {
  font-size: 19px;
  margin: 0;
  flex: 1;
}

.head-space {
  width: 36px;
}

.back-btn {
  width: 36px;
  height: 36px;
  border: 2px solid var(--c-border);
  border-radius: 50%;
  background: #fff;
  font-size: 22px;
  line-height: 1;
  color: var(--c-text-light);
  cursor: pointer;
}

.config {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.field-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--c-text-light);
  margin-top: 4px;
}

.chip-row {
  display: flex;
  gap: 8px;
}

.chip-row button {
  flex: 1;
  height: 44px;
  border: 2px solid var(--c-border);
  border-radius: 12px;
  background: #fff;
  font-size: 15px;
  font-weight: 700;
  color: var(--c-text-light);
  cursor: pointer;
}

.chip-row button.on {
  border-color: var(--c-primary);
  background: #fff3e0;
  color: var(--c-primary-dark);
}

.blind-row {
  display: flex;
  gap: 10px;
}

.blind-item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.blind-item span {
  font-size: 13px;
  color: var(--c-text-light);
  white-space: nowrap;
}

.room-head {
  padding: 14px 16px;
}

.room-no {
  font-size: 17px;
  font-weight: 800;
}

.qr-box {
  width: 64px;
  height: 64px;
  border: 2px solid var(--c-border);
  border-radius: 12px;
  display: grid;
  place-items: center;
  overflow: hidden;
  padding: 2px;
  background: #fff;
}

.qr-box img {
  display: block;
  border-radius: 8px;
}

.qr-no-mini {
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 1px;
  color: var(--c-primary-dark);
}

.qr-placeholder {
  font-size: 11px;
  color: var(--c-text-light);
}

.seat-list {
  display: grid;
  /* 与对局中玩家卡片一致：4 列，8 人局自动两行 */
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.seat {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 6px;
  border-radius: 12px;
  min-width: 0;
  overflow: hidden;
}

.seat.me {
  border-color: var(--c-primary);
  background: #fffdf7;
}

.seat .avatar {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
}

.s-name {
  font-weight: 700;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.s-seeds {
  font-size: 11px;
  font-weight: 800;
  color: var(--c-primary-dark);
  line-height: 1.1;
}

.me-tag {
  font-size: 10px;
  background: var(--c-primary);
  color: #fff;
  padding: 1px 6px;
  border-radius: 6px;
}

.wait-actions {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ── 牌桌 ── */
.table {
  background: linear-gradient(160deg, #a1887f, #6d4c41);
  border-radius: 24px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  box-shadow: inset 0 2px 12px rgba(0, 0, 0, 0.2);
}

.pot-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pot-label {
  color: #fff3e0;
  font-size: 13px;
  font-weight: 700;
  opacity: 0.85;
}

.pot-row :deep(.seed-num b) {
  color: #fff3e0;
  font-size: 18px;
}

.pot-row :deep(.seed) {
  filter: brightness(0) invert(1) opacity(0.85);
}

.phase-tag {
  font-size: 11px;
  background: rgba(255, 255, 255, 0.2);
  color: #fff3e0;
  padding: 2px 8px;
  border-radius: 8px;
}

.community {
  display: flex;
  gap: 6px;
  justify-content: center;
  min-height: 72px;
  align-items: center;
  /* 与下方玩家区留出空隙，避免公共牌压住玩家头像 */
  margin-bottom: 10px;
}

.comm-card {
  width: 48px;
  height: 67px;
  border-radius: 6px;
  animation: deal-in 0.35s ease-out both;
}

.comm-slot {
  width: 48px;
  height: 67px;
  border: 2px dashed rgba(255, 255, 255, 0.2);
  border-radius: 6px;
}

@keyframes deal-in {
  from {
    transform: translateY(-30px) rotate(-8deg);
    opacity: 0;
  }
  to {
    transform: translateY(0) rotate(0);
    opacity: 1;
  }
}

.turn-hint {
  color: #fff3e0;
  font-size: 14px;
  font-weight: 700;
}

.turn-hint.muted {
  opacity: 0.7;
  font-weight: 400;
}

/* ── 行动流水 ── */
.action-log {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  min-height: 22px;
  /* 最多两行，超出隐藏，避免把玩家区挤出屏幕 */
  max-height: 48px;
  overflow: hidden;
}

.log-item {
  font-size: 11px;
  background: #fff;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 2px 7px;
  color: var(--c-text-light);
  animation: log-in 0.25s ease-out;
}

.log-item b {
  color: var(--c-text);
}

.log-item.raise,
.log-item.bet {
  background: #fff3e0;
  border-color: var(--c-primary);
  color: var(--c-primary-dark);
}

.log-item.fold {
  opacity: 0.55;
  text-decoration: line-through;
}

.log-item.allin {
  background: #ffebee;
  border-color: var(--c-danger);
  color: var(--c-danger);
  font-weight: 700;
}

@keyframes log-in {
  from {
    transform: translateY(-6px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

/* 上轮加注提示 */
.agg-hint {
  text-align: center;
  font-size: 11px;
  color: var(--c-primary-dark);
  background: #fff3e0;
  border: 1px solid var(--c-primary);
  border-radius: 8px;
  padding: 3px 10px;
  align-self: center;
  max-width: 100%;
}

.agg-hint b {
  font-weight: 800;
}

.my-hand {
  display: flex;
  gap: 10px;
  justify-content: center;
  align-items: center;
  padding: 2px 0;
}

.hole-card {
  width: 64px;
  height: 90px;
  border-radius: 8px;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
  animation: deal-in 0.4s ease-out both;
}

.hand-name {
  font-size: 13px;
  font-weight: 800;
  color: var(--c-primary-dark);
  background: #fff;
  border: 2px solid var(--c-primary);
  border-radius: 10px;
  padding: 3px 10px;
  white-space: nowrap;
}

/* ── 其他玩家：一行 4 个紧凑卡片，8 人局自动两行 ── */
.others {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.other {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 6px;
  border-radius: 12px;
  background: #fff;
  border: 2px solid var(--c-border);
  min-width: 0;
  overflow: hidden;
}

.other.turn {
  border-color: var(--c-primary);
  box-shadow: 0 0 0 2px rgba(246, 166, 35, 0.3);
}

.other.folded {
  opacity: 0.45;
}

/* 头像右侧的信息列，纵向三段：昵称+金瓜子 / 瓜子数 / 动作 */
.o-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

/* 第一行：昵称 + 金瓜子徽标 */
.o-top {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}

.avatar--sm {
  width: 30px;
  height: 30px;
  border-width: 2px;
  flex-shrink: 0;
}

.o-name {
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}

.o-seeds {
  font-size: 11px;
  font-weight: 800;
  color: var(--c-primary-dark);
  line-height: 1.1;
}

.o-bet,
.o-act {
  font-size: 9px;
  color: var(--c-text-light);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.o-idle {
  opacity: 0.5;
}

.actions {
  display: flex;
  gap: 8px;
}

.act-btn {
  flex: 1;
  font-size: 15px;
  padding: 0 8px;
  height: 46px;
}

/* ── 动态加注档位 ── */
.raise-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 10px;
  background: #fff;
  border: 2px solid var(--c-border);
  border-radius: 16px;
}

.raise-hint {
  font-size: 12px;
  font-weight: 700;
  color: var(--c-text-light);
}

.raise-chip {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.15;
  min-width: 52px;
  padding: 4px 8px;
  border: 2px solid var(--c-primary);
  border-radius: 12px;
  background: #fff3e0;
  color: var(--c-primary-dark);
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  transition: transform 0.08s;
}

.raise-chip:active {
  transform: scale(0.94);
}

.raise-chip em {
  font-style: normal;
  font-size: 13px;
}

.raise-chip span {
  font-size: 9px;
  font-weight: 600;
  opacity: 0.65;
}

.raise-chip.allin {
  background: #ffebee;
  border-color: var(--c-danger);
  color: var(--c-danger);
}

.raise-chip.off {
  opacity: 0.35;
  cursor: not-allowed;
}

.raise-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--c-danger);
  text-align: center;
  font-weight: 700;
}

/* ── 摊牌 ── */
.result-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.res-title {
  text-align: center;
  margin: 0;
  font-size: 24px;
  color: var(--c-primary-dark);
  letter-spacing: 4px;
}

.res-pot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px;
  background: linear-gradient(160deg, #fff8e1, #ffecb3);
  border: 2px solid var(--c-accent);
  border-radius: 14px;
}

.res-pot-label {
  font-size: 13px;
  font-weight: 800;
  color: var(--c-text-light);
}

.res-pot :deep(.seed-num b) {
  font-size: 20px;
  color: var(--c-primary-dark);
}

.res-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.res-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-radius: 14px;
  background: #fff;
  border: 2px solid var(--c-border);
}

.res-row.winner {
  background: #fff8e1;
  border-color: var(--c-accent);
  box-shadow: 0 2px 8px rgba(255, 193, 7, 0.25);
}

.res-row.folded {
  opacity: 0.5;
}

.r-name {
  font-weight: 700;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.folded-tag {
  font-size: 10px;
  background: var(--c-border);
  color: #fff;
  padding: 1px 5px;
  border-radius: 5px;
}

/* 牌型名：突出显示 */
.r-hand-name {
  font-size: 14px;
  font-weight: 800;
  color: var(--c-primary-dark);
  margin-top: 2px;
}

.r-won :deep(.seed-num b) {
  font-size: 15px;
  color: var(--c-success);
}

/* 胜者的 5 张牌：居中放大 */
.res-cards {
  text-align: center;
  padding: 12px;
  background: linear-gradient(160deg, #a1887f, #6d4c41);
  border-radius: 18px;
  box-shadow: inset 0 2px 12px rgba(0, 0, 0, 0.2);
}

.res-cards-name {
  font-size: 13px;
  font-weight: 700;
  color: #fff3e0;
  margin-bottom: 8px;
  opacity: 0.9;
}

.res-cards-row {
  display: flex;
  gap: 6px;
  justify-content: center;
}

.res-card {
  width: 52px;
  height: 73px;
  border-radius: 6px;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.25);
  animation: deal-in 0.35s ease-out both;
}

.res-card:nth-child(2) { animation-delay: 0.06s; }
.res-card:nth-child(3) { animation-delay: 0.12s; }
.res-card:nth-child(4) { animation-delay: 0.18s; }
.res-card:nth-child(5) { animation-delay: 0.24s; }

.dlg-title {
  margin: 0 0 8px;
  font-size: 18px;
  text-align: center;
}

.settle-dlg {
  text-align: center;
}

.disclaimer {
  margin: 14px 0 0;
  font-size: 10px;
  color: var(--c-text-light);
  line-height: 1.5;
  opacity: 0.8;
}

@keyframes spin-in {
  from {
    transform: scale(0) rotate(-180deg);
  }
  to {
    transform: scale(1) rotate(0);
  }
}
</style>
