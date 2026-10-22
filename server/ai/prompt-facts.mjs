// 提示词的确定性事实层。只读取安全 observation，不抽样对手牌，也不替模型选择动作。
import { createDeck, parseCard } from '../../shared/logic/cards.mjs'
import { evaluate, compareHands, HAND } from '../../shared/logic/hand-evaluator.mjs'

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' }
const rankText = (v) => ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 1: 'A', 5: '5' }[v] ?? String(v))
const percent = (v) => (v * 100).toFixed(2) + '%'

/** 引擎使用 As；兼容旧测试/调用方的 sA、s14。无效牌不参与计算。 */
export function canonicalCard(value) {
  const text = String(value ?? '')
  let rank, suit
  const normal = /^([2-9TJQKA])([shdc])$/i.exec(text)
  const legacy = /^([shdc])(1[0-4]|[2-9TJQKA])$/i.exec(text)
  if (normal) [, rank, suit] = normal
  else if (legacy) {
    suit = legacy[1]
    rank = ({ 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[legacy[2]] ?? legacy[2]
  } else return null
  return rank.toUpperCase() + suit.toLowerCase()
}

export function cardText(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return '（无）'
  return cards.map((c) => {
    const code = canonicalCard(c)
    return code ? SUIT[code[1]] + (code[0] === 'T' ? '10' : code[0]) : String(c)
  }).join(' ')
}

// 只向现有判牌器送五张，避免七张中有三对时遗漏正确踢脚等展示歧义。
function bestFive(cards, gameType) {
  let best = null
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const hand = evaluate([cards[a], cards[b], cards[c], cards[d], cards[e]], gameType)
            if (!best || compareHands(hand, best) > 0) best = hand
          }
  return best
}

function madeHandText(hand) {
  const r = hand.kickers.map(rankText)
  switch (hand.type) {
    case HAND.ONE_PAIR: return `一对 ${r[0]}；踢脚 ${r.slice(1).join('、')}`
    case HAND.TWO_PAIR: return `两对 ${r[0]} 和 ${r[1]}；踢脚 ${r[2]}`
    case HAND.THREE_OF_A_KIND: return `三条 ${r[0]}；踢脚 ${r.slice(1).join('、')}`
    case HAND.FULL_HOUSE: return `葫芦 ${r[0]} 带 ${r[1]}`
    case HAND.FOUR_OF_A_KIND: return `四条 ${r[0]}；踢脚 ${r[1]}`
    case HAND.STRAIGHT: return `顺子，${r[0]} 高`
    default: return `${hand.name}；点数从大到小 ${r.join('、')}`
  }
}

function hasStraight(cards, gameType) {
  const ranks = new Set(cards.map((c) => parseCard(c).value))
  if (ranks.has(14)) ranks.add(gameType === 'short' ? 5 : 1)
  for (let high = 14; high >= (gameType === 'short' ? 9 : 5); high--)
    if ([0, 1, 2, 3, 4].every((d) => ranks.has(high - d))) return true
  return false
}

function flushStrength(hand, board, unknown) {
  const suit = hand.cards[0][1]
  const boardRanks = board.filter((c) => c[1] === suit).map((c) => parseCard(c).value)
  const remaining = unknown.filter((c) => c[1] === suit).map((c) => parseCard(c).value)
  const higherRanks = new Set()
  // 比较同花的第一个差异高张；这不是对手范围/胜率，也不把同花当成绝对坚果。
  for (let i = 0; i < remaining.length; i++) for (let j = i + 1; j < remaining.length; j++) {
    const ranks = [...boardRanks, remaining[i], remaining[j]].sort((a, b) => b - a).slice(0, 5)
    if (ranks.length < 5) continue
    const diff = ranks.findIndex((r, k) => r !== hand.kickers[k])
    if (diff >= 0 && ranks[diff] > hand.kickers[diff]) higherRanks.add(ranks[diff])
  }
  const label = higherRanks.size === 0 ? '坚果同花' : higherRanks.size === 1 ? '次坚果同花' : '存在更高同花'
  return `${label}（仅按同花差异高张分层，不代表绝对坚果）` +
    (higherRanks.size ? `；更高同花需未知高张 ${[...higherRanks].sort((a, b) => b - a).map((v) => SUIT[suit] + rankText(v)).join('、')}` : '') +
    '；仍需结合公共牌检查同花顺、葫芦或四条风险'
}

function holeStructure(hole, gameType) {
  const [a, b] = hole.map(parseCard)
  const high = Math.max(a.value, b.value), low = Math.min(a.value, b.value)
  if (high === low) return `口袋对 ${rankText(high)}；不同花，点数相同，非连张`
  const gap = high - low
  const aceLow = gameType === 'short' ? 5 : 1
  const lowAce = high === 14 && low >= aceLow + 1 && low <= aceLow + 4
    ? `；A低位时点数差 ${low - aceLow}（${low - aceLow === 1 ? '低位相连' : '低位隔' + (low - aceLow - 1) + '张'}）` : ''
  return `${rankText(high)}${rankText(low)}，${a.suit === b.suit ? '同花' : '不同花'}；常规点数差 ${gap}，` +
    (gap === 1 ? '连张' : `隔 ${gap - 1} 张，非连张`) + lowAce
}

export function cardFacts(obs) {
  const hole = (obs.myCards ?? []).map(canonicalCard)
  const board = (obs.board ?? []).map(canonicalCard)
  const cards = [...hole, ...board]
  const gameType = obs.gameType === 'short' ? 'short' : 'long'
  const deck = createDeck(gameType)
  if (hole.length !== 2 || cards.some((c) => !deck.includes(c)) || new Set(cards).size !== cards.length ||
      ![0, 3, 4, 5].includes(board.length)) return ['牌面数据不完整，无法提供确定性牌型事实；不要补造牌型或胜率。']
  if (!board.length) {
    return [`底牌结构：${holeStructure(hole, gameType)}；翻牌前未形成五张牌型`]
  }
  const hand = bestFive(cards, gameType)
  const unknown = deck.filter((c) => !cards.includes(c))
  const facts = [`底牌结构：${holeStructure(hole, gameType)}`,
    `当前最佳五张：${madeHandText(hand)}；组成 ${cardText(hand.cards)}`]
  if (hand.type === HAND.ONE_PAIR) {
    const pair = hand.kickers[0]
    const boardRanks = [...new Set(board.map((c) => parseCard(c).value))].sort((a, b) => b - a)
    if (hole.some((c) => parseCard(c).value === pair) && boardRanks.includes(pair)) {
      const order = boardRanks.indexOf(pair) + 1
      facts.push(`与公共牌配成第 ${order} 对（${order === 1 ? '顶对' : order === 2 ? '次对' : '低于次对'}）`)
    }
  }
  if (board.length === 5 && compareHands(hand, bestFive(board, gameType)) === 0)
    facts.push('最佳牌力等于公共牌，底牌未提高五张牌力；不能据此假定独赢')
  if (hand.type === HAND.FLUSH) facts.push(flushStrength(hand, board, unknown))
  if (board.length === 5) {
    facts.push('河牌已无下一张牌，不再存在待完成的听牌。')
    return facts
  }
  const straightOuts = hasStraight(cards, gameType) ? [] : unknown.filter((c) => hasStraight([...cards, c], gameType))
  facts.push(straightOuts.length ?
    `一张成顺听牌：补牌点数 ${[...new Set(straightOuts.map((c) => parseCard(c).value))].sort((a, b) => a - b).map(rankText).join('、')}，${straightOuts.length} 张未知牌；下一张成顺概率 ${percent(straightOuts.length / unknown.length)}` :
    '暂无一张成顺听牌（不统计后门听牌）。')
  const suits = Object.keys(SUIT).filter((s) => cards.filter((c) => c[1] === s).length === 4)
  for (const suit of suits) {
    const outs = unknown.filter((c) => c[1] === suit)
    const ownRanks = hole.filter((c) => c[1] === suit).map((c) => parseCard(c).value)
    const higher = ownRanks.length ? outs.filter((c) => parseCard(c).value > Math.max(...ownRanks)) : outs
    facts.push(`${SUIT[suit]}同花听牌：${outs.length} 张未知牌；下一张成花概率 ${percent(outs.length / unknown.length)}` +
      (higher.length ? `；未见的更高同色牌 ${cardText(higher)}，不能据此称为坚果同花听牌` : '；仍需检查同花顺及成对牌面风险'))
  }
  return facts
}

export function priceFacts(obs) {
  const pot = Math.max(0, obs.pot ?? 0)
  const owed = Math.max(0, (obs.currentBet ?? 0) - (obs.myBet ?? 0))
  const call = Math.min(owed, Math.max(0, obs.mySeeds ?? 0))
  const players = obs.publicPlayers ?? []
  const me = players.find((p) => p.seatId === obs.mySeatId)
  const complete = me && players.every((p) => Number.isFinite(p.totalBet) && p.totalBet >= 0) &&
    players.reduce((sum, p) => sum + p.totalBet, 0) === pot
  const cap = complete ? me.totalBet + call : 0
  const contestable = complete ? players.reduce((sum, p) => sum + Math.min(p.totalBet, cap), 0) : pot
  const facts = call ? [
    `当前底池 ${pot}（已包含对手下注）；平注尚欠 ${owed}，本次跟注实际投入 ${call}${call < owed ? '（只能短码全下，不能平齐）' : ''}`,
    `本次跟注可争夺底池 ${contestable}，跟注后 ${contestable + call}；底池赔率 ${Number((contestable / call).toFixed(3))}:1；静态盈亏平衡权益 ${percent(call / (contestable + call))} = ${call}/(${contestable}+${call})`,
  ] : ['本次过牌成本 0；不需为看下一步支付跟注。']
  if (call && !complete) facts.push('各座累计投入数据不足，以上按全池简化；如有边池不能当成精确权益门槛。')
  // 从完整本轮流水复原下注前底池，避免把「下注后的池子」错作尺度分母。
  const actions = (obs.publicActions ?? []).filter((a) => a.phase === obs.phase)
  const paid = actions.reduce((sum, a) => sum + (Number.isFinite(a.amount) ? Math.max(0, a.amount) : 0), 0)
  let before = pot - paid, highest = 0, last = null
  const bets = new Map()
  for (const a of actions) {
    const amount = Number.isFinite(a.amount) ? Math.max(0, a.amount) : 0
    const total = Number.isFinite(a.betTotal) ? a.betTotal : (bets.get(a.seatId) ?? 0) + amount
    if (['bet', 'raise', 'allin'].includes(a.type) && total > highest && amount > 0 && before > 0)
      last = { amount, before }
    highest = Math.max(highest, total)
    bets.set(a.seatId, total)
    before += amount
  }
  if (last) facts.push(`本轮最近一次主动下注/加注：本次投入 ${last.amount} / 出手前底池 ${last.before} = ${percent(last.amount / last.before)}；加注时该投入包含补跟部分，不能当成纯加注增量。`)
  return facts
}

/** 按轮次汇总出价/跟注角色；当前响应义务只认引擎的公开 actedSeatIds。 */
export function streetFacts(obs, seatLabel = (id) => {
  const i = (obs.publicPlayers ?? []).findIndex((p) => p.seatId === id)
  return i >= 0 ? '座' + (i + 1) : '未知座位'
}) {
  const phases = ['preflop', 'flop', 'turn', 'river']
  const names = ['翻牌前', '翻牌圈', '转牌圈', '河牌圈']
  const current = phases.indexOf(obs.phase)
  if (current < 0) return ['当前圈未知，不推断行动角色或待响应名单。']
  const facts = []
  let currentActions = [], currentChecks = [], lastAggressor = null
  const add = (map, id) => map.set(id, (map.get(id) ?? 0) + 1)
  const counted = (map) => [...map].map(([id, n]) => seatLabel(id) + '×' + n).join('、') || '无'
  for (let i = 0; i <= current; i++) {
    const actions = (obs.publicActions ?? []).filter((a) => a.phase === phases[i])
    const aggressive = new Map(), calls = new Map(), unknownAllins = new Map()
    const voluntary = [], checks = []
    let highest = 0, last = null
    for (const a of actions) {
      const blind = a.type === 'blind' || a.type === 'blind_allin'
      const total = Number.isFinite(a.betTotal) ? a.betTotal : blind && Number.isFinite(a.amount) ? a.amount : null
      const raises = a.type === 'bet' || a.type === 'raise' ||
        (a.type === 'allin' && total !== null && highest !== null && total > highest)
      if (raises) { add(aggressive, a.seatId); last = a }
      else if (a.type === 'call' || (a.type === 'allin' && total !== null && highest !== null && total <= highest)) add(calls, a.seatId)
      else if (a.type === 'allin') add(unknownAllins, a.seatId)
      if (['bet', 'raise', 'allin', 'call', 'fold', 'check'].includes(a.type)) voluntary.push(a)
      if (a.type === 'check') checks.push(a)
      if (total !== null && highest !== null) highest = Math.max(highest, total)
      else if (raises || a.type === 'allin') highest = null
    }
    if (voluntary.length || i === current) facts.push(`${names[i]}：出价 ${counted(aggressive)}；跟注 ${counted(calls)}` +
      (unknownAllins.size ? `；性质未知全下 ${counted(unknownAllins)}` : ''))
    if (i === current) { currentActions = voluntary; currentChecks = checks; lastAggressor = last }
  }
  const active = (obs.publicPlayers ?? []).filter((p) => !p.folded && !p.allIn && p.seeds > 0)
  const acted = new Set(currentActions.map((a) => a.seatId))
  const labels = (players) => players.map((p) => seatLabel(p.seatId)).join('、') || '无'
  facts.push(`本圈曾过牌：${[...new Set(currentChecks.map((a) => a.seatId))].map((id) => seatLabel(id)).join('、') || '无'}`)
  if (!currentActions.length) facts.push('本圈尚无人主动行动（盲注不算主动行动）')
  facts.push('本圈尚未行动：' + labels(active.filter((p) => !acted.has(p.seatId))))
  if (lastAggressor) facts.push('本圈最后出价：' + seatLabel(lastAggressor.seatId) +
    '，到 ' + (Number.isFinite(lastAggressor.betTotal) ? lastAggressor.betTotal : '未知'))
  if (Array.isArray(obs.actedSeatIds)) {
    const responded = new Set(obs.actedSeatIds)
    facts.push('待响应：' + labels(active.filter((p) => !responded.has(p.seatId) || p.bet < obs.currentBet)))
  } else facts.push('待响应：未提供引擎状态，以合法动作及完整历史为准')
  return facts
}

export function promptFacts(obs) {
  return ['【程序核对的牌力事实】', ...cardFacts(obs).map((s) => '  ' + s),
    '【程序核对的跟注与下注尺度】', ...priceFacts(obs).map((s) => '  ' + s)].join('\n')
}
