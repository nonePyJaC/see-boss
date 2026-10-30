import test from 'node:test'
import assert from 'node:assert/strict'
import { groupTileWidth, handTileWidth } from './mahjong-clarity.mjs'

test('单组副露和少量花牌放大，密集副露仍适配座位空间', () => {
  const common = { width: 568, height: 320, side: 'left' }
  const flower = groupTileWidth({ ...common, kind: 'flowers', flowers: ['Z', 'F', 'B'] })
  const short = groupTileWidth({ ...common, kind: 'melds', melds: [{ type: 'pong', from: 1, tiles: ['1m', '1m', '1m'] }] })
  const many = groupTileWidth({ ...common, kind: 'melds', melds: Array.from({ length: 4 }, () => ({ type: 'kong', from: 1, tiles: ['1m', '1m', '1m', '1m'] })) })
  assert.ok(flower >= 11 && short >= 11)
  assert.ok(many < short && many >= 5)
  assert.ok(many * (16 + 4 * .37) + 9 <= 320 * .44 + 1)
})
test('无副露时利用空位放大14张手牌，有副露时按张数适配且不会超出可用宽度', () => {
  const wide = handTileWidth({ width: 550, height: 304, count: 14, hasMelds: false })
  const withMelds = handTileWidth({ width: 550, height: 304, count: 11, hasMelds: true })
  const dense = handTileWidth({ width: 550, height: 304, count: 14, hasMelds: true })
  assert.ok(wide > 28 && withMelds > 28 && dense > 22)
  assert.ok(wide * 14 + 9 <= 550 * .75 + .01)
  assert.ok(withMelds * 11 + 9 <= 550 * .59 + .01)
})
