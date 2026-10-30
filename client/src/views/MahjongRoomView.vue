<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { hamsterDataURI, getHamster } from '@shared/assets/hamsters.mjs'
import { useUser } from '../stores/user.js'
import { askConfirm } from '../composables/useConfirm.js'
import { createOnlineRoom, joinRoom, onlineState, onlineLeave, addAi, removeAi, watchRoom,
  loadSeatCred, saveSeatCred, clearSeatCred, ONLINE_POLL_INTERVAL } from '../data/room-repo.js'
import { mahjongReady, mahjongStart, mahjongAction, mahjongReset } from '../data/mahjong-repo.js'
import { captureSeatRequest, isCurrentSeatRequest } from '../lib/seat-state-request.mjs'
import { sortedHand, tileInfo } from '../lib/mahjong-view.mjs'
import { createTileTapTracker, DISCARD_RECHECK_MS } from '../lib/mahjong-taps.mjs'
import { resultNetTransfers } from '../lib/mahjong-result.mjs'
import { groupTileWidth, handTileWidth } from '../lib/mahjong-clarity.mjs'
import { wallLayoutStacks } from '@shared/logic/mahjong/online-wall.mjs'
import JoinRoomPanel from '../components/JoinRoomPanel.vue'
import RoomQR from '../components/RoomQR.vue'
import MahjongTile from '../components/MahjongTile.vue'
import MahjongMelds from '../components/MahjongMelds.vue'
import MahjongResultWinner from '../components/MahjongResultWinner.vue'
import MahjongWallStack from '../components/MahjongWallStack.vue'

const route = useRoute(), router = useRouter(), { user, refresh } = useUser()
const roomId = computed(() => String(route.query.room || route.query.join || '').trim())
const data = ref(null), cred = ref(null), error = ref(''), connected = ref(true), busy = ref(false)
const setupTab = ref('create'), createCode = ref(''), seeds = ref(100), createBusy = ref(false)
const menuOpen = ref(false), inviteOpen = ref(false), resultOpen = ref(false), selected = ref(null), revealActive = ref(false)
const groupZoomSeat = ref(null), boardElement = ref(null)
const boardSize = ref({ width: window.innerWidth, height: window.innerHeight })
const resultWinnerIndex = ref(0), ledgerOpen = ref(false)
const openingProgress = ref(null)
const now = ref(Date.now()), toast = ref(''), profileReady = ref(false)
const animationEnabled = ref(true)
const tileTaps = createTileTapTracker()
let watcher = null, tickTimer = null, toastTimer = null, revealTimer = null, openingTimer = null, joining = false, joinAttempted = false
let pendingDiscardTimer = null
let openedFullscreen = false, lockedOrientation = false
let orientationMedia = null
let boardObserver = null

const me = computed(() => data.value?.seats?.findIndex((s) => s.isMe) ?? -1)
const viewer = computed(() => me.value >= 0 ? me.value : 0)
const isHost = computed(() => me.value >= 0 && !!data.value?.seats?.[me.value]?.isHost)
const phase = computed(() => data.value?.phase ?? 'waiting')
const hand = computed(() => sortedHand(data.value?.myHand ?? [], data.value?.myContext?.lastDraw))
const ownHasMelds = computed(() => !!data.value?.players?.[me.value]?.melds?.length)
const ownTileWidth = computed(() => handTileWidth({ ...boardSize.value, count: hand.value.length || 14, hasMelds: ownHasMelds.value }))
const actions = computed(() => data.value?.myActions ?? [])
const selectedCode = computed(() => selected.value?.code ?? '')
const specialActions = computed(() => actions.value.filter((a) => a.type !== 'discard'))
const countdown = computed(() => data.value?.deadlineAt == null ? null : Math.max(0, Math.ceil((data.value.deadlineAt - now.value) / 1000)))
const canReady = computed(() => me.value >= 0 && (phase.value === 'waiting' || (phase.value === 'finished' && !data.value?.result?.matchOver)))
const allReady = computed(() => data.value?.seats?.length === 4 && data.value?.ready?.every(Boolean))
const ownReady = computed(() => me.value >= 0 && !!data.value?.ready?.[me.value])
const resultWinners = computed(() => data.value?.result?.winners ?? [])
const selectedWinner = computed(() => resultWinners.value[resultWinnerIndex.value] ?? resultWinners.value[0])
const resultNets = computed(() => resultNetTransfers(data.value?.ledger, data.value?.seats?.length ?? 4))
const seats = computed(() => [0, 1, 2, 3].map((offset) => {
  const seat = (viewer.value + offset) % 4
  return { seat, side: ['bottom', 'right', 'top', 'left'][offset], info: data.value?.seats?.[seat], player: data.value?.players?.[seat] }
}))
const zoomSeat = computed(() => seats.value.find((seat) => seat.seat === groupZoomSeat.value))
function groupStyle(seat, kind) {
  return { '--tile-w': `${groupTileWidth({ ...boardSize.value, side: seat.side, kind,
    flowers: seat.player?.flowers ?? [], melds: seat.player?.melds ?? [] })}px` }
}
function openGroupZoom(seat) {
  if (openingProgress.value !== null || revealActive.value || resultOpen.value) return
  clearTileGesture(); selected.value = null; menuOpen.value = false; groupZoomSeat.value = seat
}
watch(boardElement, (element) => {
  boardObserver?.disconnect(); boardObserver = null
  if (!element) return
  const update = () => { boardSize.value = { width: element.clientWidth, height: element.clientHeight } }
  update()
  if (typeof ResizeObserver !== 'undefined') { boardObserver = new ResizeObserver(update); boardObserver.observe(element) }
})
const wallSegments = computed(() => {
  const layout = data.value?.wallLayout
  let stacks = layout?.stacks
  if (openingProgress.value != null && layout) {
    const progress = openingProgress.value
    let headTaken, tailTaken = 0
    if (progress < .72) headTaken = Math.min(48, Math.floor(progress / .72 * 12) * 4)
    else if (progress < .84) headTaken = 48 + [0, 2, 3, 4, 5][Math.min(4, Math.floor((progress - .72) / .12 * 5))]
    else {
      const rest = (progress - .84) / .16
      headTaken = 53 + Math.floor(Math.max(0, layout.headTaken - 53) * rest)
      tailTaken = Math.floor(layout.tailTaken * rest)
    }
    stacks = wallLayoutStacks({ ...layout, headTaken, tailTaken })
  }
  return seats.value.map((s) => ({ side: s.side, seat: s.seat, stacks: stacks?.[s.seat] ?? [] }))
})
const latestDiscard = computed(() => {
  const events = data.value?.events ?? []
  const i = events.findLastIndex((e) => e.type === 'discard')
  if (i < 0) return null
  const e = events[i]
  if (events.slice(i + 1).some((x) => (x.type === 'pong' || x.type === 'kong') && x.from === e.seat && x.tile === e.tile)) return null
  return e
})
const statusText = computed(() => {
  if (phase.value === 'ready') return '等待报听选择'
  if (phase.value === 'response') return '等待碰、杠或胡'
  if (phase.value === 'finished') return data.value?.result?.matchOver ? '本场结束' : '本手结束'
  if (phase.value === 'turn') return data.value?.turn === me.value ? '轮到你出牌' : `${data.value?.seats?.[data.value?.turn]?.nickname ?? '玩家'}行动中`
  return '等待入座'
})
const riskText = computed(() => {
  const r = data.value?.response
  if (!r?.sourceInGarden || !actions.value.some((a) => a.type === 'win')) return ''
  return r.kind === 'robKong' ? '抢园子补杠：胡牌需向其他三家各付一份，余额不足按规则分配。' : '对方已在园子：胡牌需向点炮者支付一份。'
})

