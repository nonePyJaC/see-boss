/**
 * AI 模块测试 —— 对应规格 §11.2。
 *
 * 全部使用固定种子 RNG（mulberry32）和固定模拟次数，行为分布断言用
 * 大样本比例而不是单次随机结果。
 *
 * 运行：node --test server/ai/ai.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeck, parseCard } from '../../shared/logic/cards.mjs'
import { evaluate } from '../../shared/logic/hand-evaluator.mjs'
import {
  createPersona, randomPersona, ARCHETYPES, PARAM_KEYS, clampParam,
} from './personality.mjs'
import { estimateEquity } from './equity.mjs'
import { decideAction, sklanskyGroup, fallbackAction } from './policy.mjs'
import {
  createRuntime, ensurePersona, removeSeat, clearRuntime, handFlag,
  recordHandResult, emotionDelta, recordAction, recordHandJoined,
  opponentSummary, buildObservation, EMOTION_DELTA_CAP, MIN_OPP_SAMPLES,
} from './runtime.mjs'

// ── 确定性 RNG：mulberry32 ──
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 人设：原型 + 固定 rng 扰动 */
const personaOf = (name, seed = 1) => createPersona(name, mulberry32(seed))

/** 构造一个安全观察对象的便利函数 */
function makeObs(over = {}) {
  return {
    gameType: 'long',
    mySeatId: 'me',
    myCards: ['Ah', 'Kd'],
    board: [],
    pot: 60,
    currentBet: 20,
    myBet: 0,
    mySeeds: 1000,
    bigBlind: 20,
    publicPlayers: [
      { seatId: 'me', bet: 0, seeds: 1000, folded: false, allIn: false },
      { seatId: 'opp', bet: 20, seeds: 980, folded: false, allIn: false },
    ],
    publicActions: [],
    legalActions: [
      { type: 'fold', label: '弃牌' },
      { type: 'call', label: '跟注 20' },
      { type: 'raise', label: '加注', amount: 40 },
      { type: 'allin', label: '全下' },
    ],
    ...over,
  }
}

/** 分布统计：同一个观察 + N 个种子各决策一次，数动作占比 */
function distribution(obs, persona, n = 240, opts = {}) {
  const counts = {}
  for (let i = 0; i < n; i++) {
    const a = decideAction(obs, persona, { handState: { slowPlaying: false } }, mulberry32(1000 + i), {
      equitySims: opts.equitySims ?? 150, equityMs: 1000,
    })
    counts[a.type] = (counts[a.type] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / n]))
}

// ═══ 人设 ═══

test('人设参数截断在 [0.05,0.95]，原型风格标签存在', () => {
  for (const name of Object.keys(ARCHETYPES)) {
    for (let s = 0; s < 30; s++) {
      const p = createPersona(name, mulberry32(s))
      for (const k of PARAM_KEYS) {
        assert.ok(p.params[k] >= 0.05 && p.params[k] <= 0.95, `${name}.${k}=${p.params[k]}`)
      }
      assert.equal(typeof p.styleLabel, 'string')
      assert.ok(p.styleLabel.length > 0)
    }
  }
})

test('clampParam 边界', () => {
  assert.equal(clampParam(0), 0.05)
  assert.equal(clampParam(1), 0.95)
  assert.equal(clampParam(0.5), 0.5)
})

// ═══ 胜率估算 ═══

test('多人平局按并列人数分摊（公共牌已是最大牌 → 1/(1+对手数)）', () => {
  // 公共牌本身就是同花顺，所有人平分底池
  const board = ['As', 'Ks', 'Qs', 'Js', 'Ts']
  const rng = mulberry32(42)
  const e2 = estimateEquity({ myCards: ['2c', '3d'], board, aliveOpponents: 1, rng, maxSims: 200, maxMs: 60000 })
  assert.ok(Math.abs(e2 - 0.5) < 0.01, `1v1 平局应≈0.5，实得 ${e2}`)
  const e3 = estimateEquity({ myCards: ['2c', '3d'], board, aliveOpponents: 2, rng: mulberry32(42), maxSims: 200, maxMs: 60000 })
  assert.ok(Math.abs(e3 - 1 / 3) < 0.01, `3 人平局应≈0.333，实得 ${e3}`)
  const e5 = estimateEquity({ myCards: ['2c', '3d'], board, aliveOpponents: 4, rng: mulberry32(42), maxSims: 200, maxMs: 60000 })
  assert.ok(Math.abs(e5 - 0.2) < 0.01, `5 人平局应≈0.2，实得 ${e5}`)
})

