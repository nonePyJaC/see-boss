/**
 * 数据访问层 — 统一接口
 *
 * 设计目标：
 *   1. 前端不直接碰数据库，只跟 repository 打交道
 *   2. 本地实现（localStorage）和云端实现（CloudBase PG）可无缝切换
 *   3. 实时同步策略（CDC / Broadcast / 轮询）对上层透明
 *
 * 切换方式：设置 VITE_DATA_SOURCE=cloud 启用云端，默认 local
 */

export const DATA_SOURCE = import.meta.env.VITE_DATA_SOURCE ?? 'local'

/** CloudBase 配置（从环境变量读，避免把密钥写进代码） */
export const CB_CONFIG = {
  env: import.meta.env.VITE_CLOUDBASE_ENV_ID ?? '',
  // Publishable Key 可安全暴露在前端（role=anon，受 RLS 约束）
  accessKey: import.meta.env.VITE_CLOUDBASE_PUBLISHABLE_KEY ?? '',
  region: import.meta.env.VITE_CLOUDBASE_REGION ?? 'ap-shanghai',
}

export const isCloud = DATA_SOURCE === 'cloud'

/** 环境未配置时给出明确提示，避免静默失败 */
export function assertCloudReady() {
  if (!isCloud) return
  if (!CB_CONFIG.env) throw new Error('缺少 VITE_CLOUDBASE_ENV_ID')
  if (!CB_CONFIG.accessKey) throw new Error('缺少 VITE_CLOUDBASE_PUBLISHABLE_KEY')
}

/**
 * Repository 接口约定：
 *
 * auth:
 *   signIn()                    → { uid }   匿名登录，拿稳定 uid
 *
 * profile:
 *   getProfile(uid)             → { id, nickname, avatar, goldenSeeds, totalGames } | null
 *   upsertProfile(profile)      → void
 *
 * ledger:
 *   getLedger(uid)              → [{ peerUid, peerName, peerAvatar, count }]
 *   transferSeeds(from, to, n)  → void   双向记账（走 RPC）
 *   clearLedgerEntry(owner, peer) → void 双方同时清（走 RPC）
 *
 * room:
 *   createRoom(cfg)             → { roomNo }
 *   joinRoom(roomNo, me)        → { room, members }
 *   leaveRoom(roomNo)           → void
 *   getRoom(roomNo)             → { room, members } | null
 *   subscribeRoom(roomNo, cb)   → unsubscribe   实时订阅房间变更
 *
 * history:
 *   listHistory(uid)            → [game]
 *   addHistory(game)            → void
 *   clearHistory()              → void
 */
