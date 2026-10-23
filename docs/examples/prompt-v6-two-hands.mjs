// 两手固定匿名构造；动作由人工指定，只用现有引擎校验合法性，不抽样、不调用模型。
import assert from 'node:assert/strict'
import { createDeck } from '../../shared/logic/cards.mjs'
import { initHand, dealHoleCards, applyAction, availableActions, showdown } from '../../shared/logic/betting.mjs'
import { buildObservation } from '../../server/ai/runtime.mjs'
import { buildMessages, parseDecision, LLM_PROMPT_VERSION, LLM_SYSTEM_PROMPT } from '../../server/ai/llm.mjs'

const ids = ['human', 'ai-a', 'ai-b']
const names = { human: '玩家', 'ai-a': 'AI甲', 'ai-b': 'AI乙' }
const personas = {
  'ai-a': { params: { tightLoose: 0.2, passiveAggressive: 0.2, callTendency: 0.3 } },
  'ai-b': { params: { tightLoose: 0.7, passiveAggressive: 0.8, bluffFrequency: 0.6 } },
}

function observation(state, uid, holes) {
  const me = state.seats.find(s => s.uid === uid)
  return buildObservation({ gameType: state.gameType, mySeatId: uid, myNickname: names[uid], myCards: holes[uid],
    board: state.communityCards, phase: state.phase, pot: state.pot, currentBet: state.currentBet,
    myBet: me.bet, mySeeds: me.seeds, smallBlind: state.smallBlind, bigBlind: state.bigBlind,
    sbIndex: state.seats.findIndex(s => s.uid === state.sbUid), dealerSeatId: state.dealerUid,
    smallBlindSeatId: state.sbUid, bigBlindSeatId: state.bbUid, actedSeatIds: state.actedUids,
    publicPlayers: state.seats.map(s => ({ seatId: s.uid, nickname: s.nickname, bet: s.bet, totalBet: s.totalBet,
      seeds: s.seeds, folded: s.folded, allIn: s.allIn, isAI: s.uid !== 'human' })),
    publicActions: state.actionLog,
    legalActions: availableActions(state, uid).map(a => a.type === 'raise' ? { ...a, min: a.amount, max: me.bet + me.seeds } : a),
  })
}

function play(number, config, moves, seeds, recent, previousDealer = null) {
  const prefix = [config.holes.human[0], config.holes['ai-a'][0], config.holes['ai-b'][0],
    config.holes.human[1], config.holes['ai-a'][1], config.holes['ai-b'][1], ...config.board]
  assert.equal(new Set(prefix).size, prefix.length)
  const deck = [...prefix, ...createDeck('long').filter(c => !prefix.includes(c))]
  let state = initHand({ players: ids.map(uid => ({ uid, nickname: names[uid], seeds: seeds[uid] })),
    smallBlind: 50, bigBlind: 100, gameType: 'long', roundNo: number, dealerUid: previousDealer, deck })
  const holes = dealHoleCards(state)
  assert.deepEqual(holes, config.holes)
  const initialSeeds = { ...seeds }, steps = [], requests = []
  for (const [uid, type, amount, reason] of moves) {
    assert.equal(state.turnUid, uid, `第${number}手${state.phase}行动顺序`)
    const row = { number, sequence: steps.length + 1, actor: names[uid], uid, phase: state.phase,
      board: [...state.communityCards], potBefore: state.pot, action: type, amount: amount ?? null }
    if (uid !== 'human') {
      const obs = observation(state, uid, holes)
      const output = { action: type, ...(type === 'raise' ? { amount } : {}), reason }
      assert.ok(parseDecision(JSON.stringify(output)))
      assert.ok([...reason].length <= 80)
      assert.ok(obs.legalActions.some(a => a.type === type))
      requests.push({ ...row, obs, persona: personas[uid], recentHands: structuredClone(recent),
        messages: buildMessages(obs, personas[uid], recent), illustrativeOutput: output })
    }
    const next = applyAction(state, { uid, type, ...(amount != null ? { amount } : {}) })
    assert.ok(!next.error, `第${number}手${uid} ${type}: ${next.error}`)
    state = next.state
    row.potAfter = state.pot
    assert.equal(state.pot + state.seats.reduce((n, s) => n + s.seeds, 0), Object.values(initialSeeds).reduce((a, b) => a + b, 0))
    steps.push(row)
  }
  assert.ok(state.finished)
  assert.deepEqual(state.communityCards, config.board)
  const result = showdown(state, holes)
  // 与线上公共结算相同：弃牌者没有牌型或底牌；输入摘要只读取公开牌型名和金额。
  const safe = { ...result, hands: result.hands.map(h => ({ ...h,
    hole: h.folded ? [] : h.hole, cards: h.folded ? [] : h.cards, hand: h.folded ? null : h.hand })) }
  const last = { handId: number, communityCards: [...state.communityCards], actionLog: state.actionLog, result: safe }
  const nextSeeds = Object.fromEntries(state.seats.map(s => [s.uid, s.seeds + (result.winnings.find(w => w.uid === s.uid)?.amount ?? 0)]))
  assert.equal(Object.values(nextSeeds).reduce((a, b) => a + b, 0), Object.values(initialSeeds).reduce((a, b) => a + b, 0))
  const sample = requests.at(-1)
  const resultSummary = buildMessages(sample.obs, sample.persona, [last])[1].content.split('\n').find(s => s.startsWith('【上一手】'))
  return { number, title: config.title, holes, board: config.board, initialSeeds, nextSeeds,
    dealer: state.dealerUid, result: safe, resultSummary, steps, requests, recent: last }
}

