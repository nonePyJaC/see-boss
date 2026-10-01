/**
 * AI 运行期状态 —— 移植自 D:\dezhou 的 OpponentModel + EmotionEngine 语义。
 *
 * 本文件只管「房间级的 AI 数据」：人设、对手统计、情绪、慢打标记。
 * 调度器（计时器/串行行动入口）在 T6 接入 server/index.js，这里不放。
 *
 * 数据纪律（规格 §8.7）：
 *   - 每个 AI 只记录公开可见、本房间内的数据：参与手数/加注/跟注/弃牌/近期公开行动
 *   - 不存对手底牌、不跨房间、不进快照
 *   - 情绪与对手适应只产生有界的单次决策修正，不回写基础人设
 *   - reset / 房间销毁时调用方负责 clearRuntime
 */

import { createPersona } from './personality.mjs'

/** 对手样本量下限：不足时不做适应（§8.7「样本过少时不适应」） */
export const MIN_OPP_SAMPLES = 4
/** 单个对手模型保留的最近公开行动条数 */
const RECENT_CAP = 12
/** 情绪修正单项上限（绝对值） */
export const EMOTION_DELTA_CAP = 0.1

export function createRuntime() {
  return {
    /** seatId -> { archetype, params, styleLabel }，入座生成一次，跨手稳定 */
    personas: new Map(),
    /** observerSeatId -> Map<targetSeatId, model>，每个 AI 各自记录对手 */
    models: new Map(),
    /** seatId -> { tilt, confidence, frustration, excitement, consecutiveFolds, handsSinceWin } */
    emotions: new Map(),
    /** seatId -> { handId, slowPlaying } 本手标记 */
    handFlags: new Map(),
  }
}

/** 座位人设：已存在直接返回（稳定不变），否则生成并记录 */
export function ensurePersona(rt, seatId, rng = Math.random) {
  let p = rt.personas.get(seatId)
  if (!p) {
    p = createPersona(undefined, rng)
    rt.personas.set(seatId, p)
  }
  return p
}

/** 移除座位的一切 AI 派生态 */
export function removeSeat(rt, seatId) {
  rt.personas.delete(seatId)
  rt.models.delete(seatId)
  rt.emotions.delete(seatId)
  rt.handFlags.delete(seatId)
  for (const m of rt.models.values()) m.delete(seatId)
}

/** 整桌清空（reset-online / 房间销毁） */
export function clearRuntime(rt) {
  rt.personas.clear()
  rt.models.clear()
  rt.emotions.clear()
  rt.handFlags.clear()
}

/** 本手标记：换 handId 自动重置 */
export function handFlag(rt, seatId, handId) {
  let f = rt.handFlags.get(seatId)
  if (!f || f.handId !== handId) {
    f = { handId, slowPlaying: false }
    rt.handFlags.set(seatId, f)
  }
  return f
}

/**
 * 情绪衰减：每开新手调用一次，向基线回归一档（confidence→0.5，其余→0）。
 * 用「每手」而不是「每秒」衰减：线上节奏由牌局推进决定，不按墙钟。
 */
export function decayEmotions(rt) {
  for (const e of rt.emotions.values()) {
    e.tilt *= 0.85
    e.confidence += (0.5 - e.confidence) * 0.15
    e.frustration *= 0.85
    e.excitement *= 0.7
    clampEmotion(e)
  }
}

function newEmotion() {
  return { tilt: 0, confidence: 0.5, frustration: 0, excitement: 0, consecutiveFolds: 0, handsSinceWin: 0 }
}

function clampEmotion(e) {
  for (const k of ['tilt', 'confidence', 'frustration', 'excitement']) {
    e[k] = Math.max(0, Math.min(1, e[k]))
  }
}

/**
 * 手牌结算事件 → 情绪更新（emotion.py on_win/on_lose 语义）。
 * bigPot 判定用 initialSeeds 缩放（D 项目写死 500，这里随桌型缩放）。
 */
export function recordHandResult(rt, seatId, { won, potSize = 0, initialSeeds = 3000, folded = false }) {
  let e = rt.emotions.get(seatId)
  if (!e) { e = newEmotion(); rt.emotions.set(seatId, e) }
  const big = potSize > initialSeeds * 0.5
  if (won) {
    e.confidence += 0.12 + (big ? 0.08 : 0)
    e.excitement += 0.15 + (big ? 0.1 : 0)
    e.frustration = Math.max(0, e.frustration - 0.15)
    e.tilt = Math.max(0, e.tilt - 0.08)
    e.handsSinceWin = 0
  } else {
    e.handsSinceWin += 1
    e.confidence -= 0.05
    e.frustration += big ? 0.12 : 0.05
    if (big) e.tilt += 0.15
  }
  if (folded) {
    e.consecutiveFolds += 1
    if (e.consecutiveFolds >= 3) {
      e.frustration += 0.06 * (e.consecutiveFolds - 2)
      e.confidence -= 0.03
    }
  } else {
    e.consecutiveFolds = 0
  }
  clampEmotion(e)
  return e
}

/**
 * 情绪 → 有界参数修正（emotion.py apply_to_personality 语义，
 * 但输出的是 delta 而不是新人设；每项截断到 ±EMOTION_DELTA_CAP）。
 */
export function emotionDelta(rt, seatId) {
  const e = rt.emotions.get(seatId)
  if (!e) return null
  return {
    tightLoose: bound(e.tilt * 0.2),
    bluffFrequency: bound(e.tilt * 0.15 + e.frustration * 0.14),
    callTendency: bound(e.tilt * 0.12),
    passiveAggressive: bound((e.confidence - 0.5) * 0.16 + e.excitement * 0.06),
    // adaptivity / slowPlayFrequency 不受情绪影响
  }
}