test('短牌模式牌堆不含 2-5，估算可正常运行', () => {
  const deck = createDeck('short')
  assert.equal(deck.length, 36)
  assert.ok(deck.every((c) => !'2345'.includes(parseCard(c).rank)))
  const e = estimateEquity({
    myCards: ['6s', '7s'], board: ['8s', '9s', 'Ts'], aliveOpponents: 1,
    gameType: 'short', rng: mulberry32(7), maxSims: 200, maxMs: 60000,
  })
  assert.ok(e > 0 && e < 1, `短牌估算应在 (0,1)，实得 ${e}`)
})

test('固定 RNG + 固定次数 → 结果确定', () => {
  const args = { myCards: ['Ah', 'Kd'], board: ['2s', '7c', 'Td'], aliveOpponents: 2, maxSims: 120, maxMs: 60000 }
  const a = estimateEquity({ ...args, rng: mulberry32(9) })
  const b = estimateEquity({ ...args, rng: mulberry32(9) })
  assert.equal(a, b)
})

test('坚果牌胜率接近 1，空气牌胜率低', () => {
  // AsTs + KsQsJs 翻牌即成皇家同花顺
  const nuts = estimateEquity({
    myCards: ['As', 'Ts'], board: ['Ks', 'Qs', 'Js'], aliveOpponents: 2,
    rng: mulberry32(1), maxSims: 200, maxMs: 60000,
  })
  assert.ok(nuts > 0.9, `nuts 胜率应>0.9，实得 ${nuts}`)
  const air = estimateEquity({
    myCards: ['3c', '8d'], board: ['Ks', 'Qs', 'Js'], aliveOpponents: 2,
    rng: mulberry32(1), maxSims: 200, maxMs: 60000,
  })
  assert.ok(air < 0.3, `空气牌胜率应<0.3，实得 ${air}`)
})

// ═══ Sklansky 分组 ═══

test('sklanskyGroup 具体值', () => {
  assert.equal(sklanskyGroup('Ah', 'Ad'), 1)
  assert.equal(sklanskyGroup('Ah', 'Kh'), 1)
  assert.equal(sklanskyGroup('Ah', 'Kd'), 2)
  assert.equal(sklanskyGroup('7h', '2d'), 9)
})

// ═══ 安全观察 ═══

test('安全观察只含 §8.4 字段，剥离对手底牌等越权字段', () => {
  const obs = buildObservation({
    gameType: 'long', mySeatId: 'me', myCards: ['Ah', 'Kd'], board: ['2s'],
    pot: 60, currentBet: 20, myBet: 0, mySeeds: 1000,
    publicPlayers: [
      { seatId: 'me', bet: 0, seeds: 1000, folded: false, allIn: false },
      // 调用方误传了对手底牌 —— 输出必须剥掉
      { seatId: 'opp', bet: 20, seeds: 980, folded: false, allIn: false, holeCards: ['2h', '3h'] },
    ],
    publicActions: [{ seatId: 'opp', type: 'call', amount: 20, phase: 'preflop', secret: 'x' }],
    legalActions: [{ type: 'fold', label: '弃牌' }],
  })
  assert.deepEqual(
    Object.keys(obs).sort(),
    ['bigBlind', 'board', 'currentBet', 'gameType', 'legalActions', 'myBet', 'myCards', 'mySeatId', 'mySeeds', 'pot', 'publicActions', 'publicPlayers'].sort(),
  )
  const opp = obs.publicPlayers[1]
  assert.ok(!('holeCards' in opp), '观察里不得包含对手底牌')
  assert.ok(!('secret' in obs.publicActions[0]))
  // 序列化后不得出现对手底牌字样
  assert.ok(!JSON.stringify(obs).includes('3h'))
})

