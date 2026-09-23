/**
 * 仓鼠聚会 — 房间服务（云托管容器）
 *
 * 职责边界（2026-09 架构调整后）：
 *   · 全部房间逻辑都在这里：线下计分 + 线上牌局
 *   · PG 只做数据增删改查（accounts / account_ledger / history /
 *     room_snapshots），不再有任何房间状态机函数
 *   · 容器 = 内存态。退出 / 重启 = 房间消失，靠 PG 快照兜底恢复
 *
 * 两种模式共用一个 rooms Map，用 mode 区分：
 *   offline  线下计分：不洗牌、不发底牌、不摊牌，只记瓜子
 *            → shared/logic/offline-room.mjs
 *   online   线上牌局：完整德州，发底牌 + 公共牌 + 摊牌比牌
 *            → shared/logic/betting.mjs
 *
 * 接口（均 POST，JSON in / JSON out，Bearer JWT 鉴权）：
 *   /api/room/create   建房占 1 号位
 *   /api/room/join     扫码 / 输房间号 / 从列表加入
 *   /api/room/list     可加入的房间列表
 *   /api/room/state    拉状态（前端轮询用）
 *   /api/room/start    开局（offline 自动下大小麦；online 发牌）
 *   /api/room/action   动作：collect / call / raise / fold
 *   /api/room/stage    换街（花生节拍器，offline 专用）
 *   /api/room/settle   结算：金瓜子转账 + 重置 / 解散
 *   /api/room/leave    退出：只删自己，房主退出则删房
 *
 * 约定：不写日志文件、不存任何用户信息到磁盘。
 */

import http from 'node:http'
import crypto from 'node:crypto'

import {
  PHASE,
  initHand,
  dealHoleCards,
  applyAction,
  availableActions,
  showdown,
} from '../shared/logic/betting.mjs'
import { createShuffledDeck } from '../shared/logic/cards.mjs'

import {
  initOfflineHand,
  applyOfflineAction,
  availableActions as offlineActions,
  nextStage as offlineNextStage,
  nextHand as offlineNextHand,
  handResolved,
} from '../shared/logic/offline-room.mjs'

import { buildSettlement, transfersAfterTiePick } from '../shared/logic/settlement.mjs'

const PORT = Number(process.env.PORT) || 80
const MAX_SEATS = 8
/** 请求体上限，防恶意大包打爆内存 */
const MAX_BODY = 16 * 1024
/** 房间空闲超过这个毫秒数就回收（没有 lastActive 写入的话） */
const ROOM_TTL = 60 * 60 * 1000
/** 房间数上限，满了拒绝创建 */
const MAX_ROOMS = 500

/** 内存房间表：roomId -> Room */
const rooms = new Map()

// ── 房间模型 ─────────────────────────────────────────────

/**
 * Room = {
 *   id, mode: 'offline'|'online', gameType, smallBlind, bigBlind, initialSeeds,
 *   hostUid, seats: [{uid,nickname,avatar,seeds,bet,...}],
 *   state,      // 引擎状态（online 含 deck，绝不外泄）
 *   hands,      // online: uid -> [card,card]，仅服务端持有
 *   dealerUid, roundNo, lastActive
 * }
 */
function newRoom({ id, hostUid, host, cfg }) {
  const room = {
    id,
    mode: cfg.mode === 'online' ? 'online' : 'offline',
    gameType: cfg.gameType ?? 'long',
    smallBlind: num(cfg.smallBlind, 10),
    bigBlind: num(cfg.bigBlind, 20),
    initialSeeds: num(cfg.initialSeeds, 3000),
    hostUid,
    seats: [{
      uid: hostUid,
      nickname: host.nickname ?? '匿名',
      avatar: num(host.avatar, 1),
      seeds: num(cfg.initialSeeds, 3000),
    }],
    state: null,
    hands: {},
    dealerUid: null,
    roundNo: 1,
    lastActive: Date.now(),
  }
  // 大麦必须大于小麦，否则开局就乱
  if (room.bigBlind <= room.smallBlind) {
    throw new Error('大麦必须大于小麦')
  }
  rooms.set(id, room)
  return room
}

