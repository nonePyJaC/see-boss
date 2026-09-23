/**
 * 带真实 JWT 打 whoami 网关，验证 uid 解析
 * JWT 从浏览器 localStorage 导出后存到 scripts/.jwt
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const JWT_FILE = path.join(ROOT, '.jwt')
const URL_ = 'https://see-boss-d2gjggfbz8808d1d4-1492320391.ap-shanghai.app.tcloudbase.com/whoami'

if (!fs.existsSync(JWT_FILE)) {
  console.error('缺少 ' + JWT_FILE)
  console.error('请从浏览器 Console 执行并保存：')
  console.error("  copy(localStorage.getItem('credentials_see-boss-d2gjggfbz8808d1d4'))")
  process.exit(1)
}

const cred = JSON.parse(fs.readFileSync(JWT_FILE, 'utf8'))
const token = cred.access_token
console.log('uid(from JWT 解出):', JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub)

for (const [label, headers] of [
  ['no-auth', { 'Content-Type': 'application/json' }],
  ['bearer', { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }],
]) {
  try {
    const r = await fetch(URL_, {
      method: 'POST',
      headers: { 'Sec-Fetch-Mode': 'cors', ...headers },
      body: JSON.stringify({ probe: label }),
    })
    const t = await r.text()
    console.log(`\n[${label}] status=${r.status}`)
    console.log('  ' + t.slice(0, 900))
  } catch (e) {
    console.log(`\n[${label}] EXC ${e.message}`)
  }
}
