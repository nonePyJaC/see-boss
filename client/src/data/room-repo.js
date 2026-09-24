/**
 * 房间 —— 走自家 /api/room/*，线上/线下共用。
 *
 * 取代原来的 cloud-repo / local-repo / realtime.js。
 * 所有房间逻辑（线下计分、结算、快照恢复）都在服务端完成，
 * 这个文件只负责发动作和拉状态，一行业务判断都没有。
 *
 * 轮询策略：
 *   start() 每 2s 拉一次 state。之前为省额度做过 rev 探针，
 *   但探针本身也是一次请求、且会让「刚收完池」的界面慢半拍，
 *   所以这里就直接拉全量 —— 线下局就几张牌的数据量，无所谓。
 *   真要省，让服务端在 rev 没变时返回 304 更干净（不在本期范围）。
 */

import { request } from './http.js'
import { getUid } from './account-repo.js'

export const POLL_INTERVAL = 2000

/** 建房。cfg（房间配置）和 me（房主昵称头像）是两个独立字段，
 *  服务端分别从 body.cfg 和 body.me 读，少哪个都被拒。 */
export function createRoom(cfg = {}, me = {}) {
  return request('/api/room/create', { uid: getUid(), cfg, me })
}

/** 进房。me 带自己的昵称头像，服务端缺 nickname 会直接拒。 */
export function joinRoom(roomId, me = {}) {
  return request('/api/room/join', { uid: getUid(), roomId, me })
}

/** 拉全量状态。avail 是服务端算好的可用动作，前端照着渲染就行。 */
export function roomState(roomId, uid = getUid()) {
  return request('/api/room/state', { uid, roomId })
}

/**
 * 开局。sbIndex 指定谁坐小麦位（下一家自动大麦）。
 * 房主在锁定位状态下点某个玩家就是走这个。
 */
export function startRoom(roomId, sbIndex, uid = getUid()) {
  return request('/api/room/start', { uid, roomId, sbIndex })
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
export function listRooms(uid = getUid()) {
  return request('/api/room/list', { uid })
}

/**
 * 轮询一个房间。返回 { stop() }。
 *
 * onState 每次拿到 { ok, data }；onError 在连续失败时回调一次
 * （别每次失败都弹，服务端重启时会连弹十几次）。
 */
export function watchRoom(roomId, onState, onError) {
  let stopped = false
  let failCount = 0

  async function tick() {
    if (stopped) return
    const r = await roomState(roomId)
    if (stopped) return
    if (r.ok) failCount = 0
    else if (++failCount === 3) onError?.(r)
    onState(r)
  }

  tick()
  const timer = setInterval(tick, POLL_INTERVAL)
  return { stop: () => { stopped = true; clearInterval(timer) } }
}

export const roomRepo = {
  POLL_INTERVAL,
  createRoom, joinRoom, roomState, startRoom,
  roomAction, roomStage, reorderSeats, pauseRoom, settleRoom, leaveRoom, listRooms, watchRoom,
}
