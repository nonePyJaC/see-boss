/**
 * 仓鼠聚会 — 单进程服务（静态站点 + 房间 API + SQLite）
 *
 * 一台阿里云服务器跑这一个 Node 进程，三件事全包：
 *   1. serve client/dist      静态页（同域，天然免 CORS）
 *   2. /api/room/*            房间状态机（内存 + SQLite 快照）
 *   3. /api/account/*         账号 / 金瓜子账本 / 历史
 *
 * CloudBase 已整体退役。数据全在 server/data/hamster.db（SQLite），
 * 备份 = 拷一个文件。
 *
 * 两种房间模式共用 rooms Map，用 mode 区分：
 *   offline  线下计分：不洗牌、不发底牌、不摊牌，只记瓜子
 *            → shared/logic/offline-room.mjs
 *   online   线上牌局：完整德州，发底牌 + 公共牌 + 摊牌比牌
 *            → shared/logic/betting.mjs
 *
 * 接口（均 POST，JSON in / JSON out）：
 *   账号
 *     /api/account/login     账号名登录 / 注册（无密码）
 *     /api/account/me        当前身份 + 金瓜子 + 局数
 *     /api/account/update    改昵称 / 头像
 *     /api/account/logout    解绑本机
 *     /api/account/ledger    我的账本明细
 *     /api/account/clear     与某人结清
 *   房间
 *     /api/room/create   建房占 1 号位
 *     /api/room/join     扫码 / 输房间号 / 从列表加入
 *     /api/room/list     可加入的房间列表
 *     /api/room/state    拉状态（前端轮询用）
 *     /api/room/start    开局（offline 自动下大小麦；online 发牌）
 *     /api/room/action   动作：collect / call / raise / fold
 *     /api/room/stage    换街（花生节拍器，offline 专用）
 *     /api/room/settle   结算：金瓜子入账 + 重置 / 解散
 *     /api/room/leave    退出：只删自己，房主退出则删房
 *
 * 身份：请求体带 uid（前端 localStorage 生成）+ 昵称。
 *      朋友局，服务端信任，不验签、不设密码。
 *
 * 持久：每次房间状态变更后 upsert room_snapshots；
 *      进程启动时载回 → pm2 restart / 宕机后对局自动恢复。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  PHASE,
  initHand,
  dealHoleCards,
  applyAction,
  forfeit,
  availableActions,
  showdown,
} from '../shared/logic/betting.mjs'
import { createShuffledDeck } from '../shared/logic/cards.mjs'
import { HAMSTERS } from '../shared/assets/hamsters.mjs'

import {
  initOfflineHand,
  applyOfflineAction,
  availableActions as offlineActions,
  nextStage as offlineNextStage,
} from '../shared/logic/offline-room.mjs'

import { buildSettlement, transfersAfterTiePick } from '../shared/logic/settlement.mjs'

import {
  createRuntime, ensurePersona, removeSeat as removeAiRuntimeSeat,
  clearRuntime, decayEmotions, handFlag as aiHandFlag,
  recordHandResult, recordAction, recordHandJoined,
  opponentSummary, emotionDelta, buildObservation,
} from './ai/runtime.mjs'
import { decideAction, fallbackAction } from './ai/policy.mjs'

import {
  openDb, DB_PATH,
  loginAccount, accountByUid, updateMyAccount, logoutAccount,
  accountSeedTransfer, accountLedgerRows, clearAccountLedgerRow,
  bumpTotalGames, goldenSeedsOf,
  addHistory, listHistory, deleteRoomHistory,
  saveRoomSnapshot, loadRoomSnapshot, loadAllRoomSnapshots, deleteRoomSnapshot,
  wipeData, dataCounts,
} from './db.js'
import { debugPage } from './debug-room-page.js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 80
/** 前端构建产物目录：../client/dist */
const STATIC_DIR = process.env.HAMSTER_STATIC_DIR
  || path.join(__dirname, '..', 'client', 'dist')
