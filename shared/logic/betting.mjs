/**
 * 下注状态机 —— 仓鼠聚会
 *
 * 纯函数式设计：所有状态转换都返回新对象，不修改入参。
 * 这样状态可序列化存数据库、可回放、可测试。
 *
 * 阶段流转：
 *   idle → preflop → flop → turn → river → showdown → (下一局)
 *
 * 每个下注轮结束的判定：所有未弃牌且未全下的玩家都「已行动」且「下注额相等」。
 * 满足条件时自动翻牌/转牌/河牌。
 */

import { parseCard } from './cards.mjs'
import { evaluate, compareHands } from './hand-evaluator.mjs'
import { distributePot } from './side-pot.mjs'

export const PHASE = {
  IDLE: 'idle',
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
}

/** 每个阶段要翻几张公共牌 */
export const PHASE_CARDS = { flop: 3, turn: 1, river: 1 }

/** 阶段顺序 */
const PHASE_ORDER = [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER, PHASE.SHOWDOWN]

/** 动作中文标签，供 UI 展示 */
export const ACTION_LABEL = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  bet: '下注',
  raise: '加注',
  allin: '全下',
}

/**
 * 从庄家位开始，按座位顺序找下一个还能行动的玩家
 * @param {Array} seats 座位数组
 * @param {number} fromIndex 起始座位索引（不含）
 * @returns {number|null} 座位索引，找不到返回 null
 */
function nextActiveSeat(seats, fromIndex) {
  const n = seats.length
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n
    const s = seats[idx]
    if (!s.folded && !s.allIn && s.seeds > 0) return idx
  }
  return null
}

/**
 * 判断下注轮是否结束
 *
 * 结束条件：除已弃牌/全下的玩家外，所有人都已行动过，且下注额都与 currentBet 相等。
 * 特殊情况：只剩一个能行动的玩家时也结束（其他人都弃牌了）。
 */
function isBettingRoundComplete(seats, currentBet, actedUids, startUid) {
  const live = seats.filter((s) => !s.folded && !s.allIn && s.seeds > 0)

  // 没人能行动（全弃或全下）→ 结束
  if (live.length === 0) return true

  // 只剩一个能行动 → 结束（其他人全弃了）
  if (live.length === 1) return true

  // 所有人都已行动且下注对齐
  const allActed = live.every((s) => actedUids.includes(s.uid))
  const allMatched = live.every((s) => s.bet === currentBet)
  return allActed && allMatched
}

/**
 * 初始化一局
 *
 * @param {Object} cfg
 * @param {Array<{uid:string,nickname:string,avatar:number,seeds:number}>} cfg.players
 * @param {number} cfg.smallBlind
 * @param {number} cfg.bigBlind
 * @param {'long'|'short'} cfg.gameType
 * @param {string} cfg.dealerUid 上局庄家，用于轮转盲注位
 * @param {number} cfg.roundNo
 * @param {string[]} cfg.deck 已洗好的牌堆
 * @returns {Object} 初始状态
 */
export function initHand({ players, smallBlind, bigBlind, gameType, dealerUid, roundNo, deck }) {
  if (players.length < 2) throw new Error('至少需要 2 名玩家')
  if (bigBlind <= smallBlind) throw new Error('大麦必须大于小麦')

  const seats = players.map((p, i) => ({
    ...p,
    seatNo: i,
    bet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
    isTurn: false,
  }))

  // 庄家位轮转
  const prevDealerIdx = dealerUid ? seats.findIndex((s) => s.uid === dealerUid) : -1
  const dealerIdx = prevDealerIdx >= 0 ? (prevDealerIdx + 1) % seats.length : 0

  // 双人局（heads-up）：庄家是小盲，另一人是大盲
  // 多人局：庄家左手第一个是小盲，第二个是大盲
  let sbIdx, bbIdx
  if (seats.length === 2) {
    sbIdx = dealerIdx
    bbIdx = (dealerIdx + 1) % 2
  } else {
    sbIdx = (dealerIdx + 1) % seats.length
    bbIdx = (dealerIdx + 2) % seats.length
  }

  const state = {
    phase: PHASE.PREFLOP,
    roundNo,
    gameType,
    smallBlind,
    bigBlind,
    dealerUid: seats[dealerIdx].uid,
    seats,
    communityCards: [],
    pot: 0,
    currentBet: 0,
    minRaise: bigBlind,
    turnUid: null,
    lastAggressorUid: null,
    actedUids: [],
    deck: [...deck],
    dealt: 0,
    // 行动流水：{uid, nickname, type, amount, phase}，最新在末尾
    // amount 对 fold/check 为 0；对 call/bet/raise/allin 为该动作投入的总额
    actionLog: [],
    finished: false,
  }

  // 扣盲注
  postBlind(state, seats[sbIdx], smallBlind)
  postBlind(state, seats[bbIdx], bigBlind)

  state.currentBet = bigBlind
  state.minRaise = bigBlind

  // 翻牌前从庄家左手第三个开始行动（双人局从庄家/小盲开始）
  const firstActorIdx =
    seats.length === 2 ? sbIdx : (bbIdx + 1) % seats.length
  state.turnUid = seats[firstActorIdx].uid
  seats[firstActorIdx].isTurn = true

  return state
}

