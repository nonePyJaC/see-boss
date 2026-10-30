import test from 'node:test'
import assert from 'node:assert/strict'
import { resultBreakdown, resultNetTransfers } from './mahjong-result.mjs'
import { scoreHand } from '../../../shared/logic/mahjong/score.mjs'

const pong = (tile) => ({ type: 'pong', tiles: [tile, tile, tile] })
const kong = (tile, type = 'ankong') => ({ type, tiles: [tile, tile, tile, tile] })
function check(score) {
  const display = resultBreakdown(score)
  assert.equal(display.typeTotal + display.bonusTotal + display.hard + display.softTotal, score.flowers.total)
  assert.equal(display.soft.reduce((sum, item) => sum + item.value, 0), score.flowers.soft)
  return display
}
test('全球独钓、碰杠和花杠按服务端实际花数分区，花杠硬花只计一次', () => {
  const hand = { concealed: ['E', 'E'], melds: [pong('1m'), pong('2s'), kong('3p'), pong('4m'), kong('Z', 'huagang')], flowers: ['F'] }
  const score = scoreHand(hand)
  const display = check(score)
  assert.ok(display.types.some((item) => item.label === '全球独钓'))
  assert.equal(display.hardCount, 5)
  assert.equal(display.hard, 5)
  assert.ok(display.soft.some((item) => item.label === '杠' && item.value === 4))
})
test('零硬花零软花及被大胡排除的押档缺一不伪造计入', () => {
  const hand = { concealed: ['1m','1m','2m','2m','3m','3m','4s','4s','5s','5s','6p','6p','7p','7p'], melds: [], flowers: [] }
  const display = check(scoreHand(hand))
  assert.equal(display.hardCount, 0)
  assert.equal(display.hard, 0)
  assert.equal(display.softTotal, 0)
  assert.deepEqual(display.soft, [])
})
test('门清、天地胡及花开杠开的已计项目保留服务端明细', () => {
  const hand = { concealed: ['2s','3s','4s','5s','6s','7s','1m','2m','3m','9p','9p','5p','6p','7p'], melds: [], flowers: ['Z'] }
  for (const flag of ['tianhu', 'dihu', 'huakai', 'gangkai']) {
    const score = scoreHand(hand, { [flag]: true })
    const display = check(score)
    assert.ok(display.bonuses.some((item) => ({ tianhu:'天胡', dihu:'地胡', huakai:'花开', gangkai:'杠开' })[flag] === item.label))
  }
})
test('净收付根据每笔实付计算，包含封顶和反向付款', () => {
  assert.deepEqual(resultNetTransfers([{ transfers: [
    { from: 0, to: 1, amount: 30, paid: 8 }, { from: 1, to: 2, amount: 5, paid: 5 },
  ] }]), [-8, 3, 5, 0])
})
