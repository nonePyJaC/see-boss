/**
 * AI 策略 —— 移植自 D:\dezhou\ai\mcts_ai.py + advanced_ai.py 的行为语义。
 *
 * 输入是「安全观察」对象（规格 §8.4），只允许：
 *   { gameType, mySeatId, myCards, board, pot, currentBet, myBet, mySeeds,
 *     publicPlayers, publicActions, legalActions }
 * 调用方必须新建该对象，不得传 Room、完整 hands 或他人底牌。
 *
 * decideAction 是纯函数：观察 + 人设 + 有界修正 + RNG -> 合法动作。
 * 任何异常/非法结果都按 check → call → fold → 第一个合法动作 降级。
 */

import { parseCard } from '../../shared/logic/cards.mjs'
import { estimateEquity, DEFAULT_SIMS, DEFAULT_MS } from './equity.mjs'
import { PARAM_KEYS, clampParam } from './personality.mjs'

// ── Sklansky 翻前起手牌分组（移植自 advanced_ai.py，仅单挑长牌桌用）──

/**
 * 两张底牌 → 分组 1-9（越小越强）
 */
export function sklanskyGroup(c1, c2) {
  const a = parseCard(c1)
  const b = parseCard(c2)
  const high = Math.max(a.value, b.value)
  const low = Math.min(a.value, b.value)
  const suited = a.suit === b.suit

  // 对子
  if (high === low) {
    if (high >= 12) return 1
    if (high >= 10) return 2
    if (high >= 8) return 3
    if (high >= 6) return 4
    if (high >= 4) return 5
    return 7
  }
  // AK
  if (high === 14 && low === 13) return suited ? 1 : 2
  // AQ
  if (high === 14 && low === 12) return suited ? 2 : 3
  // AJ
  if (high === 14 && low === 11) return suited ? 3 : 4
  // AT
  if (high === 14 && low === 10) return suited ? 3 : 5
  // A9-A2
  if (high === 14) return suited ? (low >= 8 ? 5 : 7) : 8
  // KQ
  if (high === 13 && low === 12) return suited ? 2 : 4
  // KJ
  if (high === 13 && low === 11) return suited ? 3 : 5
  // KT
  if (high === 13 && low === 10) return suited ? 4 : 5
  // K9-K2
  if (high === 13) return suited ? (low >= 8 ? 6 : 8) : 9
  // QJ
  if (high === 12 && low === 11) return suited ? 4 : 5
  // QT
  if (high === 12 && low === 10) return suited ? 4 : 7
  // Q9+
  if (high === 12) return suited ? (low >= 9 ? 6 : 8) : 9
  // JT
  if (high === 11 && low === 10) return suited ? 4 : 6
  // J9
  if (high === 11 && low === 9) return suited ? 6 : 8
  // J8-
  if (high === 11) return suited ? 8 : 9
  // T9
  if (high === 10 && low === 9) return suited ? 5 : 7
  // 98
  if (high === 9 && low === 8) return suited ? 5 : 7
  // 87+ 连张
  if (high - low === 1 && low >= 7) return suited ? 6 : 8
  // 同花隔张
  if (suited && high - low <= 2) return 7
  return 9
}

// ── 内部小工具 ──

const has = (legals, t) => legals.some((a) => a.type === t)
const pick = (legals, t) => legals.find((a) => a.type === t)

function callPricing(obs) {
  const currentBet = Number.isFinite(obs?.currentBet) ? obs.currentBet : 0
  const myBet = Number.isFinite(obs?.myBet) ? obs.myBet : 0
  const owed = Math.max(0, currentBet - myBet)
  const stack = Number.isFinite(obs?.mySeeds) ? Math.max(0, obs.mySeeds) : 0
  const call = pick(obs?.legalActions ?? [], 'call')
  const requested = call && Number.isFinite(call.amount) ? call.amount : owed
  const amount = Math.min(owed, Math.max(0, requested), stack)
  let contestablePot = Number.isFinite(obs?.pot) ? Math.max(0, obs.pot) : 0
  const players = obs?.publicPlayers ?? []
  const me = players.find((p) => p?.seatId === obs?.mySeatId)
  if (me && Number.isFinite(me.totalBet) && players.every((p) => Number.isFinite(p?.totalBet))) {
    const maxTotal = Math.max(0, me.totalBet) + stack
    const committed = players.reduce((sum, p) => sum + Math.min(maxTotal, Math.max(0, p.totalBet)), 0)
    contestablePot = Math.min(contestablePot, committed)
  }
  return { amount, potOdds: amount > 0 ? amount / (contestablePot + amount) : 0 }
}

