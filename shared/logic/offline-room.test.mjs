import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STAGE,
  STAGE_PEANUTS,
  initOfflineHand,
  applyOfflineAction,
  availableActions,
  toCall,
  nextStage,
  nextHand,
  handResolved,
  activePlayers,
} from './offline-room.mjs'

// ── 测试辅助 ──
const mkPlayers = (seeds) =>
  seeds.map((s, i) => ({ uid: 'u' + i, nickname: 'P' + i, avatar: 1, seeds: s }))

function start(seeds = [1000, 1000, 1000], cfg = {}) {
  return initOfflineHand({
    players: mkPlayers(seeds),
    smallBlind: 10,
    bigBlind: 20,
    ...cfg,
  })
}

// 没传 uid 就自动用当前回合持有者 —— 测试里多数场景就是「当前该动的人」
function act(state, action) {
  const uid = action.uid ?? state.turnUid
  const r = applyOfflineAction(state, { ...action, uid })
  assert.ok(!r.error, '动作被拒：' + r.error)
  return r.state
}

/** 连续执行 n 个动作（都发给当前回合持有者） */
function actN(state, type, n) {
  let s = state
  for (let i = 0; i < n; i++) s = act(s, { type })
  return s
}

test('开局自动扣大小麦，pot = 30，currentBet = 20', () => {
  const st = start()
  assert.equal(st.pot, 30)
  assert.equal(st.currentBet, 20)
  // 三人局：u0 小麦、u1 大麦、u2 先行动
  assert.equal(st.seats[0].blind, 'sb')
  assert.equal(st.seats[1].blind, 'bb')
  assert.equal(st.turnUid, 'u2')
  assert.equal(st.seats[2].seeds, 1000)
  assert.equal(toCall(st, 'u2'), 20)
})

test('跟注补齐到 currentBet，筹码进 pot', () => {
  let st = start()
  st = act(st, { uid: st.turnUid, type: 'call' })
  assert.equal(st.seats[2].seeds, 980)
  assert.equal(st.seats[2].bet, 20)
  assert.equal(st.pot, 50)
  // u2 是首家行动；他跟完后轮到只下了 10 的 u0（小盲）
  assert.equal(st.turnUid, 'u0')
  assert.equal(toCall(st, 'u0'), 10)
})

test('加注 = 跟注 + 额外，currentBet 更新，行动轮重置', () => {
  let st = start()
  const first = st.turnUid   // u2
  // u2 跟 20 再额外加 50 → 共下 70
  st = applyOfflineAction(st, { uid: first, type: 'raise', amount: 50 }).state
  assert.equal(st.seats[2].bet, 70)
  assert.equal(st.currentBet, 70)
  assert.equal(st.pot, 100)
  // 加注后行动轮重置：轮到 Bet 最小的 u0（小盲 10）
  assert.equal(st.turnUid, 'u0')
})

test('加注超出我的瓜子被拒，上限是全下', () => {
  let st = start([50, 1000, 1000])   // u0 只有 50，扣完小麦剩 40
  st = act(st, { type: 'call' })     // u2 跟 20
  st = act(st, { type: 'call' })     // u0（小盲）补 10 → 剩 30
  // 现在 u0 手里只剩 30，要他加 999 必须被拒
  const cur = st.turnUid
  const r = applyOfflineAction(st, { uid: cur, type: 'raise', amount: 999 })
  assert.match(r.error, /超出我的瓜子/)
})

test('全下：筹码不足时跟注只投入剩余全部', () => {
  // u0 只够开局的筹码：小麦 10 后剩 5，call 时把 5 全押进去
  let st = start([15, 1000, 1000])
  st = act(st, { type: 'call' })   // u2 跟 20
  st = act(st, { type: 'call' })   // u0 补差额（只有 5）→ 全下
  assert.equal(st.seats[0].seeds, 0)
  assert.equal(st.seats[0].allIn, true)
  assert.equal(st.seats[0].bet, 15, '小盲 10 + 全下 5')
})

test('弃牌后不再轮到他', () => {
  let st = start()
  st = act(st, { type: 'fold' })          // 当前回合 u2 弃牌
  assert.equal(st.seats[2].folded, true)
  assert.equal(activePlayers(st.seats).length, 2)
  // 剩下 u0（小盲 10）和 u1（大麦 20）都没表态，接下来必然是这两个人。
  // 用 uid 显式校验，而不是数次数。
  const t1 = st.turnUid
  assert.notEqual(t1, 'u2')
  st = act(st, { type: 'call' })
  const t2 = st.turnUid
  assert.notEqual(t2, 'u2')
  assert.notEqual(t1, t2)
  assert.equal(st.seats[2].folded, true)
})

test('只剩 1 人未弃牌 → 自动收池，无需他动手', () => {
  let st = start()
  st = act(st, { type: 'fold' })          // u2 弃
  // 再弃一个 → 只剩 1 人 → afterMove 里自动替他收池
  const r = applyOfflineAction(st, { uid: st.turnUid, type: 'fold' })
  assert.ok(!r.error, r.error ?? '')
  st = r.state

  const alive = st.seats.filter((s) => !s.folded)
  assert.equal(alive.length, 1)

  assert.equal(st.finished, true, '本手应已自动结束')
  assert.equal(st.pot, 0, '公共池应已被自动收走')
  assert.equal(r.autoCollected?.uid, alive[0].uid, '收池的应是幸存者')

  // 再点收会明确告知池子已空，而不是默默成功
  const again = applyOfflineAction(st, { uid: alive[0].uid, type: 'collect' })
  assert.match(again.error, /公共池是空的/)
})

