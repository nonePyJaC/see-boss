/**
 * 线下引擎新规则测试 —— 动态按钮 / check / 自动换街 / 小麦位
 *
 * 对应玩家 2026-09-23 的口述规则：
 *   · 翻牌前大小麦下完后，下家只有「加倍/弃」，轮到大盲位
 *   · 大盲行动完 → 三颗花生亮 → 轮到小麦位，此时才有 check
 *   · 大家都 check → 轮一圈回小麦位上家，本街结束
 *   · 小麦 check 后大盲加倍 → 又轮回小麦，按钮回到「加倍/弃」
 *   · 转一圈且没弃牌的人都平注 → 自动进下一街，花生 +1
 *   · 每街从小麦位开始
 *   · 房主只指定小麦位，下家自动大麦
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STAGE,
  STAGE_PEANUTS,
  initOfflineHand,
  applyOfflineAction,
  availableActions,
  toCall,
  advanceStreet,
  streetClosed,
  nextHand,
} from './offline-room.mjs'

const mkPlayers = (n = 4) =>
  Array.from({ length: n }, (_, i) => ({ uid: 'u' + i, nickname: 'P' + i, avatar: 1, seeds: 1000 }))

function start(n = 4, cfg = {}) {
  return initOfflineHand({ players: mkPlayers(n), smallBlind: 10, bigBlind: 20, ...cfg })
}

/** 当前回合持有者执行动作 */
function act(state, type, amount) {
  const r = applyOfflineAction(state, { uid: state.turnUid, type, amount })
  assert.ok(!r.error, `动作被拒：${r.error}`)
  return r.state
}

/** 按顺序执行一串动作（每步都用当时的 turnUid） */
function run(state, types) {
  let s = state
  for (const t of types) s = act(s, t.type ?? t, t.amount)
  return s
}

const typesOf = (state, uid) => availableActions(state, uid).map((a) => a.type)

// ── 大小麦归属 ──────────────────────────────────────────

test('房主只指定小麦位，下家自动大麦', () => {
  const st = start(4, { sbIndex: 2 })
  assert.equal(st.seats[2].blind, 'sb')
  assert.equal(st.seats[3].blind, 'bb', '下家是大麦')
  // preflop 从大麦下家开始（u0）
  assert.equal(st.turnUid, 'u0')
})

test('小麦位越界回落到 0', () => {
  const st = start(4, { sbIndex: 99 })
  assert.equal(st.seats[0].blind, 'sb')
  assert.equal(st.seats[1].blind, 'bb')
})

test('两人局：小麦位的人先行动', () => {
  const st = start(2, { sbIndex: 1 })
  assert.equal(st.seats[1].blind, 'sb')
  assert.equal(st.seats[0].blind, 'bb')
  assert.equal(st.turnUid, 'u1', '两人局从小麦开始')
})

// ── 动态按钮 ───────────────────────────────────────────

test('★ preflop 下家只有 加倍/弃，没有 check', () => {
  const st = start(4)   // u0 sb, u1 bb, u2 先动
  // u2 注额 0 < currentBet 20 → 不能过
  assert.equal(st.turnUid, 'u2')
  assert.deepEqual(typesOf(st, 'u2'), ['collect', 'call', 'raise', 'fold'])
})

test('★ 满注后按钮变成 check/加倍/弃', () => {
  let st = start(4)
  // u2 补平 20
  st = act(st, 'call')
  // 四人局：u2 跟完后轮到 u3（他也差 20），不是小盲
  assert.equal(st.turnUid, 'u3')
  assert.equal(toCall(st, 'u3'), 20)

  // u3 跟平 → 轮到 u0（小盲 10，还差 10）
  st = act(st, 'call')
  assert.equal(st.turnUid, 'u0')
  assert.equal(toCall(st, 'u0'), 10)
  assert.deepEqual(typesOf(st, 'u0'), ['collect', 'call', 'raise', 'fold'])

  // u0 补平 → 轮到 u1（大麦，已满注 20）
  st = act(st, 'call')
  assert.equal(st.turnUid, 'u1')
  assert.equal(toCall(st, 'u1'), 0)
  assert.deepEqual(typesOf(st, 'u1'), ['collect', 'check', 'raise', 'fold'],
    '大盲位满注，这时才出现 check')
})