const MAX_SEATS = 8
/** 请求体上限，防恶意大包打爆内存 */
const MAX_BODY = 16 * 1024
/** 房间空闲超过这个毫秒数就回收（没有 lastActive 写入的话） */
const ROOM_TTL = 60 * 60 * 1000
/** 房间数上限，满了拒绝创建 */
const MAX_ROOMS = 500
/** 线上房间同时最多 2 个（冻结决策）；线下房间不计入 */
const MAX_ONLINE_ROOMS = 2
/** 真人行动限时 120s（冻结决策）；每回合最多手动续一次 */
const TURN_MS = 120 * 1000

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
  const online = cfg.mode === 'online'
  // 线上座位的 uid 由服务端生成（seatId），客户端 uid 只作 accountUid 资料字段；
  // 线下保持原样：座位 uid 就是设备 uid。
  const hostSeat = {
    uid: online ? genSeatId() : hostUid,
    nickname: host.nickname ?? '匿名',
    avatar: num(host.avatar, 1),
    seeds: Math.max(1, num(cfg.initialSeeds, 3000)),
  }
  if (online) {
    hostSeat.accountUid = hostUid
    hostSeat.kind = 'human'
    hostSeat.seatToken = genSeatToken()
    hostSeat.joinedAt = Date.now()
  }
  const room = {
    id,
    mode: online ? 'online' : 'offline',
    gameType: cfg.gameType ?? 'long',
    smallBlind: 0,
    bigBlind: 0,
    initialSeeds: Math.max(1, num(cfg.initialSeeds, 3000)),
    hostUid: hostSeat.uid,
    seats: [hostSeat],
    state: null,
    hands: {},
    // 线上手牌生命周期：handId 每手 +1，handParticipants 开局冻结，
    // inactiveThisHand 记超时/离开者，turnSeq 每次行动 +1，
    // deadlineAt / deadlineRefreshUsed 供行动时钟使用。
    handId: 0,
    handParticipants: new Set(),
    inactiveThisHand: new Set(),
    turnSeq: 0,
    deadlineAt: null,
    deadlineRefreshUsed: false,
    aiRuntime: createRuntime(),  // AI 人设/对手模型/情绪/慢打标记（runtime.mjs）
    aiTimer: null,               // 每房最多一个 AI 行动计时器
    aiStats: { decisions: 0, totalMs: 0, maxMs: 0, samples: [], degraded: 0 },   // 决策耗时/降级采样（§12 门禁数据）
    recentHands: [],             // 最近 3 手公开记录，仅保存在房间内存
    dealerUid: null,
    roundNo: 1,
    lastActive: Date.now(),
  }
  // 大小麦：填一个就行，另一个按 ×2 自动算（实测口径：
  // 「填一个另一个自动计算」）。只给小麦 → 大麦 = 小麦×2；
  // 只给大麦 → 小麦 = 大麦÷2（大麦必须是偶数才除得尽）。
  // 两个都给 → 保持原值，走下面的常规校验。
  const sbIn = Number(cfg.smallBlind)
  const bbIn = Number(cfg.bigBlind)
  const sbOk = Number.isFinite(sbIn) && sbIn > 0
  const bbOk = Number.isFinite(bbIn) && bbIn > 0
  if (sbOk && !bbOk) {
    room.smallBlind = Math.floor(sbIn)
    room.bigBlind = room.smallBlind * 2
  } else if (!sbOk && bbOk) {
    if (bbIn % 2 !== 0) throw new Error('大麦必须是偶数（小麦 = 大麦 ÷ 2）')
    room.bigBlind = Math.floor(bbIn)
    room.smallBlind = room.bigBlind / 2
  } else {
    room.smallBlind = Math.max(1, Math.floor(num(cfg.smallBlind, 10)))
    room.bigBlind = Math.max(1, Math.floor(num(cfg.bigBlind, room.smallBlind * 2)))
  }
  // 大麦必须大于小麦，否则开局就乱
  if (room.bigBlind <= room.smallBlind) {
    throw new Error('大麦必须大于小麦')
  }
  // 大麦必须是偶数 —— 小麦永远是大麦的一半，奇数除不尽会出小数盲注
  if (room.bigBlind % 2 !== 0) {
    throw new Error('大麦必须是偶数（小麦 = 大麦 ÷ 2）')
  }
  // 大麦上限 = 入场数 / 10（进场至少留 10 个大麦）。
  // 不设上限实测踩过：每人 250、大麦 200，几乎每把都有人被打到 0，
  // 房主得反复弹结算发筹码，牌打不下去。
  const bbMax = Math.max(2, Math.floor(room.initialSeeds / 10))
  if (room.bigBlind > bbMax) {
    throw new Error(`大麦不能超过 ${bbMax}（入场 ${room.initialSeeds} ÷ 10）`)
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

/** 线上座位 ID：服务端生成，客户端不能自报（也是引擎里的 uid） */
function genSeatId(room) {
  for (let i = 0; i < 20; i++) {
    const id = 's' + crypto.randomBytes(8).toString('base64url')
    if (!room?.seats?.some((s) => s.uid === id)) return id
  }
  return 's' + crypto.randomBytes(16).toString('base64url')
}

/** 座位令牌：真人重连 / 行动的唯一凭证，绝不进公开状态、URL 或快照 */
function genSeatToken() {
  return crypto.randomBytes(32).toString('base64url')
}

/** 定长令牌比较：长度不同直接不等，不进 timingSafeEqual（它要求等长） */
function tokenEq(got, expect) {
  const a = Buffer.from(String(got ?? ''))
  const b = Buffer.from(String(expect ?? ''))
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** 在线模式才发底牌；线下完全不碰牌 */
function isOnline(room) { return room.mode === 'online' }

/**
 * 座位认证。
 *   线上：必须 seatId + seatToken 同时匹配（timing-safe 比较），
 *         uid 只是资料字段，不能当凭证；AI 座位没有令牌，不可被真人冒充。
 *   线下：沿用设备 uid 找座位（朋友局旧口径，不变）。
 * @returns 命中的座位对象；认证失败返回 null（调用方按旁观者处理或拒绝）
 */
function authSeat(room, body, uid) {
  if (!isOnline(room)) {
    return room.seats.find((s) => s.uid === uid) ?? null
  }
  const seatId = String(body?.seatId ?? '')
  const token = String(body?.seatToken ?? '')
  if (!seatId || !token) return null
  const seat = room.seats.find((s) => s.uid === seatId)
  if (!seat || seat.kind === 'ai' || !seat.seatToken) return null
  return tokenEq(token, seat.seatToken) ? seat : null
}

/**
 * 客户端可见的房间状态。
 * 绝不外泄 state.deck / room.hands（除自己的底牌）。
 */
function publicState(room, viewerUid) {
  const st = room.state
  const seats = room.seats.map((s) => {
    // online 用引擎里的座位数据，offline 直接读 seats
    const ss = st?.seats?.find((x) => x.uid === s.uid)
    // 金瓜子归属账号，uid 没绑账号就是 0
    const acct = accountByUid(s.uid)
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
      goldSeeds: acct?.goldenSeeds ?? 0,
      account: acct?.account ?? null,
      isMe: s.uid === viewerUid,
      isHost: s.uid === room.hostUid,
      // AI 只暴露标识和中文风格标签，绝不暴露内部参数/胜率/随机数
      isAI: s.kind === 'ai',
      styleLabel: s.styleLabel ?? null,
    }
  })

  const base = {
    id: room.id,
    mode: room.mode,
    gameType: room.gameType,
    seats,
    hostUid: room.hostUid,
    pot: st?.pot ?? 0,
    currentBet: st?.currentBet ?? 0,
    minRaise: st?.minRaise ?? 0,
    turnUid: st?.turnUid ?? null,
    dealerUid: room.dealerUid,
    // 盲注位（只读展示：椭圆桌上的「庄 / 小 / 大」标记）
    sbUid: st?.sbUid ?? null,
    bbUid: st?.bbUid ?? null,
    roundNo: room.roundNo,
    initialSeeds: room.initialSeeds,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    // 结算/暂停信号必须透出 —— 结算弹窗和暂停蒙层全靠它俩驱动。
    // 只写进 state 不透出，前端永远看不到（踩过：调试页读了半天 undefined）。
    settlePending: !!st?.settlePending,
    paused: !!st?.paused,
    // 轮询探针：有实质变化前端才拉全量（省流量）
    rev: room.rev ?? 0,
  }

  if (isOnline(room)) {
    base.phase = st?.phase ?? PHASE.IDLE
    base.communityCards = st?.communityCards ?? []
    base.actionLog = (st?.actionLog ?? []).slice(-12)
    base.finished = st?.finished ?? false
    base.handId = room.handId ?? 0
    base.recentHands = (room.recentHands ?? []).map((hand) => structuredClone(hand))
    base.turnSeq = room.turnSeq ?? 0
    base.deadlineAt = room.deadlineAt ?? null
    // 底牌四道闸全部满足才给（规格 §4.2）：令牌认证 + 本手参与者
    // + 未超时/未离开 + 服务端确实持有。viewerUid 必须由 authSeat 认证而来。
    const canSeeOwnCards = !!viewerUid
      && room.handParticipants?.has(viewerUid)
      && !room.inactiveThisHand?.has(viewerUid)
      && !!room.hands?.[viewerUid]
    if (canSeeOwnCards) base.myCards = room.hands[viewerUid]
    // 合法行动只对当前行动者返回
    if (st && !st.finished && viewerUid && st.turnUid === viewerUid) {
      base.avail = availableActions(st, viewerUid)
      base.canExtendTurn = !room.deadlineRefreshUsed
    }
    if (st?.finished && st.result) base.result = st.result
  } else {
    // 线下花生节拍器：UI 亮几颗花生，不发牌
    base.stage = st?.stage ?? 'preflop'
    base.finished = st?.finished ?? false
    // 下注流水（收款后由 nextHand 清空）
    base.actionLog = st?.actionLog ?? []
    // 「跟」按钮要显示需跟数量
    base.toCall = viewerUid ? Math.max(0, (st?.currentBet ?? 0) - (st?.seats?.find((x) => x.uid === viewerUid)?.bet ?? 0)) : 0
    // 暂停态即使 finished 也要给 avail —— 暂停中桌上只剩「收 / 出」
    // 两个中性键，房主要靠它们分池。卡 finished 条件会让暂停态前端
    // 拿到 undefined，操作栏直接崩（实测踩过）。
    if (st && (!st.finished || st.paused)) base.avail = offlineActions(st, viewerUid)
    // 是否有人归零 —— 只在「本手已收掉」时为真。
    // all-in 中途也会出现 0 瓜子座位，不加 finished 门槛前端会提前弹窗。
    base.hasZeroSeat = !!st?.finished && (st?.seats ?? []).some((x) => x.seeds <= 0)
  }

  return base
}

/** 每次改动 rooms 后递增，供前端探针比对手工省流量 */
/**
 * 每次房间状态变更后调它。做三件事：
 *   1. 刷新 lastActive（清扫判据）
 *   2. rev +1（前端轮询探针，没变就打便宜请求）
 *   3. 落库快照 —— pm2 restart / 宕机后对局自动恢复
 *
 * rev 变化但快照没写，是之前踩过的坑：动作后不 persist，
 * 结果重启丢局。所以 persist 放在这唯一收口处，调用方忘不掉。
 */
function touch(room) {
  room.lastActive = Date.now()
  room.rev = (room.rev ?? 0) + 1
  persistRoom(room)
}

/**
 * 只刷新活跃时间，不动 rev、不落库。
 * 轮询/重连这类「读」操作走它 —— 否则每个玩家 2s 一次轮询
 * 都会触发一次全量快照写盘 + rev 永远在变（探针失效）。
 */
function bumpActivity(room) {
  room.lastActive = Date.now()
}

// ── 接口实现 ────────────────────────────────────────────

function handleCreate(body, uid) {
  const cfg = body?.cfg ?? {}
  const host = body?.me ?? {}
  if (!host.nickname) return fail('缺少昵称')

  // 线上建房要授权码：全站一个，由环境变量提供；未配置 = 功能未启用。
  // 只校验「能不能建」，不是房间密码 —— 扫码/输房号加入的人不需要它。
  if (cfg.mode === 'online') {
    const expect = process.env.HAMSTER_ONLINE_CREATE_CODE
    if (!expect) return fail('线上建房未启用', 'CREATE_DISABLED')
    if (!tokenEq(body?.createCode, expect)) {
      return fail('创建码错误', 'BAD_CREATE_CODE')
    }
    if (!accountByUid(uid)) return fail('请先登录或注册账号再创建线上房间', 'LOGIN_REQUIRED')
    let onlineCount = 0
    for (const r of rooms.values()) if (r.mode === 'online') onlineCount++
    if (onlineCount >= MAX_ONLINE_ROOMS) {
      return fail('线上房间数已达上限', 'ONLINE_ROOM_LIMIT')
    }
  }

  const id = genRoomId()
  try {
    newRoom({ id, hostUid: uid, host, cfg })
  } catch (e) {
    return fail(e?.message ?? String(e))
  }
  const room = rooms.get(id)
  const seat = room.seats[0]
  // 线上：一次性回发 seatId/seatToken，客户端存 localStorage 当身份凭证；
  // 之后任何接口都靠它认座，uid 不再参与授权。
  return ok({
    ...publicState(room, seat.uid),
    ...(isOnline(room) ? { seatId: seat.uid, seatToken: seat.seatToken } : {}),
  })
}

function handleJoin(body, uid) {
  const id = String(body?.roomId ?? '').trim()
  if (!/^\d{6}$/.test(id)) return fail('房间号无效')
  const room = rooms.get(id)
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')

  if (isOnline(room)) {
    // 持有效令牌的旧座位重连：直接回状态，不新增座位。
    // （重连主路径是 /state，这里是兜底，避免客户端误调 join 造成重复座位）
    const existing = authSeat(room, body, uid)
    if (existing) {
      bumpActivity(room)
      return ok({
        ...publicState(room, existing.uid),
        seatId: existing.uid,
        seatToken: existing.seatToken,
      })
    }
    if (!accountByUid(uid)) return fail('请先登录或注册账号再加入线上房间', 'LOGIN_REQUIRED')
    // 同账号回座：凭证丢了（换浏览器/清了缓存）但只要 uid 没变，
    // 归还本人原座位 + 换发新令牌（旧令牌作废，旧设备自然掉成旁观）。
    // 不做这步的后果踩过：同账号重进被开成重复座位，俩「ceshi」同屋，
    // 且新座不是房主 → 房成了没房主的鬼房，谁也解散不了。
    // 安全边界：accountUid 不在任何 publicState 里透出，冒充需要知道设备 uid。
    if (uid) {
      const mine = room.seats.find((s) => s.kind !== 'ai' && s.accountUid === uid)
      if (mine) {
        mine.seatToken = genSeatToken()
        if (body.me?.nickname) mine.nickname = body.me.nickname
        if (body.me?.avatar != null) mine.avatar = num(body.me.avatar, mine.avatar)
        bumpActivity(room)
        return ok({
          ...publicState(room, mine.uid),
          seatId: mine.uid,
          seatToken: mine.seatToken,
        })
      }
    }
    // 本手进行中不能入座新玩家；只能旁观，等两手之间再 join。
    if (room.state && !room.state.finished) {
      return fail('本手进行中，结束后才能加入', 'HAND_IN_PROGRESS')
    }
    if (room.seats.length >= MAX_SEATS) return fail('房间已满', 'ROOM_FULL')
    const seat = {
      uid: genSeatId(room),
      accountUid: uid,
      nickname: body.me?.nickname ?? '匿名',
      avatar: num(body.me?.avatar, 1),
      kind: 'human',
      seatToken: genSeatToken(),
      seeds: room.initialSeeds,
      joinedAt: Date.now(),
    }
    room.seats.push(seat)
    touch(room)
    return ok({
      ...publicState(room, seat.uid),
      seatId: seat.uid,
      seatToken: seat.seatToken,
    })
  }

  // 已在房里直接返回当前状态 —— 断线重连靠这个，不能先判「对局已开始」。
  // 重连是「读」，不 bump rev 不落库；只有真的加座才算变更。
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
    touch(room)
  } else {
    bumpActivity(room)
  }
  return ok(publicState(room, uid))
}