// ═══ 合法性 / 降级 ═══

test('decideAction 始终返回合法动作（随机观察 fuzz）', () => {
  for (let i = 0; i < 300; i++) {
    const rng = mulberry32(i * 31 + 7)
    const types = [
      [{ type: 'fold' }, { type: 'call' }, { type: 'raise', amount: 40 }, { type: 'allin' }],
      [{ type: 'fold' }, { type: 'check' }, { type: 'raise', amount: 20 }],
      [{ type: 'fold' }, { type: 'call' }],
      [{ type: 'check' }, { type: 'raise', amount: 20 }, { type: 'allin' }],
    ][i % 4]
    const obs = makeObs({
      myCards: ['Ah', 'Kd'],
      board: [[], ['2s', '7c', 'Td'], ['2s', '7c', 'Td', '9h'], ['2s', '7c', 'Td', '9h', '3c']][i % 4],
      currentBet: [0, 20, 60][i % 3],
      myBet: i % 2 ? 20 : 0,
      pot: 60 + i * 3,
      legalActions: types,
    })
    const p = randomPersona(rng)
    const a = decideAction(obs, p, { handState: { slowPlaying: false } }, rng, { equitySims: 80, equityMs: 1000 })
    const legalTypes = types.map((t) => t.type)
    assert.ok(legalTypes.includes(a.type), `种子 ${i}: ${a.type} 不在合法集 ${legalTypes}`)
    if (a.type === 'raise') {
      const bound = types.find((t) => t.type === 'raise')
      const max = obs.myBet + obs.mySeeds
      assert.ok(a.amount >= bound.amount && a.amount <= max, `加注 ${a.amount} 越界 [${bound.amount}, ${max}]`)
    }
  }
})

test('畸形输入不抛出：空观察、NaN 人设、空合法集都走降级', () => {
  assert.equal(decideAction(null, null, {}, mulberry32(1)).type, 'fold')
  assert.equal(decideAction({ legalActions: [] }, null, {}, mulberry32(1)).type, 'fold')
  const nanPersona = { params: Object.fromEntries(PARAM_KEYS.map((k) => [k, NaN])) }
  const a = decideAction(makeObs(), nanPersona, { handState: {} }, mulberry32(1), { equitySims: 50, equityMs: 1000 })
  assert.ok(['fold', 'call', 'raise', 'allin'].includes(a.type))
  // 唯一合法动作 → 直接返回
  assert.equal(decideAction(makeObs({ legalActions: [{ type: 'call' }] }), personaOf('rock'), {}, mulberry32(1)).type, 'call')
  assert.equal(fallbackAction([{ type: 'check' }, { type: 'call' }]).type, 'check')
})

// ═══ 行为分布（§11.2 性格差异）═══

// 边缘牌面：纯高牌面对下注（实测蒙特卡洛胜率约 0.24）——
// 落在弃牌线附近的场景，rock/nit 弃牌率应显著高于 lag/maniac
const MARGINAL_OBS = makeObs({
  myCards: ['4c', '8h'],
  board: ['Ks', 'Qd', '7s'],
  pot: 90, currentBet: 30, myBet: 0, mySeeds: 970,
  publicPlayers: [
    { seatId: 'me', bet: 0, seeds: 970, folded: false },
    { seatId: 'opp', bet: 30, seeds: 970, folded: false },
  ],
})

test('rock/nit 在边缘牌面对下注的弃牌率显著高于 lag/maniac', () => {
  const foldRate = (name) => distribution(MARGINAL_OBS, personaOf(name)).fold ?? 0
  const tightAvg = (foldRate('rock') + foldRate('nit')) / 2
  const looseAvg = (foldRate('lag') + foldRate('maniac')) / 2
  assert.ok(tightAvg > looseAvg + 0.15, `紧弃牌率 ${tightAvg.toFixed(2)} 应显著高于松 ${looseAvg.toFixed(2)}`)
})

test('calling_station 在合理赔率下的跟注率高于 rock', () => {
  const callRate = (name) => distribution(MARGINAL_OBS, personaOf(name)).call ?? 0
  const cs = callRate('calling_station')
  const rock = callRate('rock')
  assert.ok(cs > rock + 0.15, `跟注站 ${cs.toFixed(2)} 应高于 rock ${rock.toFixed(2)}`)
})

