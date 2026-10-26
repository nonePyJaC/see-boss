import test from 'node:test'
import assert from 'node:assert/strict'
import { streetFacts } from './prompt-facts.mjs'
import { buildMessages, LLM_SYSTEM_PROMPT } from './llm.mjs'

const observation = () => ({ phase: 'turn', mySeatId: 'a', currentBet: 0, actedSeatIds: [],
  publicPlayers: ['a', 'b', 'c'].map((seatId) => ({ seatId, seeds: 1000, bet: 0, folded: false, allIn: false })),
  publicActions: [] })
const summary = (obs) => streetFacts(obs).join('\n')

test('v6 牌力和行动优先于风格，不将下注、控池或人设写成自动动作', () => {
  const obs = { ...observation(), gameType: 'long', myCards: ['Js', 'Jd'], board: ['Ts', '7c', '2h', '4s'],
    pot: 600, myBet: 0, mySeeds: 1000, legalActions: [{ type: 'check' }, { type: 'raise', min: 20, max: 1000 }] }
  const [system, user] = buildMessages(obs, { params: { tightLoose: 0.1, passiveAggressive: 0.1, callTendency: 0.1 } }, [])
  assert.match(system.content, /实际牌力与牌面→对手公开行动及合理范围→价格、位置和有效后手→风格参考/)
  assert.match(system.content, /不能单独作为弃牌、跟注或控池理由/)
  assert.match(system.content, /对手下注不等于必有强牌，过牌不等于弱牌/)
  assert.match(system.content, /顶对好踢脚、超对不因下注自动弃，也不强制跟注/)
  assert.match(system.content, /check需具体范围、风险或诱导收益/)
  assert.match(system.content, /本圈已过牌者仍可待响应，不能称为未行动/)
  assert.match(user.content, /【我的性格】仅作边缘选择参考：起手范围偏紧、边缘局面偏稳健、边缘跟注意愿偏低/)
  assert.ok(user.content.indexOf('【我的性格】') > user.content.indexOf('【其他玩家当前状态】'))
})

test('C1 下注对象边界：免费check、仍欠注、第三方支付和状态缺失', () => {
  const base = () => ({ ...observation(), gameType: 'long', myCards: ['As', 'Kd'],
    board: ['2c', '7h', '9d', 'Js'], pot: 300, myBet: 0, mySeeds: 1000,
    legalActions: [{ type: 'check' }, { type: 'raise', min: 20, max: 1000 }] })
  const free = base()
  Object.assign(free.publicPlayers[1], { allIn: true, seeds: 0 })
  free.publicPlayers[2].folded = true
  const owed = structuredClone(free)
  Object.assign(owed, { pot: 400, currentBet: 300, myBet: 100,
    legalActions: [{ type: 'fold' }, { type: 'call', amount: 200 }, { type: 'raise', min: 500, max: 1100 }] })
  owed.publicPlayers[0].bet = 100
  owed.publicPlayers[1].bet = 300
  const third = structuredClone(free)
  Object.assign(third, { currentBet: 100, myBet: 100, actedSeatIds: ['a', 'b', 'c'],
    publicActions: [{ seatId: 'c', type: 'call', amount: 100, betTotal: 100, phase: 'turn' }] })
  for (const p of third.publicPlayers) p.bet = 100
  Object.assign(third.publicPlayers[2], { folded: false, seeds: 600 })
  const missing = structuredClone(free)
  Object.assign(missing.publicPlayers[1], { allIn: undefined, seeds: undefined })
  delete missing.myBet

  for (const [name, obs, payers, payment, legal] of [
    ['免费check', free, /无（0人）/, /尚欠 0；check合法/, 'check / raise（加注到 20 ~ 1000）'],
    ['仍欠注', owed, /无（0人）/, /尚欠 200；check不在合法列表/, 'fold / call（跟 200） / raise（加注到 500 ~ 1100）'],
    ['第三方支付', third, /座3（后手 600）/, /尚欠 0；check合法/, 'check / raise（加注到 20 ~ 1000）'],
    ['状态缺失', missing, /未知（座2状态不足）/, /尚欠 未知；check合法/, 'check / raise（加注到 20 ~ 1000）'],
  ]) {
    const before = structuredClone(obs)
    const text = buildMessages(obs, {}, [])[1].content
    const line = text.split('\n').find((s) => s.startsWith('【可追加筹码对手】'))
    assert.ok(line, name + ' 应提供下注对象摘要（旧版输入契约red）')
    assert.match(line, payers, name)
    assert.match(text.split('\n').find((s) => s.startsWith('【我的当前付款义务】')), payment, name)
    assert.ok(text.endsWith('【你可以做的动作】' + legal), name + ' 保留原合法列表')
    assert.ok(text.indexOf(line) > text.indexOf('【当前决策】'), name + ' 事实位于动态后段')
    assert.deepEqual(obs, before, name + ' 不改写观察或合法动作')
    if (name === '第三方支付') assert.match(text, /待响应：无/)
    if (name === '状态缺失') {
      assert.match(text, /跟注成本未知/)
      assert.ok(!text.includes('已平注') && !text.includes('本次跟注成本 0'))
    }
  }
  assert.match(LLM_SYSTEM_PROMPT, /不等于待响应名单/)
  assert.match(LLM_SYSTEM_PROMPT, /无人可追加筹码、本人不欠注且check合法时选择check/)
  assert.match(LLM_SYSTEM_PROMPT, /仍欠注则评估call\/fold/)
  assert.match(LLM_SYSTEM_PROMPT, /第三方仍能支付时可争取价值或边池/)
})

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
  assert.match(LLM_SYSTEM_PROMPT, /翻牌普通跟注按下一张机会并考虑后续收费/)
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