function handleList(body, uid) {
  // 列当前存在的房（线上+线下都列，满员房带 full 标记而不是藏起来 ——
  // 用户要能看见残留房间并手动关掉）。
  // 线上「我在不在里面」uid 判不了：客户端把本机存过的座位凭证回传
  // { roomId: { seatId, seatToken } }，服务端逐项 authSeat 认证才给
  // iAmIn/isMine —— 没凭证的房间不会误标成「我的」。
  const now = Date.now()
  const creds = (body?.creds && typeof body.creds === 'object') ? body.creds : {}
  const list = []
  for (const r of rooms.values()) {
    if (now - r.lastActive > ROOM_TTL) continue
    let iAmIn = false
    let isMine = false
    if (isOnline(r)) {
      const c = creds[r.id]
      const seat = c ? authSeat(r, c, null) : null
      iAmIn = !!seat
      isMine = !!seat && seat.uid === r.hostUid
    } else {
      iAmIn = r.seats.some((s) => s.uid === uid)
      isMine = r.hostUid === uid
    }
    const host = r.seats.find((s) => s.uid === r.hostUid)
    list.push({
      roomNo: r.id,
      mode: r.mode,
      hostName: host?.nickname ?? '房主',
      hostAvatar: host?.avatar ?? 1,
      playerCount: r.seats.length,
      aiCount: r.seats.filter((s) => s.kind === 'ai').length,
      maxSeats: MAX_SEATS,
      smallBlind: r.smallBlind,
      bigBlind: r.bigBlind,
      initialSeeds: r.initialSeeds,
      roundNo: r.roundNo,
      full: r.seats.length >= MAX_SEATS,
      inProgress: !!(r.state && !r.state.finished),
      isMine,
      iAmIn,
    })
  }
  return ok({ rooms: list })
}

function handleState(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')
  // 轮询只续命不写库：持久化收口在 touch()，只跟着「变更」走
  bumpActivity(room)
  // 线上：认证成功才有座位视角；失败一律按旁观者投影（拿不到底牌/合法动作）。
  // 线下：照旧按 uid 看（非成员也看得到公共信息）。
  if (isOnline(room)) {
    const seat = authSeat(room, body, uid)
    return ok(publicState(room, seat?.uid ?? null))
  }
  return ok(publicState(room, uid))
}

/**
 * 调整座位顺序（房主 + 未开局）。
 *
 * order 是完整的 uid 数组，按目标顺序排列。
 * 重新排列 room.seats —— 小麦位 sbIndex 是按座位下标算的，
 * 所以顺序一变，上一手的小麦也跟着换位置，这正是拖拽想要的效果。
 */
function handleReorder(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')
  if (isOnline(room)) return fail('线上房间不支持调整座位', 'OFFLINE_ONLY')
  if (room.hostUid !== uid) return fail('只有房主可以调整座位')
  // 对局中不让改：座位顺序一变，currentBet / turnUid 这些按座位算的全乱。
  // 暂停中可以 —— 暂停就是给房主「停下来收拾一下」用的。
  if (room.state && !room.state.finished && !room.state.paused) {
    return fail('本手还没结束，不能调整座位')
  }

  const order = Array.isArray(body?.order) ? body.order.map(String) : []
  if (order.length !== room.seats.length) return fail('座位数量对不上')
  // 必须是同一批人，不能借调换顺序把别人塞进来
  const cur = new Set(room.seats.map((s) => s.uid))
  if (order.some((u) => !cur.has(u)) || new Set(order).size !== order.length) {
    return fail('座位名单对不上')
  }

  room.seats.sort((a, b) => order.indexOf(a.uid) - order.indexOf(b.uid))
  touch(room)
  return ok(publicState(room, uid))
}

