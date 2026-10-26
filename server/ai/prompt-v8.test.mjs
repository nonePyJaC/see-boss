import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMessages, LLM_SYSTEM_PROMPT, LLM_PROMPT_VERSION, parseDecision } from './llm.mjs'

// 匿名构造；不读取实战记录、不调用模型。
function draw(phase = 'flop', cost = 20) {
  const previous = cost === 100 ? 0 : 40
  return { gameType: 'long', phase, mySeatId: 'a', myCards: ['As', 'Js'],
    board: phase === 'flop' ? ['9s', '6d', '2s'] : ['9s', '6d', '2s', '4c'],
    pot: previous * 2 + cost, currentBet: cost, myBet: 0, mySeeds: 1000, smallBlind: 10, bigBlind: 20,
    dealerSeatId: 'a', smallBlindSeatId: 'b', bigBlindSeatId: 'a', actedSeatIds: ['b'],
    publicPlayers: [
      { seatId: 'a', nickname: '甲', seeds: 1000, bet: 0, totalBet: previous, folded: false, allIn: false },
      { seatId: 'b', nickname: '乙', seeds: 900, bet: cost, totalBet: previous + cost, folded: false, allIn: false },
    ],
    publicActions: [{ seatId: 'b', type: 'bet', amount: cost, betTotal: cost, phase }],
    legalActions: [{ type: 'fold' }, { type: 'call', amount: cost }, { type: 'raise', min: cost * 2, max: 1000 }],
  }
}

test('C1 v8价格与买牌：好价、差价、翻牌一张与转牌，以及较低同花听牌的风险', () => {
  for (const phase of ['flop', 'turn']) {
    const obs = draw(phase)
    const before = structuredClone(obs)
    const [system, user] = buildMessages(obs, {}, [])
    assert.match(user.content, /本次跟注实际投入 20/)
    assert.match(user.content, /静态盈亏平衡权益 16.67% = 20\/\(100\+20\)/)
    assert.match(user.content, /同花听牌：9 张未知牌/)
    assert.match(user.content, phase === 'flop' ? /下一张成花概率 19.15%/ : /下一张成花概率 19.57%/)
    assert.match(system.content, /买牌是正常策略：价格合适、听牌质量及权益实现支持时，应考虑call/)
    assert.match(system.content, /不能只因尚未成牌、非坚果或可能再被下注就弃/)
    assert.match(system.content, /翻牌普通跟注按下一张机会并考虑后续收费/)
    assert.match(system.content, /已全下且后续无需付费才可按剩余两张机会评估/)
    assert.deepEqual(obs, before)
  }
  const expensive = buildMessages(draw('turn', 100), {}, [])[1].content
  assert.match(expensive, /静态盈亏平衡权益 50.00%/)
  const gutshot = draw()
  Object.assign(gutshot, { myCards: ['8d', '7c'], board: ['4h', '5s', 'Kd'], pot: 300 })
  gutshot.publicPlayers[0].totalBet = 140
  gutshot.publicPlayers[1].totalBet = 160
  const cheapGutshot = buildMessages(gutshot, {}, [])[1].content
  assert.match(cheapGutshot, /补牌点数 6，4 张未知牌；下一张成顺概率 8.51%/)
  assert.match(cheapGutshot, /静态盈亏平衡权益 6.25% = 20\/\(300\+20\)/)
  const low = draw(); low.myCards = ['8s', '3s']
  assert.match(buildMessages(low, {}, [])[1].content, /更高同色牌 .*不能据此称为坚果同花听牌/)
  assert.match(LLM_SYSTEM_PROMPT, /不因便宜自动跟，也不凭空放大风险/)
})

test('C2 v8事实与主动比较：公共花色不混底牌、有支付对象、连弃不是行动依据', () => {
  const obs = draw('river', 0)
  Object.assign(obs, { myCards: ['7h', '4h'], board: ['5d', 'Ac', '3s', 'Ks', '6s'],
    legalActions: [{ type: 'check' }, { type: 'raise', min: 20, max: 1000 }] })
  const self = { style: 'pressure', history: { hands: 8, foldedHands: 8, consecutiveFolds: 8,
    enteredHands: 1, bets: 0, calls: 1, checks: 2, faced: 8, foldToBet: 8 } }
  const [system, user] = buildMessages(obs, { params: { passiveAggressive: 0.1 } }, [], self)
  assert.match(user.content, /当前最佳五张：顺子，7 高/)
  assert.match(user.content, /公共牌花色：♠3张、♦1张、♣1张/)
  assert.match(user.content, /【可追加筹码对手】座2（后手 900）/)
  assert.match(user.content, /近8手：弃8、连弃8/)
  assert.match(user.content, /偏主动争取底池（当前pressure）/)
  assert.match(user.content, /本次跟注成本 0。/)
  assert.ok(!user.content.includes('不需为看下一步支付跟注'))
  assert.match(system.content, /强牌先比较取值收益/)
  assert.match(system.content, /不能用“过去常弃”证明本次该弃/)
  assert.match(system.content, /对手范围、跟注或弃牌可能性注明为推测/)
  assert.match(system.content, /诱导须仍给对手行动机会/)
  const suited = draw()
  assert.match(buildMessages(suited, {}, [])[1].content, /公共牌花色：♠2张、♦1张/)
})

test('C3 v8紧凑输出与兼容：每次明确风格，示例可解析，不触发理由判废', () => {
  assert.equal(LLM_PROMPT_VERSION, 'poker-facts-v8')
  assert.ok([...LLM_SYSTEM_PROMPT].length < 1700, '保持重组后的固定规则精简')
  assert.match(LLM_SYSTEM_PROMPT, /nextStyle每次必填/)
  assert.match(LLM_SYSTEM_PROMPT, /保持也填当前枚举/)
  assert.match(LLM_SYSTEM_PROMPT, /base回该座位基础人设/)
  for (const line of LLM_SYSTEM_PROMPT.split('\n').filter(s => s.startsWith('{'))) {
    const decision = parseDecision(line)
    assert.ok(decision.nextStyle)
    assert.ok([...decision.reason].length <= 80)
    assert.equal(decision.type === 'raise', 'amount' in decision)
  }
  assert.deepEqual(parseDecision('{"action":"call","reason":"四张同花听牌价格合适"}'),
    { type: 'call', reason: '四张同花听牌价格合适' }, '遗漏风格仍兼容，不按自然语言关键词替换动作')
})
