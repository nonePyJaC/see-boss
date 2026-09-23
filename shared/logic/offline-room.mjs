/**
 * 线下计分引擎 — 只记瓜子，不发牌、不判输赢
 *
 * 与 shared/logic/betting.mjs（完整德州）是两套东西，故意分开：
 *   线下朋友局 = 桌面上的筹码计数仪。没有人发牌，也没有公共牌，
 *   服务端只回答三个问题：
 *     1. 谁下了多少（下注流水 / 每人当前注额）
 *     2. 现在轮到谁决策
 *     3. 有没有人瓜子归零 → 触发结算
 *
 * 「街道」在这里只是个视觉节拍器：stage ∈ preflop|flop|turn|river，
 * 纯粹给 UI 播花生用（翻前三颗不亮、flop 亮三颗、turn 第四颗、
 * river 第五颗）。服务端不因为它发任何牌。
 * 换街由房主显式触发（nextStage），或收池后自动回到 preflop。
 *
 * 状态字段（全部可 JSON 序列化，写 PG 快照 / 内存都行）：
 *   players[]  {uid, nickname, avatar, seeds, bet, totalBet, folded, allIn, isTurn}
 *   pot        公共池瓜子数
 *   currentBet 本手当前最高注额（「跟」要补齐到这里）
 *   stage      花生节拍器阶段
 *   turnUid    轮到谁
 *   roundNo    第几手
 *   actionLog  下注流水，最新在末尾
 *   finished   本手是否已被收掉
 */

export const STAGE = {
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
}

/** 花生节拍器：每个阶段亮几颗 */
export const STAGE_PEANUTS = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
}

/** 阶段顺序（收池后回到 preflop） */
const STAGE_ORDER = [STAGE.PREFLOP, STAGE.FLOP, STAGE.TURN, STAGE.RIVER]

export const OFFLINE_ACTION = {
  CALL: 'call',
  RAISE: 'raise',
  FOLD: 'fold',
  COLLECT: 'collect',
}

/** 快捷加注档位（长按【跟】弹出的加注窗用） */
export const RAISE_PRESETS = [10, 20, 50, 100, 300, 500]

/**
 * 建一手。
 *
 * @param {object} cfg
 * @param {Array}  cfg.players   [{uid,nickname,avatar,seeds}]
 * @param {number} cfg.smallBlind
 * @param {number} cfg.bigBlind
 * @param {number} cfg.roundNo
 * @param {string} cfg.dealerUid 上一手庄家，用于定大小麦顺序
 */
