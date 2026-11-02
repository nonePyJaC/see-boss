<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { SIZE, handicapBoard, group, play, placeSetup, score } from '../lib/go.mjs'
import placeSound from '../assets/go-sounds/place.wav'
import captureSound from '../assets/go-sounds/capture.wav'

const router = useRouter()
const soundEnabled = ref(readSoundPreference())
const sounds = {}
function readSoundPreference() {
  try { return localStorage.getItem('go-sound-enabled') !== 'false' } catch { return true }
}
function toggleSound() {
  soundEnabled.value = !soundEnabled.value
  try { localStorage.setItem('go-sound-enabled', String(soundEnabled.value)) } catch { /* storage may be unavailable */ }
}
function playSound(captured) {
  if (!soundEnabled.value) return
  try {
    const kind = captured ? 'capture' : 'place'
    const sound = sounds[kind] || (sounds[kind] = new Audio(captured ? captureSound : placeSound))
    sound.volume = 0.55
    sound.currentTime = 0
    sound.play()?.catch(() => {})
  } catch { /* Sound must never interrupt the game. */ }
}

const started = ref(false), mode = ref('solo'), handicap = ref(0), komi = ref(7.5)
const board = ref(handicapBoard(0)), turn = ref(1), setup = ref(false), setupColor = ref(1)
const scoring = ref(false), dead = ref(new Set()), history = ref([]), positions = ref([]), chooseTurn = ref(false)
const autoCapture = ref(true)
const passes = ref(0), captures = ref([0, 0]), message = ref(''), lastMove = ref(null)
const result = computed(() => score(board.value, dead.value, komi.value))
const stars = [3, 9, 15].flatMap(y => [3, 9, 15].map(x => ({ x, y })))
function start() {
  board.value = handicapBoard(Number(handicap.value)); turn.value = Number(handicap.value) ? 2 : 1
  setup.value = false; scoring.value = false; dead.value = new Set(); history.value = []
  positions.value = [board.value.join('')]; passes.value = 0; captures.value = [0, 0]; lastMove.value = null; message.value = ''
  chooseTurn.value = false; started.value = true
}
function snapshot() { history.value.push({ board: board.value.slice(), turn: turn.value, passes: passes.value, captures: captures.value.slice(), positions: positions.value.slice(), lastMove: lastMove.value }) }
function undo() {
  const previous = history.value.pop(); if (!previous) return
  board.value = previous.board; turn.value = previous.turn; passes.value = previous.passes
  captures.value = previous.captures; positions.value = previous.positions; lastMove.value = previous.lastMove
  scoring.value = false; dead.value = new Set(); message.value = '已悔棋'
}
function clickPoint(i) {
  if (scoring.value) {
    if (!board.value[i]) return
    const next = new Set(dead.value), stones = group(board.value, i).stones, mark = !next.has(i)
    for (const s of stones) mark ? next.add(s) : next.delete(s)
    dead.value = next; return
  }
  if (setup.value) {
    const removing = board.value[i] === setupColor.value
    snapshot(); const placed = placeSetup(board.value, i, setupColor.value, autoCapture.value)
    board.value = placed.board; captures.value[setupColor.value - 1] += placed.captured
    positions.value = [placed.board.join('')]; passes.value = 0; lastMove.value = null
    message.value = placed.captured ? `提掉 ${placed.captured} 子` : ''
    if (!removing) playSound(placed.captured)
    return
  }
  const move = play(board.value, i, turn.value, positions.value)
  if (move.error) { message.value = move.error; return }
  snapshot(); chooseTurn.value = false; const player = turn.value; board.value = move.board; positions.value.push(move.board.join(''))
  captures.value[player - 1] += move.captured; turn.value = 3 - player; passes.value = 0; lastMove.value = i; message.value = move.captured ? `提掉 ${move.captured} 子` : ''
  playSound(move.captured)
}
function pass() {
  snapshot(); chooseTurn.value = false; passes.value++; turn.value = 3 - turn.value; lastMove.value = null
  if (passes.value >= 2) { scoring.value = true; dead.value = new Set(); message.value = '双方连续停一手，请标记死子后查看结果' }
  else message.value = '已停一手'
}
function toggleSetup() {
  setup.value = !setup.value; scoring.value = false; dead.value = new Set(); passes.value = 0
  if (!setup.value) { chooseTurn.value = true; positions.value = [board.value.join('')]; message.value = '摆棋结束，请选择接下来落子的一方' }
  else message.value = '点击空位摆子，点击同色棋子移除，点击异色棋子替换'
}
function beginScore() { setup.value = false; scoring.value = true; dead.value = new Set(); message.value = '点击棋子标记或取消死子，整块棋会一起标记' }
function reset() { if (confirm('重新设置将清除当前棋局，确定继续？')) started.value = false }
</script>

