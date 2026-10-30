import test from 'node:test'
import assert from 'node:assert/strict'

import { MELD, analyzeHand, decomposeStandard } from './hand.mjs'

const pong = (tile) => ({ type: MELD.PONG, tiles: [tile, tile, tile] })
const kong = (tile) => ({ type: MELD.KONG, tiles: [tile, tile, tile, tile] })
const pongkong = (tile) => ({ type: MELD.PONG_KONG, tiles: [tile, tile, tile, tile] })
const ankong = (tile) => ({ type: MELD.AN_KONG, tiles: [tile, tile, tile, tile] })
const huagang = (tile) => ({ type: MELD.HUA_KONG, tiles: [tile, tile, tile, tile] })

const hand = (concealed, opts = {}) => ({
  concealed,
  melds: opts.melds ?? [],
  flowers: opts.flowers ?? [],
  winTile: opts.winTile ?? null,
})

// ── 常用牌样 ──
const QIDUI = ['1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', '7m', '7m']
const SHUANG_QIDUI = ['1m', '1m', '1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m']
const DUIDUIHU = ['1m', '1m', '1m', '2m', '2m', '2m', '3s', '3s', '3s', '4p', '4p', '4p', '5p', '5p']
const HUNYISE = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', 'E', 'E', 'E', 'S', 'S']
const QINGYISE = ['1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '1s', '2s', '3s', '5s', '5s']
const MENQING_XIAOHU = ['2s', '3s', '4s', '5s', '6s', '7s', '1m', '2m', '3m', '9p', '9p', '5p', '6p', '7p']
const PIHU = ['2s', '3s', '4s', '5s', '6s', '7s', '1m', '2m', '3m', '9p', '9p']

// ── 牌型 ──

test('七对：14 张七个对子，计大胡', () => {
  const r = analyzeHand(hand(QIDUI))
  assert.equal(r.valid, true)
  assert.equal(r.shape, 'seven_pairs')
  assert.equal(r.types.qidui, true)
  assert.equal(r.types.shuangqidui, false)
  assert.equal(r.isBigWin, true)
})

test('双七对：一个四张 + 五个对子', () => {
  const r = analyzeHand(hand(SHUANG_QIDUI))
  assert.equal(r.valid, true)
  assert.equal(r.shape, 'double_seven_pairs')
  assert.equal(r.types.shuangqidui, true)
  assert.equal(r.types.qidui, false)
  assert.equal(r.types.duiduihu, false)
})

test('对对胡：四刻子 + 一将', () => {
  const r = analyzeHand(hand(DUIDUIHU))
  assert.equal(r.shape, 'standard')
  assert.equal(r.types.duiduihu, true)
})

test('混一色：风牌 + 一种花色；清一色：只有一种花色', () => {
  const hun = analyzeHand(hand(HUNYISE))
  assert.equal(hun.types.hunyise, true)
  assert.equal(hun.types.qingyise, false)
  assert.equal(hun.types.duiduihu, false)

  const qing = analyzeHand(hand(QINGYISE))
  assert.equal(qing.types.qingyise, true)
  assert.equal(qing.types.hunyise, false)
})

test('门清：无碰算门清；直杠/暗杠/花杠不破门清；碰后补杠破门清', () => {
  assert.equal(analyzeHand(hand(MENQING_XIAOHU)).meldsConcealed, true)

  const zhi = analyzeHand(hand(PIHU, { melds: [kong('1m')] }))
  assert.equal(zhi.meldsConcealed, true)

  const an = analyzeHand(hand(PIHU, { melds: [ankong('1m')] }))
  assert.equal(an.meldsConcealed, true)

  const hua = analyzeHand(hand(MENQING_XIAOHU, { melds: [huagang('Z')] }))
  assert.equal(hua.meldsConcealed, true)

  const peng = analyzeHand(hand(PIHU, { melds: [pong('1m')] }))
  assert.equal(peng.meldsConcealed, false)

  const bu = analyzeHand(hand(PIHU, { melds: [pongkong('1m')] }))
  assert.equal(bu.meldsConcealed, false)
})

test('无花果：零硬花即算；小牌（非大胡）必须门清', () => {
  assert.equal(analyzeHand(hand(MENQING_XIAOHU)).types.wuhuaguo, true)
  assert.equal(analyzeHand(hand(MENQING_XIAOHU, { flowers: ['Z'] })).types.wuhuaguo, false)
  // 非门清小胡：零硬花也不算无花果（小牌必须门清）
  assert.equal(analyzeHand(hand(PIHU, { melds: [pong('1m')] })).types.wuhuaguo, false)
  // 非门清大胡（清一色对对胡）零硬花：不再要求门清，照算无花果
  const bigNoFlower = analyzeHand(hand(
    ['2s', '2s', '2s', '3s', '3s', '3s', '9s', '9s', '9s', '5s', '5s'],
    { melds: [pong('1s')] },
  ))
  assert.equal(bigNoFlower.types.wuhuaguo, true)
  // 花杠的 4 张也算硬花
  assert.equal(analyzeHand(hand(MENQING_XIAOHU, { melds: [huagang('Z')] })).types.wuhuaguo, false)
})

test('全球独钓：四副露 + 手上只剩一对（含胡牌）', () => {
  const r = analyzeHand(hand(['9p', '9p'], {
    melds: [pong('1m'), pong('2s'), pong('3p'), pong('E')],
  }))
  assert.equal(r.valid, true)
  assert.equal(r.types.quanqiududiao, true)
  // 四副露都是刻子，同时构成对对胡（按确认口径：不互斥即叠加）
  assert.equal(r.types.duiduihu, true)
})

test('押档：胡的那张是嵌张记 1 软花；边张/单钓不算', () => {
  const kan = analyzeHand(hand(
    ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '3p', '5p', '5p', '2p'],
    { winTile: '2p' },
  ))
  assert.equal(kan.soft.yadang, 1)

  const bian = analyzeHand(hand(
    ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '5p', '5p', '3p'],
    { winTile: '3p' },
  ))
  assert.equal(bian.soft.yadang, 0)

  const dandiao = analyzeHand(hand(['9p', '9p'], {
    melds: [pong('1m'), pong('2s'), pong('3p'), pong('E')],
    winTile: '9p',
  }))
  assert.equal(dandiao.soft.yadang, 0)
})