test('收池：公共池清零，收的人拿走全部', () => {
  let st = start()
  st = act(st, { type: 'call' })
  const pot = st.pot
  const taker = st.turnUid
  const before = st.seats.find((s) => s.uid === taker).seeds
  st = act(st, { uid: taker, type: 'collect' })
  assert.equal(st.pot, 0)
  assert.equal(st.seats.find((s) => s.uid === taker).seeds, before + pot)
  assert.equal(st.finished, true)
})

test('收空池被拒', () => {
  let st = start()
  st = act(st, { type: 'collect' })        // 当前回合持有者直接收走
  const other = st.seats.find((s) => s.uid !== st.turnUid).uid
  const r = applyOfflineAction(st, { uid: other, type: 'collect' })
  assert.match(r.error, /公共池是空的/)
})

test('不是自己的回合，任何下注动作都被拒', () => {
  const st = start()
  const other = ['u0', 'u1', 'u2'].find((u) => u !== st.turnUid)
  for (const t of ['call', 'raise', 'fold']) {
    const r = applyOfflineAction(st, { uid: other, type: t })
    assert.match(r.error, /还没到你的回合/, t + ' 应被拒')
  }
  // 但收池例外：谁都可以收
  const ok = applyOfflineAction(st, { uid: other, type: 'collect' })
  assert.ok(!ok.error, '收池不该被回合拦')
})

test('结算判定：有人归零才该弹窗', () => {
  // u0 只够开局的筹码，打完这手必然归零
  let st = start([20, 1000, 1000])
  st = act(st, { type: 'call' })
  st = act(st, { type: 'call' })
  st = act(st, { type: 'collect' })
  const zeroed = st.seats.filter((s) => s.seeds <= 0)
  assert.equal(zeroed.length, 1)
  assert.equal(zeroed[0].uid, 'u0')
})

test('无人归零 → 正常进入下一手，不触发结算', () => {
  let st = start()
  st = act(st, { type: 'collect' })
  assert.equal(st.seats.every((s) => s.seeds > 0), true)
})

test('花生节拍器：preflop 不亮，flop 三颗，turn 四颗，river 五颗', () => {
  assert.equal(STAGE_PEANUTS[STAGE.PREFLOP], 0)
  assert.equal(STAGE_PEANUTS[STAGE.FLOP], 3)
  assert.equal(STAGE_PEANUTS[STAGE.TURN], 4)
  assert.equal(STAGE_PEANUTS[STAGE.RIVER], 5)
})

test('换街只推进花生，不发牌不清注', () => {
  let st = start()
  st = act(st, { type: 'call' })
  const potBefore = st.pot
  const betsBefore = st.seats.map((s) => s.bet)
  st = nextStage(st)
  assert.equal(st.stage, STAGE.FLOP)
  assert.equal(st.pot, potBefore, '换街不动 pot')
  assert.deepEqual(st.seats.map((s) => s.bet), betsBefore, '换街不动下注')
})

test('nextHand 重置阶段/下注/弃牌，保留累计', () => {
  let st = start()
  st = act(st, { type: 'fold' })
  st = act(st, { type: 'collect' })
  const total = st.seats.map((s) => s.totalBet)
  st = nextHand(st)
  assert.equal(st.stage, STAGE.PREFLOP)
  assert.equal(st.currentBet, 0)
  assert.equal(st.finished, false)
  assert.equal(st.seats.every((s) => s.bet === 0 && !s.folded), true)
  assert.deepEqual(st.seats.map((s) => s.totalBet), total, '累计不丢')
})

test('handResolved：所有人表态后才算打完', () => {
  let st = start([15, 1000, 1000])
  st = act(st, { type: 'call' })    // u2 表态
  st = act(st, { type: 'call' })    // u0 全下表态
  assert.equal(st.seats[0].allIn, true)
  // u1（大麦）虽然满注，但从没表态过 → 本手未完
  assert.equal(handResolved(st), false, 'u1 还没表态')

  // u1 已满注，没有可跟的数额 → 由他直接收池来结束本手
  st = act(st, { type: 'collect' })
  assert.equal(st.finished, true)
})

test('状态可 JSON 往返（快照 / 恢复）', () => {
  let st = start()
  st = act(st, { uid: 'u2', type: 'raise', amount: 30 })
  const round = JSON.parse(JSON.stringify(st))
  const r = applyOfflineAction(round, { uid: round.turnUid, type: 'call' })
  assert.ok(!r.error, '恢复后应能继续')
})

test('至少 2 人，否则拒绝开局', () => {
  assert.throws(() => initOfflineHand({ players: mkPlayers([100]) }), /至少需要 2 名玩家/)
})

test('状态机不抛异常，只返回 error', () => {
  const st = start()
  const r = applyOfflineAction(st, { uid: 'u2', type: '不存在的动作' })
  assert.ok(r.error)
})