/** 下盲注（可能因筹码不足而变成部分全下） */
function postBlind(state, seat, amount) {
  const actual = Math.min(amount, seat.seeds)
  seat.seeds -= actual
  seat.bet += actual
  seat.totalBet += actual
  state.pot += actual
  if (seat.seeds === 0) seat.allIn = true
}

/**
 * 发底牌：每人 2 张
 * @returns {Record<string, string[]>} uid → 底牌
 */
export function dealHoleCards(state) {
  const hands = {}
  const order = state.seats.map((s) => s.uid)

  // 标准发牌顺序：从庄家左手第一个开始，每人一张发两轮
  for (let round = 0; round < 2; round++) {
    for (const uid of order) {
      if (!hands[uid]) hands[uid] = []
      hands[uid].push(state.deck[state.dealt++])
    }
  }
  return hands
}

/**
 * 从牌堆顶部取 n 张牌
 */
function drawFromDeck(state, n) {
  const cards = []
  for (let i = 0; i < n; i++) cards.push(state.deck[state.dealt++])
  return cards
}

/**
 * 深拷贝为普通对象。
 *
 * 不能用 structuredClone：Vue 的 reactive/ref 代理对象会被它拒绝（DataCloneError），
 * 而前端会把 state 以 ref 形式直接传进来。JSON 往返对本项目的纯数据 state 足够，
 * 且能顺便剥掉 Proxy。
 */
function plainClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

/**
 * 玩家行动
 *
 * @param {Object} state 当前状态（不会被修改）
 * @param {Object} action
 * @param {string} action.uid 行动玩家
 * @param {'fold'|'check'|'call'|'bet'|'raise'|'allin'} action.type
 * @param {number} [action.amount] raise/bet 的目标总额（不含已下的）
 * @returns {Object} { state, error? }
 */
export function applyAction(state, { uid, type, amount }) {
  // 入口先普通化，兼容 Vue reactive 代理
  state = plainClone(state)

  const seat = state.seats.find((s) => s.uid === uid)
  if (!seat) return { error: '玩家不在此房间' }
  if (state.turnUid !== uid) return { error: '还没轮到你行动' }
  if (seat.folded) return { error: '你已弃牌' }
  if (seat.allIn) return { error: '你已全下' }

  // 深拷贝，保证纯函数
  const next = structuredClone(state)
  const s = next.seats.find((x) => x.uid === uid)

  const toCall = next.currentBet - s.bet
  const prevCurrentBet = next.currentBet // 记录修改前的注额，用于区分 bet / raise
  const seedsBefore = s.seeds

  /** 记录一条行动流水（在本动作成功后调用） */
  const logAction = (t, committed) => {
    next.actionLog.push({
      uid,
      nickname: s.nickname,
      type: t,
      amount: committed,          // 该动作实际投入的筹码
      betTotal: s.bet,            // 该玩家本轮累计下注额
      phase: next.phase,
      at: next.actionLog.length,
    })
  }

  switch (type) {
    case 'fold': {
      s.folded = true
      s.isTurn = false
      logAction('fold', 0)
      break
    }

    case 'check': {
      if (toCall > 0) return { error: `当前需要跟注 ${toCall}` }
      s.isTurn = false
      logAction('check', 0)
      break
    }

    case 'call': {
      if (toCall <= 0) return { error: '无需跟注，可以过牌' }
      const actual = Math.min(toCall, s.seeds)
      s.seeds -= actual
      s.bet += actual
      s.totalBet += actual
      next.pot += actual
      if (s.seeds === 0) s.allIn = true
      s.isTurn = false
      logAction('call', actual)
      break
    }

    case 'bet':
    case 'raise': {
      // 目标总额 = 本轮想下到的总金额（跟注部分 + 加注部分）
      const targetTotal = Number(amount)
      if (!Number.isFinite(targetTotal) || targetTotal <= 0) return { error: '加注金额无效' }
      if (targetTotal <= next.currentBet) return { error: '加注金额必须大于当前注额' }

      const raiseSize = targetTotal - next.currentBet
      if (raiseSize < next.minRaise) {
        return { error: `最小加注额为 ${next.minRaise}` }
      }

      const need = targetTotal - s.bet
      if (need > s.seeds) return { error: '筹码不足，只能全下' }

      s.seeds -= need
      s.bet += need
      s.totalBet += need
      next.pot += need
      if (s.seeds === 0) s.allIn = true

      // 本回合是否已有注：没有就是 bet（首注），有就是 raise（加注）
      const isRaise = prevCurrentBet > 0
      const recordedType = isRaise ? 'raise' : 'bet'

      next.currentBet = targetTotal
      next.minRaise = raiseSize
      next.lastAggressorUid = uid
      // 有人加注 → 其他人要重新行动
      next.actedUids = [uid]
      s.isTurn = false
      logAction(recordedType, need)
      break
    }

    case 'allin': {
      const actual = s.seeds // 全下就是全部剩余筹码
      s.bet += actual
      s.totalBet += actual
      next.pot += actual
      s.seeds = 0
      s.allIn = true

      if (s.bet > next.currentBet) {
        const raiseSize = s.bet - next.currentBet
        if (raiseSize >= next.minRaise) next.minRaise = raiseSize
        next.currentBet = Math.max(next.currentBet, s.bet)
        next.lastAggressorUid = uid
        next.actedUids = [uid]
      }
      s.isTurn = false
      logAction('allin', actual)
      break
    }

    default:
      return { error: `未知行动: ${type}` }
  }

  // 记录已行动
  if (!next.actedUids.includes(uid)) next.actedUids.push(uid)

  // 推进状态机
  advance(next)

  return { state: next }
}