/** 开局 / 重开一手 */
function handleStart(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')
  let viewerUid = uid
  if (isOnline(room)) {
    const seat = authSeat(room, body, uid)
    if (!seat) return fail('身份验证失败', 'AUTH_FAILED')
    if (seat.uid !== room.hostUid) return fail('只有房主可以开局', 'NOT_HOST')
    viewerUid = seat.uid
  } else if (room.hostUid !== uid) {
    return fail('只有房主可以开局')
  }
  // 还在打的一手不能重开。暂停中可以开局/重开 —— 暂停就是让房主
  // 停下来改设置再开始的，卡在这里的话暂停态没有任何出路。
  if (room.state && !room.state.finished && !room.state.paused) {
    return fail('本手还没结束')
  }

  try {
    if (isOnline(room)) {
      // 只让筹码 > 0 的座位进本手；0 筹码留在房里旁观
      const participants = room.seats.filter((s) => (s.seeds ?? 0) > 0)
      if (participants.length < 2) return fail('至少需要 2 名筹码大于 0 的玩家')
      const deck = createShuffledDeckSafe(room.gameType)
      const players = participants.map((s) => ({
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
      // 手牌生命周期：冻结参与者、清空本手失格名单、轮次 +1、续时重置
      room.handId += 1
      room.handParticipants = new Set(participants.map((p) => p.uid))
      room.inactiveThisHand = new Set()
      room.turnSeq += 1
      room.roundNo += 1
      syncSeats(room)
      // AI 学习：情绪按手衰减 + 记录各参与者的「本手参与」样本
      if (room.aiRuntime.personas.size > 0) {
        decayEmotions(room.aiRuntime)
        const pIds = participants.map((p) => p.uid)
        for (const s of room.seats) {
          if (s.kind !== 'ai') continue
          for (const t of pIds) {
            // enteredPot 不在此记：vpip 由 recordAction 按翻前自愿动作去重统计
            if (t !== s.uid) recordHandJoined(room.aiRuntime, s.uid, t, { enteredPot: false })
          }
        }
      }
      // 回合路由：首个行动者是 AI → 调度器接管；真人 → 120s 时钟
      afterTurnChanged(room)
    } else {
      // 线下：只下大小麦，不碰牌。
      // sbIndex 是房主指定的小麦位 —— 必须透传，之前漏了导致
      // 调试页选位发到服务端被吞，小麦永远落在 seats[0]。
      const state = initOfflineHand({
        players: room.seats.map((s) => ({
          uid: s.uid, nickname: s.nickname, avatar: s.avatar, seeds: s.seeds,
        })),
        smallBlind: room.smallBlind,
        bigBlind: room.bigBlind,
        roundNo: room.roundNo,
        sbIndex: body.sbIndex,
      })
      room.state = state
      // 把引擎座位数据写回 seats，前端 state 轮询才一致
      syncSeats(room)
      // 本手开局快照（大小麦刚下完）：房主长按「继续」→「重开本手」
      // 就靠它整手逆向回起点
      room.handStartState = JSON.parse(JSON.stringify(room.state))
    }
    // 新的一手：回滚快照跟着旧手一起作废
    room.prevState = null
    room.pauseBackup = null
    touch(room)
    return ok(publicState(room, viewerUid))
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
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')
  if (!room.state) return fail('本手还没开始')

  if (isOnline(room)) {
    // 先令牌认证再谈轮次：uid / seatId / 错 token 一视同仁拒掉
    const seat = authSeat(room, body, uid)
    if (!seat) return fail('身份验证失败', 'AUTH_FAILED')
    try {
      return onlineAction(room, body, seat)
    } catch (e) {
      return fail(e?.message ?? String(e))
    }
  }

  // 不在房间里的人不能操作
  const me = room.seats.find((s) => s.uid === uid)
  if (!me) return fail('你不在这个房间')

  try {
    return offlineAction(room, body, uid)
  } catch (e) {
    return fail(e?.message ?? String(e))
  }
}

function offlineAction(room, body, uid) {
  const type = body.type

  // 收池：谁都可以点，不卡回合（桌面上的公共池谁都能顺手收）。
  // 收完 = 本手结束：
  //   · 暂停中收池 → 停在暂停态，让房主慢慢分瓜子，绝不自动开局
  //   · 有人归零 → 进结算，等房主决定（重置 / 解散 / 暂停）
  //   · 无人归零 → 直接开下一手，不用房主再点一次
  if (type === 'collect') {
    const r = applyOfflineAction(room.state, { uid, type })
    if (r.error) return fail(r.error)
    room.state = r.state
    syncSeats(room)
    // 收池本身结束了本手（引擎置 finished=true），所以这里查归零是安全的
    const settled = finishIfNeeded(room)
    // 暂停中是「房主手动分账」的状态：收完池子就停住，等 give 分完
    // 再由房主点继续。这里自动开局会把池子清掉、局数 +1，
    // 分账还没做就跳到下一局了（实测踩过）。
    if (!room.state.paused && !settled) autoNextHand(room)
    touch(room)
    return ok(publicState(room, uid))
  }

  // 下注类动作：过牌 / 跟注 / 加注 / 弃牌 / 暂停划拨
  // ⚠️ check 必须在列。漏了它，点「过」会掉到末尾的
  //    「未知动作」，页面看着就是没反应 —— 实测踩过。
  // give 是暂停态「出」（人→池，分池场景）。
  if (['check', 'fold', 'call', 'raise', 'give'].includes(type)) {
    // 游戏动作前记一笔「行动前快照」—— 暂停→继续的
    // 「回滚到上一次决策」（B 下错注、轮到 C 后房主暂停、
    // 继续时还原成 B 决策）就靠它。
    // 只记游戏动作：give/collect 是中性分账动作不记；
    // 暂停中的动作也不记（那是房主在手动分账，不动回滚点）。
    // 必须深拷贝：applyOfflineAction 内部 normalize 的
    // actionLog/actedUids 与原对象共享数组，浅引用会被改脏。
    if (!room.state.paused && type !== 'give') {
      room.prevState = JSON.parse(JSON.stringify(room.state))
    }
    const r = applyOfflineAction(room.state, {
      uid, type, amount: body.amount, toUid: body.toUid,
    })
    if (r.error) return fail(r.error)
    room.state = r.state
    syncSeats(room)
    const settled = room.state.finished && finishIfNeeded(room)
    // 弃到只剩 1 人 → 引擎自动替他收池。同样没人归零就自动开下一手，
    // 不然桌上所有人都得等房主手动开局。暂停中不自动开局（同 collect）。
    if (!room.state.paused && !settled && r.autoCollected) autoNextHand(room)
    touch(room)
    return ok(publicState(room, uid))
  }

  return fail('未知动作：' + type)
}

/**
 * 收池 / 自动收池 / 自动开下一手之后都要查：
 *   · 有人归零（seeds <= 0）→ settle-pending（只给房主弹结算窗），返回 true
 *   · 无人归零 → 返回 false
 *
 * 不要求 finished：自动开完下一手后本手刚开始（finished=false），
 * 但盲注可能刚把上把剩得少的人打成 0 —— 这时候也该进结算。
 * 之前卡了 finished 条件，漏掉了这条（实测踩过）。
 */
function finishIfNeeded(room) {
  const zeroed = (room.state?.seats ?? []).filter((s) => s.seeds <= 0)
  if (zeroed.length > 0) {
    room.state.settlePending = true
    return true
  }
  return false
}

/**
 * 自动开下一手（收池后无人归零时调）。
 *
 * 小麦位往后挪一位 —— 跟房主手动开局时的轮转口径一致，
 * 不然每次自动开局都固定在同一个位置，坐那儿的人永远下小麦。
 * 房主之后仍可在锁定位状态下点某人改小麦位。
 *
 * ⚠️ 开完要再查一次归零：上把剩 50 的人这一把当大麦，
 *    200 盲注直接把他打成 0 —— 这时候也该进结算，
 *    不然牌桌会带着一个 0 筹码的人继续打（实测踩过）。
 */
function autoNextHand(room) {
  try {
    // 找上一手的小麦位，从它后面一位开始
    const prevSb = room.state?.seats.findIndex((s) => s.blind === 'sb')
    room.state = initOfflineHand({
      players: room.seats.map((s) => ({
        uid: s.uid, nickname: s.nickname, avatar: s.avatar, seeds: s.seeds,
      })),
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      roundNo: room.roundNo,
      sbIndex: prevSb >= 0 ? (prevSb + 1) % room.seats.length : undefined,
    })
    room.roundNo += 1
    // 新的一手：回滚快照跟着旧手一起作废
    room.prevState = null
    room.pauseBackup = null
    // 本手开局快照要在 finishIfNeeded 之前拍：那个函数会往 state 上
    // 写 settlePending，重开本手要的是干干净净的开局态
    room.handStartState = JSON.parse(JSON.stringify(room.state))
    syncSeats(room)
    // 下了盲注之后可能又有人归零 —— 那就该停在结算，而不是继续打
    finishIfNeeded(room)
  } catch (e) {
    // 自动开局失败不能把收池这个动作一起搞失败 —— 池子已经收完了。
    // 退回「等房主手动开局」，房主点一下就能继续。
    console.error('[room] 自动开下一手失败:', e?.message ?? e)
  }
}

/**
 * 线上牌局统一内部行动入口（I7 同路行动）。
 * 真人 HTTP、AI 调度、超时弃牌全部走这里，不复制合法性校验和回合推进。
 *
 * @param {Object}  opts.room
 * @param {string}  opts.actorSeatId  行动者座位 ID（引擎 uid）
 * @param {Object}  opts.action       { type, amount? }
 * @param {'human'|'ai'|'timeout'} opts.source
 *
 * 回合内动作走 applyAction；非回合的 fold（离开/清理）走 forfeit——
 * 两者都是 shared/logic/betting.mjs 的公共规则，本函数只做选择和收口。
 */
function applyRoomAction({ room, actorSeatId, action, source }) {
  const st = room.state
  if (!st || st.finished) return { ok: false, error: '本局已结束', code: 'HAND_FINISHED' }
  // 行动者必须是本手参与者且未失格：离开者/归零旁观者/非本手成员都挡在这
  const seat = room.seats.find((s) => s.uid === actorSeatId)
  if (!seat || !room.handParticipants.has(actorSeatId) || room.inactiveThisHand.has(actorSeatId)) {
    return { ok: false, error: '本手与你无关', code: 'NOT_IN_HAND' }
  }

  // 学习快照：动作前的阶段和需跟额（给 AI 对手模型记 facedBet）
  const seatBefore = st.seats?.find((s) => s.uid === actorSeatId)
  const phaseBefore = st.phase
  const currentBetBefore = st.currentBet ?? 0
  const facedBetBefore = Math.max(0, currentBetBefore - (seatBefore?.bet ?? 0)) > 0

  let r
  if (st.turnUid === actorSeatId) {
    r = applyAction(st, { uid: actorSeatId, type: action.type, amount: action.amount })
  } else if (action.type === 'fold' && (source === 'human' || source === 'timeout')) {
    // 非回合弃牌：主动离开 / 超时清理用；AI 和人正常回合内都走上面
    r = forfeit(st, actorSeatId)
  } else {
    return { ok: false, error: '还没到你的回合', code: 'NOT_YOUR_TURN' }
  }
  if (r.error) return { ok: false, error: r.error, code: 'ILLEGAL_ACTION' }
  if (!r.state) return { ok: false, error: '动作未被接受', code: 'ILLEGAL_ACTION' }

  room.state = r.state
  // 每次成功行动推进轮次：turnSeq +1，新行动者重挂时钟（真人）或 AI 定时器
  room.turnSeq += 1
  syncSeats(room)
  // 公开行动喂给所有 AI 观察者的对手模型（§8.7 只记公开可见数据）
  const actionEvent = room.state.actionLog?.at(-1)
  recordAiObservation(room, actorSeatId, {
    type: actionEvent?.type ?? action.type,
    phase: actionEvent?.phase ?? phaseBefore,
    facedBet: facedBetBefore,
    handId: room.handId,
    paidAmount: actionEvent?.amount,
    raiseTo: actionEvent?.betTotal,
    currentBetBefore,
  })
  resolveOnlineIfDone(room)
  if (room.state.finished) {
    // 本手结束：私人手牌只活在当前手里，摊牌结果已写进 state.result
    room.hands = {}
    recordAiHandResults(room)
    disarmAiTimer(room)
  }
  // 回合路由收口：终局清时钟，AI 回合挂调度，真人回合挂 120s
  afterTurnChanged(room)
  touch(room)
  return { ok: true }
}

function onlineAction(room, body, seat) {
  const st = room.state
  // §5 校验顺序：handId → turnSeq → 当前行动者 → 动作合法性
  if (Number(body?.handId) !== room.handId) return fail('手牌已过期', 'STALE_HAND')
  if (Number(body?.turnSeq) !== room.turnSeq) return fail('行动已过期', 'STALE_TURN')
  if (st.finished) return fail('本局已结束', 'HAND_FINISHED')
  if (st.turnUid !== seat.uid) return fail('还没到你的回合', 'NOT_YOUR_TURN')

  const r = applyRoomAction({
    room,
    actorSeatId: seat.uid,
    action: { type: body.type, amount: body.amount },
    source: 'human',
  })
  if (!r.ok) return fail(r.error, r.code)
  return ok(publicState(room, seat.uid))
}

/**
 * 线上手牌终局收口：摊牌 → 派彩 → 写 result。
 * onlineAction 和 handleLeave（离场弃牌也可能终局）共用。
 */
function resolveOnlineIfDone(room) {
  if (!(room.state?.finished && room.state.phase === PHASE.SHOWDOWN && !room.state.result)) return
  const res = showdown(room.state, room.hands)
  // 隐私：弃牌者的底牌绝不外发
  const safeHands = (res.hands ?? []).map((h) => ({
    uid: h.uid, nickname: h.nickname, folded: h.folded,
    totalBet: h.totalBet ?? 0,
    hole: h.folded ? [] : (h.hole ?? []),
    cards: h.folded ? [] : (h.cards ?? []),
    hand: h.folded ? null : h.hand,
    isWinner: h.isWinner,
    won: h.won,
  }))
  const safePotLayers = (res.potLayers ?? []).map((layer) => ({
    ...layer,
    // 未匹配退回仅指本层唯一出资人（§3.2）；多人出资但全部弃牌的层是死钱，不是退款
    isUncalledReturn: (layer.contributorUids ?? []).length === 1,
  }))
  room.state.result = {
    pot: res.pot,
    winnings: res.winnings ?? [],
    potLayers: safePotLayers,
    hands: safeHands,
  }
  room.recentHands.unshift({
    handId: room.handId,
    gameType: room.gameType,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    endedAt: Date.now(),
    communityCards: [...(room.state.communityCards ?? [])],
    actionLog: (room.state.actionLog ?? []).map(({ uid, nickname, type, amount, betTotal, phase, at }) => ({
      uid, nickname, type, amount, betTotal, phase, at,
    })),
    result: structuredClone(room.state.result),
  })
  if (room.recentHands.length > 3) room.recentHands.length = 3
  for (const w of room.state.result.winnings) {
    const ss = room.state.seats.find((s) => s.uid === w.uid)
    if (ss) ss.seeds += w.amount
  }
  // I8 筹码守恒：派彩后底池归零，筹码只在座位上
  room.state.pot = 0
  syncSeats(room)
}

// ── 行动时钟（线上）──────────────────────────────────────

function disarmTurnClock(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer)
    room.turnTimer = null
  }
}

/**
 * 轮到真人 → 挂 120s 行动时钟；轮到 AI / 手牌结束 → 无真人时钟。
 * AI 回合由 T6 统一调度器接管（它有自己的延迟和防陈旧），不套 120s。
 * 每次重新挂钟都会重置本回合的续时额度。
 */
function armTurnClock(room) {
  disarmTurnClock(room)
  room.deadlineRefreshUsed = false
  const st = room.state
  if (!st || st.finished || !st.turnUid) {
    room.deadlineAt = null
    return
  }
  const seat = room.seats.find((s) => s.uid === st.turnUid)
  if (!seat || seat.kind === 'ai') {
    room.deadlineAt = null
    return
  }
  room.deadlineAt = Date.now() + TURN_MS
  const captured = {
    roomId: room.id,
    handId: room.handId,
    turnSeq: room.turnSeq,
    turnSeatId: st.turnUid,
  }
  room.turnTimer = setTimeout(() => onTurnTimeout(captured), TURN_MS)
  // 测试/进程退出场景不被挂起的定时器拖住
  room.turnTimer.unref?.()
}

/**
 * 行动超时回调（I6 防陈旧）。
 * 捕获的 { roomId, handId, turnSeq, turnSeatId } 与房间现状逐项比对，
 * 任一不一致立即无副作用退出；deadlineAt 还没到也退出（防提前触发）。
 * 一致 → 统一入口弃牌 → 失格名单 + 清私牌 → 正常推进。
 */
function onTurnTimeout(captured) {
  const room = rooms.get(captured.roomId)
  if (!room) return
  const st = room.state
  if (!st || st.finished) return
  if (room.handId !== captured.handId) return
  if (room.turnSeq !== captured.turnSeq) return
  if (st.turnUid !== captured.turnSeatId) return
  if (room.deadlineAt == null || Date.now() < room.deadlineAt) return

  const r = applyRoomAction({
    room,
    actorSeatId: captured.turnSeatId,
    action: { type: 'fold' },
    source: 'timeout',
  })
  if (r.ok) {
    room.inactiveThisHand.add(captured.turnSeatId)
    delete room.hands[captured.turnSeatId]
    touch(room)
  }
}

// ── AI 调度器（规格 §8.8）───────────────────────────────────

/** AI 思考等待（ms）：常见较短、偶尔长考，最多 10 秒；不占用事件循环。 */
const AI_DELAY = { min: 800, max: 10000 }
function setAiDelayRange(min, max) { AI_DELAY.min = min; AI_DELAY.max = max }

function sampleAiThinkDelay(random = Math.random) {
  const progress = Math.max(0, Math.min(1, random()))
  return Math.round(AI_DELAY.min + (AI_DELAY.max - AI_DELAY.min) * progress ** 2)
}

function disarmAiTimer(room) {
  if (room.aiTimer) {
    clearTimeout(room.aiTimer)
    room.aiTimer = null
  }
}

/**
 * 回合切换后的路由：AI → 调度器接管；真人 → 120s 行动时钟；终局 → 全清。
 * applyRoomAction / handleStart 只调它，不各自复制判断。
 */
function afterTurnChanged(room) {
  const st = room.state
  if (!st || st.finished) {
    disarmTurnClock(room)
    disarmAiTimer(room)
    room.deadlineAt = null
    return
  }
  const seat = room.seats.find((s) => s.uid === st.turnUid)
  if (seat?.kind === 'ai') {
    // AI 回合：无真人时钟（deadlineAt 透出 null），由 AI 定时器驱动
    disarmTurnClock(room)
    room.deadlineAt = null
    scheduleAiTurn(room)
  } else {
    disarmAiTimer(room)
    armTurnClock(room)
  }
}

/**
 * 每房同一时刻最多一个 AI 计时器（先清后挂）。
 * 捕获 roomId + handId + turnSeq + turnSeatId，回调前逐项复核。
 */
function scheduleAiTurn(room) {
  disarmAiTimer(room)
  const st = room.state
  if (!st || st.finished || !st.turnUid) return
  const seat = room.seats.find((s) => s.uid === st.turnUid)
  if (!seat || seat.kind !== 'ai') return
  const captured = {
    roomId: room.id,
    handId: room.handId,
    turnSeq: room.turnSeq,
    turnSeatId: st.turnUid,
  }
  const delay = sampleAiThinkDelay()
  room.aiTimer = setTimeout(() => onAiTurn(captured), delay)
  room.aiTimer.unref?.()
}

/**
 * AI 行动回调：逐项复核捕获值 + 座位仍为 AI，构造安全观察，
 * 单次决策，走统一内部行动入口。异常按合法降级处理，绝不卡死牌局。
 * 决策完成后 applyRoomAction 内部的 afterTurnChanged 会调度下一位 AI ——
 * 多个 AI 连续行动是逐个定时器串行，不是同步 while 循环。
 */
function onAiTurn(captured) {
  const room = rooms.get(captured.roomId)
  if (!room || !isOnline(room)) return
  const st = room.state
  if (!st || st.finished) return
  if (room.handId !== captured.handId) return
  if (room.turnSeq !== captured.turnSeq) return
  if (st.turnUid !== captured.turnSeatId) return
  const seat = room.seats.find((s) => s.uid === captured.turnSeatId)
  if (!seat || seat.kind !== 'ai') return

  const rt = room.aiRuntime
  const engineSeat = st.seats.find((s) => s.uid === seat.uid)
  const obs = buildObservation({
    gameType: room.gameType,
    mySeatId: seat.uid,
    myCards: room.hands[seat.uid] ?? [],
    board: st.communityCards,
    pot: st.pot,
    currentBet: st.currentBet,
    myBet: engineSeat?.bet ?? 0,
    mySeeds: engineSeat?.seeds ?? 0,
    bigBlind: room.bigBlind,
    publicPlayers: st.seats.map((s) => ({
      seatId: s.uid, bet: s.bet, totalBet: s.totalBet, seeds: s.seeds, folded: s.folded, allIn: s.allIn,
      isAI: room.seats.find((x) => x.uid === s.uid)?.kind === 'ai',
    })),
    publicActions: (st.actionLog ?? []).slice(-20),
    legalActions: availableActions(st, seat.uid),
  })
  const persona = ensurePersona(rt, seat.uid)
  const aliveTargets = st.seats
    .filter((s) => s.uid !== seat.uid && !s.folded)
    .map((s) => s.uid)
  const ctx = {
    opponentSummary: opponentSummary(rt, seat.uid, aliveTargets),
    emotionDelta: emotionDelta(rt, seat.uid),
    handState: aiHandFlag(rt, seat.uid, room.handId),
  }

  const t0 = Date.now()
  let act = null
  let degraded = false
  try {
    act = decideAction(obs, persona, ctx, Math.random, { onDegraded: () => { degraded = true } })
  } catch (e) {
    // 错误信息不得含私牌（e 是异常对象本身，不含 obs）——只记座位和阶段
    degraded = true
    console.error(`[ai] 决策异常 room=${room.id} seat=${seat.uid} phase=${st.phase}:`, e?.message ?? e)
  }
  if (!act || !['fold', 'check', 'call', 'raise', 'allin'].includes(act.type)) {
    degraded = true
    act = fallbackAction(obs.legalActions)
  }
  const ms = Date.now() - t0
  room.aiStats.decisions += 1
  room.aiStats.totalMs += ms
  room.aiStats.maxMs = Math.max(room.aiStats.maxMs, ms)
  room.aiStats.samples.push(ms)

  const r = applyRoomAction({
    room,
    actorSeatId: seat.uid,
    action: act,
    source: 'ai',
  })
  if (!r.ok) {
    // 决策产物非法 → 用降级链再试一次；仍失败说明规则边界问题，
    // 记日志后 fold 兜底（fold 在非回合也合法清理路径，但这里是回合内）
    degraded = true
    console.error(`[ai] 非法动作降级 room=${room.id} seat=${seat.uid}: ${r.error}`)
    applyRoomAction({
      room,
      actorSeatId: seat.uid,
      action: fallbackAction(obs.legalActions),
      source: 'ai',
    })
  }
  if (degraded) room.aiStats.degraded += 1
}

/** 记录一条公开行动到每个 AI 观察者的对手模型（含 vpip 去重） */
function recordAiObservation(room, actorSeatId, action) {
  const rt = room.aiRuntime
  if (!rt || !action) return
  for (const s of room.seats) {
    if (s.kind !== 'ai' || s.uid === actorSeatId) continue
    recordAction(rt, s.uid, actorSeatId, action)
  }
}

/** 手牌结算 → AI 情绪事件（只在参与者内记录） */
function recordAiHandResults(room) {
  const rt = room.aiRuntime
  const res = room.state?.result
  if (!rt || !res) return
  for (const s of room.seats) {
    if (s.kind !== 'ai' || !room.handParticipants?.has(s.uid)) continue
    const h = res.hands?.find((x) => x.uid === s.uid)
    recordHandResult(rt, s.uid, {
      won: !!h?.isWinner,
      potSize: res.pot ?? 0,
      initialSeeds: room.initialSeeds,
      folded: !!h?.folded,
    })
  }
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
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')
  // 线上局永远不走这里：不碰金瓜子 / 账本 / 局数 / 历史（规格 §6.3）
  if (isOnline(room)) return fail('线上房间不支持结算', 'OFFLINE_ONLY')
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
  // settlePending 是「该结算了」的唯一信号，比 finished 更可靠:
  // 自动开下一手会把 finished 重置成 false，但 settlePending 保留着
  // 「有人刚归零、还没结算」这件事。只判 finished 会把这条路径卡死
  // （实测：收池后有人归零、自动开了下一手、点结算被拒"本手还没结束"）。
  if (!room.state.settlePending) return fail('本手还没结束，不能结算')
  // 只有「暂停」这个动作不需要有人归零 —— 房主可能只是想停下来
  // 手动分池（两人 all-in 和牌、有人下错注），归零是结算的前置，
  // 不是暂停的前置。之前一锅端拒掉，和牌分池的场景直接进不去。
  const action = body.action ?? 'restart'   // restart | disband | pause
  if (zeroed.length === 0 && action !== 'pause') {
    return fail('没有人瓜子归零，不用结算')
  }

  const st = buildSettlement(room.state.seats)

  if (!['restart', 'disband', 'pause'].includes(action)) {
    return fail('未知结算动作：' + action)
  }

  // 并列最高 → 让房主在前端点选（沿用现行交互）。
  // 这种情况不算结算完成，因为还不知道谁收。
  // 「暂停」不需要点选：停下来分池，谁该得多少房主手动给。
  if (action !== 'pause' && st.tieUids?.length > 1 && !body.winnerUid) {
    room.state.settlePending = true
    touch(room)
    return ok({ needPick: true, tieUids: st.tieUids, zeroed: st.zeroed })
  }

  const finalSt = st.tieUids?.length > 1
    ? transfersAfterTiePick(st.zeroed, body.winnerUid)
    : st
  const transfers = finalSt.transfers ?? []

  // 暂停：不转账、不重置，只置 paused（特殊场景：全员 all-in
  // 归零后又平分继续）。必须排在入账之前 return，否则会把账也结了。
  if (action === 'pause') {
    room.state.settlePending = false
    // 回滚点同样要在置 paused 之前记（结算路径的 paused 标在 state 上，
    // 备份若先置标再克隆，恢复时会带回 paused=true）
    room.pauseBackup = room.prevState ?? JSON.parse(JSON.stringify(room.state))
    room.state.paused = true
    room.state.handDone = true
    touch(room)          // touch 已含 persistRoom
    return ok(publicState(room, uid))
  }

  // ── 金瓜子入账（服务端直写，不再让客户端转发）──
  //
  // 旧做法是返回 transfers 给前端，由前端调 account_seed_transfer。
  // 那意味着：房主手机上跑通才算数；房主中途关页面，账就不会记。
  // 而且转账责任落在客户端，谁都能伪造请求。
  //
  // 现在服务端自己写。座位 uid → 账号名，没绑账号就跳过
  // （朋友局里没登录账号的人不参与金瓜子，只记瓜子数）。
  const paid = []
  const skipped = []
  for (const t of transfers) {
    const fromAcct = accountByUid(t.fromUid)
    const toAcct = accountByUid(t.toUid)
    if (!fromAcct || !toAcct) {
      skipped.push({ ...t, reason: '任一方未登录账号' })
      continue
    }
  const r = accountSeedTransfer(fromAcct.account, toAcct.account, t.amount ?? 1)
  if (r.ok && !r.skipped) paid.push(t)
  else {
    // 余额不足等原因导致没转成 —— 不能静默吞掉。
    // 朋友局里"输光了但金瓜子是 0"很常见，至少要让房主看见。
    skipped.push({ ...t, reason: r.error ?? r.reason ?? '跳过' })
    console.warn(`[room] 金瓜子未入账: ${fromAcct.account} → ${toAcct.account}，${r.error ?? r.reason ?? '未知原因'}`)
  }
  }

  // 线下模式不留任何记录（房主口径 2026-09-24）：不写历史、不计局数，
  // 只留金瓜子账本（account_ledger）。离开房间 = 游戏结束，
  // 快照/日志/战绩全部随房间销毁清掉。线上模式照旧。
  if (room.mode !== 'offline') {
    // 局数 +1（在座且登录了账号的人）
    const gamers = room.seats.map((s) => accountByUid(s.uid)?.account).filter(Boolean)
    bumpTotalGames(gamers)

    // 写历史
    try {
      addHistory({
        roomNo: room.id,
        mode: room.mode,
        roundNo: room.roundNo,
        payload: {
          seats: room.state.seats.map((s) => ({
            name: s.nickname,
            delta: s.seeds - room.initialSeeds,
          })),
          transfers: paid,
        },
        createdBy: gamers[0] ?? '',
      })
    } catch (e) {
      console.error('[room] 写历史失败', e)
    }
  }

  if (action === 'disband') {
    room.state.handDone = true
    // 房间销毁 = 全部清理：快照 + 本房历史（上面刚写的那条也一并删掉）。
    // 线下游玩不留记录，只有金瓜子账本保留（房主口径）。
    deleteRoomSnapshot(room.id)
    deleteRoomHistory(room.id)
    rooms.delete(room.id)
    return ok({ paid, skipped, transfers: paid, disbanded: true })
  }

  // 结算并重置：全员回初始值 + 清空大小麦麦位，state 置 null 等房主重新开局。
  //
  // ⚠️ 以前用 offlineNextHand 产出一个 finished=false、turnUid=null 的
  //    「重置态」—— handleStart 的守卫看到 !finished 就拒开局，
  //    于是结算完永远开不了下一手（死锁）。置 null 后：
  //    /start 正常走 initOfflineHand 下大小麦，重复 settle 被
  //    「本手还没开始」挡掉，幂等照样成立。
  for (const s of room.seats) {
    s.seeds = room.initialSeeds
    s.bet = 0
    s.totalBet = 0
    s.blind = null
  }
  room.state = null
  room.prevState = null
  room.pauseBackup = null
  room.handStartState = null
  room.roundNo += 1
  touch(room)
  return ok({ paid, skipped, transfers: paid, roundNo: room.roundNo })
}

/**
 * 暂停 / 继续（房主专用，对局中才可用）。
 *
 * 这是房主桌上那个按钮：对局中显示「暂停」，暂停态显示「继续」。
 * 跟 settle 的 pause 不是一回事 —— settle/pause 是「结算流程里选暂停」，
 * 留在一个归零待结算的状态；这里是对局中途临时停一下。
 *
 * 暂停中的分账只有两键：收（池→人）、出（人→池），随便组合。
 * 继续时按池子状态分流（2026-09-24 实测口径）：
 *
 *   a. 池子为空 → 瓜子已手动分完，本手事实上结束。
 *      不直接开局：先回 needConfirmNextHand 让前端问房主
 *      「池子为空，是否开启新一轮」，确认（confirmNextHand）才真开。
 *
 *   b. 池子有值 → 本手还要打，回滚到「暂停前最后一次行动之前」：
 *      B 下错注、轮转到 C、房主暂停分账、点继续 → 还原成 B 决策。
 *      同样不直接动手：先回 needConfirmRollback + 池子数 + 回滚目标人，
 *      让前端弹「池子有 xxx 瓜子，即将回到 X 的行动位」，
 *      确认（confirmRollback）才真回滚。
 *      快照 = pauseBackup（暂停时存的 prevState，即最后一次行动前）；
 *      没有备份（状态异常）就退回「解除暂停原样恢复」。
 *
 *   c. 长按继续（restartHand）→ 整手重开：逆向回本手开局
 *      （大小麦刚下完）的状态，这一手的所有行动全部作废。
 *      快照 = handStartState（开局时拍的）。
 */
function handlePause(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')
  if (isOnline(room)) return fail('线上房间不支持暂停', 'OFFLINE_ONLY')
  if (room.hostUid !== uid) return fail('只有房主可以暂停')
  if (!room.state) return fail('本手还没开始')

  // paused 已经是 true → 这次调用是「继续」
  if (room.state.paused) {
    // 长按继续 = 重开本手：整手回开局态（前端的确认弹窗已经问过）
    if (body.restartHand === true) {
      if (!room.handStartState) return fail('没有本手开局的记录，无法重开')
      room.state = JSON.parse(JSON.stringify(room.handStartState))
      room.state.paused = false
      room.pauseBackup = null
      room.prevState = null
      syncSeats(room)
      touch(room)
      return ok(publicState(room, uid))
    }
    if (body.confirmNextHand === true) {
      room.state.paused = false
      room.pauseBackup = null
      room.prevState = null
      autoNextHand(room)
      touch(room)
      return ok(publicState(room, uid))
    }
    if (body.confirmRollback === true) {
      // 房主确认回滚：还原到暂停前最后一次行动之前
      if (room.pauseBackup) {
        room.state = JSON.parse(JSON.stringify(room.pauseBackup))
      } else {
        room.state.paused = false
      }
      room.pauseBackup = null
      room.prevState = null
      syncSeats(room)
      touch(room)
      return ok(publicState(room, uid))
    }
    if ((room.state.pot ?? 0) <= 0) {
      // 池子分空了 → 保持暂停，让前端弹「是否开新一轮」。
      // 房主确认后带 confirmNextHand=true 再调一次本接口。
      return ok({ ...publicState(room, uid), needConfirmNextHand: true })
    }
    // 池子有值 → 保持暂停，让前端弹「回到 X 的行动位」。
    // 房主确认后带 confirmRollback=true 再调一次本接口。
    const backUid = room.pauseBackup?.turnUid ?? null
    const backSeat = backUid
      ? (room.pauseBackup.seats ?? []).find((s) => s.uid === backUid)
      : null
    return ok({
      ...publicState(room, uid),
      needConfirmRollback: true,
      rollbackPot: room.state.pot,
      rollbackTurnUid: backUid,
      rollbackTurnName: backSeat?.nickname ?? null,
    })
  }

  // 本手已结束（收完池了）没什么好暂停的
  if (room.state.finished) return fail('本手已经结束')
  // 回滚目标 = 最后一次行动之前的状态；还没人动过就存当前。
  // ⚠️ 必须在置 paused 之前克隆 —— 不然备份里就带着 paused=true，
  //    继续时回滚过去等于没恢复（实测踩过）。
  room.pauseBackup = room.prevState ?? JSON.parse(JSON.stringify(room.state))
  room.state.paused = true
  touch(room)
  return ok(publicState(room, uid))
}

/**
 * 线上重置牌桌（§6.4）：仅房主、仅两手之间。
 * 所有在座座位恢复默认筹码，清 AI 的公开统计/情绪/计时，但保留座位和人设。
 * 不碰账号金币、账本、局数、历史 —— 那些是线下的东西。
 */
function handleResetOnline(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')
  if (!isOnline(room)) return fail('仅线上房间支持此操作', 'ONLINE_ONLY')
  const seat = authSeat(room, body, uid)
  if (!seat) return fail('身份验证失败', 'AUTH_FAILED')
  if (seat.uid !== room.hostUid) return fail('只有房主可以重置牌桌', 'NOT_HOST')
  if (room.state && !room.state.finished) {
    return fail('本手进行中，结束后才能重置', 'HAND_IN_PROGRESS')
  }
  for (const s of room.seats) {
    s.seeds = room.initialSeeds
    s.bet = 0
    s.totalBet = 0
    s.blind = null
  }
  // 已结束的本手状态一并清掉：不然投影还会拿旧牌局的座位筹码盖过重置值，
  // 留着旧 actionLog 也违背「清空历史行动」的口径。下一手照常走 /start。
  room.state = null
  room.hands = {}
  room.recentHands = []
  room.handParticipants = new Set()
  room.inactiveThisHand = new Set()
  disarmTurnClock(room)
  disarmAiTimer(room)
  room.deadlineAt = null
  room.deadlineRefreshUsed = false
  // 重置 = 新开一局：清掉旧运行态，并给仍在座的 AI 刷新人设与公开标签。
  if (room.aiRuntime) {
    clearRuntime(room.aiRuntime)
    for (const s of room.seats) {
      if (s.kind !== 'ai') continue
      s.styleLabel = ensurePersona(room.aiRuntime, s.uid).styleLabel
    }
  }
  touch(room)
  return ok(publicState(room, seat.uid))
}

/**
 * 添加一个 AI 座位（§6.3）：仅房主、仅两手之间、真人 AI 合计不超 8。
 * AI 身份 seatId、人设、风格标签全部由服务端生成；座位携带一个
 * 永不下发的内部令牌 —— 任何客户端都无法凭 API 冒名 AI 行动。
 */
function handleAddAi(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')
  if (!isOnline(room)) return fail('线下房间不支持 AI', 'OFFLINE_ONLY')
  const seat = authSeat(room, body, uid)
  if (!seat) return fail('身份验证失败', 'AUTH_FAILED')
  if (seat.uid !== room.hostUid) return fail('只有房主可以添加 AI', 'NOT_HOST')
  if (room.state && !room.state.finished) {
    return fail('本手进行中，结束后才能添加', 'HAND_IN_PROGRESS')
  }
  if (room.seats.length >= MAX_SEATS) return fail('房间已满', 'ROOM_FULL')

  const seatId = 'ai_' + crypto.randomBytes(8).toString('base64url')
  const persona = ensurePersona(room.aiRuntime, seatId)
  // 随机仓鼠名当昵称（优先没被占用的），头像用同名仓鼠；
  // 风格标签只留作辅助信息，不当名字用
  const used = new Set(room.seats.map((s) => s.nickname))
  const free = HAMSTERS.filter((h) => !used.has(h.name))
  const pick = (free.length ? free : HAMSTERS)[Math.floor(Math.random() * (free.length || HAMSTERS.length))]
  const nickname = used.has(pick.name) ? `${pick.name}${room.seats.length}` : pick.name

  room.seats.push({
    uid: seatId,
    kind: 'ai',
    // 内部令牌：不下发、不展示 —— 只是让 authSeat 永远拒绝冒名请求
    seatToken: crypto.randomBytes(32).toString('base64url'),
    accountUid: null,
    nickname,
    avatar: pick.id,
    seeds: room.initialSeeds,
    bet: 0,
    totalBet: 0,
    blind: null,
    styleLabel: persona.styleLabel,
  })
  touch(room)
  return ok(publicState(room, seat.uid))
}

/**
 * 移除 AI 座位（§6.3）：仅房主、仅两手之间。
 * 进行中的手牌不可移除（不能中途改变参与者名单）。
 */
function handleRemoveAi(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')
  if (!isOnline(room)) return fail('线下房间不支持 AI', 'OFFLINE_ONLY')
  const seat = authSeat(room, body, uid)
  if (!seat) return fail('身份验证失败', 'AUTH_FAILED')
  if (seat.uid !== room.hostUid) return fail('只有房主可以移除 AI', 'NOT_HOST')
  if (room.state && !room.state.finished) {
    return fail('本手进行中，结束后才能移除', 'HAND_IN_PROGRESS')
  }
  const target = room.seats.find((s) => s.uid === String(body?.targetSeatId ?? ''))
  if (!target) return fail('座位不存在')
  if (target.kind !== 'ai') return fail('只能移除 AI 座位')
  room.seats = room.seats.filter((s) => s.uid !== target.uid)
  if (room.aiRuntime) removeAiRuntimeSeat(room.aiRuntime, target.uid)
  touch(room)
  return ok(publicState(room, seat.uid))
}

/**
 * 行动续时（§7 时钟）：仅当前真人行动者、每回合一次、+120s。
 * 校验顺序与 /action 一致：handId → turnSeq → 当前行动者 → 续时额度。
 */
function handleExtendTurn(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在', 'ROOM_NOT_FOUND')
  if (!isOnline(room)) return fail('仅线上房间支持续时', 'ONLINE_ONLY')
  const seat = authSeat(room, body, uid)
  if (!seat) return fail('身份验证失败', 'AUTH_FAILED')
  if (Number(body?.handId) !== room.handId) return fail('手牌已过期', 'STALE_HAND')
  if (Number(body?.turnSeq) !== room.turnSeq) return fail('行动已过期', 'STALE_TURN')
  const st = room.state
  if (!st || st.finished) return fail('本局已结束', 'HAND_FINISHED')
  if (st.turnUid !== seat.uid) return fail('还没到你的回合', 'NOT_YOUR_TURN')
  if (room.deadlineAt == null) return fail('当前没有进行中的计时')
  if (room.deadlineRefreshUsed) return fail('本回合已续时过', 'EXTENSION_USED')

  room.deadlineRefreshUsed = true
  room.deadlineAt = Date.now() + TURN_MS
  // 重挂同一个捕获四元组的定时器（座位/轮次都没变，只是截止延后）
  disarmTurnClock(room)
  const captured = {
    roomId: room.id, handId: room.handId, turnSeq: room.turnSeq, turnSeatId: seat.uid,
  }
  room.turnTimer = setTimeout(() => onTurnTimeout(captured), TURN_MS)
  room.turnTimer.unref?.()
  touch(room)
  return ok({ ...publicState(room, seat.uid), deadlineAt: room.deadlineAt })
}

function handleLeave(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return ok({ left: true })

  // 线上：必须持座位令牌才能离开；uid / seatId 伪造不生效。
  // 房主离开销毁整房（线下旧口径一致，但要令牌证明真是房主）。
  if (isOnline(room)) {
    const seat = authSeat(room, body, uid)
    if (!seat) return fail('身份验证失败', 'AUTH_FAILED')
    if (seat.uid === room.hostUid) {
      // 房主离开销毁整房：先取消行动时钟/AI 任务再删房（§7.2）
      disarmTurnClock(room)
      disarmAiTimer(room)
      deleteRoomSnapshot(room.id)
      deleteRoomHistory(room.id)
      rooms.delete(room.id)
      return ok({ roomClosed: true })
    }
    // 本手进行中离开 = 经统一入口合法弃牌（非回合也能弃：forfeit 路径）
    if (room.state && !room.state.finished) {
      applyRoomAction({ room, actorSeatId: seat.uid, action: { type: 'fold' }, source: 'human' })
    }
    room.seats = room.seats.filter((s) => s.uid !== seat.uid)
    room.inactiveThisHand?.add(seat.uid)
    delete room.hands[seat.uid]
    touch(room)
    return ok({ left: true })
  }

  if (room.hostUid === uid) {
    // 房主退出：整房销毁，所有人一起弹回大厅。
    // 快照 + 本房历史全部清理 —— 线下游玩不留任何记录
    // （瓜子数、日志、快照都是冗余数据），金瓜子账本保留。
    // 快照漏删的话重启后死房复活（僵尸房）。
    deleteRoomSnapshot(room.id)
    deleteRoomHistory(room.id)
    rooms.delete(room.id)
    return ok({ roomClosed: true })
  }

  room.seats = room.seats.filter((s) => s.uid !== uid)

  // 普通成员在对局中离场 = 弃牌。弃牌不分是否轮到决策，随时可以：
  // 不给非回合弃牌，轮到离场者时整手就卡死了。
  //
  // ⚠️ 两个坑都踩过：
  //    1. applyAction 非回合返回 {error} 没 state，直接赋值会毁掉整局
  //    2. 从 state.seats 移除会让 sbIndex 索引漂移、玩家回合悬死 ——
  //       所以走「标记 folded」，不从引擎座位里删人
  if (room.state && !room.state.finished) {
    try {
      if (isOnline(room)) {
        const r = forfeit(room.state, uid)
        if (r.state) {
          room.state = r.state
          resolveOnlineIfDone(room)   // 弃到只剩一人也可能终局
        }
      } else {
        const r = applyOfflineAction(room.state, { uid, type: 'fold' })
        if (r.state) room.state = r.state
        finishIfNeeded(room)
      }
      syncSeats(room)
    } catch {
      // 引擎异常不影响「人已经走了」这个事实
    }
  }
  touch(room)
  return ok({ left: true })
}

// ── 维护：清数据 ────────────────────────────────────────

/** token 校验。抽出来避免 stats / wipe 各写一遍还写歪 */
function adminAuthed(body) {
  const expect = process.env.HAMSTER_ADMIN_TOKEN
  if (!expect) return { err: '服务端未配置 HAMSTER_ADMIN_TOKEN，清理口子未启用' }
  const got = String(body?.token ?? '')
  const a = Buffer.from(got)
  const b = Buffer.from(expect)
  // 长度不等时不能进 timingSafeEqual（它要求等长），先比长度
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { err: 'token 不对' }
  }
  return { ok: true }
}

/**
 * 清理模式（就暴露这两种语义化动作）：
 *
 *   clear-all     连账号一起清。所有人重新注册，金瓜子归零。
 *   clear-others  只清账号以外的：账本、历史战绩、房间（含内存）。
 *                 账号和登录态保留，金瓜子数字也保留。
 *
 * 不给「自定义清某几类」的公开路径 —— 清理这种事选项越少越安全。
 */
function resolveWipeScope(body) {
  const mode = String(body?.mode ?? '')
  if (mode === 'clear-all') return { what: {}, label: '连账号一起清' }
  if (mode === 'clear-others') {
    return { what: { accounts: false }, label: '保留账号，清其他' }
  }
  return null
}

/**
 * 清数据。实测一段时间会攒一堆垃圾（临时账号、测试房间、历史战绩）。
 *
 * 鉴权：body.token 必须等于环境变量 HAMSTER_ADMIN_TOKEN。
 *   不设 token 就拒绝 —— 绝不能做成一个谁都能调的 wipe 按钮。
 *   真实口令只在服务器进程环境里，仓库里 ecosystem 那个是占位空串。
 *
 * 内存里的房间一并清：快照删了内存还在的话，下一轮 touch() 又把
 * 死房间写回快照表，白清。
 */
function handleAdminWipe(body) {
  const auth = adminAuthed(body)
  if (!auth.ok) return fail(auth.err)

  const scope = resolveWipeScope(body)
  if (!scope) {
    return fail('需要 mode：clear-all（连账号）或 clear-others（保留账号）')
  }

  const before = dataCounts()
  const removed = wipeData(scope.what)
  const wipedMemoryRooms = rooms.size
  for (const r of rooms.values()) { disarmTurnClock(r); disarmAiTimer(r) }
  rooms.clear()

  return ok({
    mode: String(body?.mode ?? ''),
    label: scope.label,
    before,
    removed,
    wipedMemoryRooms,
  })
}

/** 只读：各表行数。同样要 token，免得把库规模暴露给外面 */
function handleAdminStats(body) {
  const auth = adminAuthed(body)
  if (!auth.ok) return fail(auth.err)
  return ok({ ...dataCounts(), memoryRooms: rooms.size })
}

// ── 工具 ───────────────────────────────────────────────

function createShuffledDeckSafe(gameType) {
  // 用 crypto 而不是 Math.random，牌局才不可预测
  return createShuffledDeck(gameType, () => crypto.randomInt(2 ** 32) / 2 ** 32)
}

// ── 账号 API ────────────────────────────────────────────

/** 账号名登录 / 注册。无密码，知道名字就能登（朋友局设定）。 */
function handleAccountLogin(body) {
  const uid = String(body?.uid ?? '').trim()
  if (!uid) return fail('缺少设备身份')
  const r = loginAccount(body?.account, uid, {
    nickname: body?.nickname, avatar: body?.avatar,
  })
  if (!r.ok) return fail(r.error)
  return ok(r)
}

/** 当前身份 + 金瓜子 + 局数 */
function handleAccountMe(body) {
  const uid = String(body?.uid ?? '').trim()
  const me = accountByUid(uid)
  if (!me) return ok({ loggedIn: false })
  return ok({ loggedIn: true, ...me, ledger: accountLedgerRows(me.account) })
}

function handleAccountUpdate(body) {
  return ok(updateMyAccount(String(body?.uid ?? ''), {
    nickname: body?.nickname, avatar: body?.avatar,
  }))
}

function handleAccountLogout(body) {
  return ok(logoutAccount(String(body?.uid ?? '')))
}

function handleAccountLedger(body) {
  const me = accountByUid(String(body?.uid ?? ''))
  if (!me) return ok({ rows: [] })
  return ok({ rows: accountLedgerRows(me.account) })
}

/** 与某人结清账本（双方同时冲销） */
function handleAccountClear(body) {
  const me = accountByUid(String(body?.uid ?? ''))
  if (!me) return fail('尚未登录账号')
  const r = clearAccountLedgerRow(me.account, body?.peer)
  if (!r.ok) return fail(r.error)
  return ok({ ...r, goldenSeeds: goldenSeedsOf(me.account) })
}

function handleAccountHistory(body) {
  const me = accountByUid(String(body?.uid ?? ''))
  return ok({ rows: listHistory(50, me?.account ?? null) })
}

function fail(msg, code) {
  // code = 稳定机器码（规格 §5），error 仍是给人看的中文描述
  return code ? { ok: false, error: msg, code } : { ok: false, error: msg }
}
function ok(data) { return { ok: true, data } }

// ── 房间快照 ────────────────────────────────────────────

/** 每次房间状态变更后调用：写 SQLite，重启后能恢复（线上房除外 —— V1 禁快照） */
function persistRoom(room) {
  // 线上牌局不持久化：恢复出来的房间会缺手牌/令牌/计时器，
  // 属于「有座位没牌局」的假恢复，比直接失效更糟（规格 §1.3 / I12）。
  if (isOnline(room)) return
  try {
    saveRoomSnapshot(room.id, room.mode, serializeRoom(room))
  } catch (e) {
    console.error('[room] 快照写入失败', e)
  }
}

/** 房间 → 可 JSON 化快照 */
function serializeRoom(room) {
  return {
    id: room.id,
    mode: room.mode,
    gameType: room.gameType,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    initialSeeds: room.initialSeeds,
    hostUid: room.hostUid,
    // online 的底牌只存内存不落盘：重启后重新发比恢复更安全
    seats: room.seats.map((s) => ({
      uid: s.uid, nickname: s.nickname, avatar: s.avatar, seeds: s.seeds,
      bet: s.bet, totalBet: s.totalBet, blind: s.blind,
    })),
    state: room.mode === 'offline' ? room.state : null,
    // 回滚快照也要落盘：服务器在暂停中重启，恢复后「继续→回滚」
    // 和「重开本手」还得能用。都是纯 JSON 对象，直接存。
    prevState: room.prevState ?? null,
    pauseBackup: room.pauseBackup ?? null,
    handStartState: room.handStartState ?? null,
    dealerUid: room.dealerUid,
    roundNo: room.roundNo,
    rev: room.rev ?? 0,
  }
}

function restoreRoom(snap) {
  // 线上房间一律不恢复（V1 无伪恢复）：座位还在但手牌/令牌全丢，
  // 恢复出来是个没法玩的空壳。顺手清掉旧版残留快照，免得占着位置。
  if (snap?.mode === 'online') {
    try { deleteRoomSnapshot(snap.roomId) } catch { /* 清不掉也不阻塞启动 */ }
    return null
  }
  const room = {
    id: snap.roomId,
    mode: snap.mode,
    gameType: snap.state?.gameType ?? 'long',
    smallBlind: snap.state?.smallBlind ?? 10,
    bigBlind: snap.state?.bigBlind ?? 20,
    initialSeeds: snap.state?.initialSeeds ?? 3000,
    hostUid: snap.state?.hostUid,
    seats: snap.state?.seats ?? [],
    state: snap.state?.state ?? null,
    hands: {},
    dealerUid: snap.state?.dealerUid ?? null,
    roundNo: snap.state?.roundNo ?? 1,
    rev: snap.state?.rev ?? 0,
    prevState: snap.state?.prevState ?? null,
    pauseBackup: snap.state?.pauseBackup ?? null,
    handStartState: snap.state?.handStartState ?? null,
    lastActive: Date.now(),
    restored: true,
  }
  if (!room.seats.length || !room.hostUid) return null
  rooms.set(room.id, room)
  return room
}

// ── HTTP 骨架 ─────────────────────────────────────────

const ROUTES = {
  // 账号
  '/api/account/login': handleAccountLogin,
  '/api/account/me': handleAccountMe,
  '/api/account/update': handleAccountUpdate,
  '/api/account/logout': handleAccountAccountLogoutWrap,
  '/api/account/ledger': handleAccountLedger,
  '/api/account/clear': handleAccountClear,
  '/api/account/history': handleAccountHistory,
  // 房间
  '/api/room/create': handleCreate,
  '/api/room/join': handleJoin,
  '/api/room/list': handleList,
  '/api/room/state': handleState,
  '/api/room/start': handleStart,
  '/api/room/action': handleAction,
  '/api/room/extend-turn': handleExtendTurn,
  '/api/room/stage': handleStage,
  '/api/room/reorder': handleReorder,
  '/api/room/pause': handlePause,
  '/api/room/settle': handleSettle,
  '/api/room/reset-online': handleResetOnline,
  '/api/room/add-ai': handleAddAi,
  '/api/room/remove-ai': handleRemoveAi,
  '/api/room/leave': handleLeave,
  '/api/admin/stats': handleAdminStats,
  '/api/admin/wipe': handleAdminWipe,
}

function handleAccountAccountLogoutWrap(b) { return handleAccountLogout(b) }

// ── 静态文件 ───────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

/** 静态资源；SPA 回退到 index.html（hash 路由，其实用不上，但兜底） */
function serveStatic(url, res) {
  let p = decodeURIComponent(url.pathname)
  if (p === '/') p = '/index.html'
  // 防目录穿越。必须带 path.sep 比 —— 裸 startsWith 会被
  // `dist-evil/` 这种同前缀目录绕过去。
  const full = path.normalize(path.join(STATIC_DIR, p))
  if (full !== STATIC_DIR && !full.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403); return res.end('Forbidden')
  }

  // /room?uid=&room= → 调试页（room-repo 接上之前的真实数据预览）
  // 带 no-cache：这是每次改都在动的开发页，不能让浏览器拿旧版本
  // （踩过：页面 JS 报 AVATARS is not defined，其实是缓存了旧 HTML）
  if (p === '/room' || (p === '/index.html' && url.searchParams.has('room'))) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    })
    return res.end(debugPage())
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      // SPA 回退
      const idx = path.join(STATIC_DIR, 'index.html')
      return fs.readFile(idx, (e2, b2) => {
        if (e2) { res.writeHead(404); return res.end('Not Found') }
        res.writeHead(200, { 'Content-Type': MIME['.html'] })
        res.end(b2)
      })
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': path.extname(full) === '.html' ? 'no-cache' : 'public, max-age=31536000',
    })
    res.end(buf)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')

  // 健康检查：不鉴权，服务器探活用
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      ok: true, rooms: rooms.size, mode: 'up',
      restored: restoredCount,
      uptime: Math.round(process.uptime()),
    }))
  }

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  // GET/HEAD → 静态资源（前端页面；同域所以不需要 CORS）
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(url, res)
  }

  const handler = ROUTES[url.pathname]
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(fail('接口不存在')))
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(fail('仅支持 POST')))
  }

  // 请求体大小上限
  const chunks = []
  let size = 0
  try {
    for await (const c of req) {
      size += c.length
      if (size > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(fail('请求体过大')))
      }
      chunks.push(c)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    var body = text ? JSON.parse(text) : {}
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(fail('请求体不是合法 JSON')))
  }

  // 身份从请求体拿。线下照旧认设备 uid；线上接口内部再用 seatId+seatToken 认座。
  // /state 例外：纯旁观请求可以没有任何身份，服务端按旁观者投影返回。
  const uid = String(body.uid ?? '').trim()
  if (!uid && url.pathname !== '/api/room/state') {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(fail('缺少 uid')))
  }

  try {
    const out = handler(body, uid)
    res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (e) {
    console.error('[room] 未捕获异常', e)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(fail('服务端异常：' + (e?.message ?? String(e)))))
  }
})

