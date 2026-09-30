/**
 * 胜率估算 —— 移植自 D:\dezhou\ai\mcts_ai.py _estimate_hand_strength。
 *
 * 蒙特卡洛：剩余牌堆里无放回抽取缺失公共牌 + 所有存活对手底牌，
 * 用 shared 的 evaluate/compareHands 判输赢。
 *   输记 0；独赢记 1；并列按并列总人数分摊（多人池 1/k，不是固定 0.5）。
 *
 * 双上限：maxSims 次模拟 或 maxMs 毫秒，任一先到即停。
 * 测试必须注入固定 rng 和固定 maxSims，不依赖真实随机。
 */

import { createDeck } from '../../shared/logic/cards.mjs'
import { evaluate, compareHands } from '../../shared/logic/hand-evaluator.mjs'

export const DEFAULT_SIMS = 800
export const DEFAULT_MS = 80

/**
 * @param {object} o
 * @param {string[]} o.myCards 自己 2 张底牌
 * @param {string[]} o.board 已亮公共牌（0/3/4/5 张）
 * @param {number} o.aliveOpponents 仍未弃牌的对手数
 * @param {'long'|'short'} o.gameType
 * @param {() => number} o.rng 随机源
 * @param {number} o.maxSims 模拟次数上限
 * @param {number} o.maxMs 耗时上限（毫秒）
 * @param {() => number} o.now 时钟（测试可注入）
 * @returns {number} 胜率 [0,1]
 */
export function estimateEquity({
  myCards, board = [], aliveOpponents = 1, gameType = 'long',
  rng = Math.random, maxSims = DEFAULT_SIMS, maxMs = DEFAULT_MS,
  now = () => Date.now(),
} = {}) {
  if (!Array.isArray(myCards) || myCards.length < 2) return 0.3
  if (aliveOpponents < 1) return 1

  const known = new Set([...myCards, ...board])
  const remaining = createDeck(gameType).filter((c) => !known.has(c))

  const boardNeed = Math.max(0, 5 - board.length)
  const oppCount = Math.floor(aliveOpponents)
  const need = boardNeed + oppCount * 2
  if (need <= 0 || remaining.length < need) return 0.3

  const start = now()
  let total = 0
  let score = 0

  for (let i = 0; i < maxSims; i++) {
    // 时间上限每 32 次检查一次，避免 Date.now() 自身开销稀释模拟数
    if ((i & 31) === 31 && now() - start >= maxMs) break

    // 无放回抽 need 张：对 remaining 副本做前 need 位部分洗牌
    const pool = remaining.slice()
    for (let j = 0; j < need; j++) {
      const k = j + Math.floor(rng() * (pool.length - j))
      const t = pool[j]; pool[j] = pool[k]; pool[k] = t
    }
    const simBoard = board.concat(pool.slice(0, boardNeed))
    const holes = []
    for (let o = 0; o < oppCount; o++) {
      holes.push([pool[boardNeed + o * 2], pool[boardNeed + o * 2 + 1]])
    }

    let mine
    try {
      mine = evaluate([...myCards, ...simBoard], gameType)
    } catch {
      continue
    }

    let better = 0
    let tied = 0
    for (const hole of holes) {
      let theirs
      try {
        theirs = evaluate([...hole, ...simBoard], gameType)
      } catch {
        continue
      }
      const cmp = compareHands(theirs, mine)
      if (cmp > 0) { better++; break }
      if (cmp === 0) tied++
    }
    // 输=0；独赢=1；和 k 个对手并列第一 = 1/(k+1)
    if (better > 0) score += 0
    else score += tied === 0 ? 1 : 1 / (tied + 1)
    total++
  }

  return total === 0 ? 0.3 : score / total
}
