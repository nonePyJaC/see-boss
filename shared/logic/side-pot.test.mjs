import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSidePots, verifyPots, distributePot } from './side-pot.mjs'
import { evaluate } from './hand-evaluator.mjs'
import { compareHands } from './hand-evaluator.mjs'

test('无全下时只有一个池', () => {
  const c = [
    { uid: 'a', totalBet: 100, folded: false },
    { uid: 'b', totalBet: 100, folded: false },
    { uid: 'c', totalBet: 100, folded: false },
  ]
  const pots = buildSidePots(c)
  assert.equal(pots.length, 1)
  assert.equal(pots[0].amount, 300)
  assert.deepEqual(pots[0].eligibleUids.sort(), ['a', 'b', 'c'])
})

test('一人全下，两人跟满 → 主池 + 边池', () => {
  const c = [
    { uid: 'a', totalBet: 100, folded: false }, // 全下
    { uid: 'b', totalBet: 100, folded: false },
    { uid: 'c', totalBet: 400, folded: false },
  ]
  const pots = buildSidePots(c)
  assert.equal(pots.length, 2)
  assert.equal(pots[0].amount, 300) // 100 x 3
  assert.deepEqual(pots[0].eligibleUids.sort(), ['a', 'b', 'c'])
  assert.equal(pots[1].amount, 300) // 300 x 1 (只有 c 出)
  assert.deepEqual(pots[1].eligibleUids, ['c']) // b 和 c 都没资格？错：b 投入=100 < 400，无资格
})

test('弃牌者的钱也进池，但无资格赢', () => {
  const c = [
    { uid: 'a', totalBet: 200, folded: true },  // 弃牌但投了 200
    { uid: 'b', totalBet: 200, folded: false },
    { uid: 'c', totalBet: 200, folded: false },
  ]
  const pots = buildSidePots(c)
  assert.equal(pots.length, 1)
  assert.equal(pots[0].amount, 600)
  assert.deepEqual(pots[0].eligibleUids.sort(), ['b', 'c'])
})

test('三层边池', () => {
  const c = [
    { uid: 'a', totalBet: 100, folded: false }, // 全下 100
    { uid: 'b', totalBet: 300, folded: false }, // 全下 300
    { uid: 'c', totalBet: 500, folded: false },
  ]
  const pots = buildSidePots(c)
  assert.equal(pots.length, 3)
  assert.equal(pots[0].amount, 300)  // 100x3 全员
  assert.equal(pots[1].amount, 400)  // 200x2 (b,c)
  assert.equal(pots[2].amount, 200)  // 200x1 (c)
  assert.deepEqual(pots[2].eligibleUids, ['c'])
})

test('各层金额之和 === 总投入（多条随机用例）', () => {
  const cases = [
    [{ uid: 'a', totalBet: 100, folded: false }, { uid: 'b', totalBet: 250, folded: false }],
    [{ uid: 'a', totalBet: 50, folded: false }, { uid: 'b', totalBet: 120, folded: false }, { uid: 'c', totalBet: 500, folded: true }],
    [{ uid: 'a', totalBet: 1000, folded: false }, { uid: 'b', totalBet: 1000, folded: false }, { uid: 'c', totalBet: 999, folded: false }],
  ]
  for (const c of cases) {
    const v = verifyPots(c)
    assert.ok(v.ok, `期望 ${v.expected} 实际 ${v.actual}`)
  }
})

test('分配：边池归多投的人，主池归牌大的人', () => {
  const c = [
    { uid: 'a', totalBet: 100, folded: false }, // 全下 100
    { uid: 'b', totalBet: 400, folded: false }, // 投 400
  ]
  // a 葫芦（赢主池），b 高牌（但多投的 300 只能归自己）
  const hands = {
    a: evaluate(['As', 'Ah', 'Ad', 'Ks', 'Kh', '2c', '3d'], 'long'),
    b: evaluate(['2s', '7c', '9d', 'Jh', 'Qc', 'Ac', 'Kd'], 'long'),
  }
  const winnings = distributePot(c, (uid) => hands[uid], compareHands)
  const map = Object.fromEntries(winnings.map((w) => [w.uid, w.amount]))
  assert.equal(map.a, 200, 'a 葫芦赢主池 100x2')
  assert.equal(map.b, 300, 'b 多投的 300 无人竞争，归自己')
  assert.equal(map.a + map.b, 500)
})

