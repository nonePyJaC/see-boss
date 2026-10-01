import { test } from 'node:test'
import assert from 'node:assert/strict'
import { potLayerView } from './pot-layer-view.js'

// C-R2 冻结用例：未匹配退回的「分类」与「实际到账」必须分开，
// 展示金额只认服务端权威 awards，绝不凭出资人 + 层金额凭空拼出退款数。

test('未匹配退回层：到账明细来自权威 awards', () => {
  const view = potLayerView(
    { isUncalledReturn: true, amount: 280, contributorUids: ['g'], eligibleUids: [], awards: [{ uid: 'g', amount: 280 }] },
    1,
  )
  assert.equal(view.title, '未匹配退回')
  assert.equal(view.uncalledReturn, true)
  assert.equal(view.awardLabel, '未匹配退回')
  assert.deepEqual(view.recipientUids, ['g'])
  assert.deepEqual(view.awards, [{ uid: 'g', amount: 280 }])
})

test('未匹配退回层 awards 为空：不得显示出资人+层金额拼出的退款', () => {
  const view = potLayerView(
    { isUncalledReturn: true, amount: 280, contributorUids: ['g'], eligibleUids: [], awards: [] },
    1,
  )
  assert.equal(view.title, '未匹配退回')
  assert.deepEqual(view.awards, [])
  assert.equal(view.hasAwards, false)
  assert.deepEqual(view.recipientUids, [])
  assert.equal(view.emptyAwardsLabel, '未到账')
})

test('awards 字段缺失同样走空态，而不是拆出层金额', () => {
  const view = potLayerView({ isUncalledReturn: true, amount: 280, contributorUids: ['g'] }, 2)
  assert.equal(view.hasAwards, false)
  assert.deepEqual(view.awards, [])
})

test('普通层：主池/边池标题与派彩标签不变', () => {
  const main = potLayerView({ amount: 40, contributorUids: ['a', 'b'], eligibleUids: ['a'], awards: [{ uid: 'a', amount: 40 }] }, 0)
  assert.equal(main.title, '主池')
  assert.equal(main.uncalledReturn, false)
  assert.equal(main.awardLabel, '本层派彩')
  assert.equal(main.emptyAwardsLabel, '暂无派彩')
  const side = potLayerView({ amount: 80, contributorUids: ['b'], eligibleUids: ['b'], awards: [{ uid: 'b', amount: 80 }] }, 1)
  assert.equal(side.title, '边池 1')
  assert.equal(side.uncalledReturn, false)
})
