/**
 * 本地中继：浏览器把 JWT POST 过来，再由 node 打云函数网关
 * 这样 JWT 不落盘、不进对话历史。
 *
 * 用法:
 *   node scripts/jwt-relay.mjs            # 起服务，监听 8899
 * 浏览器 Console:
 *   fetch('http://localhost:8899/relay', {method:'POST',
 *     headers:{'Content-Type':'application/json'},
 *     body: localStorage.getItem('credentials_see-boss-d2gjggfbz8808d1d4')
 *   }).then(r=>r.json()).then(console.log)
 */
import http from 'node:http'

const FN = 'https://see-boss-d2gjggfbz8808d1d4-1492320391.ap-shanghai.app.tcloudbase.com/whoami'

let lastResult = null

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // 查询上一次结果，便于命令行直接读
  if (req.url?.startsWith('/last')) {
    res.writeHead(200)
    return res.end(JSON.stringify(lastResult, null, 1))
  }

  let chunks = []
  for await (const c of req) chunks.push(c)
  const bodyText = Buffer.concat(chunks).toString('utf8')

  // 支持 GET ?t=<jwt>，方便浏览器直接开 URL（POST 在某些沙箱里被拦）
  let token = null
  try {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/relay') {
      if (u.searchParams.get('t')) token = u.searchParams.get('t')
    }
  } catch {}
  if (!token && bodyText) {
    try {
      token = JSON.parse(bodyText).access_token
    } catch {}
  } else if (!token) {
    res.writeHead(400)
    return res.end(JSON.stringify({ err: '需要 access_token：POST body 或 ?t=jwt', url: req.url }))
  }

  const out = {}

  // 1) 解 JWT，看里面到底有什么
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    )
    out.jwtKeys = Object.keys(payload)
    out.jwtSub = payload.sub
    out.jwtRole = payload.role
  } catch (e) {
    out.jwtErr = String(e?.message).slice(0, 120)
  }

  // 2) 带 token 打云函数
  try {
    const r = await fetch(FN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        Origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ probe: 'relay-with-jwt' }),
    })
    const t = await r.text()
    out.fn = { status: r.status, body: t.slice(0, 900) }
  } catch (e) {
    out.fnErr = String(e?.message).slice(0, 200)
  }

  // 3) 不带 token 打一次做对照
  try {
    const r = await fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Mode': 'cors' },
      body: JSON.stringify({ probe: 'relay-no-jwt' }),
    })
    const t = await r.text()
    out.fnNoAuth = { status: r.status, body: t.slice(0, 500) }
  } catch (e) {
    out.fnNoAuthErr = String(e?.message).slice(0, 200)
  }

  res.writeHead(200)
  res.end(JSON.stringify(out, null, 1))
  lastResult = out   // 供 /last 查询
})

server.listen(8899, () => console.log('[relay] http://localhost:8899/relay'))
