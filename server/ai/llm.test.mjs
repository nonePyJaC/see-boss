import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPrompt, parseDecision, llmEnabled } from './llm.mjs'

// ── 提示词组装 ──────────────────────────────────────────

const obs = {
  gameType: 'long',
  mySeatId: 'ai-1',
  myNickname: '沉稳',
  myCards: ['sA', 'hK'],
  board: ['d7', 'c2', 's9'],
  phase: 'flop',
  pot: 300,
  currentBet: 100,
  myBet: 0,
  mySeeds: 2800,
  bigBlind: 20,
  smallBlind: 10,
  publicPlayers: [
    { seatId: 'ai-1', nickname: '沉稳', bet: 0, seeds: 2800, folded: false, allIn: false, isAI: true },
    { seatId: 'p-2', nickname: '阿乙', bet: 100, seeds: 1900, folded: false, allIn: false, isAI: false },
    { seatId: 'p-3', nickname: '阿丙', bet: 0, seeds: 0, folded: false, allIn: true, isAI: false },
  ],
  publicActions: [
    { seatId: 'p-2', nickname: '阿乙', type: 'raise', amount: 100, phase: 'preflop' },
  ],
  legalActions: [
    { type: 'fold', label: '弃牌' },
    { type: 'call', label: '跟', amount: 100 },
    { type: 'raise', label: '加注', min: 180, max: 2800 },
  ],
}

const persona = {
  archetype: 'tag',
  styleLabel: '专注',
  params: { tightLoose: 0.3, passiveAggressive: 0.6, bluffFrequency: 0.2, callTendency: 0.4, adaptivity: 0.5, slowPlayFrequency: 0.3 },
}

test('提示词包含全部要求的信息', () => {
  const p = buildPrompt(obs, persona, [])
  // 底牌
  assert.match(p, /♠A/)
  assert.match(p, /♥K/)
  // 阶段
  assert.match(p, /翻牌圈/)
  // 公共牌
  assert.match(p, /♦7/)
  // 池子 / 盲注 / 后手
  assert.match(p, /公共池】300/)
  assert.match(p, /小盲 10/)
  assert.match(p, /大盲 20/)
  assert.match(p, /我的后手】2800/)
  // 别人后手
  assert.match(p, /阿乙：后手 1900/)
  assert.match(p, /已全下/)
  // 性格
  assert.match(p, /我的性格】/)
  // 可选动作
  assert.match(p, /raise（加注到 180 ~ 2800）/)
  assert.match(p, /call（跟 100）/)
})

test('提示词带上上一手结果', () => {
  const recent = [{
    handId: 7,
    communityCards: ['sK', 'h5', 'dQ'],
    result: { winnings: [{ uid: 'p-2', nickname: '阿乙', amount: 450, handName: '两对' }] },
  }]
  const p = buildPrompt(obs, persona, recent)
  assert.match(p, /上一手赢家：阿乙（两对，\+450）/)
  assert.match(p, /公共牌 ♠K/)
})

test('自己赢的时候说「我」', () => {
  const recent = [{
    communityCards: [],
    result: { winnings: [{ uid: 'ai-1', nickname: '沉稳', amount: 200, handName: '一对' }] },
  }]
  const p = buildPrompt(obs, persona, recent)
  assert.match(p, /上一手赢家：我（一对，\+200）/)
})

test('没有历史时说第一手', () => {
  const p = buildPrompt(obs, persona, [])
  assert.match(p, /这是本桌第一手/)
})

test('翻牌前不显示公共牌', () => {
  const pre = { ...obs, phase: 'preflop', board: [] }
  const p = buildPrompt(pre, persona, [])
  assert.match(p, /翻牌前（还没有公共牌）/)
  assert.match(p, /【公共牌】（无）/)
})

test('性格参数翻成人话', () => {
  const tight = buildPrompt(obs, { params: { tightLoose: 0.1, passiveAggressive: 0.1 } }, [])
  assert.match(tight, /起手紧/)
  assert.match(tight, /打法被动/)

  const loose = buildPrompt(obs, { params: { tightLoose: 0.9, passiveAggressive: 0.9, bluffFrequency: 0.8 } }, [])
  assert.match(loose, /起手松/)
  assert.match(loose, /打法激进/)
  assert.match(loose, /爱诈唬/)
})

// ── 解析 ────────────────────────────────────────────────

test('解析：干净 JSON', () => {
  assert.deepEqual(parseDecision('{"action":"raise","amount":350,"reason":"3bet"}'), {
    type: 'raise', reason: '3bet', amount: 350,
  })
})

test('解析：裹了 markdown 代码块', () => {
  assert.equal(parseDecision('```json\n{"action":"call","reason":"赔率够"}\n```').type, 'call')
})

test('解析：前面有废话', () => {
  const r = parseDecision('我觉得这里该弃牌。{"action":"fold","reason":"没中"}')
  assert.equal(r.type, 'fold')
})

test('解析：非法动作返回 null', () => {
  assert.equal(parseDecision('{"action":"bluff","amount":100}'), null)
  assert.equal(parseDecision('完全不是 JSON'), null)
  assert.equal(parseDecision(''), null)
  assert.equal(parseDecision(null), null)
})

test('解析：raise 没给金额也接受（由引擎夹紧）', () => {
  const r = parseDecision('{"action":"raise"}')
  assert.equal(r.type, 'raise')
  assert.equal(r.amount, undefined)
})

test('解析：金额取整', () => {
  const r = parseDecision('{"action":"raise","amount":350.7}')
  assert.equal(r.amount, 350)
})

test('解析：负数金额忽略', () => {
  const r = parseDecision('{"action":"raise","amount":-50}')
  assert.equal(r.amount, undefined)
})

test('没配 key 时 llmEnabled 为假', () => {
  // 测试环境不设 LLM_API_KEY / SK_KEY，所以应为 false
  // （若本地恰好设了，这条会假失败 —— 那时删掉即可）
  assert.equal(llmEnabled(), Boolean(process.env.LLM_API_KEY || process.env.SK_KEY))
})
