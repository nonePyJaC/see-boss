/**
 * 仓鼠聚会 — 线上对局服务（云托管）
 *
 * 职责边界：
 *   - 线上模式的牌局全部在内存中完成，不接触 PostgreSQL
 *   - 退出 / 容器重启 = 数据消失，天然满足「退出即焚、零留存」
 *   - 牌局逻辑直接 import shared/logic，与前端共用同一份引擎（80/80 测试）
 *
 * 接口（均为 POST，JSON in / JSON out）：
 *   /api/online/create   创建房间并占 1 号位
 *   /api/online/join     扫码 / 输房间号加入
 *   /api/online/start    房主开局发牌
 *   /api/online/action   过牌 / 跟注 / 加注 / 弃牌 / 全下
 *   /api/online/state    拉当前状态（前端轮询用）
 *   /api/online/leave    退出：删自己座位，房主退出则删房
 *
 * 约定：不写库、不写日志文件、不存任何用户信息到磁盘。
 */
import http from 'node:http'
import crypto from 'node:crypto'

import {
  PHASE,
  ACTION_LABEL,
  initHand,
  dealHoleCards,
  applyAction,
  availableActions,
  showdown,
} from '../shared/logic/betting.mjs'
import { createShuffledDeck } from '../shared/logic/cards.mjs'

const PORT = Number(process.env.PORT) || 80
const MAX_SEATS = 8

/** 内存房间表：roomId -> Room */
const rooms = new Map()

// ── 房间模型 ─────────────────────────────────────────────

/**
 * Room = {
 *   id, gameType, smallBlind, bigBlind, initialSeeds,
 *   hostUid, seats: [{uid,nickname,avatar,seeds,folded,allIn}],
 *   state,        // shared/logic 的牌局 state（含 deck，绝不外泄）
 *   hands,        // uid -> [card, card] 仅本服务端持有
 *   dealerUid, roundNo, lastActive
 * }
 */
function newRoom({ id, hostUid, host, cfg }) {
  const room = {
    id,
    gameType: cfg.gameType ?? 'long',
    smallBlind: cfg.smallBlind ?? 10,
    bigBlind: cfg.bigBlind ?? 20,
    initialSeeds: cfg.initialSeeds ?? 3000,
    hostUid,
    seats: [{ uid: hostUid, nickname: host.nickname, avatar: host.avatar, seeds: cfg.initialSeeds ?? 3000 }],
    state: null,
    hands: {},
    dealerUid: null,
    roundNo: 1,
    lastActive: Date.now(),
  }
  rooms.set(id, room)
  return room
}

function genRoomId() {
  for (let i = 0; i < 50; i++) {
    const id = String(crypto.randomInt(100000, 1000000))
    if (!rooms.has(id)) return id
  }
  throw new Error('房间号分配失败')
}

/** 剔掉不该给客户端看的字段 */
function publicState(room, viewerUid) {
  const st = room.state
  const seats = room.seats.map((s) => {
    const ss = st?.seats?.find((x) => x.uid === s.uid)
    return {
      uid: s.uid,
      nickname: s.nickname,
      avatar: s.avatar,
      seeds: ss?.seeds ?? s.seeds,
      bet: ss?.bet ?? 0,
      totalBet: ss?.totalBet ?? 0,
      folded: ss?.folded ?? false,
      allIn: ss?.allIn ?? false,
      isMe: s.uid === viewerUid,
      isHost: s.uid === room.hostUid,
    }
  })

  const base = {
    id: room.id,
    gameType: room.gameType,
    phase: st?.phase ?? PHASE.IDLE,
    seats,
    hostUid: room.hostUid,
    pot: st?.pot ?? 0,
    currentBet: st?.currentBet ?? 0,
    minRaise: st?.minRaise ?? 0,
    turnUid: st?.turnUid ?? null,
    dealerUid: st?.dealerUid ?? room.dealerUid,
    roundNo: room.roundNo,
    communityCards: st?.communityCards ?? [],
    actionLog: (st?.actionLog ?? []).slice(-12),
    finished: st?.finished ?? false,
    initialSeeds: room.initialSeeds,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
  }

  // 只给 viewer 自己的底牌
  if (room.hands[viewerUid]) base.myCards = room.hands[viewerUid]
  // 自己的可执行动作。availableActions 内部已判断「是否轮到 + 是否已弃牌/全下」，
  // 不轮到时天然返回 []，所以这里不需要额外判断身份。
  if (st && !st.finished) {
    base.availableActions = availableActions(st, viewerUid)
  }
  if (st?.finished && st.result) base.result = st.result

  return base
}

// ── 各接口 ──────────────────────────────────────────────

function handleCreate(body, uid) {
  const cfg = body ?? {}
  if (cfg.bigBlind && cfg.smallBlind && cfg.bigBlind <= cfg.smallBlind) {
    return fail('大麦必须大于小麦')
  }
  const id = genRoomId()
  const room = newRoom({ id, hostUid: uid, host: body.me, cfg })
  return ok(publicState(room, uid))
}

function handleJoin(body, uid) {
  const id = String(body?.roomId ?? '').trim()
  if (!/^\d{6}$/.test(id)) return fail('房间号无效')
  const room = rooms.get(id)
  if (!room) return fail('房间不存在')
  if (room.state && !room.state.finished) return fail('对局已开始，不能加入')
  if (room.seats.length >= MAX_SEATS) return fail('房间已满')

  // 已在房里则直接返回
  let me = room.seats.find((s) => s.uid === uid)
  if (!me) {
    me = { uid, nickname: body.me?.nickname ?? '匿名', avatar: body.me?.avatar ?? 1, seeds: room.initialSeeds }
    room.seats.push(me)
  }
  room.lastActive = Date.now()
  return ok(publicState(room, uid))
}