function notice(message) {
  toast.value = message; clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 3500)
}
function applyState(r) {
  if (!r.ok) {
    if (r.code === 'ROOM_NOT_FOUND') roomGone()
    return
  }
  if (error.value === '房间不存在或已结束') return
  if (r.data?.gameType !== 'nanjing') { router.replace({ path: '/room/online', query: { room: roomId.value } }); return }
  if (data.value && Number(r.data.rev ?? 0) < Number(data.value.rev ?? 0)) return
  const previousHand = JSON.stringify(data.value?.myHand ?? [])
  const previousKey = `${data.value?.matchId ?? ''}:${data.value?.handId ?? ''}`
  const previousWindow = data.value?.windowId
  const wasWaiting = !!data.value && (data.value.phase === 'waiting' || data.value.phase === 'finished')
  data.value = r.data; connected.value = true; error.value = ''
  if (previousHand !== JSON.stringify(r.data?.myHand ?? []) || previousKey !== `${r.data?.matchId ?? ''}:${r.data?.handId ?? ''}` || previousWindow !== r.data?.windowId) { selected.value = null; clearTileGesture() }
  const currentKey = `${r.data.matchId ?? ''}:${r.data.handId ?? ''}`
  if (previousKey !== currentKey || r.data.phase === 'finished') groupZoomSeat.value = null
  if (previousKey !== currentKey || r.data.phase === 'finished') { clearInterval(openingTimer); openingProgress.value = null }
  if (previousKey !== currentKey && wasWaiting && r.data.phase !== 'finished' && r.data.wallLayout) startOpening()
  if (previousKey !== currentKey || r.data.phase !== 'finished') {
    clearTimeout(revealTimer); revealActive.value = false
    if (previousKey !== currentKey) { resultOpen.value = false; resultWinnerIndex.value = 0; ledgerOpen.value = false }
  }
  if (r.data.phase === 'finished' && (previousKey !== currentKey || phaseBefore.value !== 'finished')) {
    revealActive.value = true; resultOpen.value = false
    clearTimeout(revealTimer)
    revealTimer = setTimeout(showResult, 1000)
  }
  phaseBefore.value = r.data.phase
  if (!cred.value && r.data.phase === 'waiting') void tryJoin()
}
const phaseBefore = ref('')
function roomGone() {
  clearTileGesture()
  watcher?.stop(); clearSeatCred(roomId.value); cred.value = null
  clearTimeout(revealTimer); clearInterval(openingTimer)
  data.value = null; selected.value = null; revealActive.value = false; openingProgress.value = null
  menuOpen.value = false; inviteOpen.value = false; resultOpen.value = false; groupZoomSeat.value = null
  error.value = '房间不存在或已结束'
}
async function tryJoin() {
  if (joining || joinAttempted || !profileReady.value || !user.value?.loggedIn || !roomId.value || cred.value) return
  joining = true; joinAttempted = true
  const id = roomId.value
  const r = await joinRoom(id, { nickname: user.value.nickname, avatar: user.value.avatar ?? 1 })
  if (id !== roomId.value || error.value) { joining = false; return }
  if (r.ok && r.data?.seatId && r.data?.seatToken) {
    saveSeatCred(id, r.data); cred.value = { seatId: r.data.seatId, seatToken: r.data.seatToken }; applyState(r)
  } else if (r.code === 'ROOM_NOT_FOUND') roomGone()
  else if (r.code !== 'ROOM_FULL' && r.code !== 'HAND_IN_PROGRESS') notice(r.error || '暂时无法入座')
  joining = false
}
watch(roomId, (id) => {
  clearTileGesture()
  watcher?.stop(); watcher = null; data.value = null; selected.value = null; error.value = ''; phaseBefore.value = ''
  clearTimeout(revealTimer); revealActive.value = false; clearInterval(openingTimer); openingProgress.value = null
  menuOpen.value = false; inviteOpen.value = false; resultOpen.value = false; groupZoomSeat.value = null; resultWinnerIndex.value = 0; ledgerOpen.value = false; joinAttempted = false
  cred.value = id ? loadSeatCred(id) : null
  if (id) watcher = watchRoom(id, applyState, () => { connected.value = false }, () => cred.value, ONLINE_POLL_INTERVAL)
}, { immediate: true })

onMounted(async () => {
  onOrientationChange()
  orientationMedia = window.matchMedia('(orientation: portrait)')
  if (orientationMedia.addEventListener) orientationMedia.addEventListener('change', onOrientationChange)
  else orientationMedia.addListener?.(onOrientationChange)
  window.addEventListener('resize', onOrientationChange)
  try { animationEnabled.value = localStorage.getItem('hamster-poker:mahjong-animation') !== 'off' } catch { /* 本地设置不可用时使用默认值 */ }
  tickTimer = setInterval(() => { now.value = Date.now() }, 250)
  await refresh(); profileReady.value = true
  if (!user.value?.loggedIn && !cred.value) {
    await router.replace({ name: 'register', query: { redirect: route.fullPath } }); return
  }
  if (roomId.value && !cred.value && data.value?.phase === 'waiting') void tryJoin()
})
onUnmounted(() => {
  boardObserver?.disconnect()
  if (orientationMedia?.removeEventListener) orientationMedia.removeEventListener('change', onOrientationChange)
  else orientationMedia?.removeListener?.(onOrientationChange)
  window.removeEventListener('resize', onOrientationChange)
  watcher?.stop(); clearInterval(tickTimer); clearTimeout(toastTimer); clearTimeout(revealTimer); clearInterval(openingTimer)
  clearTileGesture()
  if (lockedOrientation) screen.orientation?.unlock?.()
  if (openedFullscreen && document.fullscreenElement) void document.exitFullscreen().catch(() => {})
})

