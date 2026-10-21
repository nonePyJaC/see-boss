import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionLabel } from './action-log-view.js'

// 全下标记冻结用例：全下跟注必须与普通跟注可区分（人工试玩发现的缺口）。

test('全下跟注：显示「全下跟注 X」，不再与普通跟注同型', () => {
  assert.equal(actionLabel({ type: 'call', amount: 100, allIn: true }), '全下跟注 100')
})

test('普通跟注：不带全下前缀', () => {
  assert.equal(actionLabel({ type: 'call', amount: 500, allIn: false }), '跟注 500')
  assert.equal(actionLabel({ type: 'call', amount: 500 }), '跟注 500')
})

test('allin 类型保持「全下 X」，不重复前缀', () => {
  assert.equal(actionLabel({ type: 'allin', amount: 300, allIn: true }), '全下 300')
})

test('筹码恰好等于全下的加注/下注也带全下前缀', () => {
  assert.equal(actionLabel({ type: 'raise', amount: 300, allIn: true }), '全下加注 300')
  assert.equal(actionLabel({ type: 'bet', amount: 100, allIn: true }), '全下下注 100')
  assert.equal(actionLabel({ type: 'raise', amount: 300, allIn: false }), '加注 300')
})

test('弃牌/过牌不显示金额', () => {
  assert.equal(actionLabel({ type: 'fold', amount: 0, allIn: false }), '弃牌')
  assert.equal(actionLabel({ type: 'check', amount: 0 }), '过牌')
})