function handleStart(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  if (room.hostUid !== uid) return fail('只有房主可以开局')
  if (room.seats.length < 2) return fail('至少需要 2 名玩家')
  if (room.state && !room.state.finished) return fail('对局已开始')

  try {
    const deck = createShuffledDeck(room.gameType)
    const players = room.seats.map((s) => ({ uid: s.uid, nickname: s.nickname, avatar: s.avatar, seeds: s.seeds }))
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
    // 底牌只存服务端，state 里没有 hands，靠这个发
    room.hands = dealHoleCards(state)
    room.dealerUid = state.dealerUid
    // 同步盲注后的筹码到 seats
    for (const s of room.seats) {
      const ss = state.seats.find((x) => x.uid === s.uid)
      if (ss) s.seeds = ss.seeds
    }
    room.lastActive = Date.now()
    return ok(publicState(room, uid))
  } catch (e) {
    return fail(e?.message ?? String(e))
  }
}

function handleAction(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  if (!room.state) return fail('对局未开始')
  const st = room.state

  // 幂等 + 轮次校验：不是你的回合直接拒
  if (st.finished) return fail('本局已结束')
  if (st.turnUid !== uid) return fail('还没到你的回合')

  try {
    const r = applyAction(st, { uid, type: body.type, amount: body.amount })
    // applyAction 用 { error } 表示拒绝，不会抛异常，必须显式判断
    if (r.error) return fail(r.error)
    if (!r.state) return fail('动作未被接受')
    room.state = r.state

    // 同步筹码到 seats
    for (const s of room.seats) {
      const ss = room.state.seats.find((x) => x.uid === s.uid)
      if (ss) s.seeds = ss.seeds
    }

    // 摊牌结算。
    // 注意：引擎 advance() 进入 showdown 时已自行置 finished=true，
    // 不会留给外部补结算，所以这里判断 finished 而非 !finished。
    if (room.state.finished && room.state.phase === PHASE.SHOWDOWN && !room.state.result) {
      // showdown 返回 { pot, winnings, hands }
      const res = showdown(room.state, room.hands)
      // 隐私：弃牌者的底牌绝不外发。德州规则里弃牌即保密，
      // 泄露会让旁人反推牌堆剩余。此处统一置空 hole。
      const safeHands = (res.hands ?? []).map((h) => ({
        uid: h.uid,
        nickname: h.nickname,
        folded: h.folded,
        // 只有未弃牌者才公开底牌；摊牌阶段这是规则要求的信息
        hole: h.folded ? [] : (h.hole ?? []),
        // cards / hand 同样是牌型明细，弃牌者不外泄
        cards: h.folded ? [] : (h.cards ?? []),
        hand: h.folded ? null : (h.hand ?? null),
        isWinner: h.isWinner,
        won: h.won,
      }))
      room.state.result = {
        pot: res.pot,
        winnings: res.winnings ?? [],
        hands: safeHands,
      }
      // 把分到的筹码写回座位，否则前端看到结算后持有量没变
      for (const w of room.state.result.winnings) {
        const ss = room.state.seats.find((s) => s.uid === w.uid)
        if (ss) ss.seeds += w.amount
        const rs = room.seats.find((s) => s.uid === w.uid)
        if (rs) rs.seeds = ss?.seeds ?? rs.seeds
      }
    }

    room.lastActive = Date.now()
    return ok(publicState(room, uid))
  } catch (e) {
    return fail(e?.message ?? String(e))
  }
}

function handleState(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  room.lastActive = Date.now()
  return ok(publicState(room, uid))
}

function handleLeave(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return ok({ left: true })

  if (room.hostUid === uid) {
    // 房主退出：整房销毁，所有人一起弹回大厅
    rooms.delete(room.id)
    return ok({ roomClosed: true })
  }
  // 普通成员：只删自己
  room.seats = room.seats.filter((s) => s.uid !== uid)
  if (room.state) {
    // 对局中离场视为弃牌
    const r = applyAction(room.state, { uid, type: 'fold' })
    room.state = r.state
  }
  return ok({ left: true })
}

function fail(msg) {
  return { ok: false, error: msg }
}
function ok(data) {
  return { ok: true, data }
}

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
  '/api/online/create': handleCreate,
  '/api/online/join': handleJoin,
  '/api/online/start': handleStart,
  '/api/online/action': handleAction,
  '/api/online/state': handleState,
  '/api/online/leave': handleLeave,
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  const url = new URL(req.url, 'http://x')
  const handler = ROUTES[url.pathname]

  // 健康检查不需要鉴权，方便云托管探活（GET/POST 都行）
  if (url.pathname === '/health') {
    res.writeHead(200)
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }))
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }
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

  let body = {}
  try {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    body = text ? JSON.parse(text) : {}
  } catch {
    res.writeHead(400)
    return res.end(JSON.stringify(fail('请求体不是合法 JSON')))
  }

  try {
    const out = handler(body, uid)
    res.writeHead(out.ok ? 200 : 400)
    res.end(JSON.stringify(out))
  } catch (e) {
    res.writeHead(500)
    res.end(JSON.stringify(fail(e?.message ?? String(e))))
  }
})

server.listen(PORT, () => console.log(`[online] listening on ${PORT}`))
