import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPrompt, parseDecision, llmEnabled, availableModels, getModel, modelReady } from './llm.mjs'

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
    { seatId: 'p-2', nickname: '阿乙', type: 'raise', amount: 100, betTotal: 100, phase: 'preflop' },
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
  assert.match(p, /阿乙（大盲）：后手 1900/)
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

// ── 位置（5 人局实测口径）────────────────────────────

/** 造一个 5 人局的观察对象，我坐在第 myIdx 个座位 */
function fivePlayer(myIdx = 4, sbIdx = 0) {
  const names = ['阿甲', '阿乙', '阿丙', '阿丁', '阿戊']
  const ids = names.map((_, i) => 'seat-' + i)
  return {
    ...obs,
    sbIndex: sbIdx,
    mySeatId: ids[myIdx],
    myNickname: names[myIdx],
    publicPlayers: names.map((n, i) => ({
      seatId: ids[i], nickname: n, bet: 0, seeds: 3000,
      folded: false, allIn: false, isAI: i === myIdx,
    })),
    publicActions: [],
  }
}

test('位置：按钮位', () => {
  // sb=0 → bb=1 → 按钮 = 4（我）
  const p = buildPrompt(fivePlayer(4, 0), persona, [])
  assert.match(p, /【我的位置】按钮位（最后发言，最占优）/)
})

test('位置：小盲位', () => {
  const p = buildPrompt(fivePlayer(0, 0), persona, [])
  assert.match(p, /【我的位置】小盲位/)
})

test('位置：大盲位', () => {
  const p = buildPrompt(fivePlayer(1, 0), persona, [])
  assert.match(p, /【我的位置】大盲位/)
})

test('位置：枪口位（翻前最先发言）', () => {
  // sb=0 → bb=1 → 枪口 = 2
  const p = buildPrompt(fivePlayer(2, 0), persona, [])
  assert.match(p, /枪口位（翻前最先发言）/)
})

test('位置：中间位带距按钮位数', () => {
  // sb=0 → bb=1 → 按钮=4，我坐 3 → 距按钮 1 位（后位）
  const p = buildPrompt(fivePlayer(3, 0), persona, [])
  assert.match(p, /中间位/)
  assert.match(p, /距按钮 1 位（后位）/)
})

test('其他人按座位顺序列，并标出小盲/大盲', () => {
  const p = buildPrompt(fivePlayer(4, 0), persona, [])
  assert.match(p, /1\. 阿甲（小盲）/)
  assert.match(p, /2\. 阿乙（大盲）/)
  assert.match(p, /3\. 阿丙：/)
  const i1 = p.indexOf('阿甲（小盲）')
  const i2 = p.indexOf('阿乙（大盲）')
  const i3 = p.indexOf('3. 阿丙')
  assert.ok(i1 < i2 && i2 < i3, '应按座位顺序排列')
})

test('行动记录按发言顺序编号', () => {
  const o = fivePlayer(4, 0)
  o.publicActions = [
    { seatId: 'seat-0', nickname: '阿甲', type: 'check', amount: 0, phase: 'flop' },
    { seatId: 'seat-1', nickname: '阿乙', type: 'check', amount: 0, phase: 'flop' },
    { seatId: 'seat-2', nickname: '阿丙', type: 'check', amount: 0, phase: 'flop' },
    { seatId: 'seat-3', nickname: '阿丁', type: 'fold', amount: 0, phase: 'flop' },
  ]
  const p = buildPrompt(o, persona, [])
  assert.match(p, /【本手已发生的行动】（完整本手，按发言顺序，含盲注/)
  assert.match(p, /1\. 阿甲 过牌/)
  assert.match(p, /2\. 阿乙 过牌/)
  assert.match(p, /3\. 阿丙 过牌/)
  assert.match(p, /4\. 阿丁 弃牌/)
})

test('牌面：T 渲染成 10', () => {
  const o = { ...obs, myCards: ['sJ', 'hT'] }
  const p = buildPrompt(o, persona, [])
  assert.match(p, /♠J ♥10/)
})

test('牌面：数字写法也认', () => {
  const o = { ...obs, myCards: ['s14', 'h10'] }
  const p = buildPrompt(o, persona, [])
  assert.match(p, /♠A ♥10/)
})

