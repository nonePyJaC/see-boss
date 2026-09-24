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
 * ── 回合规则（2026-09-23 定稿，按真实下注节奏）──
 *
 * 按钮按「我的注额 vs 本街最高注额」动态决定，不是固定三个：
 *   我的注额 < currentBet  → 加倍 / 弃   （补不满就不能过）
 *   我的注额 = currentBet  → check / 加倍 / 弃
 *   收池独立成键，任何时刻谁都能点（不是回合决策）
 *
 * 推进下一街（花生 +1）的判据：
 *   转完一圈 + 除弃牌者外所有人都平注了。
 *   不靠房主手动点，全是玩家行动自然推动。
 *
 * 每街第一个行动的人 = 小麦位（房主只指定小麦，下家自动大麦）。
 *
 * ── 大小麦 ──
 * 开局由房主指定小麦位（sbIndex），下家自动是大麦。
 * 自动下大小麦，下完从小麦下家开始 preflop 行动轮。
 *
 * 「街道」只是花生节拍器：stage ∈ preflop|flop|turn|river，
 * 亮 0/3/4/5 颗。服务端不因为它发任何牌。
 *
 * 状态字段（全部可 JSON 序列化）：
 *   seats[]     {uid, nickname, avatar, seeds, bet, totalBet, blind,
 *                folded, allIn, isTurn, acted}
 *   pot         公共池瓜子数
 *   currentBet  本街当前最高注额
 *   stage       preflop | flop | turn | river
 *   turnUid     轮到谁
 *   sbIndex     小麦位索引（房主指定）
 *   roundNo     第几手
 *   actionLog   下注流水，最新在末尾（= 前端的 betLog）
 *   finished    本手是否已被收掉
 *   actedUids   本街已表态的人（没有它就分不出「满注未动」和「已动」）
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
 * @param {number} cfg.sbIndex   小麦位索引（房主指定）；缺省 0
 *
 * 房主只需指定小麦位，下家自动是大麦（玩家原话）。
 */
export function initOfflineHand({
  players,
  smallBlind = 10,
  bigBlind = 20,
  roundNo = 1,
  sbIndex = 0,
}) {
  if (!Array.isArray(players) || players.length < 2) {
    throw new Error('至少需要 2 名玩家')
  }
  const bb = Math.max(1, Number(bigBlind) || 20)
  const sb = Math.max(1, Math.min(Number(smallBlind) || 10, bb))

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
    acted: false,
    seatIndex: i,
  }))

  // 小麦位校验：必须是有效座位
  let sbIdx = Number(sbIndex)
  if (!Number.isInteger(sbIdx) || sbIdx < 0 || sbIdx >= seats.length) sbIdx = 0
  const bbIdx = (sbIdx + 1) % seats.length

  const state = {
    stage: STAGE.PREFLOP,
    pot: 0,
    currentBet: 0,
    // ⚠️ seats 必须挂在 state 上。不挂上去调用方拿到的是
    // 没有 seats 的状态，所有动作都会「你不在这个房间」。
    seats,
    turnUid: null,
    sbIndex: sbIdx,
    roundNo,
    actionLog: [],
    finished: false,
    lastAggressorUid: null,
    actedUids: [],
  }

  // 自动下大小麦
  postBlind(state, seats[sbIdx], sb, 'sb')
  postBlind(state, seats[bbIdx], bb, 'bb')

  // preflop 第一个行动的人：
  //   · 多人局：大麦下家
  //   · 两人局：小麦（Heads-up 规则）
  const firstIdx = seats.length === 2 ? sbIdx : (bbIdx + 1) % seats.length
  setTurn(state, seats, seats[firstIdx].uid)

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

/**
 * 下一个该行动的人：未弃牌、未全下、且有行动义务（未满注或未表态）。
 *
 * ⚠️ 关键：没人欠行动时必须返回 null，不能 fallback 到
 *    「第一个还能自主决定的人」。上一版就是 fallback 了，
 *    结果走完一圈后 nextActor 返回非 null，afterMove 判断不到
 *    「本街已结束」，花生永远推不下去。
 *    调用方（afterMove）靠 null 来触发换街。
 */
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
  return null
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
 * viewer 能做什么 —— 按「我的注额 vs 本街最高注额」动态决定。
 *
 * 玩家原话：翻牌前小麦大麦自动下完后，下家只有「加倍/弃」，
 * 一路轮到大盲位；大盲行动完才进下一街，轮到小麦位时才有 check。
 * 所以按钮不是固定的三个，而是：
 *
 *   我的注额 < currentBet  → 加倍 / 弃        （补不满不能过）
 *   我的注额 = currentBet  → check / 加倍 / 弃
 *
 * 「收」不占三键之一 —— 它是中性动作，任何时刻谁都能点，
 * 由服务端单独处理，不进回合决策。
 *
 * @returns {Array<{type,label,amount?,enabled}>} 不是自己的回合返回 []
 */