/** 合法加注区间：短人单挑时按有效筹码封顶，避免无意义的单人边池。 */
function raiseBounds(obs) {
  const r = pick(obs.legalActions ?? [], 'raise')
  let maxTotal = (obs.myBet ?? 0) + (obs.mySeeds ?? 0)
  const opponents = (obs.publicPlayers ?? [])
    .filter((p) => p && p.seatId !== obs.mySeatId && !p.folded)
  const responders = opponents.filter((p) => !p.allIn && (p.seeds ?? 0) > 0)
  if (responders.length === 1) {
    maxTotal = Math.min(maxTotal, (responders[0].bet ?? 0) + responders[0].seeds)
  } else if (responders.length === 0 && opponents.length) {
    maxTotal = Math.min(maxTotal, Math.max(...opponents.map((p) => p.bet ?? 0)))
  }
  return { minTotal: r?.amount ?? Infinity, maxTotal, legal: !!r }
}

/** 降级链：check → call → fold → 第一个合法动作（规格 §8.6） */
export function fallbackAction(legalActions) {
  const legals = legalActions ?? []
  for (const t of ['check', 'call', 'fold']) {
    if (legals.some((a) => a.type === t)) return { type: t }
  }
  return legals.length ? { type: legals[0].type, amount: legals[0].amount } : { type: 'fold' }
}

/**
 * 决策主入口。
 * @param {object} obs 安全观察（§8.4 列出的字段）
 * @param {{params: object}} persona 人设
 * @param {object} ctx 运行期上下文：
 *   ctx.opponentSummary {aggression, tightness, vpip, samples} | null
 *   ctx.emotionDelta {tightLoose, passiveAggressive, bluffFrequency, callTendency} | null —— 有界修正
 *   ctx.handState { slowPlaying } —— 本手内可变标记（runtime 持有）
 * @param {() => number} rng 随机源
 * @param {object} opts { equitySims, equityMs, now } 测试注入
 * @returns {{type:string, amount?:number}}
 */
export function decideAction(obs, persona, ctx = {}, rng = Math.random, opts = {}) {
  try {
    return decide(obs, persona, ctx, rng, opts)
  } catch {
    // 安全降级保留（review C-R3）：但必须让唯一调度 owner 观测到，否则
    // 全程兜底的「性能成绩」无法与真实策略区分
    opts.onDegraded?.('exception')
    return fallbackAction(obs?.legalActions)
  }
}

