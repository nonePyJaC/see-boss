/**
 * 结算与金瓜子 —— 仓鼠聚会
 *
 * 规则（已与需求方确认）：
 *   1. 任意玩家瓜子归零 → 触发本局结算
 *   2. 每个归零者给「当前瓜子最多的人」1 粒金瓜子
 *      - 5 人局 2 人同时归零 → 唯一最多者获得 2 粒
 *   3. 若瓜子最多者有多个并列 → 触发「加赛」决定归属
 *      - 线上模式：并列者打 1V1，谁赢谁收全部金瓜子（无下注轮）
 *      - 线下模式：房主弹框点击谁最后赢
 *   4. 金瓜子数量可以为负
 *   5. 重开：发放初始瓜子，round+1，清空牌局
 *      退出：所有人回首页
 */

/**
 * 找出触发结算的玩家
 * @param {Array<{uid:string, seeds:number}>} seats
 * @returns {string[]} 归零者的 uid 列表
 */
export function findZeroSeedPlayers(seats) {
  return seats.filter((s) => s.seeds <= 0).map((s) => s.uid)
}

/**
 * 判断是否需要结算
 */
export function shouldSettle(seats) {
  return findZeroSeedPlayers(seats).length > 0
}

/**
 * 找出瓜子最多的玩家
 * @returns {{maxSeeds:number, winners:string[], isTie:boolean}}
 */
export function findTopPlayers(seats, excludeUids = []) {
  const candidates = seats.filter((s) => !excludeUids.includes(s.uid))
  if (candidates.length === 0) return { maxSeeds: 0, winners: [], isTie: false }

  const maxSeeds = Math.max(...candidates.map((s) => s.seeds))
  const winners = candidates.filter((s) => s.seeds === maxSeeds).map((s) => s.uid)
  return { maxSeeds, winners, isTie: winners.length > 1 }
}

/**
 * 生成结算计划
 *
 * 平局处理：
 *   线上模式 —— 无结算，瓜子归零只是重开一局
 *   线下模式 —— 并列最多者时由房主弹框点选谁拿金瓜子（tieUids 非空即需房主选择）
 *
 * @param {Array<{uid:string, seeds:number}>} seats 当前座位状态
 * @returns {Object} 结算信息
 *   transfers 已确定的转账 [{fromUid, toUid, amount}]
 *   tieUids   并列最多者的 uid（空数组表示无需房主选择）
 *   zeroed    归零者 uid 列表
 */
export function buildSettlement(seats) {
  const zeroed = findZeroSeedPlayers(seats)
  if (zeroed.length === 0) {
    return { transfers: [], tieUids: [], zeroed }
  }

  // 极端情况：全员归零 → 无人可收，跳过转账
  if (zeroed.length >= seats.length) {
    return { transfers: [], tieUids: [], zeroed }
  }

  // 从非归零者中找最多者（归零者不能当收款方）
  const top = findTopPlayers(seats, zeroed)
  if (top.winners.length === 0) {
    return { transfers: [], tieUids: [], zeroed }
  }

  // 并列 → 交给房主点选，暂不生成转账
  if (top.winners.length > 1) {
    return { transfers: [], tieUids: top.winners, zeroed }
  }

  // 唯一最多者，直接确定收款人
  const toUid = top.winners[0]
  return {
    transfers: zeroed.map((fromUid) => ({ fromUid, toUid, amount: 1 })),
    tieUids: [],
    zeroed,
  }
}

/**
 * 房主在并列者中点选赢家后，生成转账
 * @param {string[]} zeroed 归零者 uid 列表
 * @param {string} winnerUid 房主选中的赢家
 * @returns {Array<{fromUid:string,toUid:string,amount:number}>}
 */
export function transfersAfterTiePick(zeroed, winnerUid) {
  if (!zeroed?.length || !winnerUid) return []
  return zeroed.map((fromUid) => ({ fromUid, toUid: winnerUid, amount: 1 }))
}

/**
 * 执行金瓜子转账（双向记账）
 *
 * @param {Map<string, {uid:string,goldenSeeds:number,ledger:Map<string,number>}>} users
 *        uid → 用户档案（会被就地修改）
 * @param {Array<{fromUid:string,toUid:string,amount:number}>} transfers
 * @returns {Array<{uid:string, delta:number}>} 每个受影响用户的净变化
 */
export function applyTransfers(users, transfers) {
  const affected = new Map()

  for (const { fromUid, toUid, amount } of transfers) {
    if (fromUid === toUid) continue // 归零者就是最多者（仅全员归零时），跳过

    const from = users.get(fromUid)
    const to = users.get(toUid)
    if (!from || !to) throw new Error(`转账失败：用户不存在 ${fromUid} → ${toUid}`)

    // 付款方：账本里该 peer 的 count 减少
    const fromPeer = from.ledger.get(toUid) ?? 0
    from.ledger.set(toUid, fromPeer - amount)
    from.goldenSeeds -= amount

    // 收款方：账本里该 peer 的 count 增加
    const toPeer = to.ledger.get(fromUid) ?? 0
    to.ledger.set(fromUid, toPeer + amount)
    to.goldenSeeds += amount

    affected.set(fromUid, (affected.get(fromUid) ?? 0) - amount)
    affected.set(toUid, (affected.get(toUid) ?? 0) + amount)
  }

  // 清理归零条目，不留空行
  for (const u of users.values()) {
    for (const [peer, count] of [...u.ledger.entries()]) {
      if (count === 0) u.ledger.delete(peer)
    }
  }

  return [...affected.entries()].map(([uid, delta]) => ({ uid, delta }))
}

/**
 * 清空账本某一行（长按统计行）
 * 双方同时清零，避免坏账。
 *
 * @param {Map} users
 * @param {string} ownerUid 长按者（账本显示方）
 * @param {string} peerUid 对方
 * @returns {{ownerDelta:number, peerDelta:number}} 双方的净变化
 */
export function clearLedgerEntry(users, ownerUid, peerUid) {
  const owner = users.get(ownerUid)
  const peer = users.get(peerUid)
  if (!owner || !peer) throw new Error('用户不存在')

  // 我账上关于他的条目
  const ownerCount = owner.ledger.get(peerUid) ?? 0
  // 他账上关于我的条目（应互为相反数）
  const peerCount = peer.ledger.get(ownerUid) ?? 0

  if (ownerCount === 0 && peerCount === 0) {
    return { ownerDelta: 0, peerDelta: 0 }
  }

  // 我清掉关于他的记录
  if (ownerCount !== 0) {
    owner.ledger.delete(peerUid)
    owner.goldenSeeds -= ownerCount
  }

  // 他清掉关于我的记录（账实相符：他的总数也应相应调整）
  if (peerCount !== 0) {
    peer.ledger.delete(ownerUid)
    peer.goldenSeeds -= peerCount
  }

  return { ownerDelta: -ownerCount, peerDelta: -peerCount }
}

/**
 * 重置对局：全员发放初始瓜子，清空牌局
 */
export function resetForNextRound(seats, initialSeeds) {
  return seats.map((s) => ({
    ...s,
    seeds: initialSeeds,
    bet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
    isTurn: false,
  }))
}

/**
 * 校验账实相符：goldenSeeds 应等于所有 ledger count 之和
 * 用于测试与线上自检
 */
export function verifyLedger(user) {
  const sum = [...user.ledger.values()].reduce((a, b) => a + b, 0)
  return { ok: sum === user.goldenSeeds, expected: sum, actual: user.goldenSeeds }
}
