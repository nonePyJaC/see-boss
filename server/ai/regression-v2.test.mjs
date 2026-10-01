import test from 'node:test'
import assert from 'node:assert/strict'
import { decideAction } from './policy.mjs'
import {
  buildObservation, createRuntime, opponentSummary, recordAction, recordHandJoined,
} from './runtime.mjs'

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const neutral = {
  params: {
    tightLoose: 0.5,
    passiveAggressive: 0.5,
    bluffFrequency: 0.3,
    callTendency: 0.5,
    adaptivity: 0.3,
    slowPlayFrequency: 0,
  },
}
const riverBoard = ['Ah', 'Kh', 'Qh', 'Jh', 'Tc']
const riverHand = ['2d', '3d']
const decisionOptions = { equitySims: 12000, equityMs: 10000, now: () => 0 }

function riverObservation(overrides = {}) {
  return {
    gameType: 'long',
    mySeatId: 'hero',
    myCards: riverHand,
    board: riverBoard,
    pot: 1020,
    currentBet: 1000,
    myBet: 0,
    mySeeds: 177,
    bigBlind: 20,
    publicPlayers: [
      { seatId: 'hero', bet: 0, totalBet: 0, seeds: 177, folded: false, allIn: false },
      { seatId: 'villain', bet: 1000, totalBet: 1000, seeds: 0, folded: false, allIn: true },
    ],
    publicActions: [],
    legalActions: [
      { type: 'fold' },
      { type: 'call', amount: 177 },
      { type: 'allin' },
    ],
    ...overrides,
  }
}

test('跟注价格使用合法实际支付额和可争夺池', () => {
  const observation = riverObservation({
    pot: 1354,
    publicPlayers: [
      { seatId: 'hero', bet: 0, totalBet: 0, seeds: 177, folded: false, allIn: false },
      { seatId: 'villain', bet: 1000, totalBet: 1000, seeds: 0, folded: false, allIn: true },
      { seatId: 'folded-1', bet: 0, totalBet: 177, seeds: 0, folded: true, allIn: true },
      { seatId: 'folded-2', bet: 0, totalBet: 177, seeds: 0, folded: true, allIn: true },
    ],
  })
  const action = decideAction(observation, neutral, {}, mulberry32(173), decisionOptions)
  assert.equal(action.type, 'call', '实际付 177 后，争夺池赔率优于本手胜率时应跟注')
})

test('不会把自己无法争夺的超额池计入跟注赔率', () => {
  const observation = riverObservation({
    pot: 19000,
    currentBet: 10000,
    mySeeds: 177,
    publicPlayers: [
      { seatId: 'hero', bet: 0, totalBet: 0, seeds: 177, folded: false, allIn: false },
      { seatId: 'villain', bet: 10000, totalBet: 10000, seeds: 0, folded: false, allIn: true },
      { seatId: 'folded', bet: 0, totalBet: 9000, seeds: 0, folded: true, allIn: true },
    ],
  })
  const action = decideAction(observation, neutral, {}, mulberry32(173), decisionOptions)
  assert.equal(action.type, 'fold', '不能用无法覆盖的超额投入虚增可争夺池')
})

test('高跟注倾向不能绕过极差底池赔率', () => {
  const callingStation = {
    params: { ...neutral.params, callTendency: 0.95 },
  }
  const observation = riverObservation({
    pot: 10,
    currentBet: 990,
    mySeeds: 990,
    legalActions: [
      { type: 'fold' },
      { type: 'call', amount: 990 },
      { type: 'allin' },
    ],
  })
  const action = decideAction(observation, callingStation, {}, mulberry32(173), decisionOptions)
  assert.equal(action.type, 'fold', '人设不得强迫在负赔率下跟注')
})

test('翻前起手牌分组不能绕过真实价格', () => {
  const observation = riverObservation({
    myCards: ['Ah', 'Jd'],
    board: [],
    pot: 20,
    currentBet: 1000,
    myBet: 20,
    mySeeds: 1000,
    publicPlayers: [
      { seatId: 'hero', bet: 20, seeds: 1000, folded: false, allIn: false },
      { seatId: 'villain', bet: 1000, seeds: 0, folded: false, allIn: true },
    ],
    legalActions: [
      { type: 'fold' },
      { type: 'call', amount: 980 },
      { type: 'allin' },
    ],
  })
  const action = decideAction(observation, neutral, {}, mulberry32(173), decisionOptions)
  assert.equal(action.type, 'fold', '起手牌分组不能替代价格判断')
})

test('公开观察保留累计投入以计算可争夺池', () => {
  const observation = buildObservation({
    gameType: 'long',
    mySeatId: 'hero',
    myCards: ['As', 'Kd'],
    board: [],
    pot: 180,
    currentBet: 20,
    myBet: 0,
    mySeeds: 200,
    bigBlind: 20,
    publicPlayers: [
      { seatId: 'hero', bet: 0, totalBet: 30, seeds: 200, folded: false },
      { seatId: 'villain', bet: 20, totalBet: 150, seeds: 0, folded: false, allIn: true },
    ],
    publicActions: [],
    legalActions: [],
  })
  assert.equal(observation.publicPlayers[0].totalBet, 30)
  assert.equal(observation.publicPlayers[1].totalBet, 150)
})

test('全押按实际raiseTo与支付额分类；盲注不算VPIP且翻前按手去重', () => {
  const rt = createRuntime()
  for (const handId of [0, 1, 2, 3]) {
    recordHandJoined(rt, 'observer', 'player', { enteredPot: false, raisedPreflop: false, handId })
  }
  recordAction(rt, 'observer', 'player', {
    type: 'blind', phase: 'preflop', handId: 0, paidAmount: 20,
    raiseTo: 20, currentBetBefore: 0,
  })
  recordAction(rt, 'observer', 'player', {
    type: 'call', phase: 'preflop', handId: 1, paidAmount: 10,
    raiseTo: 20, currentBetBefore: 20,
  })
  recordAction(rt, 'observer', 'player', {
    type: 'raise', phase: 'preflop', handId: 1, paidAmount: 40,
    raiseTo: 60, currentBetBefore: 20,
  })
  recordAction(rt, 'observer', 'player', {
    type: 'allin', phase: 'preflop', handId: 2, paidAmount: 160,
    raiseTo: 180, currentBetBefore: 180,
  })
  recordAction(rt, 'observer', 'player', {
    type: 'allin', phase: 'preflop', handId: 3, paidAmount: 20,
    raiseTo: 190, currentBetBefore: 180,
  })

  const model = rt.models.get('observer').get('player')
  assert.equal(model.calls, 2)
  assert.equal(model.raises, 2)
  assert.equal(model.hands, 4)
  assert.equal(model.vpipEnter, 3)
  assert.deepEqual(model.recent.map((action) => action.type), ['blind', 'call', 'raise', 'allin', 'allin'])
  assert.equal(opponentSummary(rt, 'observer', ['player']).vpip, 0.75)
})