function decide(obs, persona, ctx, rng, opts) {
  const legals = obs?.legalActions ?? []
  if (!legals.length) return { type: 'fold' }
  if (legals.length === 1) {
    const only = legals[0]
    return only.amount !== undefined ? { type: only.type, amount: only.amount } : { type: only.type }
  }

  // 有效人设 = 基础人设 + 有界情绪修正（不回写、单项截断）
  const base = persona?.params ?? {}
  const emo = ctx.emotionDelta ?? {}
  const eff = {}
  for (const k of PARAM_KEYS) {
    eff[k] = clampParam((base[k] ?? 0.5) + (Number.isFinite(emo[k]) ? emo[k] : 0))
  }

  const myCards = obs.myCards ?? []
  const board = obs.board ?? []
  const callPrice = callPricing(obs)
  const toCall = callPrice.amount
  const pot = obs.pot ?? 0
  const bounds = raiseBounds(obs)

  // 存活对手数 = publicPlayers 中未弃牌且非本人
  const aliveOpps = (obs.publicPlayers ?? [])
    .filter((p) => p && p.seatId !== obs.mySeatId && !p.folded).length

  // 单挑长牌桌翻牌前：Sklansky 分组路径（advanced_ai.py 思想）
  if (board.length === 0 && obs.gameType !== 'short' && aliveOpps === 1 && myCards.length === 2 && toCall <= 0) {
    return preflopHeadsUp(obs, eff, ctx, rng, legals, toCall, pot, bounds)
  }

  // 统一路径：蒙特卡洛胜率 → 人设调整 → 阈值决策
  const strength = estimateEquity({
    myCards, board, aliveOpponents: Math.max(1, aliveOpps), gameType: obs.gameType,
    rng, maxSims: opts.equitySims ?? DEFAULT_SIMS, maxMs: opts.equityMs ?? DEFAULT_MS,
    now: opts.now,
  })

  // 人设调整（mcts_ai._adjust_by_personality 原样移植）
  let adjusted = strength
    + (eff.passiveAggressive - 0.5) * 0.12
    + (eff.bluffFrequency - 0.3) * 0.08
    + (eff.callTendency - 0.5) * 0.08

  // 轻量对手模型（有界：每项 ≤0.05 × adaptivity）
  const opp = ctx.opponentSummary
  const adapt = eff.adaptivity
  if (opp && opp.samples >= 4 && adapt > 0.05) {
    if (opp.vpip > 0.4) adjusted += 0.04 * adapt            // 对手松：中等牌更有价值
    if (opp.aggression > 1.5) adjusted -= 0.05 * adapt      // 对手激进：弱牌更谨慎
  }
  adjusted = Math.max(0, Math.min(1, adjusted))
  const potOdds = callPrice.potOdds

  // 慢打：只允许 flop/turn（board 3|4 张）；河牌永不因慢打让渡价值
  const hs = ctx.handState
  if (hs) {
    if (board.length >= 5) hs.slowPlaying = false
    else if ((board.length === 3 || board.length === 4) && !hs.slowPlaying
             && adjusted >= 0.8 && rng() < eff.slowPlayFrequency) {
      hs.slowPlaying = true
    }
    if (hs.slowPlaying && adjusted >= 0.7) {
      if (toCall <= 0 && has(legals, 'check')) return { type: 'check' }
      if (toCall > 0 && strength > potOdds && has(legals, 'call')) return { type: 'call' }
      hs.slowPlaying = false
    }
  }

  // 阈值（mcts_ai._select_action）
  let foldLine = 0.15 + (1 - eff.tightLoose) * 0.15
  const callLine = 0.3 + (1 - eff.callTendency) * 0.1
  let raiseLine = 0.65 - eff.passiveAggressive * 0.15

  // 对手模型对阈值的有界调整
  if (opp && opp.samples >= 4 && adapt > 0.05) {
    if (opp.aggression < 0.75) { raiseLine -= 0.04 * adapt; foldLine += 0.03 * adapt }
    if (opp.aggression > 1.5) { raiseLine += 0.03 * adapt; foldLine -= 0.03 * adapt }
    if (opp.vpip > 0.4) foldLine += 0.03 * adapt
  }

  // 诈唬：弱牌 + 随机命中 + 必须可合法加注且筹码够（不能越过筹码边界）
  // 诈唬强度 = bluffThreshold + 0.1（mcts_ai 原值），确保能跨过加注线而不是只敢跟注
  const bluffChance = eff.bluffFrequency * (0.15 + 0.15 * eff.passiveAggressive)
  const bluffThreshold = 0.35 + eff.bluffFrequency * 0.3
  const canBluffRaise = bounds.legal && bounds.minTotal <= bounds.maxTotal
  let effStrength = adjusted
  if (adjusted < 0.3 && canBluffRaise && rng() < bluffChance) {
    effStrength = Math.max(adjusted, bluffThreshold + 0.1)
  }

  // 弱牌面对下注：弃牌
  if (effStrength < foldLine && toCall > 0 && has(legals, 'fold')) {
    return { type: 'fold' }
  }

  // 中等牌：过牌 / 按赔率跟注或弃牌
  if (effStrength < raiseLine) {
    if (toCall <= 0) {
      if (has(legals, 'check')) return { type: 'check' }
    } else {
      if (strength > potOdds && (effStrength > potOdds || eff.callTendency > 0.6)) {
        if (has(legals, 'call')) return { type: 'call' }
      }
      if (has(legals, 'fold')) return { type: 'fold' }
      if (strength > potOdds && has(legals, 'call')) return { type: 'call' }
    }
  }

  // 强牌：下注/加注（金额随牌力+激进度缩放，锁死在合法区间）
  if (effStrength >= raiseLine) {
    if (toCall <= 0) {
      if (has(legals, 'raise') && bounds.maxTotal >= bounds.minTotal) {
        const raw = raiseTarget(obs, effStrength, eff.passiveAggressive, toCall)
        return { type: 'raise', amount: clampAmount(raw, bounds, obs.bigBlind) }
      }
      if (has(legals, 'check')) return { type: 'check' }
    } else {
      if (has(legals, 'raise') && bounds.maxTotal >= bounds.minTotal) {
        const raw = raiseTarget(obs, effStrength, eff.passiveAggressive, toCall)
        return { type: 'raise', amount: clampAmount(raw, bounds, obs.bigBlind) }
      }
      if (strength > potOdds && has(legals, 'call')) return { type: 'call' }
      if (strength > potOdds && has(legals, 'allin')) return { type: 'allin' }
      if (has(legals, 'fold')) return { type: 'fold' }
    }
  }

  if (toCall > 0 && strength <= potOdds && has(legals, 'fold')) return { type: 'fold' }
  return fallbackAction(legals)
}