async function create() {
  if (createBusy.value) return
  if (!createCode.value.trim()) { notice('请输入创建码'); return }
  if (!Number.isSafeInteger(Number(seeds.value)) || Number(seeds.value) <= 0 || Number(seeds.value) > 100000000) { notice('初始瓜子请输入正整数'); return }
  createBusy.value = true
  try {
    const r = await createOnlineRoom({ mode: 'online', gameType: 'nanjing', initialSeeds: Number(seeds.value) },
      { nickname: user.value?.nickname || '房主', avatar: user.value?.avatar ?? 1 }, createCode.value.trim())
    if (!r.ok) { notice(r.error || '创建失败'); return }
    saveSeatCred(r.data.id, r.data)
    createCode.value = ''
    await router.replace({ path: '/room/mahjong', query: { room: r.data.id } })
  } finally { createBusy.value = false }
}
async function requestChange(call) {
  if (busy.value || !cred.value || !data.value) return
  clearTileGesture()
  const request = captureSeatRequest(roomId.value, cred.value), state = data.value
  busy.value = true
  try {
    const r = await call(request.roomId, request.credential, state)
    if (!isCurrentSeatRequest(request, roomId.value, cred.value)) return
    if (r.ok || r.code === 'ROOM_NOT_FOUND') applyState(r)
    else { notice(r.error || '操作失败'); const fresh = await onlineState(request.roomId, request.credential); if (isCurrentSeatRequest(request, roomId.value, cred.value)) applyState(fresh) }
  } finally { busy.value = false }
}
function sendAction(action) { return requestChange((id, c, state) => mahjongAction(id, c, state, action)) }
function actionText(action) {
  if (action.type === 'win') return riskText.value ? '胡 · 需赔付' : '胡'
  if (action.type === 'ready') return '报听'
  if (action.type === 'pass') return phase.value === 'ready' ? '不报听' : '过'
  const label = { pong: '碰', kong: '杠', ankong: '暗杠', bukong: '补杠' }[action.type] ?? action.type
  return action.tile ? `${label} ${tileInfo(action.tile).name}` : label
}
let lastPortrait = null
function onOrientationChange(event) {
  const portrait = typeof event?.matches === 'boolean' ? event.matches : window.matchMedia('(orientation: portrait)').matches
  if (event?.type === 'resize' || event?.type === 'change' || (lastPortrait !== null && lastPortrait !== portrait)) { clearTileGesture(); selected.value = null }
  lastPortrait = portrait
}
function clearTileGesture() {
  tileTaps.reset(); clearTimeout(pendingDiscardTimer); pendingDiscardTimer = null
}
function canDiscardTile(tile) {
  return !!data.value && !busy.value && connected.value && phase.value === 'turn' && data.value.turn === me.value && !!cred.value &&
    openingProgress.value === null && !revealActive.value && !resultOpen.value && groupZoomSeat.value === null && !window.matchMedia('(orientation: portrait)').matches &&
    actions.value.some((action) => action.type === 'discard' && action.tile === tile.code)
}
function selectTile(tile) {
  if (!data.value || pendingDiscardTimer !== null || openingProgress.value !== null || revealActive.value || resultOpen.value || groupZoomSeat.value !== null || window.matchMedia('(orientation: portrait)').matches) return
  const state = data.value
  const legal = canDiscardTile(tile)
  const scope = `${roomId.value}:${state.matchId}:${state.handId}:${state.windowId}`
  const decision = tileTaps.tap({ index: tile.index, code: tile.code, scope, now: performance.now(), canDiscard: legal })
  if (decision === 'ignore') return
  selected.value = { index: tile.index, code: tile.code }
  if (decision === 'discard') pendingDiscardTimer = setTimeout(() => {
    pendingDiscardTimer = null
    const current = data.value
    if (!current || scope !== `${roomId.value}:${current.matchId}:${current.handId}:${current.windowId}` ||
        current.myHand?.[tile.index] !== tile.code || selected.value?.index !== tile.index || !canDiscardTile(tile)) return
    void sendAction({ type: 'discard', tile: tile.code })
  }, DISCARD_RECHECK_MS)
}
function showResult() {
  clearTimeout(revealTimer); revealActive.value = false; ledgerOpen.value = false
  if (phase.value === 'finished') resultOpen.value = true
}
function startOpening() {
  clearInterval(openingTimer); openingProgress.value = 0
  const start = Date.now()
  openingTimer = setInterval(() => {
    const elapsed = Date.now() - start
    openingProgress.value = Math.max(0, Math.min(1, (elapsed - 650) / 1350))
    if (elapsed >= 2000) { clearInterval(openingTimer); openingProgress.value = null }
  }, 120)
}
function toggleAnimation() {
  animationEnabled.value = !animationEnabled.value
  try { localStorage.setItem('hamster-poker:mahjong-animation', animationEnabled.value ? 'on' : 'off') } catch { /* 不影响对局 */ }
}
async function addBot() { await requestChange((id, c) => addAi(id, c)) }
async function removeBot(seat) { await requestChange((id, c) => removeAi(id, seat.uid, c)) }
async function leave() {
  menuOpen.value = false
  if (!cred.value) { await router.push('/lobby'); return }
  const yes = await askConfirm({ title: '离开房间', msg: '离开后，如仍有真人，牌局将由托管继续；房主离开时会移交房主。', okText: '离开' })
  if (!yes) return
  const r = await onlineLeave(roomId.value, cred.value)
  if (!r.ok) { notice(r.error || '离开失败'); return }
  clearSeatCred(roomId.value); watcher?.stop(); cred.value = null; await router.push('/lobby')
}
async function copyInvite() {
  const url = `${location.origin}${location.pathname}#/join/${roomId.value}?mode=online&game=nanjing`
  try { await navigator.clipboard.writeText(url); notice('邀请链接已复制') } catch { notice(`请分享房间号 ${roomId.value}`) }
}
async function tryLandscape() {
  let opened = false
  try {
    if (!screen.orientation?.lock) throw new Error('unsupported')
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) { await document.documentElement.requestFullscreen(); opened = true }
    await screen.orientation.lock('landscape')
    openedFullscreen = openedFullscreen || opened
    lockedOrientation = true
  } catch {
    if (opened && document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    notice('请打开手机自动旋转，然后横过来')
  }
}
</script>