export function initOfflineHand({
  players,
  smallBlind = 10,
  bigBlind = 20,
  roundNo = 1,
  dealerUid = null,
}) {
  if (!Array.isArray(players) || players.length < 2) {
    throw new Error('至少需要 2 名玩家')
  }
  const bb = Math.max(1, Number(bigBlind) || 20)
  const sb = Math.max(1, Math.min(Number(smallBlind) || 10, bb))

  // 庄家右手第一家 = 小麦，第二家 = 大麦。第一手没有庄家，按座位顺序。
  // ⚠️ 这里全程用「轮转后的顺序」思考，不再混用原数组下标 ——
  //    早期版本把 order 里的位置和 seats 里的 seatIndex 混着算，
  //    三人局一开就崩（postBlind 拿到 undefined）。
  let rotated = players.slice()
  if (dealerUid) {
    const d = rotated.findIndex((p) => p.uid === dealerUid)
    if (d >= 0) rotated = [...rotated.slice(d + 1), ...rotated.slice(0, d + 1)]
  }

  const seats = players.map((p, i) => ({
    uid: p.uid,
    nickname: p.nickname ?? '匿名',
    avatar: p.avatar ?? 1,
    seeds: Math.max(0, Number(p.seeds) || 0),
    bet: 0,
    totalBet: 0,
    blind: null,
    folded: false,
    allIn: false,
    isTurn: false,
    joinedAt: p.joinedAt ?? null,
    seatIndex: i,
  }))

  const state = {
    stage: STAGE.PREFLOP,
    pot: 0,
    currentBet: 0,
    // ⚠️ seats 必须挂在 state 上。
    // postBlind / setTurn 改的是这个数组，不挂上去调用方
    // 拿到的是没有 seats 的状态，所有动作都会「你不在这个房间」。
    seats,
    turnUid: null,
    roundNo,
    actionLog: [],
    finished: false,
    lastAggressorUid: null,
    // 本下注轮里已经「回应过当前注额」的人。
    // 没有它就无法区分「已满注但还没表态」和「已表态」——
    // 大小麦是自动下的，他们从没表态过，必须给一次机会。
    actedUids: [],
  }

  // 自动下大小麦（沿用现行行为：开局自动扣）
  // 两人局：庄家下小麦、同时下大麦（ Heads-up 规则简化）
  // 多人局：第一家小麦、第二家大麦
  const twoHeads = seats.length === 2
  const sbSeat = seats.find((s) => s.uid === rotated[0].uid)
  const bbSeat = twoHeads ? sbSeat : seats.find((s) => s.uid === rotated[1].uid)

  postBlind(state, sbSeat, sb, 'sb')
  postBlind(state, bbSeat, bb, 'bb')

  // 翻前第一家行动：大麦下家；两人局从小麦开始
  const firstUid = twoHeads
    ? sbSeat.uid
    : bbSeat.uid === null
      ? null
      : seats[(seats.indexOf(bbSeat) + 1) % seats.length].uid
  setTurn(state, seats, firstUid)

  return state
}

function postBlind(state, seat, amount, blind) {
  const actual = Math.min(amount, seat.seeds)
  seat.seeds -= actual
  seat.bet += actual
  seat.totalBet += actual
  seat.blind = blind
  state.pot += actual
  if (seat.seeds === 0) seat.allIn = true
  if (seat.bet > state.currentBet) state.currentBet = seat.bet
  state.actionLog.push({
    uid: seat.uid,
    nickname: seat.nickname,
    type: 'blind',
    amount: actual,
    blind,
    stage: state.stage,
  })
}

function setTurn(state, seats, uid) {
  for (const s of seats) s.isTurn = s.uid === uid
  state.turnUid = uid
}

/**
 * 标记某人已表态（call / raise / fold 之后调用）。
 * 加注会重置行动轮：除加注者外，其他人都要重新决定。
 */
function markActed(state, uid, { reset } = {}) {
  if (reset) state.actedUids = []
  if (!state.actedUids.includes(uid)) state.actedUids.push(uid)
}

/** 下一个该行动的人：未弃牌、未全下、且有行动义务（未满注或未表态） */
function nextActor(state, seats, fromUid) {
  const from = seats.findIndex((s) => s.uid === fromUid)
  const start = from < 0 ? 0 : from
  const needsAct = (s) =>
    !s.folded && !s.allIn && s.seeds > 0 &&
    (s.bet < state.currentBet || !state.actedUids.includes(s.uid))
  for (let step = 1; step <= seats.length; step++) {
    const s = seats[(start + step) % seats.length]
    if (needsAct(s)) return s
  }
  // 没人欠行动 → 交给第一个还能自主决定的人（通常是收池）
  return seats.find((s) => !s.folded && !s.allIn && s.seeds > 0) ?? null
}

/** 未弃牌的玩家（含全下） */
export function activePlayers(seats) {
  return (seats ?? []).filter((s) => !s.folded)
}

/**
 * 本手是否已无悬念：所有人都已表态（满注且 acted），或只剩 1 人未弃牌。
 *
 * 「已表态」= 注额补齐到 currentBet 且 uid 在 actedUids 里。
 * 大小麦是自动下的，不算表态，所以他们必须有一次行动机会 ——
 * 这是没有 actedUids 时最大的坑：大麦满注却被判为已结束。
 */
