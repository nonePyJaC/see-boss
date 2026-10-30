import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPayments, settleOnlineKong, settleOnlineWin } from './online-payments.mjs'

const win = (extra) => settleOnlineWin({ balances: [100, 100, 100, 100], winners: [{ seat: 1, share: 20 }], source: 0, kind: 'discard', ...extra })
test('普通点炮和园子点炮采用事件开始时的园子快照', () => {
  assert.deepEqual(win({}).balances, [80, 120, 100, 100])
  assert.deepEqual(win({ balances: [0, 100, 100, 100], sourceInGarden: true }).balances, [20, 80, 100, 100])
  assert.deepEqual(win({ balances: [0, 100, 100, 100], sourceInGarden: false }).balances, [0, 100, 100, 100])
})
test('园子点炮一炮多响按相同快照反付', () => {
  const r = win({ balances: [0, 100, 100, 100], sourceInGarden: true, winners: [{ seat: 1, share: 20 }, { seat: 2, share: 20 }] })
  assert.deepEqual(r.balances, [40, 80, 80, 100])
})
test('自摸跳过园子付款人', () => {
  assert.deepEqual(win({ kind: 'selfDraw', balances: [0, 100, 100, 100] }).balances, [0, 140, 80, 80])
})
test('抢正常补杠包三家，抢园子补杠向三家各赔', () => {
  assert.deepEqual(win({ kind: 'robKong' }).balances, [40, 160, 100, 100])
  assert.deepEqual(win({ kind: 'robKong', sourceInGarden: true, balances: [0, 100, 100, 100] }).balances, [20, 40, 120, 120])
})
test('直杠杠开与三嘴责任及园子例外', () => {
  assert.deepEqual(win({ kind: 'selfDraw', kongSource: 0 }).balances, [40, 160, 100, 100])
  assert.deepEqual(win({ kind: 'selfDraw', kongSource: 0, balances: [0, 100, 100, 100] }).balances, [0, 140, 80, 80])
  assert.deepEqual(win({ kind: 'selfDraw', kongSource: 2, bindings: { 1: 0 } }).balances, [40, 160, 100, 100])
  assert.deepEqual(win({ kind: 'selfDraw', kongSource: 2, bindings: { 1: 0 }, balances: [0, 100, 100, 100] }).balances, [0, 140, 80, 80])
})
test('三嘴代付点炮，责任人园子时由点炮者支付', () => {
  assert.deepEqual(win({ source: 2, bindings: { 2: 0 } }).balances, [80, 120, 100, 100])
  assert.deepEqual(win({ source: 2, bindings: { 2: 0 }, balances: [0, 100, 100, 100] }).balances, [0, 120, 80, 100])
})
test('三嘴责任人自己胡被绑定者的牌，点炮者仍付普通一份', () => {
  assert.deepEqual(win({ source: 2, bindings: { 2: 1 } }).balances, [100, 120, 80, 100])
  assert.deepEqual(win({ source: 2, bindings: { 2: 1 }, balances: [100, 0, 10, 100] }).balances, [100, 10, 0, 100])
  assert.deepEqual(win({ source: 2, bindings: { 2: 1 }, balances: [100, 100, 0, 100], sourceInGarden: true }).balances, [100, 80, 20, 100])
})
test('不足支付按比例和最大余数分配，按逆时针打破平局', () => {
  const obligations = [1, 2, 3].map((to) => ({ from: 0, to, amount: 20, reason: '测试' }))
  assert.deepEqual(applyPayments([30, 0, 0, 0], obligations).balances, [0, 10, 10, 10])
  assert.deepEqual(applyPayments([2, 0, 0, 0], obligations).balances, [0, 1, 1, 0])
  assert.deepEqual(applyPayments([30, 0, 0, 0], [{ from: 0, to: 1, amount: 20 }, { from: 0, to: 2, amount: 40 }]).balances, [0, 10, 20, 0])
})
test('即时罚先结，后续点炮使用出牌前快照与罚后余额', () => {
  const penalty = applyPayments([20, 100, 100, 100], [1, 2, 3].map((to) => ({ from: 0, to, amount: 10 })))
  assert.equal(penalty.balances[0], 0)
  const result = win({ balances: penalty.balances, sourceInGarden: false })
  assert.deepEqual(result.balances, penalty.balances)
})
test('责任人就是点炮者时，同张牌不会因即时罚归零而改成其他人付款', () => {
  const result = win({ balances: [0, 100, 100, 100], sourceInGarden: false, bindings: { 1: 0 } })
  assert.deepEqual(result.balances, [0, 100, 100, 100])
})
test('杠独立付款，园子免付，翻倍和封顶', () => {
  assert.deepEqual(settleOnlineKong({ balances: [0, 100, 100, 100], seat: 1, type: 'an' }).balances, [0, 110, 95, 95])
  assert.deepEqual(settleOnlineKong({ balances: [7, 100, 100, 100], seat: 1, type: 'ming', from: 0, double: true }).balances, [0, 107, 100, 100])
})
test('拒绝非法金额和座位', () => {
  assert.throws(() => applyPayments([0, 0, 0, 0], [{ from: 0, to: 1, amount: -1 }]))
  assert.throws(() => settleOnlineKong({ balances: [10, 10, 10, 10], seat: 0, type: 'ming', from: 0 }))
})