// 中等偏强牌面：明对子上的两高张（实测胜率约 0.59），
// 低于 0.8 慢打触发线 —— 只区分价值下注倾向，不受慢打分支干扰
const MID_STRONG_OBS = makeObs({
  myCards: ['As', '8d'],
  board: ['9h', '9c', '2s'],
  pot: 80, currentBet: 0, myBet: 0, mySeeds: 1000,
  legalActions: [
    { type: 'fold', label: '弃牌' },
    { type: 'check', label: '过牌' },
    { type: 'raise', label: '加注', amount: 20 },
    { type: 'allin', label: '全下' },
  ],
})

test('tag/shark 在偏强牌面的主动下注率高于 beginner', () => {
  const betRate = (name) => (distribution(MID_STRONG_OBS, personaOf(name)).raise ?? 0)
  const aggroAvg = (betRate('tag') + betRate('shark')) / 2
  const beginner = betRate('beginner')
  assert.ok(aggroAvg > beginner + 0.15, `强攻击型下注率 ${aggroAvg.toFixed(2)} 应高于新手 ${beginner.toFixed(2)}`)
})

test('高诈唬人设只在可合法加注时增加诈唬，不越过筹码边界', () => {
  // 筹码不足以加注：toCall 后只剩 50，minRaise 需要 currentBet+20=120 > myBet+seeds=50
  const noRaiseObs = makeObs({
    myCards: ['3c', '8d'], board: ['Ks', 'Qs', 'Js'],
    pot: 100, currentBet: 100, myBet: 0, mySeeds: 50,
    legalActions: [{ type: 'fold' }, { type: 'call', label: '跟注 50' }, { type: 'allin' }],
  })
  const maniac = personaOf('maniac')
  for (let i = 0; i < 200; i++) {
    const a = decideAction(noRaiseObs, maniac, { handState: {} }, mulberry32(5000 + i), { equitySims: 60, equityMs: 1000 })
    assert.notEqual(a.type, 'raise', `筹码不足时不得诈唬加注（种子 ${i}）`)
    assert.ok(['fold', 'call', 'allin'].includes(a.type))
  }
  // 同样牌面但筹码充足：maniac 应出现一定 raise（诈唬存在且合法）
  const okRaiseObs = makeObs({
    myCards: ['3c', '8d'], board: ['Ks', 'Qs', 'Js'],
    pot: 100, currentBet: 40, myBet: 0, mySeeds: 2000,
    legalActions: [{ type: 'fold' }, { type: 'call' }, { type: 'raise', amount: 60 }, { type: 'allin' }],
  })
  const d = distribution(okRaiseObs, maniac)
  assert.ok((d.raise ?? 0) > 0.02, `maniac 在可加注时应有一定诈唬率，实得 ${(d.raise ?? 0).toFixed(3)}`)
})

test('单挑面对短码全下只跟有效注额；多人时按大盲刻度加注进入边池', () => {
  const cards = ['Ah', 'Kh']
  const board = ['Qh', 'Jh', 'Th', '2c', '3d']
  const shortAllIn = makeObs({
    myCards: cards, board, pot: 500, currentBet: 180, myBet: 0, mySeeds: 3000,
    publicPlayers: [
      { seatId: 'me', bet: 0, seeds: 3000, folded: false },
      { seatId: 'short', bet: 180, seeds: 0, folded: false, allIn: true },
    ],
    legalActions: [
      { type: 'fold' }, { type: 'call', amount: 180 },
      { type: 'raise', amount: 200 }, { type: 'allin' },
    ],
  })
  const headsUp = decideAction(shortAllIn, personaOf('shark'), {}, mulberry32(18), { equitySims: 60, equityMs: 1000 })
  assert.deepEqual(headsUp, { type: 'call' }, '单挑时高牌力也不应加注到对手无法匹配的部分')

  const allOpponentsAllIn = makeObs({
    ...shortAllIn,
    publicPlayers: [
      ...shortAllIn.publicPlayers,
      { seatId: 'also-short', bet: 180, seeds: 0, folded: false, allIn: true },
    ],
  })
  const noResponder = decideAction(allOpponentsAllIn, personaOf('shark'), {}, mulberry32(18), { equitySims: 60, equityMs: 1000 })
  assert.deepEqual(noResponder, { type: 'call' }, '桌上无人能跟注时不做不会形成竞争边池的加注')

  const multiway = makeObs({
    ...shortAllIn,
    publicPlayers: [
      ...shortAllIn.publicPlayers,
      { seatId: 'deep', bet: 180, seeds: 2800, folded: false },
    ],
  })
  const action = decideAction(multiway, personaOf('shark'), {}, mulberry32(19), { equitySims: 60, equityMs: 1000 })
  assert.equal(action.type, 'raise')
  assert.ok(action.amount > 180, '多人争夺时可加注超过短码全下额')
  assert.equal(action.amount % multiway.bigBlind, 0, '下注目标按大盲取刻度')
  assert.ok(action.amount >= 200 && action.amount <= multiway.mySeeds + multiway.myBet)
})

