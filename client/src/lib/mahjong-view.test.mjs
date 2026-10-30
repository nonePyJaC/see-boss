import test from 'node:test'
import assert from 'node:assert/strict'
import { tileInfo, relativeSeat, sidewaysIndex, sortedHand } from './mahjong-view.mjs'
import { ALL_TILES } from '../../../shared/logic/mahjong/tiles.mjs'

test('南京牌码均映射到现有素材', () => {
  for (const tile of ALL_TILES) assert.ok(tileInfo(tile).file, tile)
  assert.equal(tileInfo('E').file, 'feng-dong.svg')
  assert.equal(tileInfo('Z').file, 'jian-zhong.svg')
})
test('供牌者相对碰牌者的位置决定横牌位置', () => {
  for (let owner = 0; owner < 4; owner++) {
    assert.equal(sidewaysIndex({ type: 'pong', from: (owner + 1) % 4 }, owner), 2)
    assert.equal(sidewaysIndex({ type: 'pong', from: (owner + 2) % 4 }, owner), 1)
    assert.equal(sidewaysIndex({ type: 'pong', from: (owner + 3) % 4 }, owner), 0)
    assert.equal(sidewaysIndex({ type: 'ankong' }, owner), -1)
    assert.equal(relativeSeat((owner + 1) % 4, owner), 1)
  }
})
test('摸入牌独立展示并保留原始索引', () => {
  const cards = sortedHand(['2m', '1m', '2m'], '2m')
  assert.deepEqual(cards.map((c) => c.index), [1, 0, 2])
  assert.equal(cards[2].drawn, true)
})