export function availableActions(state, uid) {
  const st = normalize(state)
  if (st.finished) return []

  const me = st.seats.find((s) => s.uid === uid)
  if (!me) return []

  // 「收」是独立中性键，不占回合决策位：桌面上的公共池谁都可以
  // 顺手收走（输光的人、旁边看牌的人、还没轮到的）。
  // 所以 collect 必须在 turnUid 判断之前就给，否则非回合者拿到空数组、
  // 按钮全灰，桌上只有轮到的那一个人能收池。
  // 唯一条件：池子不是 0。
  const collect = [{ type: 'collect', label: '收', enabled: st.pot > 0 }]

  if (st.turnUid !== uid) return collect
  if (me.folded || me.allIn) return collect
  // 只剩自己没弃牌 → 不给下注操作，服务端会自动收池
  if (activePlayers(st.seats).length <= 1) return collect
  // 暂停中：手动模式，出/收自由，不构成回合
  if (st.paused) return collect

  const need = toCall(st, uid)          // 还需补多少才平注
  const out = [...collect]

  if (need <= 0) {
    // 已平注 → 可以过牌
    out.push({ type: 'check', label: '过', enabled: true })
  } else {
    // 未平注 → 只能跟/加注，不能过
    out.push({
      type: 'call', label: '跟', amount: need,
      enabled: need <= me.seeds,
      // 我的瓜子不够平注时，这一下实际上是全下
      allIn: need > me.seeds,
    })
  }

  out.push({ type: 'raise', label: '加倍', enabled: me.seeds > need })
  out.push({ type: 'fold', label: '弃', enabled: true })
  return out
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

  // 本手已收掉之后，只剩「收空池」和「暂停中划拨」两类动作有意义：
  // collect 放行后自己报「公共池是空的」；give 内部自查 paused。
  if (st.finished && type !== 'collect' && type !== 'give') return { error: '本手已结束' }

  // 弃牌者本回合不再操作，但「收」「暂停中划拨」是中性动作，放行。
  if (me.folded && type !== 'collect' && type !== 'give') return { error: '你已经弃牌' }
  // 全下不能再投注，但「收池」「划拨」放行 ——
  // 线下常见「输光的人顺手把池子收了」，拦住了他就没法推进对局。
  if (me.allIn && type !== 'collect' && type !== 'give') return { error: '你已经全下' }

  switch (type) {
    case 'fold': {
      // 弃牌不分是否轮到决策：离场 = 弃牌，随时可以。
      me.folded = true
      markActed(st, uid)
      st.actionLog.push({ uid, nickname: me.nickname, type: 'fold', amount: 0, stage: st.stage })
      if (st.turnUid === uid) return afterMove(st, uid)
      // 非本人回合：回合仍属当前行动者，只判「是否只剩 1 人存活」
      return endIfLastAlive(st) ?? { state: st }
    }

    case 'give': {
      // 暂停中手动划拨：「AB all-in 归零、A 收走后分一半给 B」的场景。
      // 只在 paused 开放，正常对局里不允许（否则会绕过下注规则）。
      if (!st.paused) return { error: '只有暂停中才能手动划拨瓜子' }
      const to = st.seats.find((s) => s.uid === action.toUid)
      if (!to) return { error: '找不到目标玩家' }
      if (to.uid === uid) return { error: '不能拨给自己' }
      const amt = Math.floor(Number(action.amount))
      if (!Number.isFinite(amt) || amt <= 0) return { error: '划拨数量无效' }
      if (amt > me.seeds) return { error: `瓜子不足（有 ${me.seeds}）` }
      me.seeds -= amt
      to.seeds += amt
      st.actionLog.push({
        uid, nickname: me.nickname, type: 'give',
        toUid: to.uid, toName: to.nickname, amount: amt, stage: st.stage,
      })
      return { state: st }
    }

    case 'check': {
      // 过牌：不花钱，但必须已平注。
      // 翻牌前大小麦刚下完时没人能过 —— 这是玩家明确要的规则。
      if (st.turnUid !== uid) return { error: '还没到你的回合' }
      const need = toCall(st, uid)
      if (need > 0) return { error: `还未平注，需补 ${need}` }
      markActed(st, uid)
      st.actionLog.push({ uid, nickname: me.nickname, type: 'check', amount: 0, stage: st.stage })
      return afterMove(st, uid)
    }

    case 'call': {
      if (st.turnUid !== uid) return { error: '还没到你的回合' }
      const need = toCall(st, uid)
      if (need <= 0) return { error: '已经平注，请过牌' }
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

/**
 * 一次行动之后：推进回合 / 换街 / 判断本手是否已了。
 *
 * 顺序很重要：
 *   1. 有人打光 / 只剩一人未弃 → 本手真的结束
 *   2. 这一街下注轮走完（都平注且都表态）→ 自动换街，花生 +1
 *   3. 否则 → 把回合交给下一个欠行动的人
 *
 * ⚠️ 踩过的坑：一开始把「本街已结束」和「本手已结束」混在一个
 *    handResolved 判断里，结果大盲 check 完直接被判成整手结束，
 *    花生永远停在 preflop。两者必须分开 —— 街结束只是换花生，
 *    手结束才涉及收池和结算。
 */
/**
 * 只剩 ≤1 人未弃牌时结束本手：最后存活者自动收池。
 * 返回结果对象；没结束返回 null。
 */
function endIfLastAlive(st) {
  const alive = st.seats.filter((s) => !s.folded)
  if (alive.length > 1) return null
  if (alive.length === 1 && st.pot > 0) {
    const w = alive[0]
    w.seeds += st.pot
    st.actionLog.push({
      uid: w.uid, nickname: w.nickname, type: 'collect',
      amount: st.pot, auto: true, stage: st.stage,
    })
    st.pot = 0
  }
  st.finished = true
  st.turnUid = null
  for (const s of st.seats) { s.isTurn = false; s.bet = 0 }
  return { state: st, autoCollected: alive[0] ? { uid: alive[0].uid } : null }
}

function afterMove(st, uid) {
  // ── 1. 只剩 1 人未弃牌 → 自动替他收池，本手结束 ──
  const end = endIfLastAlive(st)
  if (end) return end

  // ── 2. 本街走完 → 换街 ──
  if (streetClosed(st)) {
    const r = advanceStreet(st)
    if (r.advanced) return { state: r.state, streetAdvanced: r.state.stage }
    // river 已换无可换：停在等人收池
    st.turnUid = null
    for (const s of st.seats) s.isTurn = false
    return { state: st, needCollect: true }
  }

  // ── 3. 还有人欠行动 → 交给他 ──
  const next = nextActor(st, st.seats, uid)
  setTurn(st, st.seats, next?.uid ?? null)
  return { state: st }
}

/**
 * 本街下注轮是否结束：所有人都已表态（含满注的人）。
 *
 * 这是「花生 +1」的判据 —— 玩家原话：
 *   「如果轮询转圈结束，除了弃牌的人都平注了就推进到下一街」
 * 即：有人行动 + 转完一圈 + 没有人还欠行动。
 */
export function streetClosed(state) {
  const st = normalize(state)
  if (st.finished) return false
  // 还有人的注额没平，或者没表态 → 没结束
  const owes = st.seats.filter(
    (s) => !s.folded && !s.allIn && s.seeds > 0 &&
      (s.bet < st.currentBet || !st.actedUids.includes(s.uid))
  )
  return owes.length === 0
}

/**
 * 尝试推进到下一街。
 *
 * 只在 streetClosed 为真时推进，推进后：
 *   · 花生 +1（stage 前进一步）
 *   · 每人 bet 清零（注额计入 totalBet，花生是新一轮的视觉边界）
 *   · actedUids 清空
 *   · 行动轮从小麦位开始
 *
 * 返回 { advanced: boolean, state }。没到时机就不动状态。
 */
export function advanceStreet(state) {
  const st = normalize(state)
  if (!streetClosed(st)) return { advanced: false, state: st }

  const i = STAGE_ORDER.indexOf(st.stage)
  if (i >= STAGE_ORDER.length - 1) {
    // 已经在 river，没有下一街了
    return { advanced: false, state: st, atRiver: true }
  }

  st.stage = STAGE_ORDER[i + 1]
  st.currentBet = 0
  st.actedUids = []
  st.lastAggressorUid = null
  for (const s of st.seats) {
    if (!s.folded) { s.bet = 0; s.acted = false }
  }

  // 每街从小麦位开始（玩家原话）
  const sb = st.seats[st.sbIndex ?? 0]
  const first = st.seats.find((s) => !s.folded && !s.allIn && s.seeds > 0 && s.uid === sb?.uid)
    ?? st.seats.find((s) => !s.folded && !s.allIn && s.seeds > 0)
  setTurn(st, st.seats, first?.uid ?? null)

  st.actionLog.push({ type: 'street', stage: st.stage, amount: 0 })
  return { advanced: true, state: st }
}

/**
 * 换街：只推进花生节拍器，不发牌。保留给房主手动用。
 * 收池后由 nextHand 重置回 preflop。
 */
export function nextStage(state) {
  const st = normalize(state)
  const i = STAGE_ORDER.indexOf(st.stage)
  st.stage = STAGE_ORDER[Math.min(i + 1, STAGE_ORDER.length - 1)]
  return st
}

/**
 * 收池后开下一手。
 *   · 阶段回 preflop（花生重新灭）
 *   · bet / acted / folded 全清，totalBet 累计保留
 *   · 大小麦由下一次开局重新下（房主可重新指定小麦位）
 */
export function nextHand(state) {
  const st = normalize(state)
  st.stage = STAGE.PREFLOP
  st.finished = false
  st.currentBet = 0
  st.lastAggressorUid = null
  st.actedUids = []
  st.actionLog = []
  st.paused = false
  st.settlePending = false
  for (const s of st.seats) {
    s.bet = 0
    s.folded = false
    s.allIn = false
    s.blind = null
    s.acted = false
    s.isTurn = false
  }
  st.turnUid = null
  return st
}