function bound(v) {
  return Math.max(-EMOTION_DELTA_CAP, Math.min(EMOTION_DELTA_CAP, v))
}

// ── 轻量对手模型 ──

function newModel() {
  return {
    hands: 0, vpipEnter: 0, raises: 0, calls: 0, folds: 0,
    facedBet: 0, foldToBet: 0, recent: [], vpipHandId: null,
  }
}

/**
 * 记录一条公开行动。observerSeatId = 记录者（AI），targetSeatId = 行动者。
 * 只接受公开可见字段；调用方传什么记什么，不接触底牌。
 * handId 用来给「翻前自愿入池」按手去重（同一手多次加注只算一次 vpip）。
 * @param {'check'|'call'|'raise'|'allin'|'fold'|...} type
 */
export function recordAction(rt, observerSeatId, targetSeatId, {
  type, phase, facedBet = false, handId = null, paidAmount, raiseTo, currentBetBefore,
}) {
  if (observerSeatId === targetSeatId) return
  let byTarget = rt.models.get(observerSeatId)
  if (!byTarget) { byTarget = new Map(); rt.models.set(observerSeatId, byTarget) }
  let m = byTarget.get(targetSeatId)
  if (!m) { m = newModel(); byTarget.set(targetSeatId, m) }

  const kind = type === 'allin'
    ? Number.isFinite(raiseTo) && Number.isFinite(currentBetBefore)
      ? raiseTo > currentBetBefore ? 'raise' : 'call'
      : null
    : type === 'raise' || type === 'bet' ? 'raise' : type
  const contributed = paidAmount == null || (Number.isFinite(paidAmount) && paidAmount > 0)
  if (contributed && kind === 'raise') m.raises += 1
  else if (contributed && kind === 'call') m.calls += 1
  else if (type === 'fold') m.folds += 1
  if (facedBet) {
    m.facedBet += 1
    if (type === 'fold') m.foldToBet += 1
  }
  // vpip 口径：翻前第一手自愿入池动作（call/raise/allin）记一次，按手去重
  if (phase === 'preflop' && handId != null && contributed
      && (kind === 'call' || kind === 'raise') && m.vpipHandId !== handId) {
    m.vpipHandId = handId
    m.vpipEnter += 1
  }
  m.recent.push({ type, phase })
  if (m.recent.length > RECENT_CAP) m.recent.shift()
}

/** 新一手开始：给观察者记录「本手参与/翻前加注」样本 */
export function recordHandJoined(rt, observerSeatId, targetSeatId, { enteredPot = false, raisedPreflop = false }) {
  let byTarget = rt.models.get(observerSeatId)
  if (!byTarget) { byTarget = new Map(); rt.models.set(observerSeatId, byTarget) }
  let m = byTarget.get(targetSeatId)
  if (!m) { m = newModel(); byTarget.set(targetSeatId, m) }
  m.hands += 1
  if (enteredPot) m.vpipEnter += 1
  if (raisedPreflop) m.raises += 1
}

/**
 * 聚合观察者对某些存活对手的统计。
 * @returns {{aggression:number, tightness:number, vpip:number, samples:number}|null}
 *   样本不足返回 null（policy 里不启用适应）。
 */
export function opponentSummary(rt, observerSeatId, targetSeatIds) {
  const byTarget = rt.models.get(observerSeatId)
  if (!byTarget) return null
  let raises = 0, calls = 0, facedBet = 0, foldToBet = 0, hands = 0, vpipEnter = 0, n = 0
  for (const t of targetSeatIds) {
    const m = byTarget.get(t)
    if (!m) continue
    n++
    raises += m.raises; calls += m.calls
    facedBet += m.facedBet; foldToBet += m.foldToBet
    hands += m.hands; vpipEnter += m.vpipEnter
  }
  const samples = raises + calls + foldToBet
  if (n === 0 || samples < MIN_OPP_SAMPLES) return null
  return {
    aggression: (raises) / Math.max(1, calls),   // 加注/跟注比（mcts_ai aggression_factor 简化）
    tightness: facedBet > 0 ? foldToBet / facedBet : 0,
    vpip: hands > 0 ? vpipEnter / hands : 0,
    samples,
  }
}

/**
 * 构造安全观察对象（规格 §8.4）：只收公开字段，调用方负责只传公开数据。
 * 本函数不做网络 IO、不接触 Room；纯拷贝入参，返回的对象可安全进 policy。
 */
export function buildObservation({
  gameType, mySeatId, myCards, board, pot, currentBet, myBet, mySeeds, bigBlind,
  publicPlayers, publicActions, legalActions,
}) {
  return {
    gameType,
    mySeatId,
    myCards: [...(myCards ?? [])],
    board: [...(board ?? [])],
    pot: pot ?? 0,
    currentBet: currentBet ?? 0,
    myBet: myBet ?? 0,
    mySeeds: mySeeds ?? 0,
    bigBlind: bigBlind ?? 1,
    publicPlayers: (publicPlayers ?? []).map((p) => ({
      seatId: p.seatId, bet: p.bet ?? 0, totalBet: Number.isFinite(p.totalBet) ? p.totalBet : null,
      seeds: p.seeds ?? 0, folded: !!p.folded, allIn: !!p.allIn, isAI: !!p.isAI,
    })),
    publicActions: (publicActions ?? []).map((a) => ({
      seatId: a.seatId ?? a.uid, type: a.type, amount: a.amount ?? null, phase: a.phase,
    })),
    legalActions: (legalActions ?? []).map((a) => ({ type: a.type, label: a.label, amount: a.amount })),
  }
}