// 定期清扫超时空房，防内存只增不减
setInterval(() => {
  const now = Date.now()
  for (const [id, r] of rooms) {
    if (now - r.lastActive > ROOM_TTL) {
      disarmTurnClock(r)       // 计时器跟房间一起死，防陈旧回调打到别处
      disarmAiTimer(r)
      rooms.delete(id)
      deleteRoomSnapshot(id)
      deleteRoomHistory(id)   // 房间销毁 = 记录全清，只留金瓜子账本
    }
  }
}, 5 * 60 * 1000).unref()

// ── 启动：开库 + 恢复快照 ──────────────────────────────

let restoredCount = 0
openDb()
try {
  // 快照保鲜期 24h：一周前的死房不值得复活，直接清掉
  const SNAP_MAX_AGE = 24 * 3600 * 1000
  for (const snap of loadAllRoomSnapshots()) {
    if (Date.now() - Date.parse(snap.updatedAt) > SNAP_MAX_AGE) {
      deleteRoomSnapshot(snap.roomId)
      deleteRoomHistory(snap.roomId)   // 陈旧房一并清历史，不留孤儿记录
      continue
    }
    if (restoreRoom(snap)) restoredCount++
  }
  if (restoredCount > 0) {
    console.log(`[room] 从快照恢复 ${restoredCount} 个房间`)
  }
} catch (e) {
  console.error('[room] 快照恢复失败', e)
}

