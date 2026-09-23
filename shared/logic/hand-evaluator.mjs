/**
 * 牌型判定器 —— 仓鼠聚会
 *
 * 牌型等级（从大到小）：
 *   8 皇家同花顺 / straight flush（含皇家，同花顺已是最大，皇家只是命名）
 *   7 同花顺
 *   6 四条
 *   5 同花     ← 短牌规则：同花 > 葫芦（与标准长牌相反，这是唯一区别）
 *   4 葫芦
 *   3 三条
 *   2 顺子
 *   1 两对
 *   0 高牌
 *
 * 短牌（short）与长牌（long）的差异：
 *   - 牌堆去掉 2/3/4/5，共 36 张
 *   - 同花 > 葫芦
 *   - A 可当 5 用（A-6-7-8-9 是最小顺子）
 *   - 顺子最低 6-7-8-9-T，最高 T-J-Q-K-A
 *
 * 长牌（long）为标准顺序：
 *   - 葫芦 > 同花
 *   - A 可当 1 用（A-2-3-4-5 是最小顺子）
 *   - 顺子最低 A-2-3-4-5，最高 T-J-Q-K-A
 */

import { parseCard } from './cards.mjs'

export const HAND = {
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
}

export const HAND_NAME = {
  0: '高牌',
  1: '一对',
  2: '两对',
  3: '三条',
  4: '顺子',
  5: '同花',
  6: '葫芦',
  7: '四条',
  8: '同花顺',
}

/**
 * 牌型等级 → 可比较的排序分。
 *
 * 长牌：高牌 < 一对 < 两对 < 三条 < 顺子 < 同花 < 葫芦 < 四条 < 同花顺
 * 短牌：高牌 < 一对 < 两对 < 三条 < 顺子 < 葫芦 < 同花 < 四条 < 同花顺
 *                     ↑ 只有这一处不同：同花 > 葫芦
 */
const ORDER_LONG = {
  [HAND.HIGH_CARD]: 0,
  [HAND.ONE_PAIR]: 100,
  [HAND.TWO_PAIR]: 200,
  [HAND.THREE_OF_A_KIND]: 300,
  [HAND.STRAIGHT]: 400,
  [HAND.FLUSH]: 500,
  [HAND.FULL_HOUSE]: 600,
  [HAND.FOUR_OF_A_KIND]: 700,
  [HAND.STRAIGHT_FLUSH]: 800,
}

const ORDER_SHORT = {
  [HAND.HIGH_CARD]: 0,
  [HAND.ONE_PAIR]: 100,
  [HAND.TWO_PAIR]: 200,
  [HAND.THREE_OF_A_KIND]: 300,
  [HAND.STRAIGHT]: 400,
  [HAND.FULL_HOUSE]: 500,        // 葫芦降到同花之下
  [HAND.FLUSH]: 600,             // 同花升到葫芦之上
  [HAND.FOUR_OF_A_KIND]: 700,
  [HAND.STRAIGHT_FLUSH]: 800,
}

function handScore(type, gameType) {
  const table = gameType === 'short' ? ORDER_SHORT : ORDER_LONG
  return table[type]
}

/**
 * 从牌组中找出所有顺子，返回最大顺子的头部点数（降序数组）。
 *
 * 关键逻辑：A 的双重身份
 *   - 长牌：A=14（T-J-Q-K-A），也可 A=1（A-2-3-4-5）
 *   - 短牌：A=14（T-J-Q-K-A），也可 A=5（A-6-7-8-9）
 *
 * @param {string[]} cards 5-7 张牌
 * @param {'long'|'short'} gameType
 * @returns {number[]|null} 顺子的点数（降序），如 [14,13,12,11,10]；无顺子返回 null
 */
function findStraight(cards, gameType) {
  const values = [...new Set(cards.map((c) => parseCard(c).value))].sort((a, b) => b - a)

  // A 的低位身份：长牌 A=1，短牌 A=5
  const hasAce = values.includes(14)
  if (hasAce) {
    const aceLow = gameType === 'short' ? 5 : 1
    if (!values.includes(aceLow)) values.push(aceLow)
  }

  // 至少 5 张不同点数才可能有顺子
  if (values.length < 5) return null

  values.sort((a, b) => b - a)

  // 连续 5 个即顺子
  for (let i = 0; i + 4 < values.length; i++) {
    const window = values.slice(i, i + 5)
    let ok = true
    for (let j = 0; j < 4; j++) {
      if (window[j] - window[j + 1] !== 1) {
        ok = false
        break
      }
    }
    if (ok) return window
  }
  return null
}