/**
 * 推进到下一状态：决定下一个行动者，或翻牌，或摊牌
 */
function advance(state) {
  // 检查是否只剩一个未弃牌玩家 → 直接结束，无需摊牌
  const live = state.seats.filter((s) => !s.folded)
  if (live.length === 1) {
    state.phase = PHASE.SHOWDOWN
    state.turnUid = null
    state.seats.forEach((s) => (s.isTurn = false))
    state.finished = true
    return
  }

  // 检查下注轮是否结束
  if (isBettingRoundComplete(state.seats, state.currentBet, state.actedUids, state.turnUid)) {
    // 进入下一阶段
    const nextPhaseIdx = PHASE_ORDER.indexOf(state.phase) + 1
    state.phase = PHASE_ORDER[nextPhaseIdx]

    // 重置本轮下注额（totalBet 保留，用于算边池）
    state.seats.forEach((s) => {
      s.bet = 0
      s.isTurn = false
    })
    state.actedUids = []
    state.currentBet = 0
    state.minRaise = state.bigBlind

    // 翻公共牌
    if (PHASE_CARDS[state.phase]) {
      state.communityCards.push(...drawFromDeck(state, PHASE_CARDS[state.phase]))
    }

    if (state.phase === PHASE.SHOWDOWN) {
      state.turnUid = null
      state.finished = true
      return
    }

    // 从庄家左手第一个未弃牌未全下玩家开始
    const dealerIdx = state.seats.findIndex((s) => s.uid === state.dealerUid)
    const firstIdx = nextActiveSeat(state.seats, dealerIdx)
    if (firstIdx === null) {
      // 没人能行动（全下了）→ 直接发完公共牌到河牌
      runOutBoard(state)
      return
    }
    state.turnUid = state.seats[firstIdx].uid
    state.seats[firstIdx].isTurn = true
  } else {
    // 下注轮继续，找下一个行动者
    const curIdx = state.seats.findIndex((s) => s.uid === state.turnUid)
    const nextIdx = nextActiveSeat(state.seats, curIdx)
    if (nextIdx === null) {
      // 理论上不会到这里（上面已判过只剩一个能行动）
      state.turnUid = null
      return
    }
    state.seats.forEach((s) => (s.isTurn = false))
    state.turnUid = state.seats[nextIdx].uid
    state.seats[nextIdx].isTurn = true
  }
}

/**
 * 剩余玩家全部全下时，把公共牌直接发完
 */
function runOutBoard(state) {
  while (state.phase !== PHASE.RIVER) {
    const nextIdx = PHASE_ORDER.indexOf(state.phase) + 1
    state.phase = PHASE_ORDER[nextIdx]
    if (PHASE_CARDS[state.phase]) {
      state.communityCards.push(...drawFromDeck(state, PHASE_CARDS[state.phase]))
    }
  }
  state.phase = PHASE.SHOWDOWN
  state.turnUid = null
  state.finished = true
}