function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

function genRoomId() {
  if (rooms.size >= MAX_ROOMS) throw new Error('房间数已满，请稍后再试')
  for (let i = 0; i < 50; i++) {
    const id = String(crypto.randomInt(100000, 1000000))
    if (!rooms.has(id)) return id
  }
  throw new Error('房间号分配失败')
}

/** 在线模式才发底牌；线下完全不碰牌 */
function isOnline(room) { return room.mode === 'online' }

/**
 * 客户端可见的房间状态。
 * 绝不外泄 state.deck / room.hands（除自己的底牌）。
 */
function publicState(room, viewerUid) {
  const st = room.state
  const seats = room.seats.map((s) => {
    // online 用引擎里的座位数据，offline 直接读 seats
    const ss = st?.seats?.find((x) => x.uid === s.uid)
    return {
      uid: s.uid,
      nickname: s.nickname,
      avatar: s.avatar,
      seatNo: s.seatNo ?? null,
      seeds: ss?.seeds ?? s.seeds,
      bet: ss?.bet ?? s.bet ?? 0,
      totalBet: ss?.totalBet ?? s.totalBet ?? 0,
      folded: ss?.folded ?? false,
      allIn: ss?.allIn ?? false,
      blind: ss?.blind ?? s.blind ?? null,
      isMe: s.uid === viewerUid,
      isHost: s.uid === room.hostUid,
    }
  })

  const base = {
    id: room.id,
    mode: room.mode,
    seats,
    hostUid: room.hostUid,
    pot: st?.pot ?? 0,
    currentBet: st?.currentBet ?? 0,
    minRaise: st?.minRaise ?? 0,
    turnUid: st?.turnUid ?? null,
    dealerUid: room.dealerUid,
    roundNo: room.roundNo,
    initialSeeds: room.initialSeeds,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    // 轮询探针：有实质变化前端才拉全量（省 CloudBase 调用）
    rev: room.rev ?? 0,
  }

  if (isOnline(room)) {
    base.phase = st?.phase ?? PHASE.IDLE
    base.communityCards = st?.communityCards ?? []
    base.actionLog = (st?.actionLog ?? []).slice(-12)
    base.finished = st?.finished ?? false
    if (room.hands[viewerUid]) base.myCards = room.hands[viewerUid]
    if (st && !st.finished) base.avail = availableActions(st, viewerUid)
    if (st?.finished && st.result) base.result = st.result
  } else {
    // 线下花生节拍器：UI 亮几颗花生，不发牌
    base.stage = st?.stage ?? 'preflop'
    base.finished = st?.finished ?? false
    // 下注流水（收款后由 nextHand 清空）
    base.actionLog = st?.actionLog ?? []
    // 「跟」按钮要显示需跟数量
    base.toCall = viewerUid ? Math.max(0, (st?.currentBet ?? 0) - (st?.seats?.find((x) => x.uid === viewerUid)?.bet ?? 0)) : 0
    if (st && !st.finished) base.avail = offlineActions(st, viewerUid)
    // 是否有人归零 → 前端决定弹不弹结算窗（只给房主弹）
    base.hasZeroSeat = (st?.seats ?? []).some((x) => x.seeds <= 0)
  }

  return base
}

/** 每次改动 rooms 后递增，供前端探针比对手工省流量 */
function touch(room) {
  room.lastActive = Date.now()
  room.rev = (room.rev ?? 0) + 1
}

// ── 接口实现 ────────────────────────────────────────────

function handleCreate(body, uid) {
  const cfg = body?.cfg ?? {}
  const host = body?.me ?? {}
  if (!host.nickname) return fail('缺少昵称')
  const id = genRoomId()
  try {
    newRoom({ id, hostUid: uid, host, cfg })
  } catch (e) {
    return fail(e?.message ?? String(e))
  }
  return ok(publicState(rooms.get(id), uid))
}

