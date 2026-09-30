/**
 * 房间 —— 走自家 /api/room/*，线上/线下共用。
 *
 * 取代原来的 cloud-repo / local-repo / realtime.js。
 * 所有房间逻辑（线下计分、结算、快照恢复）都在服务端完成，
 * 这个文件只负责发动作和拉状态，一行业务判断都没有。
 *
 * 轮询策略：
 *   默认每 2s 拉一次 state；线上牌桌传入 500ms，以免漏过快速街道。请求在途时跳过本次 tick。
 *   之前为省额度做过 rev 探针，
 *   但探针本身也是一次请求、且会让「刚收完池」的界面慢半拍，
 *   所以这里就直接拉全量 —— 线下局就几张牌的数据量，无所谓。
 *   真要省，让服务端在 rev 没变时返回 304 更干净（不在本期范围）。
 */

import { request } from './http.js'
import { getUid } from './account-repo.js'

export const POLL_INTERVAL = 2000
export const ONLINE_POLL_INTERVAL = 500

// ── 线上座位凭证 ──────────────────────────────────────────
// create/join 时服务端发 { seatId, seatToken }，之后所有线上请求都靠它认座；
// uid 只是设备资料字段。key 必须带房间号（规格：凭证按房隔离，跨房不复用）。
const SEAT_KEY = (roomId) => `hamster-poker:seat:${roomId}`

export function loadSeatCred(roomId) {
  try {
    const raw = localStorage.getItem(SEAT_KEY(String(roomId)))
    if (!raw) return null
    const c = JSON.parse(raw)
    return c?.seatId && c?.seatToken ? { seatId: c.seatId, seatToken: c.seatToken } : null
  } catch {
    return null
  }
}

export function saveSeatCred(roomId, data) {
  try {
    if (data?.seatId && data?.seatToken) {
      localStorage.setItem(SEAT_KEY(String(roomId)), JSON.stringify({
        seatId: data.seatId, seatToken: data.seatToken,
      }))
    }
  } catch { /* localStorage 被禁就只靠内存状态 */ }
}

export function clearSeatCred(roomId) {
  try { localStorage.removeItem(SEAT_KEY(String(roomId))) } catch {}
}

/**
 * 枚举本机存过的所有线上座位凭证：{ roomId: { seatId, seatToken } }。
 * 「回到我的房间」和列表里的 iAmIn/isMine 都靠它认座 —— 凭证就是身份，
 * 服务端逐项 authSeat 验证后才给标记，伪造不了别人的房间。
 */
export function listSeatCredRooms() {
  const out = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith('hamster-poker:seat:')) continue
      const roomId = k.slice('hamster-poker:seat:'.length)
      const c = loadSeatCred(roomId)
      if (c) out[roomId] = c
    }
  } catch { /* localStorage 被禁就空 */ }
  return out
}

/** 线上建房：cfg.mode='online' + 全站授权码 */
export function createOnlineRoom(cfg = {}, me = {}, createCode = '') {
  return request('/api/room/create', { uid: getUid(), cfg, me, createCode })
}

/** 线上拉状态：cred = {seatId, seatToken}，缺了按旁观者投影返回 */
export function onlineState(roomId, cred) {
  return request('/api/room/state', { uid: getUid(), roomId, ...cred })
}

/** 线上行动：必须带当前 handId + turnSeq（防重放，服务端先验再过规则） */
export function onlineAction(roomId, cred, handId, turnSeq, type, amount) {
  return request('/api/room/action', {
    uid: getUid(), roomId, ...cred, handId, turnSeq, type, amount,
  })
}

/** 续时：当前真人行动者，每个 turnSeq 只能续一次 */
export function onlineExtendTurn(roomId, cred, handId, turnSeq) {
  return request('/api/room/extend-turn', { uid: getUid(), roomId, ...cred, handId, turnSeq })
}

/** 线上重置牌桌：仅房主、仅两手之间 */
export function onlineReset(roomId, cred) {
  return request('/api/room/reset-online', { uid: getUid(), roomId, ...cred })
}

/** 线上离房：需座位令牌；房主离开 = 解散房间 */
export function onlineLeave(roomId, cred) {
  return request('/api/room/leave', { uid: getUid(), roomId, ...cred })
}

/** 添加 AI：仅房主、仅两手之间；真人 AI 合计最多 8 座 */
export function addAi(roomId, cred) {
  return request('/api/room/add-ai', { uid: getUid(), roomId, ...cred })
}

/** 移除 AI 座位：仅房主、仅两手之间 */
export function removeAi(roomId, targetSeatId, cred) {
  return request('/api/room/remove-ai', { uid: getUid(), roomId, ...cred, targetSeatId })
}

/** 建房。cfg（房间配置）和 me（房主昵称头像）是两个独立字段，
 *  服务端分别从 body.cfg 和 body.me 读，少哪个都被拒。 */