<template>
  <main class="go-page">
    <header class="go-head"><button class="plain" @click="started ? reset() : router.push('/lobby')">‹ {{ started ? '重新设置' : '游戏大厅' }}</button><h1>围棋</h1><button class="sound-toggle" :aria-pressed="soundEnabled" @click="toggleSound">{{ soundEnabled ? '音效：开' : '音效：关' }}</button></header>
    <section v-if="!started" class="panel settings">
      <h2>开始一局</h2><p>无需房间码，在这台设备上轮流落子。</p>
      <div class="mode-options"><button :class="{ selected: mode === 'solo' }" @click="mode = 'solo'">单机模式<small>本地轮流落子</small></button><button :class="{ selected: mode === 'online' }" @click="mode = 'online'">对弈模式<small>暂未开放</small></button></div>
      <label>让子规则 <select v-model.number="handicap"><option :value="0">不让子</option><option v-for="n in 8" :key="n" :value="n + 1">黑棋让 {{ n + 1 }} 子</option></select></label>
      <label>白棋贴目 <input v-model.number="komi" type="number" step="0.5" min="0" max="100" /></label>
      <p class="hint">固定星位让子；让子局由白棋先行。默认贴 7.5 目，可按规则调整。</p>
      <button class="primary" :disabled="mode === 'online'" @click="start">{{ mode === 'online' ? '对弈模式暂未开放' : '开始单机棋局' }}</button>
    </section>
    <template v-else>
      <div class="game-layout">
        <section class="board-section">
          <div class="status"><strong>{{ scoring ? '数目中' : setup ? '摆子模式' : (turn === 1 ? '黑棋落子' : '白棋落子') }}</strong><span>黑提 {{ captures[0] }} 子 · 白提 {{ captures[1] }} 子</span></div>
          <div class="board" role="grid" aria-label="19路围棋棋盘">
            <svg class="board-lines" viewBox="0 0 19 19" aria-hidden="true"><template v-for="n in 19" :key="n"><line :x1="0.5" :x2="18.5" :y1="n - 0.5" :y2="n - 0.5"/><line :y1="0.5" :y2="18.5" :x1="n - 0.5" :x2="n - 0.5"/></template><circle v-for="star in stars" :key="star.x + '-' + star.y" :cx="star.x + 0.5" :cy="star.y + 0.5" r="0.12" /></svg>
            <button v-for="(stone, i) in board" :key="i" class="point" :aria-label="`${Math.floor(i / SIZE) + 1}行${i % SIZE + 1}列 ${stone === 1 ? '黑子' : stone === 2 ? '白子' : '空'}`" @click="clickPoint(i)"><span v-if="stone" class="stone" :class="[stone === 1 ? 'black' : 'white', { dead: scoring && dead.has(i) }]"><i v-if="lastMove === i && !scoring"></i><b v-if="scoring && dead.has(i)">×</b></span><span v-else-if="scoring && result.ownership[i]" class="territory" :class="result.ownership[i] === 1 ? 'black' : 'white'"></span></button>
          </div>
          <p class="message" aria-live="polite">{{ message || '点击交叉点落子' }}</p>
        </section>
        <aside class="panel controls">
          <template v-if="scoring"><h2>数目结果</h2><p>中国数子法：活子 + 围空；白棋加贴目。中立点不计入双方。</p><div class="score-row"><span>黑棋</span><strong>{{ result.black }} 目</strong><small>{{ result.blackStones }} 子 + {{ result.blackTerritory }} 空</small></div><div class="score-row"><span>白棋</span><strong>{{ result.white }} 目</strong><small>{{ result.whiteStones }} 子 + {{ result.whiteTerritory }} 空 + {{ komi }} 贴目</small></div><p>中立 {{ result.neutral }} 点 · {{ result.black === result.white ? '平局' : (result.black > result.white ? '黑棋' : '白棋') + '领先 ' + Math.abs(result.black - result.white) + ' 目' }}</p><p class="hint">请先确认双方活死，点击棋块标记死子；未完成的棋局结果仅供参考。</p><button @click="scoring = false; message = ''">返回棋局</button></template>
          <template v-else><h2>棋局操作</h2><div v-if="setup" class="choose"><span>摆放颜色</span><button :class="{ active: setupColor === 1 }" @click="setupColor = 1">⚫ 黑</button><button :class="{ active: setupColor === 2 }" @click="setupColor = 2">⚪ 白</button></div><label v-if="setup" class="capture-option"><input v-model="autoCapture" type="checkbox" /> 自动提子 <small>关闭后可自由摆出任意局面</small></label><div v-else-if="chooseTurn" class="choose"><span>下一手</span><button :class="{ active: turn === 1 }" @click="turn = 1; passes = 0">⚫ 黑</button><button :class="{ active: turn === 2 }" @click="turn = 2; passes = 0">⚪ 白</button></div><div class="actions"><button @click="toggleSetup">{{ setup ? '完成摆棋' : '摆子模式' }}</button><button :disabled="setup" @click="pass">停一手</button><button :disabled="!history.length" @click="undo">悔棋</button><button class="primary" @click="beginScore">结算数目</button></div><p class="hint">禁止自杀和重复此前棋形。双方连续停一手进入数目；摆棋后从当前棋形重新记录同形。棋局仅保存在当前页面，离开或刷新后将清空。</p></template>
        </aside>
      </div>
    </template>
  </main>
