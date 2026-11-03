<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { SIZE, newGame, play } from '@shared/logic/gomoku.mjs'
import { chooseMove } from '@shared/logic/gomoku-ai.mjs'
import { useUser } from '../stores/user.js'
import { getUid } from '../data/account-repo.js'
import { request } from '../data/http.js'
import { createOnlineRoom, onlineState, onlineLeave, startRoom, loadSeatCred, saveSeatCred, clearSeatCred } from '../data/room-repo.js'
import JoinRoomPanel from '../components/JoinRoomPanel.vue'
import RoomQR from '../components/RoomQR.vue'
import { askConfirm } from '../composables/useConfirm.js'

const router = useRouter(), route = useRoute(), { user, refresh } = useUser()
const roomId = computed(() => String(route.query.room || '').trim())
const mode = ref(''), tab = ref('create'), rules = ref({ doubleThree:false, doubleFour:false, overline:false })
const difficulty = ref('normal'), playerColor = ref(1), aiThinking = ref(false)
const createCode = ref(''), localGame = ref(null), room = ref(null), cred = ref(null), error = ref(''), busy = ref(false), connected = ref(true)
let timer = null, polling = false, aiWorker = null, aiTimer = null, aiVersion = 0
const game = computed(() => roomId.value ? room.value?.game : localGame.value)
const isHost = computed(() => !!room.value?.seats?.find(s => s.isMe && s.isHost))
const myColor = computed(() => room.value?.seats?.find(s => s.isMe)?.color || 0)
const displayRules = computed(() => roomId.value ? room.value?.rules : game.value?.rules)
const ruleSummary = computed(() => { const r=displayRules.value; if (!r) return ''; const a=[]; if(r.doubleThree)a.push('三三'); if(r.doubleFour)a.push('四四'); if(r.overline)a.push('长连'); return a.length ? '黑棋禁手：'+a.join('、') : '无禁手' })
const status = computed(() => {
  if (!game.value) return '等待好友加入并由房主开局'
  const g = game.value
  if (g.phase === 'finished') return g.winner ? (g.winner === 1 ? '黑棋获胜' : '白棋获胜') + (g.reason ? ' · '+g.reason : '') : '棋盘已满，平局'
  return (g.turn === 1 ? '黑棋' : '白棋') + '落子' + (roomId.value ? (myColor.value === g.turn ? ' · 轮到你' : '') : (g.turn === playerColor.value ? ' · 轮到你' : aiThinking.value ? ' · AI 思考中' : ' · 等待 AI 重试'))
})
const lines = Array.from({length:SIZE}, (_,i) => i)
const stars = [{x:3,y:3},{x:11,y:3},{x:7,y:7},{x:3,y:11},{x:11,y:11}]
function stopAI() {
  aiVersion++; if (aiTimer) clearTimeout(aiTimer); aiTimer = null
  aiWorker?.terminate(); aiWorker = null; aiThinking.value = false
}
function scheduleAI() {
  const current = localGame.value
  if (!current || current.phase !== 'playing' || current.turn === playerColor.value || roomId.value) return
  stopAI(); const version = aiVersion, plain = JSON.parse(JSON.stringify(current)); aiThinking.value = true; error.value = ''
  function finish(index, problem) {
    if (version !== aiVersion || current !== localGame.value || roomId.value) return
    aiWorker?.terminate(); aiWorker = null; aiTimer = null; aiThinking.value = false
    if (problem || !Number.isInteger(index)) { error.value = problem || 'AI 暂时无法落子，请重试'; return }
    const result = play(current, index)
    if (result.error) { error.value = 'AI 落子失败，请重试'; return }
    localGame.value = result.state
  }
  function fallback() {
    if (version !== aiVersion) return
    aiWorker?.terminate(); aiWorker = null
    aiTimer = setTimeout(() => { try { finish(chooseMove(plain, difficulty.value)) } catch { finish(null, 'AI 思考失败，请重试') } }, 0)
  }
  try {
    aiWorker = new Worker(new URL('../workers/gomoku-ai.js', import.meta.url), { type: 'module' })
    aiWorker.onmessage = ({ data }) => finish(data.index, data.error)
    aiWorker.onerror = fallback
    aiWorker.postMessage({ id: version, game: plain, difficulty: difficulty.value })
  } catch { fallback() }
}
function localStart() { stopAI(); localGame.value = newGame(rules.value); error.value = ''; scheduleAI() }
function setRoom(data) { if (!data || data.id !== roomId.value) return; if (room.value && (data.rev ?? 0) < (room.value.rev ?? 0)) return; room.value = data }
async function poll() {
  const id = roomId.value
  if (!id || polling) return
  polling = true
  try { const r = await onlineState(id, cred.value); if (id !== roomId.value) return; connected.value = r.ok
    if (r.ok) setRoom(r.data)
    else if (r.code === 'ROOM_NOT_FOUND') { clearSeatCred(id); room.value = null; error.value = '房间已解散或过期'; if (timer) clearInterval(timer) }
  } finally { polling = false }
}
watch(roomId, id => {
  if (timer) clearInterval(timer)
  if (id) stopAI()
  room.value = null; error.value = ''; cred.value = id ? loadSeatCred(id) : null
  if (id) { void poll(); timer = setInterval(poll, 1000) }
}, { immediate:true })
onMounted(async () => {
  await refresh()
  if (!user.value?.loggedIn && (roomId.value || mode.value === 'online')) await router.replace({ name:'register', query:{ redirect:route.fullPath } })
})
onUnmounted(() => { if (timer) clearInterval(timer); stopAI() })
async function selectMode(m) {
  if (m === 'online' && !user.value?.loggedIn) { await refresh(); if (!user.value?.loggedIn) { await router.push({name:'register',query:{redirect:'/gomoku'}}); return } }
  mode.value=m; error.value=''
}
async function create() {
  if (busy.value) return
  if (!user.value?.canCreateWithoutCode && !createCode.value.trim()) { error.value = '请输入创建码'; return }
  busy.value=true; error.value=''
  try {
    const r=await createOnlineRoom({mode:'online',gameType:'gomoku',rules:rules.value}, {nickname:user.value?.nickname || '房主',avatar:user.value?.avatar ?? 1}, createCode.value.trim())
    if (!r.ok) { error.value=r.error || '创建失败'; return }
    saveSeatCred(r.data.id,r.data); await router.push({path:'/gomoku',query:{room:r.data.id}})
  } finally { busy.value=false }
}
async function startOnline() {
  if (busy.value || !cred.value) return
  busy.value=true; error.value=''
  try { const r=await startRoom(roomId.value, undefined, cred.value); if (r.ok) setRoom(r.data); else error.value=r.error || '开局失败' } finally { busy.value=false }
}
async function move(i) {
  if (!game.value || busy.value) return
  if (!roomId.value) { if (aiThinking.value || localGame.value.turn !== playerColor.value) return; const r=play(localGame.value,i); if (r.error) error.value=r.error; else { localGame.value=r.state; error.value=''; scheduleAI() }; return }
  if (!cred.value || game.value.turn !== myColor.value || game.value.phase !== 'playing') return
  const id=roomId.value, current=game.value; busy.value=true; error.value=''
  try { const r=await request('/api/room/action',{uid:getUid(),roomId:id,...cred.value,matchId:current.matchId,moveNo:current.moveNo,index:i})
    if (id !== roomId.value) return
    if (r.ok) setRoom(r.data); else { error.value=r.error || '落子失败'; if (r.code === 'STALE_MOVE') void poll() }
  } finally { busy.value=false }
}
async function leave() {
  const id=roomId.value
  if (!id) { if (localGame.value && !await askConfirm({title:'返回设置',msg:'离开将结束当前棋局，确定返回？',okText:'返回'})) return; stopAI(); localGame.value=null; mode.value=''; return }
  if (!cred.value) { await router.push('/gomoku'); return }
  if (!await askConfirm({title:isHost.value?'解散房间':'退出房间',msg:isHost.value?'解散后双方将退出房间。':'退出后当前棋局将结束。',okText:isHost.value?'解散':'退出',danger:true})) return
  const r=await onlineLeave(id,cred.value); if (!r.ok) { error.value=r.error || '退出失败'; return }
  clearSeatCred(id); await router.push('/gomoku'); mode.value=''
}
const inviteLink = computed(() => location.origin + location.pathname + '#/join/' + roomId.value + '?mode=online&game=gomoku')
async function copyInvite() { try { await navigator.clipboard.writeText(inviteLink.value); error.value='邀请链接已复制' } catch { error.value='请长按下方链接复制' } }
</script>
<template>
<main class="gomoku-page">
  <header class="head"><button @click="roomId || localGame ? leave() : mode ? mode = '' : router.push('/lobby')">‹ {{ roomId ? '退出房间' : localGame ? '返回设置' : mode ? '返回' : '游戏大厅' }}</button><h1>五子棋</h1><span></span></header>
  <section v-if="!mode && !roomId" class="panel entry"><h2>选择模式</h2><button class="mode" @click="selectMode('solo')"><strong>单机模式</strong><small>与 AI 对弈 · 难度可选</small></button><button class="mode" @click="selectMode('online')"><strong>对弈模式</strong><small>创建房间，邀请好友一起玩</small></button></section>
  <section v-else-if="!roomId && !localGame" class="panel entry">
    <h2>{{ mode === 'solo' ? '单机模式' : '好友对弈' }}</h2><template v-if="mode === 'solo'"><label class="setting">AI 难度<select v-model="difficulty"><option value="easy">入门</option><option value="normal">普通</option><option value="hard">困难</option></select></label><label class="setting">选择棋色<select v-model.number="playerColor"><option :value="1">执黑 · 先手</option><option :value="2">执白 · 后手</option></select></label></template>
    <div v-if="mode === 'online'" class="tabs"><button :class="{active:tab==='create'}" @click="tab='create'">创建房间</button><button :class="{active:tab==='join'}" @click="tab='join'">加入房间</button></div>
    <JoinRoomPanel v-if="mode === 'online' && tab === 'join'" mode="online" game-type="gomoku" />
    <template v-else><p>黑棋禁手规则（可多选，默认无禁手）</p><label class="rule"><input v-model="rules.doubleThree" type="checkbox"> 三三禁手</label><label class="rule"><input v-model="rules.doubleFour" type="checkbox"> 四四禁手</label><label class="rule"><input v-model="rules.overline" type="checkbox"> 长连禁手</label><p class="hint">黑棋走出禁手即判负；成五优先。白棋不受禁手限制。</p><label v-if="mode==='online' && !user?.canCreateWithoutCode" class="code">创建码<input v-model="createCode" type="password" placeholder="输入房间创建码" autocomplete="off"></label><p v-if="error" class="error">{{ error }}</p><button class="primary" :disabled="busy" @click="mode==='solo' ? localStart() : create()">{{ busy ? '创建中…' : mode==='solo' ? '开始对弈' : '创建房间' }}</button></template>
  </section>
  <template v-else>
    <div v-if="roomId && !connected" class="error">{{ error || '连接中断，正在重试' }}</div>
    <div class="layout"><section class="board-area"><div class="status"><strong>{{ status }}</strong><span>{{ ruleSummary }}</span></div>
      <div v-if="game" class="board" role="grid" aria-label="15路五子棋棋盘"><svg class="lines" viewBox="0 0 15 15" aria-hidden="true"><template v-for="n in lines" :key="n"><line x1="0.5" x2="14.5" :y1="n+.5" :y2="n+.5"/><line y1="0.5" y2="14.5" :x1="n+.5" :x2="n+.5"/></template><circle v-for="star in stars" :key="star.x+'-'+star.y" :cx="star.x+.5" :cy="star.y+.5" r=".12" /></svg><button v-for="(stone,i) in game.board" :key="i" class="point" :aria-label="`${Math.floor(i/SIZE)+1}行${i%SIZE+1}列 ${stone===1?'黑子':stone===2?'白子':'空'}`" @click="move(i)"><span v-if="stone" :class="['stone',stone===1?'black':'white',{win:game.winning?.includes(i)}]"><i v-if="game.lastMove===i"></i></span></button></div>
      <div v-else class="waiting">{{ roomId && !room ? '正在连接房间…' : '等待好友加入' }}</div><p v-if="error" class="error" role="status">{{ error }}</p>
    </section><aside class="panel controls"><h2>{{ roomId ? '好友对弈' : '单机对弈' }}</h2><template v-if="roomId && room"><p>房间号：<strong>{{ roomId }}</strong></p><p v-for="seat in room.seats" :key="seat.uid">{{ seat.color===1?'⚫ 黑棋':'⚪ 白棋' }}：{{ seat.nickname }}{{ seat.isMe?'（你）':'' }}</p><p v-if="room.seats.length<2">等待另一位玩家加入</p><button v-if="isHost && room.seats.length===2 && (!game || game.phase==='finished')" class="primary" :disabled="busy" @click="startOnline">{{ game ? '再来一局' : '开始对局' }}</button><div v-if="room.seats.length<2" class="invite"><RoomQR :room-no="roomId" mode="online" game="gomoku" :size="150"/><button @click="copyInvite">复制邀请链接</button><input :value="inviteLink" readonly aria-label="邀请链接" @focus="$event.target.select()"></div></template><template v-else-if="!roomId"><p>你执{{ playerColor === 1 ? '黑' : '白' }}棋 · AI {{ {easy:'入门',normal:'普通',hard:'困难'}[difficulty] }}</p><p v-if="aiThinking">AI 正在思考…</p><button v-if="!aiThinking && game?.phase === 'playing' && game.turn !== playerColor" @click="scheduleAI">AI 重试</button><button @click="localStart">重新开始</button></template><p class="hint">{{ ruleSummary }}。棋子连成五个获胜；黑棋走出禁手即判负。{{ roomId ? '房间服务重启后本局结束。' : '' }}</p></aside></div>
  </template>
