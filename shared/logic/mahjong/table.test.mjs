import test from 'node:test'
import assert from 'node:assert/strict'

import { MELD } from './hand.mjs'
import { createMahjongTable, drawRound, settleKong, settleRound } from './table.mjs'

const seats = ['u0', 'u1', 'u2', 'u3'].map((uid, i) => ({ uid, nickname: 'P' + i }))
const pong = (tile) => ({ type: MELD.PONG, tiles: [tile, tile, tile] })

const hand = (concealed, opts = {}) => ({
  concealed,
  melds: opts.melds ?? [],
  flowers: opts.flowers ?? [],
  winTile: opts.winTile ?? null,
})

// 屁胡 10 花：碰 1m + 234s 567s 123m + 99p
const PIHU = () => hand(['2s', '3s', '4s', '5s', '6s', '7s', '1m', '2m', '3m', '9p', '9p'], { melds: [pong('1m')] })
// 大胡：门清无花果对对胡（30 + 40 = 70）
const DAHU = () => hand(['1m', '1m', '1m', '2m', '2m', '2m', '3s', '3s', '3s', '4p', '4p', '4p', '5p', '5p'])

const table = (opts = {}) => createMahjongTable({ seats, dealerSeat: 0, ...opts })

test('南京麻将需要 4 位玩家', () => {
  assert.throws(() => createMahjongTable({ seats: seats.slice(0, 3) }), /4 位玩家/)
})

test('自摸：三家各付全额，胡家收 3 份', () => {
  const { table: next, result } = settleRound(table(), {
    winType: 'tsumo',
    winners: [{ seat: 1, hand: PIHU() }],
  })
  assert.deepEqual(result.net, [-10, 30, -10, -10])
  assert.equal(next.dealerSeat, 1) // 闲家小胡 → 下家坐庄
  assert.equal(next.isDoubleRound, false)
})

test('点炮：点炮者付 1 份', () => {
  const { result } = settleRound(table(), {
    winType: 'ron',
    discarderSeat: 2,
    winners: [{ seat: 1, hand: PIHU() }],
  })
  assert.deepEqual(result.net, [0, 10, -10, 0])
})

test('包牌：包者付 3 份', () => {
  const { result } = settleRound(table(), {
    winType: 'ron',
    discarderSeat: 2,
    winners: [{ seat: 1, hand: PIHU(), baoSeat: 3 }],
  })
  assert.deepEqual(result.net, [0, 30, 0, -30])
})

test('杠开：被杠者包三家；暗杠杠开无被杠者则按自摸', () => {
  const bao = settleRound(table(), {
    winType: 'tsumo',
    winners: [{ seat: 1, hand: PIHU(), flags: { gangkai: true }, gangkaiFromSeat: 2 }],
  })
  // 屁胡 10 + 杠开 10 = 20 花，被杠者一人付 3 份
  assert.deepEqual(bao.result.net, [0, 60, -60, 0])

  const an = settleRound(table(), {
    winType: 'tsumo',
    winners: [{ seat: 1, hand: PIHU(), flags: { gangkai: true }, gangkaiFromSeat: null }],
  })
  assert.deepEqual(an.result.net, [-20, 60, -20, -20])
})

test('胡牌结算不含杠钱（杠独立结算）', () => {
  const { result } = settleRound(table(), {
    winType: 'tsumo',
    winners: [{ seat: 1, hand: PIHU() }],
  })
  assert.ok(result.transfers.every((t) => t.reason === '自摸'))
})

test('杠独立结算：明杠被杠者付 10，暗杠三家各 5，花杠三家各 10', () => {
  const t0 = table()
  const ming = settleKong(t0, { seat: 0, type: 'ming', fromSeat: 1 })
  assert.deepEqual(ming.result.net, [10, -10, 0, 0])

  const an = settleKong(ming.table, { seat: 2, type: 'an' })
  assert.deepEqual(an.result.net, [-5, -5, 15, -5])

  const hua = settleKong(an.table, { seat: 3, type: 'hua' })
  assert.deepEqual(hua.result.net, [-10, -10, -10, 30])

  assert.equal(hua.table.history.length, 3)
})

test('杠独立结算：翻倍局 ×2，不改变庄家与翻倍状态', () => {
  const t = { ...table(), isDoubleRound: true }
  const r = settleKong(t, { seat: 0, type: 'ming', fromSeat: 1 })
  assert.deepEqual(r.result.net, [20, -20, 0, 0])
  assert.equal(r.result.mult, 2)
  assert.equal(r.table.dealerSeat, 0)
  assert.equal(r.table.isDoubleRound, true)
})

test('杠钱不退：杠完流局，已入账的杠钱保留在流水里', () => {
  const k = settleKong(table(), { seat: 0, type: 'ming', fromSeat: 1 })
  const d = drawRound(k.table)
  assert.equal(d.table.history.filter((h) => h.kong).length, 1)
  assert.deepEqual(d.result.net, [0, 0, 0, 0])
})