test('单挑时位置说 heads-up', () => {
  const o = {
    ...obs,
    sbIndex: 0,
    mySeatId: 'seat-1',
    publicPlayers: [
      { seatId: 'seat-0', nickname: '阿甲', bet: 0, seeds: 3000, folded: false, allIn: false },
      { seatId: 'seat-1', nickname: '我', bet: 0, seeds: 3000, folded: false, allIn: false },
    ],
  }
  const p = buildPrompt(o, persona, [])
  assert.match(p, /单挑（heads-up）/)
})

// ── 注额结构（实测踩过：阿丙在大盲之后直接 check）────────

test('盲注进行动流水，且区分大小盲', () => {
  const o = fivePlayer(4, 0)
  // obs 的 smallBlind 是 10，所以 10=小盲、20=大盲
  o.publicActions = [
    { seatId: 'seat-0', nickname: '阿甲', type: 'blind', amount: 10, phase: 'preflop' },
    { seatId: 'seat-1', nickname: '阿乙', type: 'blind', amount: 20, phase: 'preflop' },
  ]
  const p = buildPrompt(o, persona, [])
  assert.match(p, /1\. 阿甲 下盲注（小盲） 10/)
  assert.match(p, /2\. 阿乙 下盲注（大盲） 20/)
})

test('当前注额结构单独一行，说明还差多少平注', () => {
  const o = fivePlayer(4, 0)
  o.currentBet = 120
  o.myBet = 0
  const p = buildPrompt(o, persona, [])
  assert.match(p, /【当前注额】本轮最高下注 120，我已下 0，还需补 120 才能平注/)
})

test('已平注时不说「还需补」', () => {
  const o = fivePlayer(4, 0)
  o.currentBet = 40
  o.myBet = 40
  const p = buildPrompt(o, persona, [])
  assert.match(p, /本轮最高下注 40，我已下 40，已平注/)
  assert.ok(!/还需补/.test(p))
})

test('加注显示成「加注到 N」', () => {
  const o = fivePlayer(4, 0)
  o.publicActions = [
    { seatId: 'seat-2', nickname: '阿丙', type: 'raise', amount: 120, betTotal: 180, phase: 'preflop' },
  ]
  const p = buildPrompt(o, persona, [])
  assert.match(p, /阿丙 加注到 180（本次投入 120）.*翻牌前/)
})

test('动作名翻成人话', () => {
  const o = fivePlayer(4, 0)
  o.publicActions = [
    { seatId: 'seat-2', nickname: '阿丙', type: 'check', amount: 0, phase: 'flop' },
    { seatId: 'seat-3', nickname: '阿丁', type: 'fold', amount: 0, phase: 'flop' },
    { seatId: 'seat-1', nickname: '阿乙', type: 'call', amount: 40, phase: 'flop' },
    { seatId: 'seat-0', nickname: '阿甲', type: 'allin', amount: 3000, phase: 'flop' },
  ]
  const p = buildPrompt(o, persona, [])
  assert.match(p, /阿丙 过牌/)
  assert.match(p, /阿丁 弃牌/)
  assert.match(p, /阿乙 跟注 40/)
  assert.match(p, /阿甲 全下 3000/)
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
  assert.equal(llmEnabled(), Boolean(process.env.DEEPSEEK_API_KEY || process.env.STEPFUN_API_KEY))
})

test('availableModels 只列配了 key 的', () => {
  const list = availableModels()
  assert.ok(Array.isArray(list))
  // 每项都该有 id / label / model
  for (const m of list) {
    assert.ok(m.id && m.label && m.model, '模型项字段齐全')
  }
  // 数量不超过注册表里的两个
  assert.ok(list.length <= 2)
})

test('getModel 不认识的 id 返回 null', () => {
  assert.equal(getModel('不存在的模型'), null)
  assert.equal(getModel(undefined), null)
})

test('modelReady 与 key 一致', () => {
  for (const id of ['deepseek', 'stepfun']) {
    const expect = Boolean(process.env[id.toUpperCase() + '_API_KEY'])
    assert.equal(modelReady(id), expect, id + ' 的可用性应与 key 一致')
  }
})