export function handResolved(state) {
  const st = normalize(state)
  const alive = st.seats.filter((s) => !s.folded)
  if (alive.length <= 1) return true
  const owes = alive.filter(
    (s) => !s.allIn && s.seeds > 0 && (s.bet < st.currentBet || !st.actedUids.includes(s.uid))
  )
  return owes.length === 0
}

/** 把纯 JSON 快照补成内部结构（restore 时用） */
function normalize(state) {
  return {
    ...state,
    actedUids: Array.isArray(state.actedUids) ? state.actedUids : [],
    seats: (state.seats ?? []).map((s) => ({ ...s })),
  }
}

/**
 * 当前 viewer 还需要跟多少。
 * 前端「跟」按钮直接显示这个数。
 */
export function toCall(state, uid) {
  const st = normalize(state)
  const me = st.seats.find((s) => s.uid === uid)
  if (!me || me.folded || me.allIn) return 0
  return Math.max(0, st.currentBet - me.bet)
}

/**
 * viewer 能做什么。
 *
 * 只在自己的回合返回非空数组（服务端强校验，这里只是给 UI 用）。
 */
export function availableActions(state, uid) {
  const st = normalize(state)
  if (st.finished) return []
  if (st.turnUid !== uid) return []
  const me = st.seats.find((s) => s.uid === uid)
  if (!me || me.folded || me.allIn) return []
  // 只剩自己没弃牌时不给操作，由服务端自动收
  if (activePlayers(st.seats).length <= 1) return []

  const call = toCall(st, uid)
  return [
    { type: 'collect', label: '收', enabled: true },
    { type: 'call', label: '跟', amount: call, enabled: call <= me.seeds },
    { type: 'raise', label: '倍', enabled: me.seeds > call },
    { type: 'fold', label: '弃', enabled: true },
  ]
}

/**
 * 执行一个动作。
 *
 * 返回 { state } 或 { error }。绝不抛异常 —— 调用方按 error 字段处理。
 *
 * @param {object} state  当前状态（会被深拷贝，不改原对象）
 * @param {{uid:string, type:string, amount?:number}} action
 */
export function applyOfflineAction(state, action) {
  const uid = action?.uid
  const type = action?.type
  if (!uid) return { error: '缺少 uid' }
  const st = normalize(state)

  const me = st.seats.find((s) => s.uid === uid)
  if (!me) return { error: '你不在这个房间' }

  // 本手已收掉之后，只剩「收空池」这一类无意义动作，
  // 所以先放行 collect 让它自己报「公共池是空的」，
  // 其余动作（call/raise/fold）一律拒绝。
  if (st.finished && type !== 'collect') return { error: '本手已结束' }

  if (me.folded) return { error: '你已经弃牌' }
  if (me.allIn) return { error: '你已经全下' }

  switch (type) {
    case 'fold': {
      if (st.turnUid !== uid) return { error: '还没到你的回合' }
      me.folded = true
      markActed(st, uid)
      st.actionLog.push({ uid, nickname: me.nickname, type: 'fold', amount: 0, stage: st.stage })
      return afterMove(st, uid)
    }

    case 'call': {
      if (st.turnUid !== uid) return { error: '还没到你的回合' }
      const need = toCall(st, uid)
      if (need <= 0) return { error: '当前无需跟注' }
      const pay = Math.min(need, me.seeds)
      moveIn(st, me, pay)
      markActed(st, uid)
      st.actionLog.push({
        uid, nickname: me.nickname, type: 'call', amount: pay,
        allIn: pay < need, stage: st.stage,
      })
      if (pay === need) st.lastAggressorUid = uid
      return afterMove(st, uid)
    }

    case 'raise': {
      if (st.turnUid !== uid) return { error: '还没到你的回合' }
      const extra = Number(action.amount)
      if (!Number.isFinite(extra) || extra <= 0) return { error: '加注数量无效' }
      const need = toCall(st, uid)
      // 语义：跟注 + 额外加注。上家下 100，我点加注 50 → 我这手共 150
      const want = need + extra
      if (want > me.seeds) return { error: '超出我的瓜子，最多全下' }
      moveIn(st, me, need)
      moveIn(st, me, extra)
      st.currentBet = me.bet
      st.actionLog.push({
        uid, nickname: me.nickname, type: 'raise', amount: want,
        called: need, extra, stage: st.stage,
      })
      st.lastAggressorUid = uid
      // 加注 = 行动轮重置：其他人要重新表态
      markActed(st, uid, { reset: true })
      return afterMove(st, uid)
    }

    case 'collect': {
      // 收池不需要等回合：桌面上的公共池谁都可以收走
      // （线下场景经常是「凑巧坐在旁边的人顺手收一下」）
      // 也不要求 finished —— 全下打完之后 handResolved 已真，
      // 但还要有人动手把池子收干净，所以这里放行。
      const taker = me
      const pot = st.pot
      if (pot <= 0) return { error: '公共池是空的' }
      taker.seeds += pot
      st.actionLog.push({
        uid, nickname: me.nickname, type: 'collect', amount: pot, stage: st.stage,
      })
      st.pot = 0
      st.finished = true
      st.turnUid = null
      for (const s of st.seats) { s.isTurn = false; s.bet = 0 }
      return { state: st, collected: { uid, amount: pot } }
    }

    default:
      return { error: '未知动作：' + type }
  }
}

