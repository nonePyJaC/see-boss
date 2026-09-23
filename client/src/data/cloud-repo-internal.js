/**
 * 内部模块 — 导出 CloudBase app 单例
 *
 * 单独拆出来避免 cloud-repo.js 与 realtime.js 循环依赖。
 */

import { CB_CONFIG, assertCloudReady } from './index.js'

let app = null

/** 懒初始化 CloudBase app（幂等） */
export async function ensureApp() {
  assertCloudReady()
  if (app) return app

  const cloudbase = (await import('@cloudbase/js-sdk')).default
  app = cloudbase.init({
    env: CB_CONFIG.env,
    accessKey: CB_CONFIG.accessKey,
    region: CB_CONFIG.region,
  })

  // 匿名登录：拿到带真实 sub 的 token，RLS 才能按用户隔离
  await app.auth.signInAnonymously()

  return app
}

/** 同步取 app（必须先 ensureApp） */
export function getApp() {
  if (!app) throw new Error('CloudBase 未初始化，请先 await ensureApp()')
  return app
}

/** 当前用户 uid */
export async function currentUid() {
  const a = await ensureApp()
  const state = await a.auth.getLoginState()
  return state?.user?.uid ?? null
}
