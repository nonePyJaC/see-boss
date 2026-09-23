/**
 * whoami — 验证云函数能否拿到调用者身份
 *
 * 部署: cmd /c "tcb fn deploy whoami --env-id <env> --force --httpFn --path /whoami"
 *
 * 关键修正：之前调 auth.getEndUserInfo() 一直是错的（js-sdk 里无此方法）。
 * 正确做法：
 *   1. auth.getUserInfo()          —— 云函数运行时自动注入调用者身份（Event 函数）
 *   2. 手动解析 Authorization 头里的 JWT，取 payload.sub
 * 两条都测，看哪条在这条链路上有效。
 */
const http = require('http')

const ENV_ID = 'see-boss-d2gjggfbz8808d1d4'
const REGION = 'ap-shanghai'

let sdkApp = null
function getApp() {
  if (sdkApp) return sdkApp
  const sdk = require('@cloudbase/node-sdk')
  sdkApp = sdk.init({
    env: ENV_ID,
    region: REGION,
    secretId: process.env.TENCENTCLOUD_SECRETID,
    secretKey: process.env.TENCENTCLOUD_SECRETKEY,
    token: process.env.TENCENTCLOUD_SESSIONTOKEN,
  })
  return sdkApp
}

/** 手动解 JWT payload，不验签，只取身份字段 */
function decodeJWT(token) {
  try {
    const p = token.split('.')
    if (p.length !== 3) return { err: 'not a jwt' }
    const payload = JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
    return {
      sub: payload.sub,
      role: payload.role,
      is_anonymous: payload.is_anonymous,
      iss: payload.iss,
      exp: payload.exp,
      keys: Object.keys(payload),
    }
  } catch (e) {
    return { err: String(e?.message || e) }
  }
}

async function probe(req) {
  const out = {}

  // ── 路径 A：SDK 自动注入 ──
  try {
    const auth = getApp().auth()
    if (typeof auth.getUserInfo === 'function') {
      out.getUserInfo = JSON.stringify(auth.getUserInfo()).slice(0, 400)
    } else {
      out.getUserInfo = '方法不存在，可用: ' + Object.getOwnPropertyNames(Object.getPrototypeOf(auth)).join(',')
    }
  } catch (e) {
    out.getUserInfoErr = String(e?.message || e).slice(0, 200)
  }

  // ── 路径 B：手动解 JWT ──
  const authz = req.headers['authorization'] || req.headers['Authorization'] || ''
  out.authHeader = authz ? authz.slice(0, 24) + '…(len=' + authz.length + ')' : '(空)'
  if (authz.startsWith('Bearer ')) {
    out.jwtPayload = decodeJWT(authz.slice(7))
  }

  // ── 顺带证明 admin 读库仍在 ──
  try {
    const r = await getApp().rdb().from('rooms').select('id').limit(1)
    out.dbRead = { ok: true, rows: r?.data?.length ?? 0 }
  } catch (e) {
    out.dbReadErr = String(e?.message || e).slice(0, 200)
  }

  return out
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  try {
    res.writeHead(200)
    res.end(JSON.stringify(await probe(req)))
  } catch (e) {
    res.writeHead(200)
    res.end(JSON.stringify({ fatal: String(e?.message || e).slice(0, 300) }))
  }
})

server.listen(Number(process.env.PORT) || 9000, () => {
  console.log('[whoami] listening')
})
