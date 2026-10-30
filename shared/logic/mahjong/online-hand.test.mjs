import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeHand } from './hand.mjs'
import { scoreHand } from './score.mjs'

const concealed = ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '4s', '5s', '6s', 'E', 'E']
test('梅兰竹菊与春夏秋冬各成立花杠，花不重复计数', () => {
  for (const tiles of [['f1', 'f2', 'f3', 'f4'], ['f5', 'f6', 'f7', 'f8']]) {
    const hand = { concealed, melds: [{ type: 'huagang', tiles }], flowers: [] }
    const score = scoreHand(hand)
    assert.equal(score.info.valid, true)
    assert.equal(score.flowers.hard, 4)
    assert.equal(score.flowers.softGang, 2)
  }
})
test('成牌形状不能掩盖超张或非法花牌', () => {
  const tooMany = analyzeHand({ concealed, melds: [{ type: 'huagang', tiles: ['f1', 'f2', 'f3', 'f4'] }], flowers: ['f1'] })
  assert.equal(tooMany.valid, false)
  const fakeFlower = analyzeHand({ concealed, flowers: ['1m'] })
  assert.equal(fakeFlower.valid, false)
})
test('双七对只能有一个四张与五个对子', () => {
  const info = analyzeHand({ concealed: ['1m','1m','1m','1m','2p','2p','2p','2p','4s','4s','6s','6s','E','E'] })
  assert.equal(info.shape, 'invalid')
  assert.equal(info.valid, false)
})
