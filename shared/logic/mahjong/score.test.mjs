import test from 'node:test'
import assert from 'node:assert/strict'

import { MELD } from './hand.mjs'
import { scoreHand } from './score.mjs'

const pong = (tile) => ({ type: MELD.PONG, tiles: [tile, tile, tile] })
const ankong = (tile) => ({ type: MELD.AN_KONG, tiles: [tile, tile, tile, tile] })
const huagang = (tile) => ({ type: MELD.HUA_KONG, tiles: [tile, tile, tile, tile] })

const hand = (concealed, opts = {}) => ({
  concealed,
  melds: opts.melds ?? [],
  flowers: opts.flowers ?? [],
  winTile: opts.winTile ?? null,
})

// 屁胡：碰 1m，暗牌 234s 567s 123m + 99p
const PIHU = (opts = {}) => hand(
  ['2s', '3s', '4s', '5s', '6s', '7s', '1m', '2m', '3m', '9p', '9p'],
  { melds: [pong('1m')], ...opts },
)
// 门清小胡（带 1 张硬花，避免误判无花果）
const MENQING = (flowers = ['Z']) => hand(
  ['2s', '3s', '4s', '5s', '6s', '7s', '1m', '2m', '3m', '9p', '9p', '5p', '6p', '7p'],
  { flowers },
)
const QIDUI_SANMEN = ['1m', '1m', '2m', '2m', '3m', '3m', '4s', '4s', '5s', '5s', '6p', '6p', '7p', '7p']
const QIDUI_HUNYISE = ['1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', 'E', 'E']
const QINGYISE_DUIDUIHU = ['2s', '2s', '2s', '3s', '3s', '3s', '9s', '9s', '9s', '5s', '5s']

test('屁胡 = 10 花（非门清小胡）', () => {
  const s = scoreHand(PIHU())
  assert.equal(s.flowers.small, 10)
  assert.equal(s.flowers.total, 10)
  assert.equal(s.isBigWin, false)
  assert.deepEqual(s.breakdown, [{ label: '屁胡', value: 10 }])
})

test('门清小胡 = 20 花（替代屁胡，不叠加）', () => {
  const s = scoreHand(MENQING())
  assert.equal(s.flowers.small, 20)
  assert.equal(s.flowers.total, 21) // 20 + 1 张硬花
})

test('大胡不互斥即叠加：门清 + 混一色 + 对对胡 = 30+30+20', () => {
  const s = scoreHand(hand(
    ['1m', '1m', '1m', '2m', '2m', '2m', '3m', '3m', '3m', 'E', 'E', 'E', '9m', '9m'],
    { flowers: ['Z', 'F'] },
  ))
  assert.equal(s.flowers.big, 60)
  assert.equal(s.flowers.menqing, 20)
  assert.equal(s.flowers.softQueyi, 0) // 缺一是小胡加分项，大胡不算
  assert.equal(s.flowers.total, 82) // 60 + 20 + 2 硬花
  assert.equal(s.isBigWin, true)
})

test('清一色对对胡 = 40+30；大胡不再计缺一', () => {
  const s = scoreHand(hand(QINGYISE_DUIDUIHU, { melds: [pong('1s')], flowers: ['Z'] }))
  assert.equal(s.flowers.big, 70)
  assert.equal(s.flowers.softQueyi, 0) // 缺一是小胡加分项，大胡不算
  assert.equal(s.flowers.total, 71) // 70 + 1 硬花
})

test('非门清大胡零硬花也计无花果（小牌才要求门清）', () => {
  const s = scoreHand(hand(QINGYISE_DUIDUIHU, { melds: [pong('1s')] }))
  assert.equal(s.flowers.big, 110) // 清一色 40 + 对对胡 30 + 无花果 40
  assert.equal(s.flowers.total, 110) // 大胡不计缺一
})

test('七对不计门清；七对 + 混一色叠加；七对 + 无花果也叠加', () => {
  const sanmen = scoreHand(hand(QIDUI_SANMEN, { flowers: ['Z'] }))
  assert.equal(sanmen.flowers.big, 50)
  assert.equal(sanmen.flowers.menqing, 0)
  assert.equal(sanmen.flowers.total, 51)

  const hun = scoreHand(hand(QIDUI_HUNYISE, { flowers: ['Z', 'F'] }))
  assert.equal(hun.flowers.big, 80) // 50 + 30
  assert.equal(hun.flowers.total, 82) // + 2 硬花（大胡不计缺一）

  const wuhua = scoreHand(hand(QIDUI_SANMEN))
  assert.equal(wuhua.flowers.big, 90) // 七对 50 + 无花果 40
  assert.equal(wuhua.flowers.total, 90)
})

