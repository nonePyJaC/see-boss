/**
 * 带匿名 JWT 打 HTTP 网关，验证云函数能否拿到调用者 uid
 * 用法: node scripts/hit-whoami-auth.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const ENV_ID = 'see-boss-d2gjggfbz8808d1d4'
const GW = `https://${ENV_ID}-1492320391.ap-shanghai.app.tcloudbase.com`
const URL_ = `${GW}/whoami`

// 从 dev server 的 localStorage 拿不到，改用匿名登录自己换一个
const PUB_KEY = fs.readFileSync(path.join(ROOT, '..', 'client', '.env'), 'utf8')
  .match(/VITE_CLOUDBASE_PUBLISHABLE_KEY=(.+)/)[1].trim()

async function getToken() {
  // 尝试 CloudBase 网关的匿名登录端点
  const candidates = [
    `${GW}/auth/v1/rdb/signup`,
    `https://${ENV_ID}.api.tcloudbasegateway.com/auth/v1/rdb/signup`,
  ]
  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PUB_KEY}` },
        body: JSON.stringify({ provider_type: 'anonymous', anonymous: true }),
      })
      const t = await r.text()
      console.log(`[login] ${url} -> ${r.status} ${t.slice(0, 200)}`)
      if (r.ok) {
        const j = JSON.parse(t)
        if (j.access_token) return j.access_token
      }
    } catch (e) {
      console.log(`[login] ${url} EXC ${e.message}`)
    }
  }
  return null
}

const token = await getToken()

const cases = [
  ['no-auth', {}],
  ['bearer', { Authorization: `Bearer ${token}` }],
]

for (const [label, headers] of cases) {
  if (label === 'bearer' && !token) continue
  try {
    const r = await fetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Mode': 'cors', ...headers },
      body: JSON.stringify({ probe: label }),
    })
    const t = await r.text()
    console.log(`\n[${label}] status=${r.status}`)
    console.log('  ', t.slice(0, 800))
  } catch (e) {
    console.log(`\n[${label}] EXC ${e.message}`)
  }
}