function handleJoin(body, uid) {
  const id = String(body?.roomId ?? '').trim()
  if (!/^\d{6}$/.test(id)) return fail('房间号无效')
  const room = rooms.get(id)
  if (!room) return fail('房间不存在')

  // 已在房里直接返回当前状态 —— 断线重连靠这个，不能先判「对局已开始」
  let me = room.seats.find((s) => s.uid === uid)
  if (!me) {
    if (room.seats.length >= MAX_SEATS) return fail('房间已满')
    me = {
      uid,
      nickname: body.me?.nickname ?? '匿名',
      avatar: num(body.me?.avatar, 1),
      seeds: room.initialSeeds,
    }
    room.seats.push(me)
  }
  touch(room)
  return ok(publicState(room, uid))
}

function handleList(body, uid) {
  // 只列能加入的：offline 模式、未开局、未满、30 分钟内有动静
  const now = Date.now()
  const list = []
  for (const r of rooms.values()) {
    if (r.mode !== 'offline') continue
    if (now - r.lastActive > ROOM_TTL) continue
    if (r.seats.length >= MAX_SEATS) continue
    const host = r.seats.find((s) => s.uid === r.hostUid)
    list.push({
      roomNo: r.id,
      mode: r.mode,
      hostName: host?.nickname ?? '房主',
      hostAvatar: host?.avatar ?? 1,
      playerCount: r.seats.length,
      maxSeats: MAX_SEATS,
      smallBlind: r.smallBlind,
      bigBlind: r.bigBlind,
      initialSeeds: r.initialSeeds,
      roundNo: r.roundNo,
      isMine: r.hostUid === uid,
      iAmIn: r.seats.some((s) => s.uid === uid),
    })
  }
  return ok({ rooms: list })
}

function handleState(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  touch(room)
  return ok(publicState(room, uid))
}

/** 开局 / 重开一手 */
function handleStart(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  if (room.hostUid !== uid) return fail('只有房主可以开局')
  if (room.seats.length < 2) return fail('至少需要 2 名玩家')
  // 还在打的一手不能重开
  if (room.state && !room.state.finished) return fail('本手还没结束')

  try {
    if (isOnline(room)) {
      const deck = createShuffledDeckSafe(room.gameType)
      const players = room.seats.map((s) => ({
        uid: s.uid, nickname: s.nickname, avatar: s.avatar, seeds: s.seeds,
      }))
      const state = initHand({
        players,
        smallBlind: room.smallBlind,
        bigBlind: room.bigBlind,
        gameType: room.gameType,
        dealerUid: room.dealerUid,
        roundNo: room.roundNo,
        deck,
      })
      room.state = state
      room.hands = dealHoleCards(state)
      room.dealerUid = state.dealerUid
      syncSeats(room)
    } else {
      // 线下：只下大小麦，不碰牌
      const state = initOfflineHand({
        players: room.seats.map((s) => ({
          uid: s.uid, nickname: s.nickname, avatar: s.avatar, seeds: s.seeds,
        })),
        smallBlind: room.smallBlind,
        bigBlind: room.bigBlind,
        roundNo: room.roundNo,
        dealerUid: room.dealerUid,
      })
      room.state = state
      // 把引擎座位数据写回 seats，前端 state 轮询才一致
      syncSeats(room)
    }
    touch(room)
    return ok(publicState(room, uid))
  } catch (e) {
    return fail(e?.message ?? String(e))
  }
}

/** 引擎座位 → seats 回写（筹码、下注、弃牌状态） */
function syncSeats(room) {
  const st = room.state
  if (!st?.seats) return
  for (const s of room.seats) {
    const ss = st.seats.find((x) => x.uid === s.uid)
    if (!ss) continue
    s.seeds = ss.seeds
    s.bet = ss.bet ?? 0
    s.totalBet = ss.totalBet ?? 0
    s.blind = ss.blind ?? null
  }
}

