/**
 * Repository 选择器 — 上层只跟这一个模块打交道
 *
 * 用法：
 *   import { repo } from '@/data'
 *   const { uid } = await repo.signIn()
 *   await repo.transferSeeds(uid, peerUid, 1)
 *
 * 切换方式：
 *   VITE_DATA_SOURCE=local  → localStorage（默认，单机）
 *   VITE_DATA_SOURCE=cloud  → CloudBase PostgreSQL
 */

import { isCloud } from './index.js'
import { localRepo } from './local-repo.js'
import { cloudRepo } from './cloud-repo.js'

export const repo = isCloud ? cloudRepo : localRepo

export const dataSourceName = repo.name

/** 当前是否云端模式 */
export const usingCloud = isCloud

/**
 * 初始化数据层。
 *
 * 必须在 App 启动时调用一次：云端模式要在这里完成匿名登录，
 * 否则后续所有 RLS 查询都会因缺 JWT 被拒。
 *
 * @returns {Promise<{uid:string|null}>}
 */
export async function initData() {
  if (isCloud) {
    // 匿名登录：拿到带真实 sub 的 token
    const { uid } = await repo.signIn()
    if (!uid) throw new Error('匿名登录失败，未拿到 uid')
    return { uid }
  }
  return { uid: await repo.signIn().then((r) => r.uid) }
}

export * from './index.js'
export { createRoomSync, REALTIME_MODE, POLL_INTERVAL } from './realtime.js'