test('翻牌前任何人未平注都不能 check', () => {
  const st = start(4)
  const r = applyOfflineAction(st, { uid: 'u2', type: 'check' })
  assert.match(r.error, /还未平注/)
})

test('不是自己的回合：只给「收」，不给下注类按钮', () => {
  const st = start(4)
  const acts = availableActions(st, 'u0')   // u0 是小盲但还没轮到他
  // 收池是中性键，谁都能点（桌面上公共池谁都可以顺手收）——
  // 之前写成「一律空按钮」，实测发现非回合者连收都点不了，
  // 不符合「收只要池子不是 0 就能点」的口径。
  assert.deepEqual(acts.map((a) => a.type), ['collect'])
  assert.equal(acts[0].enabled, true)   // 刚下完盲注，池子不是 0
})

test('池子是 0 时，非回合者连「收」都不给', () => {
  const st = start(2)
  st.pot = 0
  const acts = availableActions(st, 'u1')
  assert.deepEqual(acts.map((a) => a.type), ['collect'])
  assert.equal(acts[0].enabled, false)
})

test('已弃牌的人也能收池（但没下注按钮）', () => {
  let st = start(3)
  // 让 u1 弃牌
  st = applyOfflineAction(st, { uid: st.turnUid, type: 'call' }).state
  st = applyOfflineAction(st, { uid: st.turnUid, type: 'call' }).state
  // 此时轮到一个未弃牌的；找个人弃掉
  const victim = st.seats.find((s) => !s.folded && s.uid !== st.turnUid)
  if (victim) {
    st = applyOfflineAction(st, { uid: victim.uid, type: 'fold' }).state
    const acts = availableActions(st, victim.uid)
    assert.deepEqual(acts.map((a) => a.type), ['collect'])
  }
})

// ── 自动换街 ───────────────────────────────────────────

test('★ 大盲行动完 → 自动进 flop，三颗花生亮，轮到小麦位', () => {
  let st = start(4)
  // u2 跟 20、u0 补 10、u1（大盲）表态 → 一圈走完，该换街
  st = act(st, 'call')            // u2 跟 20
  assert.equal(st.turnUid, 'u3', '接着轮 u3，不是 u0')
  st = act(st, 'call')            // u3 跟 20
  assert.equal(st.turnUid, 'u0')
  st = act(st, 'call')            // u0（小盲）补 10
  assert.equal(st.turnUid, 'u1')
  st = act(st, 'check')           // u1 大盲表态（已满注所以是 check）
  // 自动推进
  assert.equal(st.stage, STAGE.FLOP, '应自动进 flop')
  assert.equal(STAGE_PEANUTS[st.stage], 3, 'flop 亮三颗')
  assert.equal(st.turnUid, 'u0', '新一街从小麦位开始')
  assert.equal(st.currentBet, 0, '新街注额清零')
  assert.equal(st.seats.every((s) => s.bet === 0), true, '每人 bet 清零')
})

test('★ 大家都 check → 轮一圈后进下一街', () => {
  let st = start(4)
  st = act(st, 'call'); st = act(st, 'call'); st = act(st, 'call'); st = act(st, 'check')   // 进 flop
  assert.equal(st.stage, STAGE.FLOP)
  // flop 从小麦 u0 起，四人全 check
  st = act(st, 'check')   // u0
  st = act(st, 'check')   // u1
  st = act(st, 'check')   // u2
  st = act(st, 'check')   // u3
  assert.equal(st.stage, STAGE.TURN, '全 check 后进 turn')
  assert.equal(STAGE_PEANUTS[st.stage], 4, 'turn 亮四颗')
  assert.equal(st.turnUid, 'u0', '还是从小麦起')
})