function handleAction(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  if (!room.state) return fail('本手还没开始')

  // 不在房间里的人不能操作
  const me = room.seats.find((s) => s.uid === uid)
  if (!me) return fail('你不在这个房间')

  try {
    if (isOnline(room)) {
      return onlineAction(room, body, uid)
    }
    return offlineAction(room, body, uid)
  } catch (e) {
    return fail(e?.message ?? String(e))
  }
}

function offlineAction(room, body, uid) {
  const type = body.type

  // 收池：谁都可以，不卡回合。收完判断要不要进结算
  if (type === 'collect') {
    const r = applyOfflineAction(room.state, { uid, type })
    // 「公共池是空的」这类正常拒绝不算 500
    if (r.error && !/公共池是空的/.test(r.error)) return fail(r.error)
    if (r.error) return fail(r.error)
    room.state = r.state
    syncSeats(room)
    finishIfNeeded(room)
    touch(room)
    return ok(publicState(room, uid))
  }

  if (type === 'fold' || type === 'call' || type === 'raise') {
    const r = applyOfflineAction(room.state, { uid, type, amount: body.amount })
    if (r.error) return fail(r.error)
    room.state = r.state
    syncSeats(room)
    finishIfNeeded(room)
    touch(room)
    return ok(publicState(room, uid))
  }

  return fail('未知动作：' + type)
}

/**
 * 收池 / 自动收池之后：
 *   有人归零 → settle-pending（只给房主弹结算窗，其他人蒙层等）
 *   无人归零 → 保持 playing，正常走下一手
 */
function finishIfNeeded(room) {
  if (!room.state?.finished) return
  const zeroed = room.state.seats.filter((s) => s.seeds <= 0)
  if (zeroed.length > 0) {
    room.state.settlePending = true
  }
}

function onlineAction(room, body, uid) {
  const st = room.state
  if (st.finished) return fail('本局已结束')
  if (st.turnUid !== uid) return fail('还没到你的回合')

  const r = applyAction(st, { uid, type: body.type, amount: body.amount })
  if (r.error) return fail(r.error)
  if (!r.state) return fail('动作未被接受')
  room.state = r.state
  syncSeats(room)

  if (room.state.finished && room.state.phase === PHASE.SHOWDOWN && !room.state.result) {
    const res = showdown(room.state, room.hands)
    // 隐私：弃牌者的底牌绝不外发
    const safeHands = (res.hands ?? []).map((h) => ({
      uid: h.uid, nickname: h.nickname, folded: h.folded,
      hole: h.folded ? [] : (h.hole ?? []),
      cards: h.folded ? [] : (h.cards ?? []),
      hand: h.folded ? null : h.hand,
      isWinner: h.isWinner,
      won: h.won,
    }))
    room.state.result = { pot: res.pot, winnings: res.winnings ?? [], hands: safeHands }
    for (const w of room.state.result.winnings) {
      const ss = room.state.seats.find((s) => s.uid === w.uid)
      if (ss) ss.seeds += w.amount
    }
    syncSeats(room)
  }
  touch(room)
  return ok(publicState(room, uid))
}

/** 换花生（offline 专用）：只推进视觉阶段，不发牌 */
function handleStage(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  if (isOnline(room)) return fail('线上模式按引擎推进，不用手动换街')
  if (!room.state) return fail('本手还没开始')
  room.state = offlineNextStage(room.state)
  touch(room)
  return ok(publicState(room, uid))
}

/**
 * 结算。
 *
 * offline：0 瓜子玩家各给「筹码最高者」1 粒金瓜子。
 *   转账由客户端拿到 transfers 后调 account_seed_transfer 完成，
 *   服务端只负责裁决谁收谁付 —— 这里和 PG 时代的口径一致。
 *   pause=true 时不转账不重置，只把状态置 paused（特殊场景：全员
 *   all-in 归零后又平分继续）。
 */