<template>
  <div v-if="!roomId" class="page mj-entry">
    <header class="entry-head"><button class="back-btn" @click="router.push('/lobby')">‹ 大厅</button><span>南京麻将</span><span></span></header>
    <main class="entry-card card">
      <div class="entry-icon">🀄</div><h1>南京麻将</h1><p>和朋友围坐一桌，也可以请 AI 凑一局。</p>
      <div class="entry-tabs"><button :class="{ active: setupTab === 'create' }" @click="setupTab = 'create'">创建房间</button><button :class="{ active: setupTab === 'join' }" @click="setupTab = 'join'">加入房间</button></div>
      <template v-if="setupTab === 'create'">
        <label>房间创建码<input v-model="createCode" type="password" autocomplete="off" placeholder="输入创建码" /></label>
        <label>每人初始瓜子<input v-model.number="seeds" type="number" min="1" max="100000000" inputmode="numeric" /></label>
        <p class="entry-note">四人一桌 · 瓜子只用于本场 · 对局时请横屏</p>
        <button class="entry-primary" :disabled="createBusy" @click="create">{{ createBusy ? '创建中…' : '创建牌桌' }}</button>
      </template>
      <JoinRoomPanel v-else mode="online" />
    </main>
  </div>

  <div v-else class="mj-screen" :class="{ 'no-motion': !animationEnabled }">
    <div class="rotate-cover" role="alert"><div class="rotate-icon">▯</div><strong>请横过手机</strong><span>打开自动旋转，横屏后即可继续对局</span><button @click="tryLandscape">尝试自动横屏</button></div>
    <div v-if="error && !data" class="loading-overlay"><p>{{ error }}</p><button @click="router.replace('/lobby')">返回大厅</button></div>
    <div v-else-if="!data" class="loading-overlay">正在进入牌桌…</div>
    <template v-else>
      <div ref="boardElement" class="board" :class="{ 'board--opening': openingProgress !== null }" :inert="openingProgress !== null || undefined" :style="{ '--hand-tile-w': `${ownTileWidth}px` }" :data-window-id="data.windowId" :data-result-type="data.result?.type">
        <div class="board-grain"></div>
        <div v-if="!connected" class="connection">连接中断，正在重连…</div>
        <div class="corner">
          <button class="menu-trigger" aria-label="房间菜单" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">•••</button>
          <div v-if="menuOpen" class="menu-panel">
            <div class="menu-heading">房间 {{ data.id }}</div>
            <button @click="inviteOpen = true; menuOpen = false">邀请好友 <span>›</span></button>
            <button v-if="phase !== 'waiting'" @click="openGroupZoom(viewer)">放大花牌和碰杠 <span>›</span></button>
            <button :aria-pressed="animationEnabled" @click="toggleAnimation">选牌动画 <span>{{ animationEnabled ? '开' : '关' }}</span></button>
            <button v-if="phase === 'finished'" @click="showResult(); menuOpen = false">查看本手结果 <span>›</span></button>
            <button @click="leave">离开房间 <span>›</span></button>
          </div>
        </div>

        <template v-if="phase === 'waiting'">
          <div class="waiting-panel">
            <div class="waiting-kicker">一桌好时光</div><h2>等朋友入座</h2><p>房间号 <b>{{ data.id }}</b> · 四人开局</p>
            <div class="waiting-seats">
              <div v-for="i in 4" :key="i" class="waiting-seat">
                <template v-if="data.seats[i - 1]"><img :src="hamsterDataURI(getHamster(data.seats[i - 1].avatar), 48)" alt="" /><b>{{ data.seats[i - 1].nickname }}</b><span>{{ data.seats[i - 1].isAI ? 'AI' : data.ready?.[i - 1] ? '已准备' : '未准备' }}</span><button v-if="isHost && data.seats[i - 1].isAI && !data.handId" class="remove-bot" @click="removeBot(data.seats[i - 1])">移除</button></template>
                <template v-else><div class="empty-seat">＋</div><b>空座位</b><button v-if="isHost && !data.handId" class="add-bot" :disabled="busy" @click="addBot">添加 AI</button></template>
              </div>
            </div>
            <div class="waiting-actions"><button v-if="me >= 0" class="action-btn" :disabled="busy" @click="requestChange((id, c, s) => mahjongReady(id, c, s, !ownReady))">{{ ownReady ? '取消准备' : '准备' }}</button><button v-if="isHost" class="action-btn action-btn--gold" :disabled="busy || !allReady" @click="requestChange(mahjongStart)">开始对局</button><button v-if="me < 0" class="action-btn" @click="joinAttempted = false; tryJoin()">尝试入座</button><button class="action-btn action-btn--ghost" @click="inviteOpen = true">邀请好友</button></div>
          </div>
        </template>

        <template v-else>
          <div v-if="openingProgress !== null" class="opening-message" role="status">正在发牌</div>
          <div v-for="wall in wallSegments" :key="wall.seat" class="tile-wall" :class="`tile-wall--${wall.side}`" :aria-label="`座位 ${wall.seat + 1} 的牌墙`">
            <MahjongWallStack v-for="(count, n) in wall.stacks" :key="n" :count="count" :side="wall.side" />
          </div>
          <div v-for="s in seats.filter(x => x.side !== 'bottom')" :key="s.seat" class="opponent" :class="`opponent--${s.side}`">
            <div class="player-badge" :class="{ 'player-badge--acting': phase === 'turn' && data.turn === s.seat }"><span class="avatar-chip" :class="{ 'avatar-chip--dealer': data.dealer === s.seat }"><img v-if="s.info" :src="hamsterDataURI(getHamster(s.info.avatar), 36)" alt="" /><em v-if="data.dealer === s.seat">庄</em></span><div><b>{{ s.info?.nickname ?? '空位' }}</b><small>{{ s.info?.isAI ? 'AI · ' : '' }}{{ data.balances?.[s.seat] ?? '—' }} 瓜子 <em v-if="s.info?.left">托管</em></small><small v-if="phase === 'turn' && data.turn === s.seat" class="seat-timer">行动中<template v-if="countdown != null"> {{ countdown }}秒</template></small></div></div>
            <div class="back-row" :class="{ 'reveal-tiles': revealActive }" :aria-label="`${s.info?.nickname ?? '玩家'} ${s.player?.handCount ?? 0} 张手牌`"><template v-if="revealActive && data.revealedHands?.[s.seat]"><MahjongTile v-for="tile in sortedHand(data.revealedHands[s.seat])" :key="tile.index" :code="tile.code" :sideways="s.side === 'left' || s.side === 'right'" /></template><template v-else><MahjongTile v-for="n in (s.player?.handCount ?? 0)" :key="n" code="back" :sideways="s.side === 'left' || s.side === 'right'" /></template></div>
          </div>
          <template v-for="s in seats" :key="`groups-${s.seat}`">
            <MahjongMelds v-if="s.player?.flowers?.length" class="seat-flowers" :class="[`seat-flowers--${s.side}`, { 'seat-flowers--wide': s.side === 'bottom' && !ownHasMelds }]" :style="groupStyle(s, 'flowers')" :flowers="s.player.flowers" :owner="s.seat" :selected="selectedCode" :vertical="s.side === 'left' || s.side === 'right'" role="button" tabindex="0" :aria-label="`${s.info?.nickname ?? '玩家'}的花牌，点击放大`" @click="openGroupZoom(s.seat)" @keydown.enter.prevent="openGroupZoom(s.seat)" @keydown.space.prevent="openGroupZoom(s.seat)" />
            <MahjongMelds v-if="s.player?.melds?.length" class="seat-melds" :class="`seat-melds--${s.side}`" :style="groupStyle(s, 'melds')" :melds="s.player.melds" :owner="s.seat" :selected="selectedCode" :vertical="s.side === 'left' || s.side === 'right'" role="button" tabindex="0" :aria-label="`${s.info?.nickname ?? '玩家'}的碰杠，点击放大`" @click="openGroupZoom(s.seat)" @keydown.enter.prevent="openGroupZoom(s.seat)" @keydown.space.prevent="openGroupZoom(s.seat)" />
          </template>

          <div v-for="s in seats" :key="`river-${s.seat}`" class="river" :class="[`river--${s.side}`, { 'river--dense': (s.player?.discards?.length ?? 0) > 24 }]" :aria-label="`${s.info?.nickname ?? '玩家'}出牌区`">
            <MahjongTile v-for="(tile, i) in (s.player?.discards ?? [])" :key="i" :code="tile"
              :highlight="tile === selectedCode || (latestDiscard?.seat === s.seat && latestDiscard?.tile === tile && i === s.player.discards.length - 1)" />
          </div>

          <div class="table-center"><strong>余 {{ data.wallCount }} 张</strong><span v-if="data.double" class="double-badge">×2</span><small v-if="phase !== 'turn'">{{ statusText }}<template v-if="countdown != null"> · {{ countdown }}秒</template></small></div>
          <div v-if="me < 0" class="spectator-tag">旁观中</div>
          <div class="own-badge player-badge" :class="{ 'player-badge--acting': phase === 'turn' && data.turn === viewer }"><span class="avatar-chip" :class="{ 'avatar-chip--dealer': data.dealer === viewer }"><img v-if="data.seats?.[viewer]" :src="hamsterDataURI(getHamster(data.seats[viewer].avatar), 42)" alt="" /><em v-if="data.dealer === viewer">庄</em></span><div><b>{{ me >= 0 ? data.seats[me].nickname : '旁观视角' }}</b><small v-if="me >= 0">{{ data.balances?.[me] }} 瓜子</small><small v-if="phase === 'turn' && data.turn === viewer" class="seat-timer">行动中<template v-if="countdown != null"> {{ countdown }}秒</template></small></div></div>
          <div v-if="revealActive && data.revealedHands?.[viewer]" class="my-hand revealed-bottom reveal-tiles" :class="{ 'my-hand--wide': !ownHasMelds }" aria-label="本家摊牌"><MahjongTile v-for="tile in sortedHand(data.revealedHands[viewer])" :key="tile.index" :code="tile.code" /></div>
          <div v-else-if="me >= 0" class="my-hand" :class="{ 'my-hand--wide': !ownHasMelds }" aria-label="我的手牌，快速点击同一张两次出牌">
            <button v-for="tile in hand" :key="tile.index" class="hand-button" :class="{ 'hand-button--selected': selected?.index === tile.index && selected?.code === tile.code, 'hand-button--drawn': tile.drawn }" :aria-label="`${tileInfo(tile.code).name}${selected?.index === tile.index ? '，已选中' : ''}`" :aria-pressed="selected?.index === tile.index" @click="selectTile(tile)"><MahjongTile :code="tile.code" :highlight="selected?.index === tile.index && selected?.code === tile.code" /></button>
          </div>
          <div v-else class="spectator-hand">旁观不会显示其他玩家手牌</div>

          <div v-if="specialActions.length" class="action-area">
            <div v-if="riskText" class="risk-note">{{ riskText }}</div>
            <div class="action-buttons"><button v-for="(action, i) in specialActions" :key="`${action.type}-${action.tile ?? i}`" class="action-btn" :class="{ 'action-btn--gold': action.type === 'win' }" :disabled="busy" @click="sendAction(action)">{{ actionText(action) }}</button></div>
          </div>
          <div v-if="revealActive" class="reveal-message"><span>四家摊牌</span><button @click="showResult">查看结算 ›</button></div>
          <div v-if="phase === 'finished' && !resultOpen && !revealActive" class="finished-controls"><button class="action-btn" @click="showResult">本手结果</button><button v-if="canReady" class="action-btn" :disabled="busy" @click="requestChange((id,c,s) => mahjongReady(id,c,s,!ownReady))">{{ ownReady ? '取消准备' : '准备' }}</button><button v-if="isHost && !data.result?.matchOver" class="action-btn action-btn--gold" :disabled="busy || !allReady" @click="requestChange(mahjongStart)">下一手</button><button v-if="isHost && data.result?.matchOver" class="action-btn action-btn--gold" :disabled="busy" @click="requestChange(mahjongReset)">重新开场</button></div>
        </template>
      </div>

      <div v-if="inviteOpen" class="modal-shade" @click.self="inviteOpen = false"><div class="invite-card"><button class="modal-close" aria-label="关闭" @click="inviteOpen = false">×</button><span class="modal-kicker">一起入座</span><h2>邀请好友</h2><p>扫码或输入房间号</p><RoomQR :room-no="data.id" mode="online" game="nanjing" :size="150" /><strong class="invite-number">{{ data.id }}</strong><button class="entry-primary" @click="copyInvite">复制邀请链接</button></div></div>
      <div v-if="groupZoomSeat !== null && zoomSeat" class="modal-shade" @click.self="groupZoomSeat = null"><div class="group-zoom-card" role="dialog" aria-modal="true" aria-label="放大查看花牌和碰杠"><header><b>花牌和碰杠</b><small v-if="countdown != null">剩余 {{ countdown }} 秒</small><button aria-label="关闭放大查看" @click="groupZoomSeat = null">×</button></header><nav aria-label="选择玩家"><button v-for="s in seats" :key="s.seat" :class="{ active: groupZoomSeat === s.seat }" @click="groupZoomSeat = s.seat">{{ s.info?.nickname ?? '玩家' }}</button></nav><div class="group-zoom-content"><div><strong>碰杠与花杠</strong><MahjongMelds v-if="zoomSeat.player?.melds?.length" class="zoom-groups" :melds="zoomSeat.player.melds" :owner="zoomSeat.seat" show-labels /><span v-else>无</span></div><div><strong>花牌</strong><MahjongMelds v-if="zoomSeat.player?.flowers?.length" class="zoom-groups" :flowers="zoomSeat.player.flowers" :owner="zoomSeat.seat" /><span v-else>无</span></div></div></div></div>
      <div v-if="phase === 'finished' && resultOpen" class="modal-shade"><div class="result-card">
        <header class="result-header"><h2>{{ data.result?.type === 'win' ? '胡牌结算' : data.result?.type === 'draw' ? '流局' : '本场结算' }}</h2><div v-if="resultWinners.length > 1" class="winner-tabs" aria-label="切换胡家"><button v-for="(winner, i) in resultWinners" :key="winner.seat" :class="{ active: i === resultWinnerIndex && !ledgerOpen }" @click="resultWinnerIndex = i; ledgerOpen = false">{{ data.seats?.[winner.seat]?.nickname ?? '玩家' }}</button></div><button v-if="data.ledger?.length" class="ledger-toggle" @click="ledgerOpen = !ledgerOpen">{{ ledgerOpen ? '返回牌组' : '流水' }}</button><button class="modal-close" aria-label="关闭结果" @click="resultOpen = false">×</button></header>
        <div class="result-body"><div v-if="ledgerOpen" class="result-ledger"><b>本手实际收付流水</b><div v-for="(entry, ei) in data.ledger" :key="ei" class="ledger"><b>{{ entry.event }}</b><span v-for="transfer in entry.transfers" :key="transfer.id">{{ data.seats?.[transfer.from]?.nickname }} → {{ data.seats?.[transfer.to]?.nickname }}：实付 {{ transfer.paid }}<template v-if="transfer.amount !== transfer.paid">（应付 {{ transfer.amount }}）</template> · {{ transfer.reason }}</span><span v-if="!entry.transfers?.length">无实际转账</span></div></div><MahjongResultWinner v-else-if="selectedWinner" :winner="selectedWinner" :nickname="data.seats?.[selectedWinner.seat]?.nickname ?? '玩家'" :double="!!data.double" /><div v-else class="result-empty">{{ data.result?.type === 'draw' ? '本手流局' : '本场结束' }}</div></div>
        <footer class="result-footer"><div class="result-balances" aria-label="本手实际净收付"><strong>本手净收付</strong><span v-for="(amount, i) in data.balances" :key="i">{{ data.seats?.[i]?.nickname }} <b :class="{ positive: resultNets[i] > 0, negative: resultNets[i] < 0 }">{{ resultNets[i] > 0 ? '+' : '' }}{{ resultNets[i] }}</b> <small>余{{ amount }}</small></span></div>
          <div class="result-actions"><button v-if="canReady" class="action-btn" :disabled="busy" @click="requestChange((id,c,s) => mahjongReady(id,c,s,!ownReady))">{{ ownReady ? '取消准备' : '准备下一手' }}</button><button v-if="isHost && !data.result?.matchOver" class="action-btn action-btn--gold" :disabled="busy || !allReady" @click="requestChange(mahjongStart)">开始下一手</button><button v-if="isHost && data.result?.matchOver" class="action-btn action-btn--gold" :disabled="busy" @click="requestChange(mahjongReset)">重新开场</button><button class="action-btn action-btn--ghost" @click="resultOpen = false">返回牌桌</button></div>
        </footer>
      </div></div>
    </template>
    <div v-if="toast" class="mj-toast" role="status">{{ toast }}</div>
  </div>
