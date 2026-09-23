/**
 * 扑克牌模型 —— 仓鼠聚会
 *
 * 牌面编码：两位字符串，如 "As" "Kd" "Tc" "2h"
 *   第一位 = 点数：A 2 3 4 5 6 7 8 9 T J Q K
 *   第二位 = 花色：s 黑桃 / h 红心 / d 方块 / c 梅花
 *
 * 支持两种牌堆：
 *   long  长牌 52 张（2-A）
 *   short 短牌 36 张（去掉 2/3/4/5），按需求：同花 > 葫芦，A 可当 5
 */

export const RANKS_LONG = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
export const RANKS_SHORT = ['6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
export const SUITS = ['s', 'h', 'd', 'c']

/** 点数 → 数值。A 默认取 14（最大），需要时单独按 5 处理 */
const RANK_VALUE = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
}

/** 中文点数，用于 UI 展示 */
export const RANK_LABEL = {
  '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
  T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A',
}

/** 花色中文名 */
export const SUIT_LABEL = { s: '♠', h: '♥', d: '♦', c: '♣' }

/**
 * 解析一张牌
 * @param {string} code 如 "As"
 * @returns {{code:string, rank:string, suit:string, value:number}}
 */
export function parseCard(code) {
  if (typeof code !== 'string' || code.length !== 2) {
    throw new Error(`无效的牌面编码: ${String(code)}`)
  }
  const rank = code[0]
  const suit = code[1]
  const value = RANK_VALUE[rank]
  if (value === undefined) throw new Error(`无效的点数: ${rank}`)
  if (!SUITS.includes(suit)) throw new Error(`无效的花色: ${suit}`)
  return { code, rank, suit, value }
}

/**
 * 生成一副牌
 * @param {'long'|'short'} gameType
 * @returns {string[]} 未洗牌的牌堆
 */
export function createDeck(gameType) {
  const ranks = gameType === 'short' ? RANKS_SHORT : RANKS_LONG
  const deck = []
  for (const suit of SUITS) {
    for (const rank of ranks) deck.push(rank + suit)
  }
  return deck
}

/**
 * Fisher-Yates 洗牌。
 * @param {string[]} deck 会被就地打乱
 * @param {() => number} [rand] 随机源，测试时可注入确定性随机
 * @returns {string[]} 同一数组引用
 */
export function shuffle(deck, rand = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = deck[i]
    deck[i] = deck[j]
    deck[j] = tmp
  }
  return deck
}

/** 创建并洗好一副牌 */
export function createShuffledDeck(gameType, rand = Math.random) {
  return shuffle(createDeck(gameType), rand)
}

/**
 * 牌面人类可读名，如 "A♠"
 */
export function cardLabel(code) {
  const { rank, suit } = parseCard(code)
  return `${RANK_LABEL[rank]}${SUIT_LABEL[suit]}`
}

/**
 * 按数值排序（降序），用于比牌前整理
 */
export function sortByValue(cards) {
  return [...cards].sort((a, b) => parseCard(b).value - parseCard(a).value)
}
