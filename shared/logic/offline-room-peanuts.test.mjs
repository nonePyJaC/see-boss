import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STAGE, STAGE_PEANUTS, initOfflineHand, applyOfflineAction, nextHand,
} from './offline-room.mjs'

const mk = (n) => Array.from({ length: n }, (_, i) => ({ uid: 'u' + i, nickname: 'P' + i, avatar: 1, seeds: 1000 }))
const start = (n = 4) => initOfflineHand({ players: mk(n), smallBlind: 100, bigBlind: 200, sbIndex: 0 })

/** 当前回合者执行，返回 { state, autoCollected } */
function act(state, type, amount) {
  const r = applyOfflineAction(state, { uid: state.turnUid, type, amount })
  assert.ok(!r.error, `${type} 被拒：${r.error}`)
  return r
}
const peanuts = (st) => STAGE_PEANUTS[st.stage]

// ── 花生灯顺序 ──────────────────────────────────────────

test('★ 花生顺序：0 → 3 → 4 → 5，每街走完自动 +', async () => {
  let st = start(4)
  const seq = [peanuts(st)]           // preflop = 0
  assert.equal(st.stage, STAGE.PREFLOP)

  // preflop 一圈：3 家 call + 大麦 check
  for (let i = 0; i < 4; i++) {
    const acts = (await import('./offline-room.mjs')).availableActions(st, st.turnUid)
    const type = acts.some(a => a.type === 'check') ? 'check' : 'call'
    st = act(st, type).state
    seq.push(peanuts(st))
  }
  assert.equal(st.stage, STAGE.FLOP)
  assert.equal(seq[seq.length - 1], 3, 'preflop 走完 → 亮 3 颗')

  // flop 全 check → turn
  for (let i = 0; i < 4; i++) st = act(st, 'check').state
  assert.equal(st.stage, STAGE.TURN)
  assert.equal(peanuts(st), 4, '亮第 4 颗')

  // turn 全 check → river
  for (let i = 0; i < 4; i++) st = act(st, 'check').state
  assert.equal(st.stage, STAGE.RIVER)
  assert.equal(peanuts(st), 5, '亮第 5 颗')
})

test('★ 大家都弃牌 → 提前结束，花生灭灯、麦位可重开', async () => {
  let st = start(4)
  assert.equal(peanuts(st), 0)

  // u2 u3 相继弃牌，只剩 u0/u1
  st = act(st, 'fold').state
  st = act(st, 'fold').state
  assert.equal(st.seats.filter(s => !s.folded).length, 2)
  assert.equal(st.finished, false, '还有 2 人未弃，不该结束')

  // u0 也弃 → 只剩 u1 → 自动收池，本手结束
  st = act(st, 'fold').state
  assert.equal(st.finished, true, '只剩 1 人应自动收池并结束')
  assert.equal(st.pot, 0, '公共池应被自动收走')

  // 提前结束时 stage 停在原地，但新一手会回 preflop
  assert.equal(peanuts(nextHand(st)), 0, '新一手花生全灭')
  assert.equal(nextHand(st).seats.every(s => !s.folded), true, '弃牌状态也清掉')
})

test('★ 收池后 stage 回 preflop，准备下一手', async () => {
  let st = start(4)
  for (let i = 0; i < 4; i++) {
    const acts = (await import('./offline-room.mjs')).availableActions(st, st.turnUid)
    st = act(st, acts.some(a => a.type === 'check') ? 'check' : 'call').state
  }
  assert.equal(st.stage, STAGE.FLOP)
  // 收池
  st = act(st, 'collect').state
  assert.equal(st.finished, true)
  const nh = nextHand(st)
  assert.equal(nh.stage, STAGE.PREFLOP)
  assert.equal(peanuts(nh), 0, '花生全灭，等下一手开局')
})