</template>

<style scoped>
.mj-entry { align-items: center; gap: 16px; padding: calc(16px + var(--sat)) 16px calc(20px + var(--sab)); }
.entry-head { width: min(100%, 540px); display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; color: #684b39; font-weight: 900; }
.back-btn { justify-self: start; border: 0; background: transparent; color: #8a684b; font-size: 15px; font-weight: 800; padding: 10px 2px; }
.entry-card { width: min(100%, 480px); padding: 26px; display: flex; flex-direction: column; gap: 13px; text-align: center; }
.entry-icon { margin: 0 auto; width: 62px; height: 62px; display: grid; place-items: center; background: #ddf0df; border-radius: 20px; font-size: 35px; }
.entry-card h1, .entry-card p { margin: 0; }
.entry-card h1 { font-size: 25px; color: #355a44; }
.entry-card p { color: #897767; font-size: 13px; }
.entry-tabs { display: flex; padding: 4px; gap: 4px; background: #f4f0e5; border-radius: 14px; }
.entry-tabs button { flex: 1; border: 0; background: transparent; border-radius: 11px; padding: 10px; color: #8a7c6c; font-weight: 800; }
.entry-tabs button.active { background: white; color: #2d7650; box-shadow: 0 2px 8px #46341418; }
.entry-card label { display: flex; flex-direction: column; gap: 7px; text-align: left; font-size: 13px; font-weight: 800; color: #706252; }
.entry-card input { width: 100%; height: 46px; border: 1px solid #dfd7c8; background: #fbfaf6; color: #4e4a3d; border-radius: 12px; padding: 0 13px; font: inherit; }
.entry-card .entry-note { font-size: 12px; text-align: left; }
.entry-primary { border: 0; border-radius: 13px; background: #2c8056; color: #fff; font-weight: 900; font-size: 15px; padding: 12px 18px; box-shadow: 0 3px 0 #1d5d3c; }
.entry-primary:disabled { opacity: .5; }

.mj-screen { position: relative; width: 100%; height: 100dvh; min-height: 0; overflow: hidden; background: #162b25; color: #f8f6e7; }
.board { --hand-tile-w: clamp(16px, min(4vw, 8vh), 46px); position: absolute; inset: var(--sat) var(--sar) var(--sab) var(--sal); overflow: hidden; border: clamp(4px, 1vw, 12px) solid #4d3424; border-radius: clamp(9px, 2vw, 24px); box-shadow: inset 0 0 0 2px #c19150, inset 0 0 32px #00190d; background: radial-gradient(ellipse at 50% 38%, #2b8059 0%, #1e6746 55%, #145037 100%); }
.board-grain { position: absolute; inset: 2%; border: 1px solid #c9dbb427; border-radius: 12px; pointer-events: none; }
.board--opening .back-row, .board--opening .seat-flowers, .board--opening .seat-melds, .board--opening .river, .board--opening .my-hand, .board--opening .action-area, .board--opening .table-center { visibility: hidden; }
.opening-message { position: absolute; z-index: 8; left: 50%; top: 48%; transform: translate(-50%, -50%); padding: 7px 14px; border: 1px solid #e2c87e; border-radius: 18px; color: #ffe7ab; background: #153f2df0; font-size: clamp(11px, 2vw, 16px); font-weight: 900; white-space: nowrap; }
.tile-wall { position: absolute; z-index: 1; display: flex; pointer-events: none; filter: drop-shadow(1px 2px 1px #062b20aa); }
.tile-wall--top, .tile-wall--bottom { left: 24%; width: 52%; height: clamp(14px, 6vh, 30px); }
.tile-wall--top { top: 22%; }
.tile-wall--top { flex-direction: row-reverse; }
.tile-wall--bottom { bottom: 20%; }
.tile-wall--left, .tile-wall--right { top: 28%; height: 46%; width: clamp(14px, 2.4vw, 26px); flex-direction: column; }
.tile-wall--left { left: 21.5%; }
.tile-wall--right { right: 21.5%; flex-direction: column-reverse; }
.corner { position: absolute; z-index: 12; top: 2%; right: 2%; }
.menu-trigger { border: 1px solid #ecddb27d; border-radius: 10px; width: clamp(34px, 5vw, 48px); height: clamp(29px, 4.4vw, 42px); background: #143c2bd9; color: #fff5d3; font-size: 18px; font-weight: 900; line-height: 1; }
.menu-panel { position: absolute; right: 0; top: calc(100% + 6px); width: 156px; border-radius: 13px; padding: 7px; background: #fffdf4; color: #4f4a38; box-shadow: 0 9px 25px #09271980; }
.menu-heading { font-size: 11px; color: #9b8b74; padding: 7px 8px; }
.menu-panel button { width: 100%; text-align: left; padding: 10px 8px; background: none; border: 0; color: #3a5c46; font-size: 13px; font-weight: 800; }
.menu-panel button span { float: right; color: #aab6a7; }
.connection { position: absolute; z-index: 15; left: 50%; top: 3%; transform: translateX(-50%); padding: 4px 10px; border-radius: 9px; background: #9b4929; font-size: 11px; white-space: nowrap; }
.player-badge { display: flex; align-items: center; gap: 4px; min-width: 0; text-shadow: 0 1px 2px #0d3425; }
.avatar-chip { position: relative; flex: none; border: 2px solid transparent; border-radius: 50%; display: flex; }
.avatar-chip img { width: clamp(22px, 4.5vh, 42px); height: clamp(22px, 4.5vh, 42px); border-radius: 50%; background: #f8e1aa; }
.avatar-chip--dealer { border-color: #ffd878; box-shadow: 0 0 6px #e9c05caa; }
.player-badge--acting .avatar-chip { outline: 2px solid #8fe6d1; outline-offset: 2px; }
.avatar-chip em { position: absolute; right: -6px; bottom: -4px; }
.player-badge div { min-width: 0; display: flex; flex-direction: column; }
.player-badge b { max-width: 88px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: clamp(9px, 1.7vw, 14px); }
.player-badge small { color: #cbe3d0; white-space: nowrap; font-size: clamp(8px, 1.3vw, 11px); }
.player-badge .seat-timer { color: #b1f7df; font-weight: 900; }
.player-badge em { display: inline-block; font-style: normal; color: #684612; background: #f3ce76; border-radius: 4px; padding: 0 3px; font-size: 9px; }
.opponent { position: absolute; z-index: 2; display: flex; gap: 3px; align-items: center; --tile-w: clamp(7px, 1.28vw, 14px); --tile-h: calc(var(--tile-w) * 1.37); }
.opponent--top { top: 2%; left: 25%; width: 50%; height: 17%; flex-direction: column; justify-content: flex-start; }
.opponent--left { left: 1.4%; top: 18%; width: 10.5%; height: 56%; flex-direction: column; align-items: flex-start; }
.opponent--right { right: 1.4%; top: 18%; width: 10.5%; height: 56%; flex-direction: column; align-items: flex-end; }
.back-row { display: flex; align-items: center; justify-content: center; max-height: 52%; }
.opponent--left .back-row, .opponent--right .back-row { flex-direction: column; flex: none; max-height: none; margin-top: 6px; }
.opponent--left .back-row { align-self: flex-end; margin-right: 4px; }
.opponent--right .back-row { align-self: flex-start; margin-left: 4px; }
.seat-flowers, .seat-melds { --tile-w: clamp(7px, min(1.3vw, 2.8vh), 13px); --tile-h: calc(var(--tile-w) * 1.37); position: absolute; z-index: 3; }
.seat-flowers, .seat-melds { cursor: pointer; touch-action: manipulation; }
.seat-flowers--bottom { right: 24%; bottom: calc(3% + var(--hand-tile-w) * 1.37 + 4px); max-width: 23%; }
.seat-flowers--wide { right: 1.5%; }
.seat-melds--bottom { right: 1.5%; bottom: 3%; max-width: 23%; }
.seat-flowers--top { left: 30%; top: 14%; max-width: 12%; }
.seat-melds--top { right: 15%; top: 14%; max-width: 23%; }
.seat-flowers--left { left: 12.5%; top: 31%; max-height: 48%; }
.seat-melds--left { left: 16%; top: 31%; max-height: 48%; }
.seat-flowers--right { right: 12.5%; top: 31%; max-height: 48%; }
.seat-melds--right { right: 16%; top: 31%; max-height: 48%; }
.river { --tile-w: clamp(10px, min(2vw, 4.1vh), 21px); --tile-h: calc(var(--tile-w) * 1.37); position: absolute; z-index: 2; display: grid; grid-template-columns: repeat(8, var(--tile-w)); grid-auto-rows: var(--tile-h); justify-content: center; align-content: start; gap: 1px; }
.river--dense { --tile-w: clamp(9px, min(1.8vw, 3.2vh), 16px); }
.river--top { top: 28%; left: 36%; width: 28%; }
.river--bottom { bottom: 30%; left: 36%; width: 28%; }
.river--left { left: 25%; top: 32%; width: 10%; grid-template-columns: repeat(4, var(--tile-w)); }
.river--right { right: 25%; top: 32%; width: 10%; grid-template-columns: repeat(4, var(--tile-w)); }
.table-center { position: absolute; z-index: 3; left: 2%; top: 2%; display: flex; flex-wrap: wrap; align-items: baseline; gap: 1px 5px; width: 22%; min-width: 100px; color: #d8e7d4; pointer-events: none; text-shadow: 0 1px 3px #15432b; }
.table-center span { color: #f5d897; font-size: clamp(9px, 1.35vw, 13px); letter-spacing: .08em; }
.table-center strong { font-size: clamp(12px, 2vw, 20px); }
.double-badge { border-radius: 5px; padding: 1px 4px; color: #654616 !important; background: #f4d684; font-weight: 900; }
.table-center small { flex-basis: 100%; white-space: nowrap; font-size: clamp(8px, 1.15vw, 11px); }
.own-badge { position: absolute; z-index: 3; left: 2%; bottom: 4%; }
.own-badge b { max-width: max(32px, 7vw); }
.my-hand { --tile-w: var(--hand-tile-w); --tile-h: calc(var(--tile-w) * 1.37); position: absolute; z-index: 5; bottom: 3%; left: 16%; width: 59%; display: flex; justify-content: center; align-items: end; }
.my-hand--wide { width: 75%; }
.hand-button { display: inline-flex; flex: 0 1 var(--tile-w); width: var(--tile-w); height: var(--tile-h); min-width: 0; padding: 0; border: 0; background: transparent; touch-action: manipulation; user-select: none; -webkit-tap-highlight-color: transparent; }
.hand-button :deep(.tile) { transition: transform .14s ease; }
.hand-button--drawn { margin-left: clamp(3px, .7vw, 9px); }
.hand-button--selected { z-index: 4; }
.hand-button--selected :deep(.tile) { transform: translateY(-10px); }
.no-motion .hand-button :deep(.tile) { transition: none; }
.reveal-tiles { animation: reveal-hand .65s ease-out both; }
@keyframes reveal-hand { from { opacity: .25; transform: perspective(400px) rotateX(70deg) translateY(-7px); } to { opacity: 1; transform: none; } }
.reveal-message { position: absolute; z-index: 9; left: 2%; bottom: 20%; display: flex; align-items: center; gap: 8px; padding: 5px 9px; border: 1px solid #e8ce82; border-radius: 20px; background: #173f2de9; color: #ffdf8d; font-size: clamp(10px, 1.5vw, 14px); font-weight: 900; white-space: nowrap; }
.reveal-message button { border: 0; background: transparent; color: #fff8df; font: inherit; cursor: pointer; }
.spectator-tag { position: absolute; top: 4%; left: 13%; color: #fff0bd; font-size: 11px; }
.spectator-hand { position: absolute; bottom: 5%; left: 38%; font-size: 11px; color: #cae0cd; }
.action-area { position: absolute; z-index: 8; bottom: 17%; left: 23%; width: 54%; display: flex; flex-direction: column; align-items: center; gap: 3px; }
.action-buttons, .waiting-actions, .result-actions, .finished-controls { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 6px; }
.action-btn { border: 1px solid #ead9a4aa; border-radius: 9px; background: #fffaf0; color: #32634a; padding: clamp(5px, 1.4vh, 10px) clamp(9px, 1.7vw, 18px); font-size: clamp(11px, 1.8vw, 15px); font-weight: 900; white-space: nowrap; box-shadow: 0 3px 0 #a29a72, 0 3px 8px #062b1d66; }
.action-btn--gold { background: #ffdb79; border-color: #ffe8a9; color: #694815; box-shadow: 0 3px 0 #b28b38, 0 3px 8px #062b1d66; }
.action-btn--ghost { background: #ffffff20; color: #f6f4dd; box-shadow: none; }
.action-btn:disabled { opacity: .48; }
.risk-note { max-width: 100%; padding: 3px 7px; background: #6e271de8; border-radius: 6px; color: #fff0dc; font-size: clamp(9px, 1.4vw, 12px); text-align: center; }
.finished-controls { position: absolute; z-index: 8; left: 20%; width: 60%; bottom: 17%; }
.waiting-panel { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(72%, 620px); text-align: center; }
.waiting-kicker, .modal-kicker { color: #e9c578; letter-spacing: .2em; font-size: 10px; font-weight: 900; }
.waiting-panel h2 { margin: 2px 0; color: #fff8dc; font-size: clamp(18px, 4vh, 27px); }
.waiting-panel p { margin: 2px 0 8px; color: #d5e6d1; font-size: 11px; }
.waiting-seats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 8px; }
.waiting-seat { min-width: 0; min-height: clamp(75px, 24vh, 125px); background: #104b32a8; border: 1px solid #b9dcaa42; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; padding: 4px; }
.waiting-seat img, .empty-seat { width: clamp(26px, 8vh, 48px); height: clamp(26px, 8vh, 48px); border-radius: 50%; background: #f2e1b6; }
.empty-seat { display: grid; place-items: center; border: 1px dashed #d5e7c8; background: #ffffff12; color: #d5e7c8; }
.waiting-seat b { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: clamp(9px, 1.5vw, 13px); }
.waiting-seat span { color: #b8d9c0; font-size: 10px; }
.add-bot, .remove-bot { color: #f9db8f; background: none; border: 0; font-size: 10px; text-decoration: underline; }
.modal-shade { position: absolute; z-index: 30; inset: 0; display: grid; place-items: center; padding: 12px; background: #09251cbd; }
.group-zoom-card { width: min(94vw, 700px); max-height: 92%; display: flex; flex-direction: column; gap: 6px; padding: 10px 14px; overflow: hidden; border: 1px solid #eee3be; border-radius: 16px; background: #fffdf5; color: #504637; box-shadow: 0 14px 50px #071d16a8; }
.group-zoom-card header { display: flex; align-items: center; gap: 12px; color: #275f43; }
.group-zoom-card header small { color: #82735f; }
.group-zoom-card header button { margin-left: auto; border: 0; padding: 0 4px; background: none; color: #897d6d; font-size: 24px; line-height: 1; }
.group-zoom-card nav { display: flex; gap: 5px; overflow-x: auto; }
.group-zoom-card nav button { border: 1px solid #c9d8c0; border-radius: 7px; padding: 5px 10px; background: #f8f7ea; color: #477253; white-space: nowrap; }
.group-zoom-card nav button.active { background: #397c53; color: white; }
.group-zoom-content { overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 9px; }
.group-zoom-content strong { display: block; margin-bottom: 3px; color: #85755c; font-size: 12px; }
.group-zoom-content span:not(.tile):not(.tile-fallback) { color: #8c816e; }
.zoom-groups { --tile-w: clamp(24px, min(4.5vw, 9vh), 38px); --tile-h: calc(var(--tile-w) * 1.37); justify-content: flex-start; }
.invite-card, .result-card { position: relative; max-height: 92%; overflow: auto; border: 1px solid #eee3be; border-radius: 18px; background: #fffdf5; color: #504637; box-shadow: 0 14px 50px #071d16a8; }
.invite-card { width: min(86vw, 270px); display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 18px; }
.invite-card h2, .invite-card p, .result-card h2 { margin: 0; }
.invite-card p { font-size: 12px; color: #958879; }
.invite-card .modal-kicker, .result-card .modal-kicker { color: #bc8c39; }
.invite-number { color: #286b49; font-size: 23px; letter-spacing: .15em; }
.modal-close { position: absolute; right: 10px; top: 7px; border: 0; background: transparent; color: #897d6d; font-size: 25px; line-height: 1; }
.result-card { width: min(96vw, 920px); height: min(94%, 300px); padding: 7px 10px; display: flex; flex-direction: column; gap: 5px; overflow: hidden; text-align: left; }
.result-header { display: flex; flex: none; align-items: center; gap: 8px; min-height: 24px; }
.result-header h2 { margin: 0; color: #275f43; font-size: clamp(14px, 2vw, 18px); white-space: nowrap; }
.result-header .modal-close { position: static; margin-left: auto; padding: 0 4px; }
.winner-tabs { display: flex; gap: 4px; overflow-x: auto; min-width: 0; }
.winner-tabs button, .ledger-toggle { border: 1px solid #c9d8c0; border-radius: 7px; padding: 3px 7px; background: #f8f7ea; color: #477253; font-size: 11px; white-space: nowrap; }
.winner-tabs button.active { background: #397c53; color: white; }
.result-body { flex: 1; min-height: 0; overflow: auto; }
.result-empty { display: grid; place-items: center; height: 100%; color: #8a795f; }
.result-ledger { height: 100%; overflow: auto; padding: 7px 10px; border-radius: 9px; background: #f5f1df; color: #766b56; font-size: 11px; }
.ledger { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 4px 0; }
.result-footer { flex: none; display: flex; flex-direction: column; gap: 4px; }
.result-balances { display: flex; gap: 4px 9px; align-items: baseline; overflow-x: auto; white-space: nowrap; font-size: clamp(9px, 1.4vw, 11px); }
.result-balances strong { color: #87765c; }
.result-balances b.positive { color: #257846; }
.result-balances b.negative { color: #aa4d3d; }
.result-balances small { color: #958b79; }
.result-actions { justify-content: flex-end; }
.result-actions .action-btn { font-size: clamp(10px, 1.5vw, 13px); padding: 5px 10px; }
.result-actions .action-btn--ghost { color: #3a6d4f; border-color: #c1d4bc; }
.mj-toast { position: absolute; z-index: 100; left: 50%; top: 12%; transform: translateX(-50%); background: #102e22ef; color: white; border-radius: 20px; padding: 7px 13px; font-size: 12px; white-space: nowrap; }
.loading-overlay { position: absolute; inset: 0; display: grid; place-content: center; gap: 10px; text-align: center; }
.loading-overlay button { padding: 8px; border: 0; border-radius: 8px; }
.rotate-cover { display: none; }
@media (orientation: portrait) {
  .rotate-cover { position: fixed; z-index: 200; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: #153e2e; color: #fff9e6; text-align: center; padding: 24px; }
  .rotate-cover strong { font-size: 21px; }
  .rotate-cover span { color: #c8dfcc; font-size: 13px; }
  .rotate-cover button { margin-top: 8px; border: 1px solid #d7e7bd; border-radius: 12px; background: transparent; color: #fff8dd; padding: 10px 18px; font-weight: 800; }
  .rotate-icon { font-size: 56px; line-height: 1; transform: rotate(90deg); color: #e9ce85; }
}
@media (prefers-reduced-motion: reduce) { .hand-button :deep(.tile) { transition: none; } .reveal-tiles { animation: none; } }
</style>
