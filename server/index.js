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

import {
  initOfflineHand,
  applyOfflineAction,
  availableActions as offlineActions,
  nextStage as offlineNextStage,
} from '../shared/logic/offline-room.mjs'

import { buildSettlement, transfersAfterTiePick } from '../shared/logic/settlement.mjs'

import {
  openDb, DB_PATH,
  loginAccount, accountByUid, updateMyAccount, logoutAccount,
  accountSeedTransfer, accountLedgerRows, clearAccountLedgerRow,
  bumpTotalGames, goldenSeedsOf,
  addHistory, listHistory,
  saveRoomSnapshot, loadRoomSnapshot, loadAllRoomSnapshots, deleteRoomSnapshot,
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
    smallBlind: Math.max(1, num(cfg.smallBlind, 10)),
    bigBlind: Math.max(1, num(cfg.bigBlind, 20)),
    initialSeeds: Math.max(1, num(cfg.initialSeeds, 3000)),
    hostUid,
    seats: [{
      uid: hostUid,
      nickname: host.nickname ?? '匿名',
      avatar: num(host.avatar, 1),
      seeds: Math.max(1, num(cfg.initialSeeds, 3000)),
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
  // 列可加入的房：offline 模式、未满、有动静。
  // 进行中的房也列（朋友局允许中途加入旁观，下一手入座），用 inProgress 标注。
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
      inProgress: !!(r.state && !r.state.finished),
      isMine: r.hostUid === uid,
      iAmIn: r.seats.some((s) => s.uid === uid),
    })
  }
  return ok({ rooms: list })
}

function handleState(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  // 轮询只续命不写库：持久化收口在 touch()，只跟着「变更」走
  bumpActivity(room)
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
  if (!room) return fail('房间不存在')
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
function handleStart(body, uid) {  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  if (room.hostUid !== uid) return fail('只有房主可以开局')
  if (room.seats.length < 2) return fail('至少需要 2 名玩家')
  // 还在打的一手不能重开。暂停中可以开局/重开 —— 暂停就是让房主
  // 停下来改设置再开始的，卡在这里的话暂停态没有任何出路。
  if (room.state && !room.state.finished && !room.state.paused) {
    return fail('本手还没结束')
  }

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

  // 收池：谁都可以点，不卡回合（桌面上的公共池谁都能顺手收）。
  // 收完 = 本手结束：
  //   · 有人归零 → 进结算，等房主决定（重置 / 解散 / 暂停）
  //   · 无人归零 → 直接开下一手，不用房主再点一次
  if (type === 'collect') {
    const r = applyOfflineAction(room.state, { uid, type })
    if (r.error) return fail(r.error)
    room.state = r.state
    syncSeats(room)
    const settled = finishIfNeeded(room)
    // 没人归零 → 自动轮转下一手。之前收完就停住，必须房主手动
    // 设小麦位再开局，桌面上每个人都得等 —— 实测提过这个问题。
    if (!settled) autoNextHand(room)
    touch(room)
    return ok(publicState(room, uid))
  }

  // 下注类动作：过牌 / 跟注 / 加注 / 弃牌 / 暂停划拨
  // ⚠️ check 必须在列。漏了它，点「过」会掉到末尾的
  //    「未知动作」，页面看着就是没反应 —— 实测踩过。
  // give 是暂停态手动划拨（all-in 归零后收池再平分的场景）。
  if (['check', 'fold', 'call', 'raise', 'give'].includes(type)) {
    const r = applyOfflineAction(room.state, {
      uid, type, amount: body.amount, toUid: body.toUid,
    })
    if (r.error) return fail(r.error)
    room.state = r.state
    syncSeats(room)
    const settled = finishIfNeeded(room)
    // 弃到只剩 1 人 → 引擎自动替他收池。同样没人归零就自动开下一手，
    // 不然桌上所有人都得等房主手动开局。
    if (!settled && r.autoCollected) autoNextHand(room)
    touch(room)
    return ok(publicState(room, uid))
  }

  return fail('未知动作：' + type)
}

/**
 * 收池 / 自动收池之后：
 *   · 有人归零 → settle-pending（只给房主弹结算窗，其他人蒙层等），返回 true
 *   · 无人归零 → 返回 false，由调用方决定是否自动开下一手
 */
function finishIfNeeded(room) {
  if (!room.state?.finished) return false
  const zeroed = room.state.seats.filter((s) => s.seeds <= 0)
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
    syncSeats(room)
  } catch (e) {
    // 自动开局失败不能把收池这个动作一起搞失败 —— 池子已经收完了。
    // 退回「等房主手动开局」，房主点一下就能继续。
    console.error('[room] 自动开下一手失败:', e?.message ?? e)
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
  resolveOnlineIfDone(room)
  touch(room)
  return ok(publicState(room, uid))
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

  // 暂停：不转账、不重置，只置 paused（特殊场景：全员 all-in
  // 归零后又平分继续）。必须排在入账之前 return，否则会把账也结了。
  if (action === 'pause') {
    room.state.settlePending = false
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

  if (action === 'disband') {
    room.state.handDone = true
    deleteRoomSnapshot(room.id)
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
  room.roundNo += 1
  touch(room)
  return ok({ paid, skipped, transfers: paid, roundNo: room.roundNo })
}

/**
 * 暂停 / 继续（房主专用，对局中才可用）。
 *
 * 这是房主桌上那个按钮：对局中显示「暂停」，暂停态显示「继续」。
 * 跟 settle 的 pause 不是一回事 —— settle/pause 是「结算流程里选暂停」，
 * 留在一个归零待结算的状态；这里是对局中途临时停一下，
 * 停完还能原样继续（currentBet / turnUid / actedUids 全部保留）。
 *
 * 为什么单独开接口而不复用 settle 的 pause：
 *   settle/pause 要求 finished + 有人归零，对局中途根本进不去。
 */
function handlePause(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return fail('房间不存在')
  if (room.hostUid !== uid) return fail('只有房主可以暂停')
  if (!room.state) return fail('本手还没开始')

  // paused 已经是 true → 这次调用是「继续」
  if (room.state.paused) {
    room.state.paused = false
    touch(room)
    return ok(publicState(room, uid))
  }

  // 本手已结束（收完池了）没什么好暂停的
  if (room.state.finished) return fail('本手已经结束')
  room.state.paused = true
  touch(room)
  return ok(publicState(room, uid))
}

function handleLeave(body, uid) {
  const room = rooms.get(String(body?.roomId ?? ''))
  if (!room) return ok({ left: true })

  if (room.hostUid === uid) {
    // 房主退出：整房销毁，所有人一起弹回大厅。
    // 快照必须一起删 —— 漏删的话重启后死房复活（僵尸房）。
    deleteRoomSnapshot(room.id)
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

function fail(msg) { return { ok: false, error: msg } }
function ok(data) { return { ok: true, data } }

// ── 房间快照 ────────────────────────────────────────────

/** 每次房间状态变更后调用：写 SQLite，重启后能恢复 */
function persistRoom(room) {
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
    dealerUid: room.dealerUid,
    roundNo: room.roundNo,
    rev: room.rev ?? 0,
  }
}

function restoreRoom(snap) {
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
  '/api/room/stage': handleStage,
  '/api/room/reorder': handleReorder,
  '/api/room/pause': handlePause,
  '/api/room/settle': handleSettle,
  '/api/room/leave': handleLeave,
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

  // 身份从请求体拿（朋友局，服务端信任，不验签不设密码）
  const uid = String(body.uid ?? '').trim()
  if (!uid) {
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
      rooms.delete(id)
      deleteRoomSnapshot(id)
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
export { server, rooms }
