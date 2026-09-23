/**
 * 边池（Side Pot）计算 —— 职业比赛规则
 *
 * 场景：多个玩家投入不同金额，有人中途全下，导致一个奖池不够覆盖所有人。
 * 必须按「累计投入金额」分层，每层独立比大小，否则筹码会算错。
 *
 * 算法：
 *   1. 收集所有未弃牌玩家的 totalBet（本局累计投入）
 *   2. 按投入金额升序取每一层「台阶」，每层金额 = 该台阶值 - 上一层累计
 *   3. 每层的参与者 = 投入 >= 台阶值 的所有玩家（含已弃牌者也要出钱）
 *   4. 每层池子独立比大小，赢家通吃该层
 *
 * 例：A 全下 100，B 跟 100，C 投 400
 *   → 主池 100×3 = 300（ABC 都有资格）
 *   → 边池 0+0+300 = 300（只有 B、C 有资格）
 */

/**
 * @typedef {Object} PotLayer
 * @property {number} amount 该层金额
 * @property {string[]} eligibleUids 有资格赢这层的玩家 uid（未弃牌）
 */

/**
 * 计算边池分层
 * @param {Array<{uid:string, totalBet:number, folded:boolean}>} contributors
 *        所有有投入的玩家（含已弃牌者，弃牌者的钱也要进池）
 * @returns {PotLayer[]} 从主池到最外层
 */
export function buildSidePots(contributors) {
  // 只统计真实有投入的
  const active = contributors.filter((c) => c.totalBet > 0)
  if (active.length === 0) return []

  // 去重并升序排列所有「投入台阶」
  const levels = [...new Set(active.map((c) => c.totalBet))].sort((a, b) => a - b)

  const layers = []
  let consumed = 0 // 上一层已切走的累计金额

  for (const level of levels) {
    if (level <= consumed) continue
    const layerSize = level - consumed
    if (layerSize <= 0) continue

    // 该层的出资人 = 投入 >= level 的所有人（含弃牌）
    const payers = active.filter((c) => c.totalBet >= level)

    // 有资格赢这层的人 = 出资人中未弃牌的
    const eligible = payers.filter((c) => !c.folded)

    layers.push({
      amount: layerSize * payers.length,
      eligibleUids: eligible.map((c) => c.uid),
    })

    consumed = level
  }

  return layers
}

/**
 * 主池 + 边池的总金额（应等于所有投入之和）
 * 用于校验 buildSidePots 的正确性
 */
export function totalPot(contributors) {
  return contributors.reduce((sum, c) => sum + c.totalBet, 0)
}

/**
 * 校验分层结果：所有层金额之和 === 总投入
 * @returns {{ok:boolean, expected:number, actual:number}}
 */
export function verifyPots(contributors) {
  const layers = buildSidePots(contributors)
  const actual = layers.reduce((s, l) => s + l.amount, 0)
  const expected = totalPot(contributors)
  return { ok: actual === expected, expected, actual }
}

/**
 * 按边池分配筹码
 *
 * @param {Array<{uid:string, totalBet:number, folded:boolean}>} contributors
 * @param {(uid:string) => object} evaluateFor 返回该玩家的牌型评估结果
 * @param {import('./hand-evaluator.mjs').compareHands} compare
 * @returns {{uid:string, amount:number, layerIndex:number}[]} 每个玩家赢得的金额（>0 才有）
 */
export function distributePot(contributors, evaluateFor, compare) {
  const layers = buildSidePots(contributors)
  const winnings = new Map()

  layers.forEach((layer, layerIndex) => {
    if (layer.eligibleUids.length === 0) return

    // 该层只有一个人有资格（其他人都弃牌了）→ 直接通吃，无需比牌
    if (layer.eligibleUids.length === 1) {
      const uid = layer.eligibleUids[0]
      const current = winnings.get(uid) ?? { uid, amount: 0, layerIndex }
      winnings.set(uid, { uid, amount: current.amount + layer.amount, layerIndex })
      return
    }

    // 有玩家没有牌型（公共牌未发完）时无法比牌，跳过该层
    const evaluated = layer.eligibleUids.map((uid) => ({ uid, hand: evaluateFor(uid) }))
    if (evaluated.some(({ hand }) => !hand)) return

    // 找该层的最大牌型（可能并列）
    const best = evaluated.reduce((acc, cur) => (compare(cur.hand, acc.hand) > 0 ? cur : acc))
    const winners = evaluated.filter(({ hand }) => compare(hand, best.hand) === 0)

    // 平分该层；除不尽的余数逐个补给赢家（先给 uid 小的，保证结果确定）
    const winnersSorted = winners.sort((a, b) => (a.uid < b.uid ? -1 : 1))
    const share = Math.floor(layer.amount / winnersSorted.length)
    let remainder = layer.amount - share * winnersSorted.length

    for (const { uid } of winnersSorted) {
      const extra = remainder > 0 ? 1 : 0
      remainder -= extra
      const current = winnings.get(uid) ?? { uid, amount: 0, layerIndex }
      winnings.set(uid, { uid, amount: current.amount + share + extra, layerIndex })
    }
  })

  return [...winnings.values()].filter((w) => w.amount > 0)
}