test('缺一：万条饼缺一门记 1 软花；三门齐全不算', () => {
  const que = analyzeHand(hand(['1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', 'E', 'E', 'E', '5p', '5p']))
  assert.equal(que.soft.queyi, 1)

  const quan = analyzeHand(hand(MENQING_XIAOHU))
  assert.equal(quan.soft.queyi, 0)
})

test('杠软花：每杠 2 颗（含花杠），两个杠 4 颗', () => {
  const one = analyzeHand(hand(MENQING_XIAOHU, { melds: [huagang('Z')] }))
  assert.equal(one.gangCount, 1)
  assert.equal(one.soft.gang, 2)

  const two = analyzeHand(hand(['3s', '4s', '5s', '6s', '7s', '8s', '9p', '9p'], {
    melds: [ankong('1m'), kong('2m')],
  }))
  assert.equal(two.valid, true)
  assert.equal(two.gangCount, 2)
  assert.equal(two.soft.gang, 4)
})

test('诈胡提示：非门清小胡且硬花不足 4 张', () => {
  const low = analyzeHand(hand(PIHU, { melds: [pong('1m')], flowers: ['Z', 'F'] }))
  assert.equal(low.hint, '非门清小胡通常需≥4张硬花，请核对牌型是否合法')

  const ok = analyzeHand(hand(PIHU, { melds: [pong('1m')], flowers: ['Z', 'F', 'B', 'f1'] }))
  assert.equal(ok.hint, null)

  const menqing = analyzeHand(hand(MENQING_XIAOHU))
  assert.equal(menqing.hint, null)
})

test('非法牌型：张数对不上 / 单张超过 4 张', () => {
  const short = analyzeHand(hand(['1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m', '6m', '7m']))
  assert.equal(short.valid, false)
  assert.ok(short.errors.length > 0)

  const over = analyzeHand(hand(['1m', '1m', '1m', '1m', '1m', '2m', '2m', '3m', '3m', '4m', '4m', '5m', '5m', '6m']))
  assert.equal(over.valid, false)
  assert.ok(over.errors.some((e) => e.includes('超过')))
})

test('标准型拆解：能拆出多解', () => {
  const decomps = decomposeStandard({ '1m': 2, '2m': 2, '3m': 2, '5p': 2 })
  assert.ok(decomps.length >= 1)
  for (const d of decomps) {
    assert.equal(d.pair.length, 2)
    assert.equal(d.sets.length + 1, 3)
  }
})
