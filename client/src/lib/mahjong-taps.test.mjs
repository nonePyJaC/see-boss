import test from 'node:test'
import assert from 'node:assert/strict'
import { createTileTapTracker, DOUBLE_TAP_MS, AFTER_DISCARD_GUARD_MS } from './mahjong-taps.mjs'

const press = (tracker, time, options = {}) => tracker.tap({ index: 0, code: 'E', scope: 'room:match:hand:window', now: time, canDiscard: true, ...options })
test('同一实体牌的快速两次点击只产生一次出牌，其后短暂阻断连续点击', () => {
  const tracker = createTileTapTracker()
  assert.equal(press(tracker, 1000), 'select')
  assert.equal(press(tracker, 1000 + DOUBLE_TAP_MS), 'discard')
  assert.equal(press(tracker, 1001 + DOUBLE_TAP_MS), 'ignore')
  assert.equal(press(tracker, 1000 + DOUBLE_TAP_MS + AFTER_DISCARD_GUARD_MS), 'select')
})
test('同牌值不同索引、超过时间、窗口变化都必须重新选牌', () => {
  const tracker = createTileTapTracker()
  assert.equal(press(tracker, 100), 'select')
  assert.equal(press(tracker, 200, { index: 1 }), 'select')
  assert.equal(press(tracker, 200 + DOUBLE_TAP_MS + 1, { index: 1 }), 'select')
  assert.equal(press(tracker, 800, { index: 1, scope: 'new-window' }), 'select')
  tracker.reset()
  assert.equal(press(tracker, 850, { index: 1, scope: 'new-window' }), 'select')
})
test('非法回合或请求处理中不可累计成双点', () => {
  const tracker = createTileTapTracker()
  assert.equal(press(tracker, 100, { canDiscard: false }), 'select')
  assert.equal(press(tracker, 200), 'select')
  assert.equal(press(tracker, 250, { canDiscard: false }), 'select')
  assert.equal(press(tracker, 300), 'select')
})