export function createTwoHandPreview() {
  const first = play(1, { title: '稳健AI用顶对、两对逐街取值；主动AI在听牌落空后退出',
    holes: { human: ['Kc', '9d'], 'ai-a': ['Kd', 'Qd'], 'ai-b': ['Qh', 'Js'] },
    board: ['Ks', 'Th', '2d', 'Qc', '7h'] }, [
    ['human', 'raise', 300],
    ['ai-a', 'call', null, '同花KQ面对按钮加注可跟注保留较弱范围，翻后按牌面和对手行动判断。'],
    ['ai-b', 'call', null, 'QJ不同花连张，在大盲补200；按价格跟入，翻后不因主动偏好强行进攻。'],
    ['ai-a', 'raise', 450, '顶对K带Q踢脚，可向较弱K、Tx和顺听牌取值，下注半池450。'],
    ['ai-b', 'call', null, 'QJ有A或9的两头顺听牌，跟450保留成顺回报；身后仍有人，后续按价格判断。'],
    ['human', 'call'],
    ['ai-a', 'raise', 600, '转牌成KQ两对，10是公共踢脚；向较弱K、Q和听牌下注600取值。'],
    ['ai-b', 'call', null, '转牌Q带来一对和两头顺听牌，补600的价格可接受，跟注争取成顺回报。'],
    ['human', 'call'],
    ['ai-a', 'raise', 1400, '河牌7未完成新的明显顺子，两对仍可向较弱K取值，下注1400保留跟注范围。'],
    ['ai-b', 'fold', null, 'QJ仅一对Q，顺听牌落空；座2连续三街下注且座1仍待响应，弃牌。'],
    ['human', 'call'],
  ], { human: 5000, 'ai-a': 5000, 'ai-b': 5000 }, [])
  const second = play(2, { title: '稳健AI用JJ超对跟注、取值；河牌A后按新局面抓诈，结果仍可能输',
    holes: { human: ['As', 'Kd'], 'ai-a': ['Jc', 'Jh'], 'ai-b': ['9s', '9h'] },
    board: ['Td', '7c', '2h', '4s', 'Ah'] }, [
    ['ai-a', 'raise', 300, '按钮位口袋JJ有价值加注空间，加到300争取较弱对子和高张支付。'],
    ['ai-b', 'call', null, '小盲口袋99可跟注250进入底池，翻后依据牌面和行动决定是否继续。'],
    ['human', 'call'],
    ['ai-b', 'check', null, '99低于公共10，三人底池先过牌观察下注者和尺度，不把一对自动当成价值下注。'],
    ['human', 'raise', 300],
    ['ai-a', 'call', null, 'JJ是超对，座1只下注三分之一池，仍可能有Tx或听牌，跟300保留较弱范围。'],
    ['ai-b', 'call', null, '99仍可赢较小对子和部分听牌，补300价格较低，跟一街后重新判断。'],
    ['ai-b', 'check', null, '转牌4未提高99，一家翻牌下注一家跟注，先过牌观察本街价格。'],
    ['human', 'check'],
    ['ai-a', 'raise', 600, '转牌4未改变JJ超对，两家本街已过牌；向Tx、较小对子和听牌下注600取值。'],
    ['ai-b', 'fold', null, '99面对座2转牌下注且座1仍待响应，对方可解释范围中有Tx和较强对子，弃牌。'],
    ['human', 'call'],
    ['human', 'raise', 1000],
    ['ai-a', 'call', null, '河牌A使JJ不再是超对，但座1三分之一池领打仍可能有Tx或诈唬，按20%价格门槛跟注。'],
  ], first.nextSeeds, [first.recent], first.dealer)
  return { version: LLM_PROMPT_VERSION, system: LLM_SYSTEM_PROMPT, initialTotal: 15000, hands: [first, second] }
}
