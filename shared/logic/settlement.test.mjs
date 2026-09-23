import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findZeroSeedPlayers,
  shouldSettle,
  findTopPlayers,
  buildSettlement,
  transfersAfterTiePick,
  applyTransfers,
  clearLedgerEntry,
  resetForNextRound,
  verifyLedger,
} from './settlement.mjs'

/** 构造测试用户 */
function mkUsers() {
  const mk = (uid) => ({ uid, goldenSeeds: 0, ledger: new Map() })
  const users = new Map()
  for (const uid of ['a', 'b', 'c', 'd', 'e']) users.set(uid, mk(uid))
  return users
}

test('无人归零 → 不结算', () => {
  const seats = [
    { uid: 'a', seeds: 100 },
    { uid: 'b', seeds: 200 },
  ]
  assert.equal(shouldSettle(seats), false)
  assert.deepEqual(findZeroSeedPlayers(seats), [])
})

test('单人归零 → 触发结算', () => {
  const seats = [
    { uid: 'a', seeds: 0 },
    { uid: 'b', seeds: 500 },
    { uid: 'c', seeds: 300 },
  ]
  assert.equal(shouldSettle(seats), true)
  assert.deepEqual(findZeroSeedPlayers(seats), ['a'])
})

test('5 人局 2 人同时归零 → 唯一最多者获得 2 粒', () => {
  const seats = [
    { uid: 'a', seeds: 0 },
    { uid: 'b', seeds: 0 },
    { uid: 'c', seeds: 400 },
    { uid: 'd', seeds: 100 },
    { uid: 'e', seeds: 50 },
  ]
  const st = buildSettlement(seats)
  assert.deepEqual(st.tieUids, [], '唯一最多者不应触发房主选择')
  assert.equal(st.transfers.length, 2, '两个归零者各付 1 粒')
  assert.equal(st.transfers.every((t) => t.toUid === 'c'), true, '都付给 c')
  assert.equal(st.transfers.reduce((s, t) => s + t.amount, 0), 2)
})

test('并列最多 → 交给房主点选，不自动生成转账', () => {
  const seats = [
    { uid: 'a', seeds: 0 },
    { uid: 'b', seeds: 400 },
    { uid: 'c', seeds: 400 },
  ]
  const st = buildSettlement(seats)
  assert.equal(st.transfers.length, 0, '平局时不自动转账')
  assert.deepEqual(st.tieUids.sort(), ['b', 'c'])
  assert.deepEqual(st.zeroed, ['a'])
})

test('房主点选赢家后生成转账', () => {
  const zeroed = ['a']
  const transfers = transfersAfterTiePick(zeroed, 'c')
  assert.equal(transfers.length, 1)
  assert.equal(transfers[0].fromUid, 'a')
  assert.equal(transfers[0].toUid, 'c', '房主选了 c')
  assert.equal(transfers[0].amount, 1)
})

test('房主点选：多个归零者各付 1 粒', () => {
  const transfers = transfersAfterTiePick(['a', 'b'], 'c')
  assert.equal(transfers.length, 2)
  assert.equal(transfers.every((t) => t.toUid === 'c'), true)
  assert.equal(transfers.reduce((s, t) => s + t.amount, 0), 2)
})

test('未点选或归零者为空时不生成转账', () => {
  assert.deepEqual(transfersAfterTiePick(['a'], ''), [])
  assert.deepEqual(transfersAfterTiePick([], 'c'), [])
  assert.deepEqual(transfersAfterTiePick(null, 'c'), [])
})

test('房主点选后的转账可正确执行', () => {
  const users = mkUsers()
  const transfers = transfersAfterTiePick(['a'], 'c')
  applyTransfers(users, transfers)
  assert.equal(users.get('a').goldenSeeds, -1)
  assert.equal(users.get('c').goldenSeeds, 1)
  for (const u of users.values()) {
    assert.ok(verifyLedger(u).ok, `${u.uid} 账实不符`)
  }
})

test('全员归零 → 无人可收，跳过转账', () => {
  const seats = [
    { uid: 'a', seeds: 0 },
    { uid: 'b', seeds: 0 },
  ]
  const st = buildSettlement(seats)
  assert.equal(st.transfers.length, 0)
  assert.deepEqual(st.tieUids, [])
})