test('翻倍局：总花数 ×2', () => {
  const { result } = settleRound(table({ pricePerFlower: 1 }), {
    winType: 'tsumo',
    isDoubleRound: true,
    winners: [{ seat: 1, hand: PIHU() }],
  })
  assert.deepEqual(result.net, [-20, 60, -20, -20])
  assert.equal(result.mult, 2)
})

test('一炮多响：按逆时针依次与点炮者各结算 1 份', () => {
  const { result } = settleRound(table(), {
    winType: 'ron',
    discarderSeat: 2,
    winners: [
      { seat: 1, hand: PIHU() },
      { seat: 3, hand: PIHU() },
    ],
  })
  assert.deepEqual(result.net, [0, 10, -20, 10])
})

test('手动罚分/包牌：金额计入流水，翻倍局同步 ×2', () => {
  const { result } = settleRound(table(), {
    winType: 'tsumo',
    winners: [{ seat: 1, hand: PIHU() }],
    payments: [{ from: 0, to: 2, amount: 10, reason: '罚分' }],
  })
  assert.deepEqual(result.net, [-20, 30, 0, -10])
  assert.ok(result.transfers.some((t) => t.reason === '罚分'))

  const doubled = settleRound(table(), {
    winType: 'tsumo',
    isDoubleRound: true,
    winners: [{ seat: 1, hand: PIHU() }],
    payments: [{ from: 0, to: 2, amount: 10, reason: '罚分' }],
  })
  assert.ok(doubled.result.transfers.some((t) => t.reason === '罚分' && t.amount === 20))
})

test('庄家胡牌连庄', () => {
  const { table: next } = settleRound(table(), {
    winType: 'tsumo',
    winners: [{ seat: 0, hand: PIHU() }],
  })
  assert.equal(next.dealerSeat, 0)
  assert.equal(next.isDoubleRound, false)
})

test('闲家大胡不换庄，且下局翻倍', () => {
  const { table: next, result } = settleRound(table(), {
    winType: 'tsumo',
    winners: [{ seat: 2, hand: DAHU() }],
  })
  assert.equal(result.bigWin, true)
  assert.equal(next.dealerSeat, 0)
  assert.equal(next.isDoubleRound, true)
})

test('花杠触发下局翻倍（庄家照常轮换）', () => {
  const { table: next, result } = settleRound(table(), {
    winType: 'ron',
    discarderSeat: 0,
    winners: [{ seat: 2, hand: PIHU() }],
    hadHuagang: true,
  })
  assert.equal(result.hadHuagang, true)
  assert.equal(next.dealerSeat, 1)
  assert.equal(next.isDoubleRound, true)
})

test('翻倍局：庄家连庄继续翻倍', () => {
  const { table: next } = settleRound(table({ pricePerFlower: 1 }), {
    winType: 'tsumo',
    winners: [{ seat: 0, hand: PIHU() }],
    isDoubleRound: true,
  })
  assert.equal(next.dealerSeat, 0)
  assert.equal(next.isDoubleRound, true)
})

test('翻倍局：闲家小胡结束翻倍', () => {
  const { table: next } = settleRound(table(), {
    winType: 'tsumo',
    winners: [{ seat: 2, hand: PIHU() }],
    isDoubleRound: true,
  })
  assert.equal(next.dealerSeat, 1)
  assert.equal(next.isDoubleRound, false)
})

test('流局：不结算、庄家连庄、翻倍状态原样延续', () => {
  const normal = drawRound(table())
  assert.equal(normal.table.dealerSeat, 0)
  assert.equal(normal.table.isDoubleRound, false)
  assert.deepEqual(normal.result.net, [0, 0, 0, 0])

  const doubled = drawRound(table({ pricePerFlower: 1 }))
  doubled.table.isDoubleRound = true
  const cont = drawRound(doubled.table)
  assert.equal(cont.table.isDoubleRound, true)
  assert.equal(cont.result.nextDouble, true)
})

test('roundNo 与历史流水随每局推进', () => {
  const { table: t1 } = settleRound(table(), { winType: 'tsumo', winners: [{ seat: 1, hand: PIHU() }] })
  assert.equal(t1.roundNo, 1)
  const { table: t2 } = drawRound(t1)
  assert.equal(t2.roundNo, 2)
  assert.equal(t2.history.length, 2)
  assert.equal(t2.history[1].draw, true)
})

test('诈胡提示会随结算结果带出', () => {
  const { result } = settleRound(table(), {
    winType: 'ron',
    discarderSeat: 2,
    winners: [{ seat: 1, hand: hand(['2s', '3s', '4s', '5s', '6s', '7s', '1m', '2m', '3m', '9p', '9p'], { melds: [pong('1m')], flowers: ['Z', 'F'] }) }],
  })
  assert.equal(result.warnings.length, 1)
  assert.ok(result.warnings[0].includes('硬花'))
})