/**
 * 判断 5 张牌是否同花
 */
function isFlush(five) {
  return five.every((c) => parseCard(c).suit === parseCard(five[0]).suit)
}

/**
 * 评估一组牌，返回牌型与用于比大小的踢脚序列。
 *
 * @param {string[]} cards 5-7 张牌（底牌 + 公共牌）
 * @param {'long'|'short'} gameType
 * @returns {{type:number, score:number, name:string, kickers:number[], cards:string[]}}
 *   score    用于直接比较大小（越大越强）
 *   kickers  依次比较的踢脚点数，长度统一为 5，便于逐位比较
 *   cards    构成该牌型的 5 张牌（用于展示）
 */
export function evaluate(cards, gameType = 'long') {
  if (cards.length < 5) throw new Error(`比牌至少需要 5 张牌，收到 ${cards.length} 张`)

  const parsed = cards.map(parseCard)

  // 按点数分组
  const byRank = new Map()
  for (const p of parsed) {
    if (!byRank.has(p.value)) byRank.set(p.value, [])
    byRank.get(p.value).push(p.code)
  }
  // 分组按「张数多 → 点数大」排序，这是取出主牌的依据
  const groups = [...byRank.entries()]
    .map(([value, codes]) => ({ value, codes }))
    .sort((a, b) => b.codes.length - a.codes.length || b.value - a.value)

  const counts = groups.map((g) => g.codes.length).sort((a, b) => b - a)

  // 同花：找某个花色是否 >= 5 张
  const bySuit = new Map()
  for (const p of parsed) {
    if (!bySuit.has(p.suit)) bySuit.set(p.suit, [])
    bySuit.get(p.suit).push(p.code)
  }
  const flushSuit = [...bySuit.entries()].find(([, cs]) => cs.length >= 5)
  const flushCards = flushSuit ? flushSuit[1] : null

  const straight = findStraight(cards, gameType)

  // ── 同花顺 ──
  if (flushCards && flushCards.length >= 5) {
    const sf = findStraight(flushCards, gameType)
    if (sf) {
      return {
        type: HAND.STRAIGHT_FLUSH,
        score: handScore(HAND.STRAIGHT_FLUSH, gameType),
        name: sf[0] === 14 ? '皇家同花顺' : '同花顺',
        kickers: sf.slice(0, 5),
        cards: takeCards(parsed, sf.slice(0, 5), true),
      }
    }
  }

  // ── 四条 ──
  if (counts[0] === 4) {
    const quad = groups.find((g) => g.codes.length === 4)
    const kicker = groups
      .filter((g) => g.codes.length !== 4)
      .sort((a, b) => b.value - a.value)[0]
    return {
      type: HAND.FOUR_OF_A_KIND,
      score: handScore(HAND.FOUR_OF_A_KIND, gameType),
      name: '四条',
      kickers: [quad.value, kicker.value],
      cards: [...quad.codes, ...kicker.codes],
    }
  }

  // ── 葫芦 / 同花（短牌里同花更大，所以先判同花）──
  if (gameType === 'short' && flushCards) {
    // 短牌：同花 > 葫芦
    const top5 = flushCards
      .map((c) => parseCard(c))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
    return {
      type: HAND.FLUSH,
      score: handScore(HAND.FLUSH, gameType),
      name: '同花',
      kickers: top5.map((p) => p.value),
      cards: top5.map((p) => p.code),
    }
  }

  if (counts[0] === 3 && counts[1] >= 2) {
    const trips = groups.find((g) => g.codes.length === 3)
    // 可能有多个三条，取点数大的；对子也取点数大的
    const pairs = groups.filter((g) => g.codes.length >= 2 && g !== trips)
    const bestPair = pairs.sort((a, b) => b.value - a.value)[0]
    return {
      type: HAND.FULL_HOUSE,
      score: handScore(HAND.FULL_HOUSE, gameType),
      name: '葫芦',
      kickers: [trips.value, bestPair.value],
      cards: [...trips.codes, ...bestPair.codes.slice(0, 2)],
    }
  }

  // ── 长牌：葫芦 > 同花，所以同花放在葫芦之后 ──
  if (gameType === 'long' && flushCards) {
    const top5 = flushCards
      .map((c) => parseCard(c))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
    return {
      type: HAND.FLUSH,
      score: handScore(HAND.FLUSH, gameType),
      name: '同花',
      kickers: top5.map((p) => p.value),
      cards: top5.map((p) => p.code),
    }
  }

  // ── 顺子 ──
  if (straight) {
    return {
      type: HAND.STRAIGHT,
      score: handScore(HAND.STRAIGHT, gameType),
      name: '顺子',
      kickers: straight.slice(0, 5),
      cards: takeCards(parsed, straight.slice(0, 5), false),
    }
  }

  // ── 三条 ──
  if (counts[0] === 3) {
    const trips = groups.find((g) => g.codes.length === 3)
    const kickers = groups
      .filter((g) => g !== trips)
      .sort((a, b) => b.value - a.value)
      .slice(0, 2)
    return {
      type: HAND.THREE_OF_A_KIND,
      score: handScore(HAND.THREE_OF_A_KIND, gameType),
      name: '三条',
      kickers: [trips.value, ...kickers.map((k) => k.value)],
      cards: [...trips.codes, ...kickers.flatMap((k) => k.codes)],
    }
  }

  // ── 两对 ──
  if (counts[0] === 2 && counts[1] === 2) {
    const pairs = groups.filter((g) => g.codes.length === 2).sort((a, b) => b.value - a.value)
    const kicker = groups.find((g) => g.codes.length === 1)
    return {
      type: HAND.TWO_PAIR,
      score: handScore(HAND.TWO_PAIR, gameType),
      name: '两对',
      kickers: [pairs[0].value, pairs[1].value, kicker.value],
      cards: [...pairs[0].codes, ...pairs[1].codes, ...kicker.codes],
    }
  }

  // ── 一对 ──
  if (counts[0] === 2) {
    const pair = groups.find((g) => g.codes.length === 2)
    const kickers = groups
      .filter((g) => g !== pair)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
    return {
      type: HAND.ONE_PAIR,
      score: handScore(HAND.ONE_PAIR, gameType),
      name: '一对',
      kickers: [pair.value, ...kickers.map((k) => k.value)],
      cards: [...pair.codes, ...kickers.flatMap((k) => k.codes)],
    }
  }

  // ── 高牌 ──
  const top5 = [...parsed].sort((a, b) => b.value - a.value).slice(0, 5)
  return {
    type: HAND.HIGH_CARD,
    score: handScore(HAND.HIGH_CARD, gameType),
    name: '高牌',
    kickers: top5.map((p) => p.value),
    cards: top5.map((p) => p.code),
  }
}

/**
 * 从手牌中挑出指定点数集合的牌。
 * @param {Array} parsed 已解析的牌
 * @param {number[]} values 想要的点数（如顺子的 5 个点数）
 * @param {boolean} sameSuit 是否要求同花色（同花顺用）
 */
function takeCards(parsed, values, sameSuit) {
  const picked = []
  const used = new Set()
  for (const v of values) {
    const found = parsed.find(
      (p, idx) => !used.has(idx) && p.value === v && (!sameSuit || !picked.length || p.suit === picked[0].suit)
    )
    if (found) {
      used.add(parsed.indexOf(found))
      picked.push(found.code)
    }
  }
  return picked
}

/**
 * 比较两手牌大小
 * @returns {number} 1 = a 赢, -1 = b 赢, 0 = 完全平局
 */
export function compareHands(a, b) {
  if (a.score !== b.score) return a.score > b.score ? 1 : -1
  const len = Math.max(a.kickers.length, b.kickers.length)
  for (let i = 0; i < len; i++) {
    const av = a.kickers[i] ?? -1
    const bv = b.kickers[i] ?? -1
    if (av !== bv) return av > bv ? 1 : -1
  }
  return 0
}