function moveIn(st, seat, amount) {
  const actual = Math.min(amount, seat.seeds)
  seat.seeds -= actual
  seat.bet += actual
  seat.totalBet += actual
  st.pot += actual
  if (seat.seeds === 0) seat.allIn = true
  if (seat.bet > st.currentBet) st.currentBet = seat.bet
}

/** 一次行动之后：推进回合 / 判断是否本手已了 */
function afterMove(st, uid) {
  if (handResolved(st)) {
    // 只剩 1 人未弃牌 → 自动替他收池
    const alive = st.seats.filter((s) => !s.folded)
    if (alive.length === 1 && st.pot > 0) {
      const w = alive[0]
      w.seeds += st.pot
      st.actionLog.push({
        uid: w.uid, nickname: w.nickname, type: 'collect',
        amount: st.pot, auto: true, stage: st.stage,
      })
      st.pot = 0
      st.finished = true
      st.turnUid = null
      for (const s of st.seats) { s.isTurn = false; s.bet = 0 }
      return { state: st, autoCollected: { uid: w.uid } }
    }
    // 其他情况（全下结束）：停在这，等有人点「收」
    st.turnUid = null
    for (const s of st.seats) s.isTurn = false
    return { state: st }
  }

  const next = nextActor(st, st.seats, uid)
  setTurn(st, st.seats, next?.uid ?? null)
  return { state: st }
}

/**
 * 换街：只推进花生节拍器，不发牌。
 * 收池后由 nextHand 重置回 preflop。
 */
export function nextStage(state) {
  const st = normalize(state)
  const i = STAGE_ORDER.indexOf(st.stage)
  st.stage = STAGE_ORDER[Math.min(i + 1, STAGE_ORDER.length - 1)]
  return st
}

/**
 * 收池后开下一手：
 *   · 阶段回 preflop（花生重新灭）
 *   · bet 全清，totalBet 累计
 *   · 不清 folded —— 由房主在结算弹窗里决定重置范围
 */
export function nextHand(state) {
  const st = normalize(state)
  st.stage = STAGE.PREFLOP
  st.finished = false
  st.currentBet = 0
  st.lastAggressorUid = null
  st.actedUids = []
  st.actionLog = []
  for (const s of st.seats) {
    s.bet = 0
    s.folded = false
    s.allIn = false
    s.blind = null
  }
  return st
}