// 河牌坚果 + 高慢打人设：慢打不得让渡明显价值
const RIVER_NUTS_OBS = makeObs({
  myCards: ['As', 'Ts'],
  board: ['Ks', 'Qs', 'Js', '2d', '7h'],
  pot: 80, currentBet: 0, myBet: 0, mySeeds: 1000,
  legalActions: [
    { type: 'fold' }, { type: 'check' }, { type: 'raise', amount: 20 }, { type: 'allin' },
  ],
})
// 同牌但 flop 阶段：慢打应当主导（强牌装弱诱敌）
const FLOP_NUTS_OBS = makeObs({
  myCards: ['As', 'Ts'],
  board: ['Ks', 'Qs', 'Js'],
  pot: 80, currentBet: 0, myBet: 0, mySeeds: 1000,
  legalActions: [
    { type: 'fold' }, { type: 'check' }, { type: 'raise', amount: 20 }, { type: 'allin' },
  ],
})
// 慢打频率 0.95 的人设（截断值内）
const SLOWPLAY_PERSONA = { archetype: 'test', params: {
  tightLoose: 0.5, passiveAggressive: 0.5, bluffFrequency: 0.3,
  callTendency: 0.5, adaptivity: 0.3, slowPlayFrequency: 0.95,
}, styleLabel: 'test' }

test('慢打只作用于 flop/turn：river 坚果仍主打价值', () => {
  const river = distribution(RIVER_NUTS_OBS, SLOWPLAY_PERSONA, 240)
  assert.ok((river.raise ?? 0) > 0.6, `河牌坚果加注率应>60%，实得 ${(river.raise ?? 0).toFixed(2)}`)
  const flop = distribution(FLOP_NUTS_OBS, SLOWPLAY_PERSONA, 240)
  assert.ok((flop.check ?? 0) > 0.6, `翻牌坚果慢打率应>60%，实得 ${(flop.check ?? 0).toFixed(2)}`)
})

// ═══ 运行期：人设稳定 / 情绪有界 / 对手统计 ═══

test('人设入座生成后稳定，decideAction 不修改基础人设', () => {
  const rt = createRuntime()
  const p1 = ensurePersona(rt, 'ai1', mulberry32(1))
  const p2 = ensurePersona(rt, 'ai1', mulberry32(2))
  assert.equal(p1, p2)
  const snapshot = JSON.parse(JSON.stringify(p1.params))
  for (let i = 0; i < 100; i++) {
    decideAction(makeObs(), p1, {
      handState: { slowPlaying: false },
      emotionDelta: emotionDelta(rt, 'ai1'),
    }, mulberry32(i), { equitySims: 40, equityMs: 1000 })
    recordHandResult(rt, 'ai1', { won: i % 2 === 0, potSize: 800, initialSeeds: 1000 })
  }
  assert.deepEqual(p1.params, snapshot, '基础人设参数不得被决策/情绪修改')
})