// 什么时候监听端口：
//   1. 被测试 import 时不 listen（测试自己起服务占端口）→ LISTEN=0
//   2. pm2 / node 直接跑 → LISTEN=1
//
// ⚠️ 不要用「import.meta.url === pathToFileURL(argv[1]).href」判断是不是主模块。
//    pm2 的 fork 模式会把 argv[1] 设成 ProcessContainerFork.js，
//    这个判断恒 false —— 进程显示 online、日志一片空白、端口从没监听，
//    而且不报任何错（踩过，查了半天）。
//    现在用 LISTEN 显式声明：测试设 0，其余设 1。
const SHOULD_LISTEN = process.env.LISTEN !== '0'

if (SHOULD_LISTEN) {
  server.listen(PORT, () => {
    console.log(`[room] listening on ${PORT}`)
    console.log(`[room] static: ${STATIC_DIR} ${fs.existsSync(STATIC_DIR) ? '' : '(未构建，仅 API 可用)'}`)
    console.log(`[room] db: ${DB_PATH}`)
  })
}

// 导出：供集成测试在进程内起服务（避免重复 listen）
// onTurnTimeout/onAiTurn 给测试直接触发回调，不用真等 120s / AI 延迟；
// setAiDelayRange 让测试把 AI 延迟压成 0（规格 §8.8 测试注入）
export { server, rooms, restoreRoom, onTurnTimeout, onAiTurn, setAiDelayRange, sampleAiThinkDelay }