function handleSettle(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  if (room.hostUid !== uid) return fail('只有房主可以结算')
  if (!room.state) return fail('本手还没开始')

  // 幂等：同一手只结算一次，防房主连点导致金瓜子 ×2。
  //
  // 判据不是「记一个布尔」，而是「这一手是否真的到了待结算状态」：
  //     本手已收掉（finished） + 有人 0 瓜子
  // 两个条件同时成立才允许结算。结算后 room.state 换成新的一手
  // （finished=false、没人归零），条件自动不成立 —— 不需要外部钥匙。
  //
  // 踩过的坑：拿 room.roundNo 当钥匙，结算重置时它 +1，
  // 「结算前的 1」和「结算后的 2」永远不相等，重复请求直接漏过去
  // （实测第二次 settle 返回 transfers=[] 但 roundNo 又 +1）。
  const zeroed = (room.state.seats ?? []).filter((s) => s.seeds <= 0)
  if (!room.state.finished) return fail('本手还没结束，不能结算')
  if (zeroed.length === 0) return fail('没有人瓜子归零，不用结算')

  const st = buildSettlement(room.state.seats)
  const action = body.action ?? 'restart'   // restart | disband | pause

  if (!['restart', 'disband', 'pause'].includes(action)) {
    return fail('未知结算动作：' + action)
  }

  // 并列最高 → 让房主在前端点选（沿用现行交互）。
  // 这种情况不算结算完成，因为还不知道谁收。
  if (st.tieUids?.length > 1 && !body.winnerUid) {
    room.state.settlePending = true
    touch(room)
    return ok({ needPick: true, tieUids: st.tieUids, zeroed: st.zeroed })
  }

  const finalSt = st.tieUids?.length > 1
    ? transfersAfterTiePick(st.zeroed, body.winnerUid)
    : st
  const transfers = finalSt.transfers ?? []

  // 暂停：不转账、不重置，只把状态置 paused（特殊场景：全员 all-in
  // 归零后又平分继续）。也算处理掉了，所以置 handDone。
  if (action === 'pause') {
    room.state.settlePending = false
    room.state.paused = true
    room.state.handDone = true
    touch(room)
    return ok(publicState(room, uid))
  }

  // 解散：转账清单交给客户端，房间删掉
  if (action === 'disband') {
    room.state.handDone = true
    rooms.delete(room.id)
    return ok({ transfers, disbanded: true })
  }

  // 结算并重置：全员回初始值 + 清空大小麦麦位。
  //
  // 先用 handDone 把「这一手已经结算过」钉在旧 state 上，
  // 再做重置 —— 否则旧 state 上没留痕，重复请求查不到。
  room.state.handDone = true
  room.state.settlePending = false

  const reset = offlineNextHand(room.state)
  const byUid = new Map(reset.seats.map((s) => [s.uid, s]))
  for (const s of room.seats) {
    s.seeds = room.initialSeeds
    s.bet = 0
    s.totalBet = 0
    s.blind = null
    const rs = byUid.get(s.uid)
    if (rs) {
      rs.seeds = room.initialSeeds
      rs.bet = 0
      rs.totalBet = 0
      rs.blind = null
    }
  }
  reset.handDone = false       // 新的一手，可以再结算
  reset.settlePending = false
  reset.paused = false
  room.state = reset
  room.roundNo += 1
  touch(room)
  return ok({ transfers, roundNo: room.roundNo })
}

function handleLeave(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return ok({ left: true })

  if (room.hostUid === uid) {
    // 房主退出：整房销毁，所有人一起弹回大厅
    rooms.delete(room.id)
    return ok({ roomClosed: true })
  }

  room.seats = room.seats.filter((s) => s.uid !== uid)

  // 普通成员在对局中离场 = 弃牌。
  //
  // ⚠️ 这里以前直接 room.state = applyAction(...).state，
  //    而 applyAction 在「不是你的回合」时返回 { error } 且没有 state，
  //    于是 room.state 被置成 undefined —— phase 变 IDLE、底池消失、
  //    外人可以加入、还能重复开局。手机切后台必然踩到。
  //
  // 现在只在引擎真的接受了这个 fold 时才替换 state。
  if (room.state && !room.state.finished) {
    try {
      if (isOnline(room)) {
        const r = applyAction(room.state, { uid, type: 'fold' })
        if (r.state) room.state = r.state
      } else {
        const r = applyOfflineAction(room.state, { uid, type: 'fold' })
        if (r.state) room.state = r.state
        else if (r.error) {
          // 没到他回合：只从座位移除，不动引擎状态
          room.state.seats = (room.state.seats ?? []).filter((s) => s.uid !== uid)
        }
      }
      syncSeats(room)
    } catch {
      // 引擎异常不影响「人已经走了」这个事实
    }
  }
  touch(room)
  return ok({ left: true })
}