test('全球独钓 + 对对胡叠加 = 60+30', () => {
  const s = scoreHand(hand(['9p', '9p'], {
    melds: [pong('1m'), pong('2s'), pong('3p'), pong('E')],
    flowers: ['Z'],
  }))
  assert.equal(s.flowers.big, 90)
  assert.equal(s.flowers.total, 91)
})

test('天胡/地胡与大胡叠加、不加小胡底与门清', () => {
  const tianhuPihu = scoreHand(MENQING(), { tianhu: true })
  assert.equal(tianhuPihu.flowers.small, 0)
  assert.equal(tianhuPihu.flowers.tianhu, 50)
  assert.equal(tianhuPihu.flowers.menqing, 0)
  assert.equal(tianhuPihu.flowers.total, 51) // 50 + 1 张硬花

  const tianhuQidui = scoreHand(hand(QIDUI_SANMEN, { flowers: ['Z'] }), { tianhu: true })
  assert.equal(tianhuQidui.flowers.big, 50)
  assert.equal(tianhuQidui.flowers.tianhu, 50)
  assert.equal(tianhuQidui.flowers.total, 101)

  const dihu = scoreHand(MENQING(), { dihu: true })
  assert.equal(dihu.flowers.dihu, 30)
  assert.equal(dihu.flowers.total, 31)
  assert.equal(dihu.isBigWin, true)
})

test('硬花计数：花堆 + 花杠的四张', () => {
  const s = scoreHand(hand(MENQING().concealed, { melds: [huagang('Z')], flowers: ['F', 'B'] }))
  assert.equal(s.flowers.hard, 6)
  assert.equal(s.flowers.softGang, 2)
  assert.equal(s.flowers.total, 28) // 门清 20 + 硬花 6 + 杠 2
})

test('软花：杠 2 颗 + 押档 1 颗 + 缺一 1 颗', () => {
  const s = scoreHand(hand(
    ['2s', '3s', '4s', '5s', '6s', '7s', '1p', '3p', '5p', '5p', '2p'],
    { melds: [ankong('E')], flowers: ['Z', 'F'], winTile: '2p' },
  ))
  assert.equal(s.flowers.softGang, 2)
  assert.equal(s.flowers.softYadang, 1)
  assert.equal(s.flowers.softQueyi, 1)
  assert.equal(s.flowers.soft, 4)
  assert.equal(s.flowers.total, 26) // 门清 20 + 硬花 2 + 软花 4
})

test('押档/缺一是小胡加分项：大胡不再计算', () => {
  // 混一色（大胡）嵌张胡 2m：牌面上押档/缺一都成立，但计分时不计
  const s = scoreHand(hand(
    ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '5m', '5m', 'E', 'E', 'E'],
    { flowers: ['Z'], winTile: '2m' },
  ))
  assert.equal(s.info.soft.yadang, 1) // 牌面识别到押档
  assert.equal(s.info.soft.queyi, 1) // 牌面识别到缺一
  assert.equal(s.flowers.big, 30) // 混一色
  assert.equal(s.flowers.menqing, 20)
  assert.equal(s.flowers.softYadang, 0) // 大胡不计
  assert.equal(s.flowers.softQueyi, 0) // 大胡不计
  assert.equal(s.flowers.total, 51) // 30 + 20 + 1 硬花
})

test('花开 / 杠开各 +10', () => {
  assert.equal(scoreHand(PIHU(), { huakai: true }).flowers.total, 20)
  assert.equal(scoreHand(PIHU(), { gangkai: true }).flowers.total, 20)
})

test('无花果 = 40（零硬花 + 门清小胡）', () => {
  const s = scoreHand(MENQING([]))
  assert.equal(s.flowers.big, 40)
  assert.equal(s.flowers.total, 40)
  assert.equal(s.flowers.menqing, 0)
})

test('诈胡提示随结果带出', () => {
  const s = scoreHand(PIHU({ flowers: ['Z', 'F'] }))
  assert.ok(s.hint)
  assert.equal(scoreHand(PIHU({ flowers: ['Z', 'F', 'B', 'f1'] })).hint, null)
})