test('★ 小麦 check 后有人加倍 → 又轮回他，按钮回到加倍/弃', () => {
  let st = start(4)
  st = act(st, 'call'); st = act(st, 'call'); st = act(st, 'call'); st = act(st, 'check')   // → flop，u0 先动
  assert.equal(st.turnUid, 'u0')

  st = act(st, 'check')          // u0 过
  assert.equal(st.turnUid, 'u1')
  // flop 是新街，currentBet 已清零，所以 raise 50 就是纯加 50
  st = act(st, 'raise', 50)      // u1 加注 → currentBet 50
  assert.equal(st.currentBet, 50)
  assert.equal(st.seats.find(s => s.uid === 'u1').bet, 50)
  // 加注重置行动轮：后面的人都要重新决定，从小麦位之后开始轮
  assert.equal(st.turnUid, 'u2', '加倍后行动轮重置，从下一位开始')

  // 一路补齐，最后又回到 u0（小麦位）
  st = act(st, 'call')
  assert.equal(st.turnUid, 'u3')
  st = act(st, 'call')
  assert.equal(st.turnUid, 'u0', '轮完一圈又回到小麦位')
  assert.deepEqual(typesOf(st, 'u0'), ['collect', 'call', 'raise', 'fold'],
    '面对未平注，check 消失，只能跟/加倍/弃')
  // u2/u3 各跟了 50，所以 u0 也要补 50 才平
  assert.equal(toCall(st, 'u0'), 50)
})

test('river 之后不再自动换街', () => {
  let st = start(4)
  // 一路推进到 river
  st = act(st, 'call'); st = act(st, 'call'); st = act(st, 'call'); st = act(st, 'check')   // flop
  for (const t of ['check', 'check', 'check', 'check']) st = act(st, t)  // turn
  assert.equal(st.stage, STAGE.TURN)
  for (const t of ['check', 'check', 'check', 'check']) st = act(st, t)  // river
  assert.equal(st.stage, STAGE.RIVER)
  assert.equal(STAGE_PEANUTS[st.stage], 5, 'river 亮五颗')

  // river 再全 check → 没有下一街，停在等人收池
  const before = st.turnUid
  for (const t of ['check', 'check', 'check', 'check']) st = act(st, t)
  assert.equal(st.stage, STAGE.RIVER, 'river 是最后一街')
  assert.equal(st.turnUid, null, '没人欠行动，等收池')
})

test('streetClosed 与 advanceStreet 语义', () => {
  let st = start(4)
  assert.equal(streetClosed(st), false, '刚开局有人未平注')
  const r = advanceStreet(st)
  assert.equal(r.advanced, false, '没到时机不能换街')

  st = act(st, 'call'); st = act(st, 'call'); st = act(st, 'call'); st = act(st, 'check')
  assert.equal(st.stage, STAGE.FLOP)
})

test('花生节拍器数值不变', () => {
  assert.equal(STAGE_PEANUTS.preflop, 0)
  assert.equal(STAGE_PEANUTS.flop, 3)
  assert.equal(STAGE_PEANUTS.turn, 4)
  assert.equal(STAGE_PEANUTS.river, 5)
})

// ── 收池 / 下一手 ──────────────────────────────────────

test('收池后 nextHand 回到 preflop 且清干净', () => {
  let st = start(4)
  st = act(st, 'call'); st = act(st, 'call'); st = act(st, 'call'); st = act(st, 'check')   // → flop
  st = act(st, 'collect')    // 谁都可以收
  assert.equal(st.finished, true)
  assert.equal(st.pot, 0)

  const nh = nextHand(st)
  assert.equal(nh.stage, STAGE.PREFLOP)
  assert.equal(nh.finished, false)
  assert.equal(nh.currentBet, 0)
  assert.equal(nh.seats.every((s) => s.bet === 0 && !s.folded && !s.acted), true)
  assert.equal(nh.turnUid, null, '等下一次开局下大小麦')
})

test('加注上限 = 全下', () => {
  let st = start(4)
  // u2 只有 1000，raise 要 need+extra，超出拒绝
  const r = applyOfflineAction(st, { uid: 'u2', type: 'raise', amount: 5000 })
  assert.match(r.error, /超出我的瓜子/)
})
