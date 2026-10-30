/**
 * 南京麻将桌状态机 —— 仓鼠聚会线下计分器
 *
 * 桌状态只关心四件事：四家分数、庄家归属、翻倍（比大胡）状态、流水。
 * 出牌与胡牌本身由牌桌解决，这里只做「一局结束后怎么记账、下局什么状态」。
 *
 * 口径（2026-10-07 确认）：
 *   - 庄家：首局手动指定；庄家胡牌连庄；流局连庄；大胡不换庄；闲家小胡则下家坐庄
 *   - 翻倍触发：本局出现大胡或花杠 → 下局翻倍
 *   - 翻倍延续：翻倍局遇庄家连庄（站桩）或流局 → 继续翻倍；
 *     直到闲家胡牌且本局无大胡/花杠时结束
 *   - 翻倍范围：总花数、杠钱、罚分全部 ×2
 *   - 结算方向：自摸三家各付全额；点炮者付 1 份；包牌者付 3 份；杠开由被杠者包 3 家
 *   - 一炮多响：按逆时针依次与点炮者各结算 1 份
 *   - 杠钱独立结算（settleKong 即时入账，不退不补——杠完没胡也不退，线下自行处理）；
 *     胡牌结算只做「赢家自己的杠 → 每杠 2 颗软花」的加成
 */

import { DEFAULT_RULES, mergeRules, scoreHand } from './score.mjs'

/** 四家流水账本：transfers 明细 + net 净变化 */
function createLedger(n) {
  const transfers = []
  const net = new Array(n).fill(0)
  const push = (from, to, amount, reason) => {
    if (!amount) return
    transfers.push({ from, to, amount, reason })
    net[from] -= amount
    net[to] += amount
  }
  return { transfers, net, push }
}

const othersOf = (n, seat) => Array.from({ length: n }, (_, i) => i).filter((i) => i !== seat)

export function createMahjongTable({ seats, dealerSeat = 0, pricePerFlower = 1, rules = {} } = {}) {
  if (!Array.isArray(seats) || seats.length !== 4) throw new Error('南京麻将需要 4 位玩家')
  return {
    seats: seats.map((s) => ({ ...s })),
    dealerSeat,
    pricePerFlower,
    rules: mergeRules(rules),
    isDoubleRound: false,
    roundNo: 0,
    history: [],
  }
}

/**
 * 杠独立结算（与胡牌无关，即时入账、不退不补）。
 * 明杠 = 被杠者一人付 10；暗杠 = 其余三家各付 5；花杠 = 其余三家各付 10；翻倍局同步 ×2。
 *
 * @param {object} table createMahjongTable 的产物
 * @param {{seat:number, type:'ming'|'an'|'hua', fromSeat?:number}} kong
 */
export function settleKong(table, kong) {
  const rules = mergeRules(table.rules)
  const mult = table.isDoubleRound ? 2 : 1
  const n = table.seats.length
  const { transfers, net, push } = createLedger(n)

  if (kong.type === 'ming') push(kong.fromSeat, kong.seat, rules.gangPay.ming * mult, '明杠')
  else if (kong.type === 'an') for (const s of othersOf(n, kong.seat)) push(s, kong.seat, rules.gangPay.an * mult, '暗杠')
  else if (kong.type === 'hua') for (const s of othersOf(n, kong.seat)) push(s, kong.seat, rules.gangPay.hua * mult, '花杠')
  else throw new Error(`未知杠类型: ${String(kong.type)}`)

  const next = {
    ...table,
    history: [...table.history, { roundNo: table.roundNo, kong: { ...kong }, transfers, net }],
  }
  return { table: next, result: { ok: true, kong: { ...kong }, mult, transfers, net } }
}