test('分配：最强牌通吃所有层', () => {
  const c = [
    { uid: 'a', totalBet: 400, folded: false },
    { uid: 'b', totalBet: 400, folded: false },
  ]
  // a 皇家同花顺，b 高牌 → a 通吃 800
  const hands = {
    a: evaluate(['As', 'Ks', 'Qs', 'Js', 'Ts', '9c', '8d'], 'long'),
    b: evaluate(['2s', '7c', '9d', 'Jh', 'Qc', 'Ac', 'Kd'], 'long'),
  }
  const winnings = distributePot(c, (uid) => hands[uid], compareHands)
  assert.equal(winnings.length, 1)
  assert.equal(winnings[0].uid, 'a')
  assert.equal(winnings[0].amount, 800)
})

test('分配：边池归全下的赢家，主池归小赢家', () => {
  const c = [
    { uid: 'a', totalBet: 100, folded: false }, // 全下，牌小
    { uid: 'b', totalBet: 100, folded: false }, // 牌中
    { uid: 'c', totalBet: 400, folded: false }, // 牌大
  ]
  const hands = {
    a: evaluate(['2s', '7s', '9s', 'Js', 'Qs', 'Ac', 'Kd'], 'long'), // 高牌
    b: evaluate(['As', 'Ah', 'Ad', 'Ks', 'Kh', '2c', '3d'], 'long'), // 葫芦 → 赢主池
    c: evaluate(['As', 'Ks', 'Qs', 'Js', 'Ts', '9c', '8d'], 'long'), // 皇家同花顺 → 赢全部
  }
  const winnings = distributePot(c, (uid) => hands[uid], compareHands)
  const map = Object.fromEntries(winnings.map((w) => [w.uid, w.amount]))
  // 主池 300 归 c（皇家最大），边池 300 归 c
  assert.equal(map.c, 600)
  assert.equal(map.a, undefined)
  assert.equal(map.b, undefined)
})

test('分配：平局平分，余数确定性地分配', () => {
  const c = [
    { uid: 'a', totalBet: 100, folded: false },
    { uid: 'b', totalBet: 100, folded: false },
  ]
  // 公共牌同花顺，两人完全同牌
  const board = ['As', 'Ks', 'Qs', 'Js', 'Ts', '9c', '8d']
  const hands = {
    a: evaluate([...board.slice(0, 5), '2h', '3h'], 'long'),
    b: evaluate([...board.slice(0, 5), '4c', '5c'], 'long'),
  }
  const winnings = distributePot(c, (uid) => hands[uid], compareHands)
  assert.equal(winnings.length, 2)
  const map = Object.fromEntries(winnings.map((w) => [w.uid, w.amount]))
  assert.equal(map.a + map.b, 200)
  assert.equal(map.a, 100)
  assert.equal(map.b, 100)
})

test('分配：不能整除时余数只加 1，总数守恒', () => {
  const c = [
    { uid: 'a', totalBet: 101, folded: false },
    { uid: 'b', totalBet: 101, folded: false },
    { uid: 'c', totalBet: 101, folded: false },
  ]
  const board = ['As', 'Ks', 'Qs', 'Js', 'Ts', '9c', '8d']
  const hands = {
    a: evaluate([...board.slice(0, 5), '2h', '3h'], 'long'),
    b: evaluate([...board.slice(0, 5), '4c', '5c'], 'long'),
    c: evaluate([...board.slice(0, 5), '4h', '5h'], 'long'),
  }
  const winnings = distributePot(c, (uid) => hands[uid], compareHands)
  const total = winnings.reduce((s, w) => s + w.amount, 0)
  assert.equal(total, 303, '分配总额必须等于总投入')
  // 每人至少 101
  for (const w of winnings) assert.ok(w.amount >= 101)
})