/**
 * 摊牌结算
 *
 * @param {Object} state
 * @param {Record<string, string[]>} holeCards uid → 底牌
 * @returns {Object} {
 *   winnings: Array<{uid, amount, layerIndex}>,
 *   hands: Array<{uid, nickname, hand, hole, cards, isWinner, won}>,
 *   pot: number
 * }
 */
export function showdown(state, holeCards) {
  const contributors = state.seats.map((s) => ({
    uid: s.uid,
    totalBet: s.totalBet,
    folded: s.folded,
  }))

  // 只给未弃牌玩家评估牌型
  const hands = {}
  for (const s of state.seats) {
    if (s.folded) continue
    const hole = holeCards[s.uid]
    if (!hole) throw new Error(`缺少玩家 ${s.uid} 的底牌`)
    const all = [...hole, ...state.communityCards]
    // 公共牌不足 5 张时无法比牌（例如其他人全弃牌，直接取胜）
    if (all.length >= 5) {
      hands[s.uid] = evaluate(all, state.gameType)
    }
  }

  const winnings = distributePot(
    contributors,
    (uid) => hands[uid],
    compareHands
  )

  const wonMap = Object.fromEntries(winnings.map((w) => [w.uid, w.amount]))

  return {
    pot: state.pot,
    winnings,
    hands: state.seats.map((s) => ({
      uid: s.uid,
      nickname: s.nickname,
      folded: s.folded,
      hole: holeCards[s.uid] ?? [],
      hand: hands[s.uid] ?? null,
      cards: hands[s.uid]?.cards ?? [],
      isWinner: !!wonMap[s.uid],
      won: wonMap[s.uid] ?? 0,
    })),
  }
}

/** 加注快捷档位（与线下计分一致） */
export const RAISE_PRESETS = [5, 10, 20, 50, 100, 500]

/**
 * 计算当前可用的加注档位。
 *
 * 每个档位给出「目标下注总额」（不是加注增量），
 * 这样 UI 直接点就能用，不用自己算 toCall + increment。
 *
 * @returns {Array<{increment:number, targetTotal:number, label:string, affordable:boolean}>}
 */
export function raiseOptions(state, uid) {
  const seat = state.seats.find((s) => s.uid === uid)
  if (!seat) return []
  const myMax = seat.bet + seat.seeds // 我最多能下到的总额

  const options = []
  for (const inc of RAISE_PRESETS) {
    // 必须满足最小加注额，否则会被 applyAction 拒绝
    if (inc < state.minRaise) continue
    const targetTotal = state.currentBet + inc
    const need = targetTotal - seat.bet
    options.push({
      increment: inc,
      targetTotal,
      label: `+${inc}`,
      affordable: need <= seat.seeds && targetTotal <= myMax,
    })
  }

  // 全下档位（若未被上面的档位覆盖）
  const allInTotal = seat.bet + seat.seeds
  const alreadyCovered = options.some((o) => o.targetTotal === allInTotal)
  if (!alreadyCovered && allInTotal > state.currentBet) {
    options.push({
      increment: allInTotal - state.currentBet,
      targetTotal: allInTotal,
      label: '全下',
      affordable: true,
      isAllIn: true,
    })
  }

  return options
}

/**
 * 获取玩家当前可执行的操作
 * @returns {Array<{type:string, label:string, amount?:number}>}
 */
export function availableActions(state, uid) {
  const seat = state.seats.find((s) => s.uid === uid)
  if (!seat || state.turnUid !== uid || seat.folded || seat.allIn) return []

  const toCall = state.currentBet - seat.bet
  const actions = [{ type: 'fold', label: '弃牌' }]

  if (toCall <= 0) {
    actions.push({ type: 'check', label: '过牌' })
  } else if (toCall >= seat.seeds) {
    // 筹码不够全额跟注：仍要提供「跟注」入口（部分跟注 = all-in call），
    // 否则玩家只剩「弃牌」一个选择，不符合德州规则
    actions.push({ type: 'call', label: `跟注 ${seat.seeds}` })
  } else {
    actions.push({ type: 'call', label: `跟注 ${toCall}` })
  }

  // 加注：需要 当前注 + 最小加注 <= 自己全部筹码
  const minRaiseTotal = state.currentBet + state.minRaise
  if (seat.bet + seat.seeds > minRaiseTotal) {
    actions.push({ type: 'raise', label: '加注', amount: minRaiseTotal })
  }
  // 全下始终可用（只要有筹码）
  if (seat.seeds > 0) {
    actions.push({ type: 'allin', label: '全下' })
  }

  return actions
}