/**
 * 结算一局。
 *
 * @param {object} table createMahjongTable 的产物
 * @param {object} round
 * @param {'tsumo'|'ron'} round.winType
 * @param {number|null} [round.discarderSeat] 点炮者（ron 时必填）
 * @param {Array} round.winners [{seat, hand:{concealed,melds,flowers,winTile}, flags?, gangkaiFromSeat?, baoSeat?}]
 * @param {boolean} [round.hadHuagang] 本局是否出现花杠（触发下局翻倍；杠钱由 settleKong 另行入账）
 * @param {Array} [round.payments] 手动罚分/包牌 [{from, to, amount, reason}]
 * @param {boolean} [round.isDoubleRound] 覆盖桌面的翻倍状态（玩家可改）
 */
export function settleRound(table, round) {
  const rules = { ...mergeRules(table.rules), pricePerFlower: table.pricePerFlower ?? 1 }
  const isDoubleRound = round.isDoubleRound ?? table.isDoubleRound
  const mult = isDoubleRound ? 2 : 1
  const n = table.seats.length
  const { transfers, net, push } = createLedger(n)

  // 1. 胡牌（杠钱不在这里算：杠独立结算，见 settleKong）
  const winners = round.winners ?? []
  const perWinner = winners.map((w) => {
    const score = scoreHand(w.hand, w.flags ?? {}, rules)
    const share = score.flowers.total * rules.pricePerFlower * mult
    let from = null
    if (w.baoSeat != null) {
      push(w.baoSeat, w.seat, share * 3, '包牌')
      from = w.baoSeat
    } else if (w.flags?.gangkai && w.gangkaiFromSeat != null) {
      // 杠开本质是自摸，但由引出杠的被杠者包三家；暗杠/花杠没有被杠者，落到自摸分支
      push(w.gangkaiFromSeat, w.seat, share * 3, '杠开包三家')
      from = w.gangkaiFromSeat
    } else if (round.winType === 'tsumo') {
      for (const s of othersOf(n, w.seat)) push(s, w.seat, share, '自摸')
      from = 'all'
    } else {
      push(round.discarderSeat, w.seat, share, '点炮')
      from = round.discarderSeat
    }
    return { seat: w.seat, score, share, from }
  })

  // 2. 手动罚分 / 包牌（固定金额）
  for (const p of round.payments ?? []) push(p.from, p.to, (p.amount ?? 0) * mult, p.reason ?? '罚分')

  // 3. 桌状态推进
  const bigWin = perWinner.some((w) => w.score.isBigWin)
  const hadHuagang = round.hadHuagang === true
  const winnerIsDealer = winners.some((w) => w.seat === table.dealerSeat)
  const dealerStays = winnerIsDealer || bigWin
  const dealerSeat = dealerStays ? table.dealerSeat : (table.dealerSeat + 1) % n
  // 延续判据用「本局实际是否翻倍局」（玩家可覆盖桌面预填），而不是桌面旧状态
  const nextDouble = bigWin || hadHuagang || (isDoubleRound && dealerStays)

  const result = {
    ok: true,
    isDoubleRound,
    mult,
    perWinner,
    transfers,
    net,
    bigWin,
    hadHuagang,
    dealerStays,
    dealerSeat,
    nextDouble,
    warnings: perWinner.map((w) => w.score.hint).filter(Boolean),
  }
  const next = {
    ...table,
    dealerSeat,
    isDoubleRound: nextDouble,
    roundNo: table.roundNo + 1,
    history: [...table.history, {
      roundNo: table.roundNo + 1,
      winners: winners.map((w) => w.seat),
      winType: round.winType,
      bigWin,
      hadHuagang,
      transfers,
      net,
    }],
  }
  return { table: next, result }
}

/** 流局：不结算金额，庄家连庄，翻倍状态原样延续（不新触发） */
export function drawRound(table, reason = '流局') {
  const next = {
    ...table,
    roundNo: table.roundNo + 1,
    history: [...table.history, { roundNo: table.roundNo + 1, draw: true, reason }],
  }
  return {
    table: next,
    result: {
      ok: true,
      draw: true,
      reason,
      dealerStays: true,
      dealerSeat: table.dealerSeat,
      nextDouble: table.isDoubleRound,
      transfers: [],
      net: new Array(table.seats.length).fill(0),
    },
  }
}