// ── 工具 ───────────────────────────────────────────────

function createShuffledDeckSafe(gameType) {
  // 用 crypto 而不是 Math.random，牌局才不可预测
  return createShuffledDeck(gameType, () => crypto.randomInt(2 ** 32) / 2 ** 32)
}

function fail(msg) { return { ok: false, error: msg } }
function ok(data) { return { ok: true, data } }

// ── 鉴权：解 JWT 取 sub ────────────────────────────────

function parseUid(req) {
  const h = req.headers.authorization || ''
  if (!h.startsWith('Bearer ')) return null
  try {
    const payload = JSON.parse(
      Buffer.from(h.slice(7).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    )
    return payload.sub || null
  } catch {
    return null
  }
}

// ── HTTP 骨架 ─────────────────────────────────────────

const ROUTES = {
  '/api/room/create': handleCreate,
  '/api/room/join': handleJoin,
  '/api/room/list': handleList,
  '/api/room/state': handleState,
  '/api/room/start': handleStart,
  '/api/room/action': handleAction,
  '/api/room/stage': handleStage,
  '/api/room/settle': handleSettle,
  '/api/room/leave': handleLeave,
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  const url = new URL(req.url, 'http://x')

  // 健康检查：不鉴权，方便云托管探活。容器缩容到 0 时靠它唤醒。
  if (url.pathname === '/health') {
    res.writeHead(200)
    return res.end(JSON.stringify({
      ok: true, rooms: rooms.size, mode: 'up',
      uptime: Math.round(process.uptime()),
    }))
  }

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const handler = ROUTES[url.pathname]
  if (!handler) {
    res.writeHead(404)
    return res.end(JSON.stringify(fail('接口不存在')))
  }
  if (req.method !== 'POST') {
    res.writeHead(405)
    return res.end(JSON.stringify(fail('仅支持 POST')))
  }

  const uid = parseUid(req)
  if (!uid) {
    res.writeHead(401)
    return res.end(JSON.stringify(fail('未登录')))
  }

  // 请求体大小上限
  const chunks = []
  let size = 0
  try {
    for await (const c of req) {
      size += c.length
      if (size > MAX_BODY) { res.writeHead(413); return res.end(JSON.stringify(fail('请求体过大'))) }
      chunks.push(c)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    var body = text ? JSON.parse(text) : {}
  } catch {
    res.writeHead(400)
    return res.end(JSON.stringify(fail('请求体不是合法 JSON')))
  }

  try {
    const out = handler(body, uid)
    res.writeHead(out.ok ? 200 : 400)
    res.end(JSON.stringify(out))
  } catch (e) {
    console.error('[room] 未捕获异常', e)
    res.writeHead(500)
    res.end(JSON.stringify(fail('服务端异常：' + (e?.message ?? String(e)))))
  }
})

// 定期清扫超时空房，防内存只增不减
setInterval(() => {
  const now = Date.now()
  for (const [id, r] of rooms) {
    if (now - r.lastActive > ROOM_TTL) rooms.delete(id)
  }
}, 5 * 60 * 1000).unref()

// 只有直接 `node server/index.js` 运行时才监听端口。
// 被测试 import 时（isMain 为假）不 listen，测试自己控制端口。
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
if (isMain || process.env.LISTEN !== '0') {
  server.listen(PORT, () => console.log(`[room] listening on ${PORT}, mode: offline+online`))
}

// 导出：供集成测试在进程内起服务（避免重复 listen）
export { server, rooms }