test('转账后金瓜子可为负', () => {
  const users = mkUsers()
  applyTransfers(users, [{ fromUid: 'a', toUid: 'c', amount: 1 }])
  assert.equal(users.get('a').goldenSeeds, -1, '付款方可以为负')
  assert.equal(users.get('c').goldenSeeds, 1)
  assert.equal(users.get('a').ledger.get('c'), -1, '账本记 -1：我给 c 1 粒')
  assert.equal(users.get('c').ledger.get('a'), 1, '对方账本记 +1')
})

test('账实相符：多笔转账后 goldenSeeds === 账本之和', () => {
  const users = mkUsers()
  applyTransfers(users, [
    { fromUid: 'a', toUid: 'c', amount: 1 },
    { fromUid: 'a', toUid: 'c', amount: 1 },
    { fromUid: 'b', toUid: 'a', amount: 1 },
  ])
  for (const u of users.values()) {
    const v = verifyLedger(u)
    assert.ok(v.ok, `${u.uid} 账实不符: 账本和 ${v.expected} != ${v.actual}`)
  }
  assert.equal(users.get('a').goldenSeeds, -1, 'a 付出 2 收到 1')
  assert.equal(users.get('c').goldenSeeds, 2)
  assert.equal(users.get('b').goldenSeeds, -1)
})

test('账本归零条目被清除，不留空行', () => {
  const users = mkUsers()
  // a 给 c 1 粒，再让 c 给 a 1 粒 → 应互相抵消并删除条目
  applyTransfers(users, [{ fromUid: 'a', toUid: 'c', amount: 1 }])
  applyTransfers(users, [{ fromUid: 'c', toUid: 'a', amount: 1 }])
  assert.equal(users.get('a').ledger.has('c'), false, '归零条目应删除')
  assert.equal(users.get('a').goldenSeeds, 0)
  assert.equal(users.get('c').goldenSeeds, 0)
})

test('长按清空账本：双方同时清零，无坏账', () => {
  const users = mkUsers()
  applyTransfers(users, [
    { fromUid: 'a', toUid: 'c', amount: 3 },
    { fromUid: 'b', toUid: 'a', amount: 2 },
  ])
  // a 的账本：c: -3, b: +2  → goldenSeeds = -1
  assert.equal(users.get('a').goldenSeeds, -1)
  assert.equal(users.get('c').goldenSeeds, 3)

  // a 长按「小明(c) 给你 3 颗」→ 实际是 a 给了 c 3 颗，双方清零
  const r = clearLedgerEntry(users, 'a', 'c')
  assert.equal(r.ownerDelta, 3, 'a 少了 -3 的记录，净 +3')
  assert.equal(r.peerDelta, -3, 'c 少了 +3 的记录，净 -3')
  assert.equal(users.get('a').goldenSeeds, 2, '-1 + 3 = 2')
  assert.equal(users.get('c').goldenSeeds, 0)
  assert.equal(users.get('a').ledger.has('c'), false)
  assert.equal(users.get('c').ledger.has('a'), false)

  // 双方账实仍相符
  for (const u of users.values()) {
    assert.ok(verifyLedger(u).ok)
  }
})

test('重置对局：全员发放初始瓜子，清空牌局状态', () => {
  const seats = [
    { uid: 'a', seeds: 0, bet: 20, totalBet: 100, folded: true, allIn: false, isTurn: true },
    { uid: 'b', seeds: 500, bet: 0, totalBet: 100, folded: false, allIn: true, isTurn: false },
  ]
  const next = resetForNextRound(seats, 3000)
  assert.equal(next[0].seeds, 3000)
  assert.equal(next[1].seeds, 3000)
  assert.equal(next[0].bet, 0)
  assert.equal(next[0].totalBet, 0)
  assert.equal(next[0].folded, false)
  assert.equal(next[1].allIn, false)
  assert.equal(next[0].isTurn, false)
})

test('findTopPlayers 支持排除归零者', () => {
  const seats = [
    { uid: 'a', seeds: 0 },
    { uid: 'b', seeds: 500 },
    { uid: 'c', seeds: 500 },
  ]
  const top = findTopPlayers(seats, ['a'])
  assert.equal(top.isTie, true)
  assert.deepEqual(top.winners.sort(), ['b', 'c'])
  assert.equal(top.maxSeeds, 500)
})
