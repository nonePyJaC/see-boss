import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeHand } from './hand.mjs'
import { scoreHand } from './score.mjs'
import { createWall } from './online-wall.mjs'
import { isFlower } from './tiles.mjs'
import { createOnlineGame, dealSeatSequence, legalOnlineActions, applyOnlineAction } from './online-game.mjs'

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
const doubleSevenHands = [
  ['1m','1m','1m','1m','2p','2p','4s','4s','6s','6s','E','E','W','W'],
  ['1m','1m','1m','1m','2p','2p','2p','2p','4s','4s','6s','6s','E','E'],
  ['1m','1m','1m','1m','2p','2p','2p','2p','4s','4s','4s','4s','E','E'],
]

test('一至三组四张的14张全对子牌都算双七对，100花替代普通七对', () => {
  for (const hand of doubleSevenHands) {
    const score = scoreHand({ concealed: hand, flowers: ['Z'] })
    assert.equal(score.info.valid, true)
    assert.equal(score.info.shape, 'double_seven_pairs')
    assert.equal(score.info.types.shuangqidui, true)
    assert.equal(score.info.types.qidui, false)
    assert.equal(score.info.types.duiduihu, false)
    assert.equal(score.flowers.big, 100)
    assert.equal(score.flowers.menqing, 0)
    assert.equal(score.flowers.total, 101)
    assert.equal(score.breakdown.filter((v) => v.label === '双七对').length, 1)
  }
})

test('碰、直杠、暗杠和补杠均破坏七对资格，门清本身不能恢复该资格', () => {
  const closed = ['1m','1m','1m','2p','2p','2p','4s','4s','4s','E','E']
  for (const type of ['pong', 'kong', 'ankong', 'pongkong']) {
    const info = analyzeHand({ concealed: closed, melds: [{ type, tiles: Array(type === 'pong' ? 3 : 4).fill('9p') }] })
    assert.equal(info.valid, true)
    assert.equal(info.shape, 'standard')
    assert.equal(info.types.qidui, false)
    assert.equal(info.types.shuangqidui, false)
    if (type === 'ankong' || type === 'kong') assert.equal(info.meldsConcealed, true)
    assert.equal(analyzeHand({ concealed: doubleSevenHands[2], melds: [{ type, tiles: Array(type === 'pong' ? 3 : 4).fill('9p') }] }).valid, false)
  }
})

test('自动花杠仍作为花牌处理，不破坏双七对且花数不重复', () => {
  const score = scoreHand({ concealed: doubleSevenHands[2], melds: [{ type: 'huagang', tiles: ['f1','f2','f3','f4'] }] })
  assert.equal(score.info.valid, true)
  assert.equal(score.info.types.shuangqidui, true)
  assert.equal(score.flowers.big, 100)
  assert.equal(score.flowers.hard, 4)
  assert.equal(score.flowers.softGang, 2)
  assert.equal(score.flowers.total, 106)
})

test('全对子资格仍要求14张、每种至多四张，单张不能伪装为对子', () => {
  assert.equal(analyzeHand({ concealed: doubleSevenHands[2].slice(0, -1) }).valid, false)
  assert.equal(analyzeHand({ concealed: [...doubleSevenHands[2], 'E', 'E'] }).valid, false)
  const fiveCopies = doubleSevenHands[2].slice(); fiveCopies[0] = '2p'
  assert.equal(analyzeHand({ concealed: fiveCopies }).valid, false)
  const unpaired = doubleSevenHands[2].slice(); unpaired[13] = 'S'
  assert.equal(analyzeHand({ concealed: unpaired }).valid, false)
})

test('两组和三组四张的听牌可报听、获得合法胡动作并正常结算', () => {
  for (const fullHand of doubleSevenHands.slice(1)) {
    const deck = createWall(() => .5)
    const take = (tile) => { const i = deck.indexOf(tile); assert.ok(i >= 0); return deck.splice(i, 1)[0] }
    const hands = [[take('E')], fullHand.slice(0, -1).map(take), [], []]
    for (const s of [0, 2, 3]) while (hands[s].length < (s === 0 ? 14 : 13)) hands[s].push(deck.splice(deck.findIndex((t) => !isFlower(t)), 1)[0])
    const wall = [...dealSeatSequence(0).map((s) => hands[s].shift()), ...deck]
    let game = createOnlineGame({ dealer: 0, balances: [1000,1000,1000,1000], wall, rng: () => .5 })
    assert.ok(game.readyPending.includes(1))
    while (game.phase === 'ready') game = applyOnlineAction(game, game.readyPending[0], { type: 'pass' })
    game = applyOnlineAction(game, 0, { type: 'discard', tile: 'E' })
    assert.ok(legalOnlineActions(game, 1).some((a) => a.type === 'win'))
    for (const seat of Object.keys(game.response.options).map(Number).filter((s) => s !== 1)) game = applyOnlineAction(game, seat, { type: 'pass' })
    game = applyOnlineAction(game, 1, { type: 'win' })
    assert.equal(game.result.winners[0].score.info.types.shuangqidui, true)
    assert.equal(game.result.winners[0].score.flowers.big, 140) // 双七对100 + 无花果40
    assert.equal(game.balances.reduce((a, b) => a + b, 0), 4000)
  }
})
