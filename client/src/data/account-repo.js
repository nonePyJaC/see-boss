/**
 * 账号 / 账本 / 历史 —— 走自家 /api/account/*。
 *
 * 取代原来的 cloud-repo（CloudBase PG）+ local-repo（localStorage）。
 * 金瓜子、账本、历史全部由服务端 SQLite 持有，前端只读只写 API，
 * 不再有「客户端算余额再转发」这种会双账的口子。
 *
 * 身份：账号名即身份（无密码，朋友局）。uid 由 localStorage 生成并长期保存，
 * 登录时把 uid 绑到这个账号名上 —— 这就是 spec 里定的「账号重建」口径。
 */

import { request } from './http.js'
import { writeIdentity, readIdentity } from './identity.js'

const UID_KEY = 'hamster-poker:uid'

/**
 * 取本机 uid；没有就生成一个。这是唯一的身份凭据，服务端信任它。
 *
 * URL 上的 ?uid= 优先，并写回 localStorage。
 * 两个用处：
 *   1. 调试/联调 —— seed 脚本造的 demo uid 能直接开页面，不用先登一遍
 *   2. 扫码进房 —— 别人分享的链接里带 uid，点开就是他的座位
 */
export function getUid() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('uid')
      || new URLSearchParams(location.hash.split('?')[1] || '').get('uid')
    if (fromUrl) {
      localStorage.setItem(UID_KEY, fromUrl)
      return fromUrl
    }
    let u = localStorage.getItem(UID_KEY)
    if (!u) {
      u = 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      localStorage.setItem(UID_KEY, u)
    }
    return u
  } catch {
    return 'anon-' + Math.random().toString(36).slice(2, 10)
  }
}

/** 账号名登录 / 注册。已存在则直接登上，不存在就按这个昵称建档。 */
export async function login(account, nickname) {
  const uid = getUid()
  const r = await request('/api/account/login', { uid, account, nickname })
  if (r.ok) {
    const nick = r.data?.nickname || nickname || account
    writeIdentity({ nickname: nick, avatar: r.data?.avatar })
  }
  return r
}

/** 当前身份 + 金瓜子 + 局数。未登录时 loggedIn=false，拦不到流程里去。 */
export function me(uid = getUid()) {
  return request('/api/account/me', { uid })
}

/** 改昵称 / 头像 */
export function updateProfile(patch, uid = getUid()) {
  return request('/api/account/update', { uid, ...patch })
}

/** 退出登录（服务端解绑 uid；uid 本身保留在本机） */
export function logout(uid = getUid()) {
  return request('/api/account/logout', { uid })
}

/** 与他人之间的账本往来 */
export function ledger(uid = getUid()) {
  return request('/api/account/ledger', { uid })
}

/** 历史战绩 */
export function history(uid = getUid()) {
  return request('/api/account/history', { uid })
}

/**
 * 本地记住的昵称/头像兜底。
 * iOS 微信 WebView 清 localStorage 很凶，uid 丢了就登不回去；
 * 这个兜底让用户至少不用重新输昵称。
 */
export function cachedIdentity() {
  return readIdentity()
}

export const accountRepo = {
  login, me, updateProfile, logout, ledger, history, getUid, cachedIdentity,
}
