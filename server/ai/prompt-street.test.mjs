import test from 'node:test'
import assert from 'node:assert/strict'
import { streetFacts } from './prompt-facts.mjs'
import { buildMessages, LLM_SYSTEM_PROMPT } from './llm.mjs'

const observation = () => ({ phase: 'turn', mySeatId: 'a', currentBet: 0, actedSeatIds: [],
  publicPlayers: ['a', 'b', 'c'].map((seatId) => ({ seatId, seeds: 1000, bet: 0, folded: false, allIn: false })),
  publicActions: [] })
const summary = (obs) => streetFacts(obs).join('\n')

test('上一圈过牌不进入本圈曾过牌；新圈尚无人行动，不保证免费到下一圈', () => {
  const obs = observation()
  obs.publicActions = [
    { seatId: 'a', type: 'check', amount: 0, betTotal: 0, phase: 'flop' },
    { seatId: 'b', type: 'check', amount: 0, betTotal: 0, phase: 'flop' },
  ]
  const text = summary(obs)
  assert.match(text, /转牌圈：出价 无；跟注 无/)
  assert.match(text, /本圈曾过牌：无/)
  assert.match(text, /本圈尚无人主动行动/)
  assert.match(text, /本圈尚未行动：座1、座2、座3/)
  assert.match(text, /待响应：座1、座2、座3/)
  assert.match(LLM_SYSTEM_PROMPT, /不能声称已保证免费看到后续公共牌/)
})

test('分圈明确对手下注、自己跟注，不将两圈行动者颠倒', () => {
  const obs = observation()
  obs.phase = 'river'
  obs.publicActions = [
    { seatId: 'b', type: 'bet', amount: 100, betTotal: 100, phase: 'flop' },
    { seatId: 'a', type: 'call', amount: 100, betTotal: 100, phase: 'flop' },
    { seatId: 'b', type: 'bet', amount: 250, betTotal: 250, phase: 'turn' },
    { seatId: 'a', type: 'call', amount: 250, betTotal: 250, phase: 'turn' },
  ]
  assert.match(summary(obs), /翻牌圈：出价 座2×1；跟注 座1×1/)
  assert.match(summary(obs), /转牌圈：出价 座2×1；跟注 座1×1/)
  assert.match(summary(obs), /河牌圈：出价 无；跟注 无/)
  assert.match(summary(obs), /本圈曾过牌：无/)
})

test('曾行动与待再次响应区分；加注后不能把已过牌/跟注者排除', () => {
  const obs = observation()
  obs.currentBet = 600
  obs.actedSeatIds = ['c']
  obs.publicPlayers[0].bet = 300
  obs.publicPlayers[1].bet = 300
  obs.publicPlayers[2].bet = 600
  obs.publicPlayers[0].seeds = 700
  obs.publicPlayers[1].seeds = 700
  obs.publicPlayers[2].seeds = 400
  obs.publicActions = [
    { seatId: 'a', type: 'check', amount: 0, betTotal: 0, phase: 'turn' },
    { seatId: 'b', type: 'bet', amount: 100, betTotal: 100, phase: 'turn' },
    { seatId: 'c', type: 'call', amount: 100, betTotal: 100, phase: 'turn' },
    { seatId: 'a', type: 'raise', amount: 300, betTotal: 300, phase: 'turn' },
    { seatId: 'b', type: 'call', amount: 200, betTotal: 300, phase: 'turn' },
    { seatId: 'c', type: 'raise', amount: 500, betTotal: 600, phase: 'turn' },
  ]
  const text = summary(obs)
  assert.match(text, /转牌圈：出价 座2×1、座1×1、座3×1；跟注 座3×1、座2×1/)
  assert.match(text, /本圈曾过牌：座1/)
  assert.match(text, /本圈尚未行动：无/)
  assert.match(text, /本圈最后出价：座3，到 600/)
  assert.match(text, /待响应：座1、座2/)
})

test('盲注不算主动行动；大盲已平注但尚未行动仍须响应', () => {
  const obs = observation()
  obs.phase = 'preflop'; obs.currentBet = 20
  obs.publicPlayers[0].bet = 10; obs.publicPlayers[1].bet = 20
  obs.publicActions = [
    { seatId: 'a', type: 'blind', amount: 10, betTotal: 10, phase: 'preflop' },
    { seatId: 'b', type: 'blind', amount: 20, betTotal: 20, phase: 'preflop' },
  ]
  const text = summary(obs)
  assert.match(text, /翻牌前：出价 无；跟注 无/)
  assert.match(text, /本圈尚未行动：座1、座2、座3/)
  assert.match(text, /待响应：座1、座2、座3/)
})

test('全下跟注与全下加注正确归类，弃牌/全下/零筹码不进入待响应', () => {
  const obs = observation()
  obs.currentBet = 300; obs.actedSeatIds = ['a', 'b']; obs.mySeatId = 'd'
  obs.publicPlayers[0].allIn = true; obs.publicPlayers[0].seeds = 0; obs.publicPlayers[0].bet = 300
  obs.publicPlayers[1].folded = true
  obs.publicPlayers[2].allIn = true; obs.publicPlayers[2].seeds = 0; obs.publicPlayers[2].bet = 75
  obs.publicPlayers.push({ seatId: 'd', bet: 100, seeds: 900, folded: false, allIn: false })
  obs.publicActions = [
    { seatId: 'b', type: 'bet', amount: 100, betTotal: 100, phase: 'turn' },
    { seatId: 'c', type: 'allin', amount: 75, betTotal: 75, phase: 'turn' },
    { seatId: 'd', type: 'call', amount: 100, betTotal: 100, phase: 'turn' },
    { seatId: 'a', type: 'allin', amount: 300, betTotal: 300, phase: 'turn' },
    { seatId: 'b', type: 'fold', amount: 0, betTotal: 100, phase: 'turn' },
  ]
  const text = summary(obs)
  assert.match(text, /出价 座2×1、座1×1；跟注 座3×1、座4×1/)
  assert.match(text, /本圈最后出价：座1，到 300/)
  assert.match(text, /待响应：座4/)
})

test('缺少引擎状态/全下累计金额时保留未知，不冒造下注义务', () => {
  const obs = observation()
  delete obs.actedSeatIds
  obs.publicActions = [{ seatId: 'a', type: 'allin', amount: 50, phase: 'turn' }]
  assert.match(summary(obs), /性质未知全下 座1×1/)
  assert.match(summary(obs), /待响应：未提供引擎状态/)
})

test('身份、角色摘要和底牌事实位于动态后段，公共历史缓存前缀不随AI视角变化', () => {
  const obs = { ...observation(), phase: 'preflop', gameType: 'long', myCards: ['Qh', 'Tc'], board: [],
    pot: 0, myBet: 0, mySeeds: 1000, smallBlind: 10, bigBlind: 20, sbIndex: 0 }
  const a = buildMessages(obs, {}, [])
  const b = buildMessages({ ...obs, mySeatId: 'b', myCards: ['8h', '5h'] }, {}, [])
  assert.deepEqual(a[0], b[0])
  assert.equal(a[1].content.split('\n【当前决策】')[0], b[1].content.split('\n【当前决策】')[0])
  assert.match(a[1].content, /Q10，不同花；常规点数差 2，隔 1 张，非连张/)
  assert.match(b[1].content, /85，同花；常规点数差 3，隔 2 张，非连张/)
  assert.ok(a[1].content.indexOf('【分圈行动角色与当前响应】') > a[1].content.indexOf('【当前决策】'))
})