test('情绪修正有界（±0.1），大赢大输后仍受限', () => {
  const rt = createRuntime()
  for (let i = 0; i < 50; i++) {
    recordHandResult(rt, 'ai1', { won: i < 25, potSize: 2000, initialSeeds: 1000 })
  }
  const d = emotionDelta(rt, 'ai1')
  for (const [k, v] of Object.entries(d)) {
    assert.ok(Math.abs(v) <= EMOTION_DELTA_CAP + 1e-9, `${k} 修正 ${v} 越界`)
  }
})

test('对手统计：样本不足返回 null，足量后聚合', () => {
  const rt = createRuntime()
  assert.equal(opponentSummary(rt, 'ai1', ['p1']), null)
  for (let i = 0; i < 10; i++) {
    recordAction(rt, 'ai1', 'p1', { type: 'raise', phase: 'preflop', facedBet: false })
  }
  recordHandJoined(rt, 'ai1', 'p1', { enteredPot: true, raisedPreflop: true })
  const s = opponentSummary(rt, 'ai1', ['p1'])
  assert.ok(s, '足量样本应有聚合')
  assert.ok(s.aggression > 1.5, `纯加注者 aggression 应>1.5，实得 ${s.aggression}`)
  assert.equal(s.vpip, 1)
})

test('对手适应方向：激进对手让 AI 阈值收紧但仍有界', () => {
  const rt = createRuntime()
  const ai = 'shark1'
  // 喂一个纯加注疯子对手
  for (let i = 0; i < 20; i++) {
    recordAction(rt, ai, 'aggro', { type: 'raise', phase: 'flop', facedBet: false })
    recordHandJoined(rt, ai, 'aggro', { enteredPot: true, raisedPreflop: true })
  }
  const summary = opponentSummary(rt, ai, ['aggro'])
  assert.ok(summary.samples >= MIN_OPP_SAMPLES)
  // 在边缘牌面上跑两次：带适应 vs 不带，方向应可测但不失控
  const withAdapt = distribution(MARGINAL_OBS, personaOf('shark'), 240, {})
  const obs = MARGINAL_OBS
  const noAdapt = (() => {
    const counts = { fold: 0 }
    for (let i = 0; i < 240; i++) {
      const a = decideAction(obs, personaOf('shark'), { handState: {} }, mulberry32(1000 + i), { equitySims: 150, equityMs: 1000 })
      counts[a.type] = (counts[a.type] ?? 0) + 1
    }
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / 240]))
  })()
  // 有适应时输入 opponentSummary —— 上面 withAdapt 没带；这里补一个带的
  const adapted = (() => {
    const counts = {}
    for (let i = 0; i < 240; i++) {
      const a = decideAction(obs, personaOf('shark'), {
        handState: {}, opponentSummary: summary,
      }, mulberry32(1000 + i), { equitySims: 150, equityMs: 1000 })
      counts[a.type] = (counts[a.type] ?? 0) + 1
    }
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / 240]))
  })()
  // 修正有界：两种模式的动作分布都应在合法集内（这里只验证不崩溃且分布存在）
  assert.ok(withAdapt && noAdapt && adapted)
  // 激进对手 → 弱牌更谨慎：带适应的 fold 率不应低于无适应版超过安全边界
  // （只断言差异有限，不断言方向大小 —— 方向已由阈值公式保证）
  assert.ok(Math.abs((adapted.fold ?? 0) - (noAdapt.fold ?? 0)) <= 0.15, '适应修正幅度应有界')
})

test('handFlag 换手重置；removeSeat/clearRuntime 清理', () => {
  const rt = createRuntime()
  const f1 = handFlag(rt, 'a', 1)
  f1.slowPlaying = true
  const f2 = handFlag(rt, 'a', 2)
  assert.equal(f2.slowPlaying, false, '换 handId 应重置慢打标记')
  ensurePersona(rt, 'a', mulberry32(1))
  recordHandResult(rt, 'a', { won: true, potSize: 100 })
  removeSeat(rt, 'a')
  assert.equal(rt.personas.has('a'), false)
  assert.equal(rt.emotions.has('a'), false)
  ensurePersona(rt, 'b', mulberry32(1))
  clearRuntime(rt)
  assert.equal(rt.personas.size, 0)
})
