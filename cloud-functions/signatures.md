/**
 * 云函数签名定义 — 仓鼠聚会
 *
 * 这些函数跑在 CloudBase 云函数上，用 service_role 访问数据库，
 * 是唯一能写 rooms / hands / decks / room_members 的入口。
 * 前端通过 HTTP 调用（或 app.callFunction）。
 *
 * 免费体验版限制：云函数超时 3s 且不可改。
 * 每个函数只做几次数据库操作，远小于 3s。
 *
 * ⚠️ 待实测：免费版云函数不支持 VPC，能否连通 PostgreSQL 未确认。
 *    若不连通，需把逻辑前移到 PG 的 SECURITY DEFINER 函数。
 */

/**
 * POST /hand/create
 * 创建一局：洗牌、建房间状态、发底牌、扣盲注
 *
 * body: { roomNo, players:[{uid,nickname,avatar,seeds}], smallBlind, bigBlind, gameType, dealerUid }
 * resp: { state, holeCardsByUid }   ← holeCards 由服务端单独下发，绝不进广播
 */
export const HAND_CREATE = {
  name: 'hand-create',
  timeout: 3,
}

/**
 * POST /hand/act
 * 玩家行动
 *
 * body: { roomNo, uid, type, amount? }
 * resp: { state, actions, finished }
 */
export const HAND_ACT = {
  name: 'hand-act',
  timeout: 3,
}

/**
 * POST /hand/showdown
 * 摊牌结算
 *
 * body: { roomNo }
 * resp: { winnings, hands }   ← hands 含每人的牌型，可广播
 */
export const HAND_SHOWDOWN = {
  name: 'hand-showdown',
  timeout: 3,
}

/**
 * POST /room/join
 * 加入房间
 *
 * body: { roomNo, nickname, avatar }
 * resp: { room, members }
 */
export const ROOM_JOIN = {
  name: 'room-join',
  timeout: 3,
}

/**
 * POST /room/leave
 * 离开房间（线上模式删除房间，零留存）
 *
 * body: { roomNo }
 * resp: { ok }
 */
export const ROOM_LEAVE = {
  name: 'room-leave',
  timeout: 3,
}

/**
 * POST /offline/settle
 * 线下结算：金瓜子转账 + 写历史 + 重置瓜子
 *
 * body: { roomNo, transfers:[{fromUid,toUid,amount}], history }
 * resp: { ok }
 */
export const OFFLINE_SETTLE = {
  name: 'offline-settle',
  timeout: 3,
}

/**
 * POST /offline/pot
 * 线下公共池变动（出瓜子/收瓜子）
 *
 * body: { roomNo, uid, action:'out'|'in', amount }
 * resp: { pot, mySeeds }
 */
export const OFFLINE_POT = {
  name: 'offline-pot',
  timeout: 3,
}

/** 所有云函数清单 */
export const FUNCTIONS = [
  HAND_CREATE,
  HAND_ACT,
  HAND_SHOWDOWN,
  ROOM_JOIN,
  ROOM_LEAVE,
  OFFLINE_SETTLE,
  OFFLINE_POT,
]
