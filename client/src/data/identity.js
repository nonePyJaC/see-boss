/**
 * 身份恢复 —— 解决「微信里每次扫码都要重新注册昵称和头像」
 *
 * 根因：
 *   匿名身份的 uid 存在 localStorage。iOS 微信 WebView 对 localStorage
 *   清理很激进（尤其是「退出小程序/网页」或系统内存紧张时），
 *   uid 一旦丢失，signInAnonymously() 会发一个新的 uid，
 *   云端按新 uid 查不到 profile → 用户被打回注册页。
 *
 * 方案：昵称 + 头像兜底记忆
 *   在两处独立存储各写一份（降低同时被清的概率）：
 *     1. localStorage      hamster-poker:identity
 *     2. Cookie            hp_identity（7 天，iOS 微信通常保留更久）
 *   启动时若云端 profile 取不到，但兜底记忆里有，
 *   就用记忆的昵称/头像自动建档，不再问用户。
 *
 * 注意：这只是「免重新注册」的体验优化。
 * 金瓜子和账本仍绑定 uid，uid 变了就找不回来 —— 那是数据归属问题，
 * 要真正做到跨设备继承得上账号体系（见 docs/账号体系方案.md）。
 */

const KEY = 'hamster-poker:identity'
const COOKIE = 'hp_identity'
const DAYS = 180

/** 读兜底身份（Cookie 优先，微信里 localStorage 更容易被清） */
export function readIdentity() {
  const fromCookie = readCookie(COOKIE)
  if (fromCookie) return fromCookie
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** 写兜底身份，两处都写 */
export function writeIdentity({ nickname, avatar }) {
  if (!nickname) return
  const data = JSON.stringify({ nickname, avatar })
  try {
    localStorage.setItem(KEY, data)
  } catch {}
  writeCookie(COOKIE, data, DAYS)
}

/** 清掉兜底身份（用户主动改头像/昵称时不需要清，这里留给注销用） */
export function clearIdentity() {
  try {
    localStorage.removeItem(KEY)
  } catch {}
  writeCookie(COOKIE, '', -1)
}

// ── Cookie 工具 ──

function writeCookie(name, value, days) {
  try {
    const maxAge = days > 0 ? days * 86400 : 0
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`
  } catch {}
}

function readCookie(name) {
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
    if (!m) return null
    const data = JSON.parse(decodeURIComponent(m[1]))
    return data?.nickname ? data : null
  } catch {
    return null
  }
}