export function createRoom(cfg = {}, me = {}) {
  return request('/api/room/create', { uid: getUid(), cfg, me })
}

/** 进房。me 带自己的昵称头像，服务端缺 nickname 会直接拒。
 *  cred（线上）可选：持有效令牌重连时幂等回座，不新增座位。 */
export function joinRoom(roomId, me = {}, cred) {
  return request('/api/room/join', { uid: getUid(), roomId, me, ...cred })
}

/** 拉全量状态。avail 是服务端算好的可用动作，前端照着渲染就行。
 *  cred（线上）可选：带了才看得到自己底牌和合法动作。 */
export function roomState(roomId, cred, uid = getUid()) {
  return request('/api/room/state', { uid, roomId, ...cred })
}

/**
 * 开局。sbIndex 指定谁坐小麦位（下一家自动大麦）。
 * 房主在锁定位状态下点某个玩家就是走这个。
 * cred（线上）可选：服务端按庄家轮转，线上不传 sbIndex。
 */
export function startRoom(roomId, sbIndex, cred, uid = getUid()) {
  return request('/api/room/start', { uid, roomId, sbIndex, ...cred })
}

/**
 * 动作。type:
 *   check   过牌（平注时才有）
 *   call    平跟
 *   raise   加注，amount = 需跟数 + 额外加注额（上限全下）
 *   fold    弃牌
 *   collect 收公共池（不占回合，任何时候谁都能收）
 *   give    暂停中划拨，amount = 数量，toUid = 接收人
 */
export function roomAction(roomId, type, amount, toUid, uid = getUid()) {
  return request('/api/room/action', { uid, roomId, type, amount, toUid })
}

/** 推进花生阶段（线下用） */
export function roomStage(roomId, stage, uid = getUid()) {
  return request('/api/room/stage', { uid, roomId, stage })
}

/** 调整座位顺序。order 是完整 uid 数组（房主 + 未开局才允许） */
export function reorderSeats(roomId, order) {
  return request('/api/room/reorder', { uid: getUid(), roomId, order })
}

/** 暂停 / 继续（房主）。同一接口切换：暂停态调用就是继续。
 * 继续时按服务端回应带确认标记：
 *   · 池子为空 → 先回 needConfirmNextHand，确认后传 { confirmNextHand: true } 开新一轮
 *   · 池子有值 → 先回 needConfirmRollback，确认后传 { confirmRollback: true } 回滚到暂停前行动位
 *   · 长按继续 → { restartHand: true } 整手重开（回到本手开局大小麦刚下完的状态） */
export function pauseRoom(roomId, confirm = {}) {
  return request('/api/room/pause', {
    uid: getUid(), roomId,
    confirmNextHand: confirm.confirmNextHand === true,
    confirmRollback: confirm.confirmRollback === true,
    restartHand: confirm.restartHand === true,
  })
}

/** 结算。action: restart | disband | pause */
export function settleRoom(roomId, action, uid = getUid()) {
  return request('/api/room/settle', { uid, roomId, action })
}

/** 离房 */
export function leaveRoom(roomId, uid = getUid()) {
  return request('/api/room/leave', { uid, roomId })
}

/** 房间列表（大厅用） */
/**
 * 房间列表（线上+线下都返回）。creds = listSeatCredRooms() 的结果，
 * 服务端用它认线上座位 → iAmIn/isMine 只对持凭证的客户端为真。
 */
export function listRooms(uid = getUid(), creds = null) {
  return request('/api/room/list', { uid, creds })
}

/**
 * 轮询一个房间。返回 { stop() }。
 *
 * onState 每次拿到 { ok, data }；onError 在连续失败时回调一次
 * （别每次失败都弹，服务端重启时会连弹十几次）。
 */
export function watchRoom(roomId, onState, onError, cred, intervalMs = POLL_INTERVAL) {
  let stopped = false
  let failCount = 0
  let inFlight = false
  // cred 可以是对象或 getter —— 座位令牌可能中途才拿到（扫码先进旁观再入座）
  const credOf = () => (typeof cred === 'function' ? cred() : cred)

  async function tick() {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const r = await roomState(roomId, credOf())
      if (stopped) return
      if (r.ok) failCount = 0
      else if (++failCount === 3) onError?.(r)
      onState(r)
    } finally {
      inFlight = false
    }
  }

  tick()
  const timer = setInterval(tick, intervalMs)
  return { stop: () => { stopped = true; clearInterval(timer) } }
}

export const roomRepo = {
  POLL_INTERVAL,
  createRoom, joinRoom, roomState, startRoom,
  roomAction, roomStage, reorderSeats, pauseRoom, settleRoom, leaveRoom, listRooms, watchRoom,
  createOnlineRoom, onlineState, onlineAction, onlineExtendTurn, onlineReset, onlineLeave,
  addAi, removeAi,
  loadSeatCred, saveSeatCred, clearSeatCred, listSeatCredRooms,
}