</main>
</template>
<style scoped>
.gomoku-page{max-width:1400px;margin:auto;padding:16px;color:#332b22}.head{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;margin-bottom:16px}.head h1{font-size:22px;margin:0}.head button{justify-self:start;border:0;background:none;color:#77532f}.panel{background:#fffaf2;border:1px solid #e6d4b8;border-radius:18px;padding:20px}.panel h2{margin:0 0 12px;font-size:19px}.panel p{color:#756653;font-size:14px;line-height:1.6}.entry{max-width:500px;margin:30px auto}.mode{width:100%;display:flex;flex-direction:column;text-align:left;gap:6px;margin:10px 0}.mode small{color:#85725c}.tabs{display:flex;gap:8px;margin:16px 0}.active{background:#f7e3c2!important;border-color:#aa6925!important}.setting{display:flex;align-items:center;justify-content:space-between;margin:14px 0}.setting select{padding:9px;border:1px solid #dbc8ae;border-radius:9px;background:white;min-width:145px}.rule{display:block;margin:12px 0;font-size:15px}.code{display:grid;gap:6px}.code input,.invite input{min-width:0;padding:10px;border:1px solid #dbc8ae;border-radius:9px}.primary{background:#80552c!important;color:white!important;border-color:#80552c!important}.entry>.primary,.controls>.primary{width:100%;margin-top:12px}.layout{display:grid;grid-template-columns:minmax(0,min(900px,calc(100dvh - 125px))) minmax(250px,320px);gap:20px}.board-area{min-width:0}.status{display:flex;justify-content:space-between;gap:8px;margin:4px 0 10px;font-size:14px}.status span{color:#78644d}.board{position:relative;display:grid;grid-template-columns:repeat(15,minmax(0,1fr));grid-template-rows:repeat(15,minmax(0,1fr));aspect-ratio:1;background:#d9a95f;border:5px solid #a9773d;border-radius:4px}.lines{position:absolute;width:100%;height:100%;fill:#5c3f24;stroke:#6c4928;stroke-width:.035;pointer-events:none}.lines circle{stroke:none}.point{z-index:1;display:grid;place-items:center;border:0;padding:0;background:none;min-width:0}.stone{width:92%;height:92%;border-radius:50%;display:grid;place-items:center;box-shadow:1px 2px 3px #38271370}.black{background:#242424}.white{background:#f9f7ef;border:1px solid #aaa}.stone i{width:22%;height:22%;border-radius:50%;background:#e95637}.stone.win{outline:2px solid #d74327;outline-offset:-3px}.waiting{display:grid;place-items:center;aspect-ratio:1;max-height:400px;border-radius:12px;background:#f1dec1;color:#8c7354}.error{color:#ad3e2b;font-size:14px}.hint{font-size:12px!important;color:#8c7c68!important}.invite{display:grid;justify-items:center;gap:10px;margin-top:20px}.invite input{width:100%;font-size:12px}.gomoku-page button:not(.point){border:1px solid #dbc8ae;border-radius:10px;padding:10px;background:#fff;color:#493c2c;cursor:pointer}.gomoku-page button:disabled{opacity:.5;cursor:not-allowed}@media(max-width:800px){.gomoku-page{padding:12px}.layout{grid-template-columns:1fr;gap:8px}.controls{padding:16px}.board{border-width:3px}.status{font-size:12px}.entry{margin:16px auto}}
</style>