/** 下注尺度按大盲取整；面对下注时按“跟注后底池”的比例加注。 */
function raiseTarget(obs, strength, aggression, toCall) {
  const blind = Math.max(1, Number(obs.bigBlind) || 1)
  const currentBet = obs.currentBet ?? 0
  if (!(obs.board?.length)) {
    const multiple = 2 + Math.max(0, Math.min(1, aggression))
    return toCall > 0
      ? currentBet * multiple
      : Math.max(blind * 2, currentBet + blind * multiple)
  }
  const fraction = Math.max(0.4, Math.min(1, 0.45 + strength * 0.4 + (aggression - 0.5) * 0.2))
  return toCall > 0
    ? currentBet + ((obs.pot ?? 0) + toCall) * fraction
    : Math.max(blind, (obs.pot ?? 0) * fraction)
}

/** 加注目标锁在合法区间；仅合法下限无法按大盲对齐时保留原下限。 */
function clampAmount(raw, bounds, bigBlind) {
  const unit = Math.max(1, Number(bigBlind) || 1)
  let target = Math.round(raw / unit) * unit
  if (target < bounds.minTotal) target = Math.ceil(bounds.minTotal / unit) * unit
  if (target > bounds.maxTotal) target = bounds.minTotal
  return Math.max(bounds.minTotal, Math.min(bounds.maxTotal, target))
}

/**
 * 单挑长牌桌翻牌前路径 —— advanced_ai._preflop_decision 移植。
 * Sklansky 分组 + 性格偏移，不走蒙特卡洛。
 */
function preflopHeadsUp(obs, eff, ctx, rng, legals, toCall, pot, bounds) {
  const group = sklanskyGroup(obs.myCards[0], obs.myCards[1])
  // 松紧度偏移分组（松 = 组号减小 = 更多手牌可玩）
  const effectiveGroup = Math.max(1, Math.min(9, group - Math.trunc((eff.tightLoose - 0.5) * 2)))

  let shouldRaise = effectiveGroup <= 3
  let shouldCall = effectiveGroup <= 5 + Math.trunc(eff.callTendency * 2)
  let shouldFold = effectiveGroup >= 7

  // 对手模型调整（adaptivity 控制幅度）
  const opp = ctx.opponentSummary
  const adapt = eff.adaptivity
  if (opp && opp.samples >= 4 && adapt > 0.05) {
    if (opp.vpip > 0.4) {
      shouldCall = effectiveGroup <= Math.min(8, Math.trunc(5 + 2 * adapt + eff.callTendency * 2))
      shouldFold = effectiveGroup >= Math.max(6, 8 - Math.trunc(2 * adapt))
    }
    if (opp.aggression < 0.75) {
      shouldRaise = effectiveGroup <= Math.min(6, Math.trunc(3 + 2 * adapt + eff.passiveAggressive * 2))
    }
  }

  // 高诈唬人设：弱牌也可能主动加注偷池（仍需可合法加注）
  const bluffChance = eff.bluffFrequency * (0.15 + 0.2 * eff.passiveAggressive)
  const canRaise = bounds.legal && bounds.minTotal <= bounds.maxTotal
  if (effectiveGroup >= 7 && canRaise && rng() < bluffChance) { shouldRaise = true; shouldFold = false }
  if (effectiveGroup === 6 && canRaise && rng() < bluffChance * 0.5) { shouldRaise = true; shouldFold = false }

  if (shouldRaise && canRaise) {
    const raw = raiseTarget(obs, 0.8, eff.passiveAggressive, toCall)
    return { type: 'raise', amount: clampAmount(raw, bounds, obs.bigBlind) }
  }
  if (shouldCall && toCall > 0) {
    const potOdds = toCall / (pot + toCall)
    if ((effectiveGroup <= 4 || potOdds < 0.3) && has(legals, 'call')) return { type: 'call' }
  }
  if (shouldFold && toCall > 0 && has(legals, 'fold')) return { type: 'fold' }

  if (toCall <= 0 && has(legals, 'check')) return { type: 'check' }
  return fallbackAction(legals)
}
