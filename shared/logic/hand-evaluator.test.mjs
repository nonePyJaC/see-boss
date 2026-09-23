import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, compareHands, HAND_NAME } from './hand-evaluator.mjs'

test('长牌：皇家同花顺', () => {
  const h = evaluate(['As', 'Ks', 'Qs', 'Js', 'Ts', '2c', '3d'], 'long')
  assert.equal(h.type, 8)
  assert.equal(h.name, '皇家同花顺')
})

test('长牌：葫芦 > 同花', () => {
  const fullHouse = evaluate(['As', 'Ah', 'Ad', 'Ks', 'Kh', '2c', '3d'], 'long')
  const flush = evaluate(['As', '9s', '7s', '5s', '3s', '2c', 'Kd'], 'long')
  assert.equal(fullHouse.name, '葫芦')
  assert.equal(flush.name, '同花')
  assert.equal(compareHands(fullHouse, flush), 1, '长牌葫芦应大于同花')
})

test('短牌：同花 > 葫芦（唯一区别）', () => {
  const fullHouse = evaluate(['As', 'Ah', 'Ad', 'Ks', 'Kh', 'Tc', '9d'], 'short')
  const flush = evaluate(['As', '9s', '7s', '6s', 'Ts', 'Kc', 'Qd'], 'short')
  assert.equal(fullHouse.name, '葫芦')
  assert.equal(flush.name, '同花')
  assert.equal(compareHands(flush, fullHouse), 1, '短牌同花应大于葫芦')
})

test('短牌：高牌 < 一对 < 两对 < 三条 < 顺子', () => {
  // 注意：短牌只有 36 张，选牌时要避免意外组成同花/顺子
  // A-K-Q-J-9-8 中 A 只能当 14，凑不出连续 5 张 → 高牌
  const high = evaluate(['As', 'Kc', 'Qd', 'Jh', '9s', '8c', '7d'], 'short')
  assert.equal(high.name, '高牌', 'As Kc Qd Jh 9s 8c 7d 不应成顺')

  const pair = evaluate(['As', 'Ac', 'Kd', 'Qh', '9s', 'Tc', '8d'], 'short')
  assert.equal(pair.name, '一对')

  const twoPair = evaluate(['As', 'Ac', 'Ks', 'Kd', 'Qh', 'Tc', '9d'], 'short')
  assert.equal(twoPair.name, '两对')

  const trips = evaluate(['As', 'Ac', 'Ad', 'Ks', 'Qh', 'Tc', '9d'], 'short')
  assert.equal(trips.name, '三条')

  const straight = evaluate(['As', 'Kc', 'Qs', 'Jd', 'Th', '9c', '8d'], 'short')
  assert.equal(straight.name, '顺子')

  assert.equal(compareHands(pair, high), 1)
  assert.equal(compareHands(twoPair, pair), 1)
  assert.equal(compareHands(trips, twoPair), 1)
  assert.equal(compareHands(straight, trips), 1)
})

test('短牌：A 可当 5 用（A-6-7-8-9）', () => {
  const h = evaluate(['As', '6c', '7s', '8d', '9h', 'Kc', 'Qs'], 'short')
  assert.equal(h.name, '顺子')
  assert.deepEqual(h.kickers, [9, 8, 7, 6, 5])
})

test('短牌：A 也可当 14（T-J-Q-K-A）', () => {
  const h = evaluate(['As', 'Kc', 'Qs', 'Jd', 'Th', '9c', '8s'], 'short')
  assert.equal(h.name, '顺子')
  assert.equal(h.kickers[0], 14)
})

test('长牌：A 可当 1 用（A-2-3-4-5）', () => {
  const h = evaluate(['As', '2c', '3s', '4d', '5h', 'Kc', 'Qs'], 'long')
  assert.equal(h.name, '顺子')
  assert.deepEqual(h.kickers, [5, 4, 3, 2, 1])
})

test('短牌不应出现 2/3/4/5 的顺子', () => {
  // 短牌里 A 不能当 1，A-2-3-4-5 不可能
  const h = evaluate(['As', '6c', '7s', '8d', 'Th', 'Kc', 'Qs'], 'short')
  assert.equal(h.name, '高牌')
})

test('四条 > 同花（短牌）', () => {
  const quads = evaluate(['As', 'Ac', 'Ad', 'Ah', 'Ks', 'Tc', '9d'], 'short')
  const flush = evaluate(['Ks', 'Qs', 'Js', '9s', '7s', 'Ac', 'Td'], 'short')
  assert.equal(quads.name, '四条')
  assert.equal(flush.name, '同花')
  assert.equal(compareHands(quads, flush), 1)
})

test('同花顺 > 四条', () => {
  const sf = evaluate(['As', 'Ks', 'Qs', 'Js', 'Ts', '9c', '8d'], 'long')
  const quads = evaluate(['9h', '9s', '9d', '9c', 'As', 'Kc', 'Qd'], 'long')
  assert.equal(sf.name, '皇家同花顺')
  assert.equal(quads.name, '四条')
  assert.equal(compareHands(sf, quads), 1)
})

test('同牌型比踢脚（同花比最大张）', () => {
  // a 最大 A，b 最大 K
  const a = evaluate(['As', 'Ks', 'Qs', 'Js', '9s', 'Tc', '8c'], 'long')
  const b = evaluate(['Ks', 'Qs', 'Js', '9s', '7s', 'Ac', 'Td'], 'long')
  assert.equal(a.name, '同花')
  assert.equal(b.name, '同花')
  assert.equal(compareHands(a, b), 1, 'A 同花应大于 K 同花')
})

test('完全平局', () => {
  const a = evaluate(['As', 'Ks', 'Qs', 'Js', '9s', 'Tc', '8c'], 'long')
  const b = evaluate(['As', 'Ks', 'Qs', 'Js', '9s', 'Th', '8h'], 'long')
  assert.equal(compareHands(a, b), 0)
})

test('6 张牌中选最优 5 张', () => {
  // 有对子 + 同花可能，应选同花
  const h = evaluate(['As', 'Ks', 'Qs', 'Js', '9s', 'Ac'], 'long')
  assert.equal(h.name, '同花')
})