</template>
<style scoped>
.go-page{max-width:1440px;margin:auto;padding:16px;color:#332b22}.go-head{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;margin-bottom:16px}.go-head h1{font-size:22px;margin:0}.sound-toggle{justify-self:end;font-size:13px;white-space:nowrap}.plain{justify-self:start;background:none;border:0;color:#77532f;font-size:15px}.panel{background:#fffaf2;border:1px solid #e6d4b8;border-radius:18px;padding:20px;box-shadow:0 4px 20px #71532a12}.settings{max-width:480px;margin:30px auto}.panel h2{font-size:19px;margin:0 0 12px}.panel p{font-size:14px;line-height:1.6;color:#756653}.mode-options{display:flex;gap:10px;margin:20px 0}.mode-options button{flex:1;text-align:left}.mode-options small{display:block;margin-top:5px;color:#806f5e}.selected,.active{border-color:#aa6925!important;background:#f7e3c2!important}.settings label{display:flex;justify-content:space-between;align-items:center;margin:15px 0}.settings select,.settings input{width:145px;padding:9px;border:1px solid #d7c5ad;border-radius:8px;background:white}.hint{font-size:12px!important;color:#8c7c68!important}.settings>.primary{width:100%;margin-top:10px}.game-layout{display:grid;grid-template-columns:minmax(0, min(1050px, calc(100dvh - 125px))) minmax(250px, 320px);gap:20px}.board-section{min-width:0}.status{display:flex;justify-content:space-between;gap:8px;margin:4px 0 10px;font-size:14px}.status span{color:#78644d}.board{position:relative;display:grid;grid-template-columns:repeat(19,minmax(0,1fr));grid-template-rows:repeat(19,minmax(0,1fr));aspect-ratio:1;background:#d9a95f;box-shadow:0 4px 16px #69452133;border:5px solid #a9773d;border-radius:4px}.board-lines{position:absolute;width:100%;height:100%;fill:#5c3f24;stroke:#6c4928;stroke-width:.035;pointer-events:none}.board-lines circle{stroke:none}.point{position:relative;display:grid;place-items:center;padding:0;border:0;background:none;min-width:0;cursor:pointer;z-index:1}.point:focus-visible{outline:2px solid #c22;z-index:3}.stone{width:92%;height:92%;border-radius:50%;display:grid;place-items:center;box-shadow:1px 2px 3px #38271370}.black{background:#242424}.white{background:#f9f7ef;border:1px solid #aaa}.stone.dead{opacity:.55}.stone b{color:#e33;font-size:clamp(9px,2vw,20px);line-height:1}.stone i{width:22%;height:22%;border-radius:50%;background:#d75939}.territory{width:24%;height:24%}.message{min-height:24px;font-size:13px;color:#795b39}.controls{align-self:start}.capture-option{display:flex;align-items:center;gap:6px;margin:12px 0;flex-wrap:wrap;font-size:14px}.capture-option small{color:#8c7c68}.choose{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:12px 0}.choose span{margin-right:auto;font-size:14px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.go-page button:not(.point):not(.plain){border:1px solid #dbc8ae;border-radius:10px;padding:10px;background:#fff;color:#493c2c;cursor:pointer}.go-page button.primary{background:#80552c!important;color:white!important;border-color:#80552c!important}.go-page button:disabled{opacity:.5;cursor:not-allowed}.score-row{display:grid;grid-template-columns:1fr auto;gap:4px;padding:12px 0;border-bottom:1px solid #eadcc8}.score-row small{grid-column:1/-1;color:#8a7b68}.controls>button{width:100%}@media(max-width:800px){.go-page{padding:12px}.game-layout{grid-template-columns:1fr;gap:8px}.controls{padding:16px}.board{border-width:3px}.status{font-size:12px}.settings{margin:16px auto}}
</style>



