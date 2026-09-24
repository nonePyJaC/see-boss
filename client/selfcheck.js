/**
 * 自家 API 连通性自检
 *
 * 用法：
 *   npm run dev
 *   浏览器打开 http://localhost:5173
 *   F12 Console 执行：await window.__apiCheck()
 *
 * 依次检查：
 *   1. /health 是否通
 *   2. 本机 uid 有没有绑账号
 *   3. 账号/账本/历史接口是否可用
 */

import { accountRepo } from './src/data/account-repo.js'
import { roomRepo } from './src/data/room-repo.js'

const results = []
function ok(name, detail = '') {
  results.push({ name, pass: true, detail })
  console.log(`%c✓ ${name}`, 'color:#2e7d32;font-weight:bold', detail)
}
function fail(name, detail = '') {
  results.push({ name, pass: false, detail })
  console.log(`%c✗ ${name}`, 'color:#c62828;font-weight:bold', detail)
}

async function check() {
  console.log('%c── API 连通性自检 ──', 'color:#1565c0;font-weight:bold;font-size:14px')
  console.log(`uid: ${accountRepo.getUid()}`)

  // 1. 健康检查
  try {
    const res = await fetch('/health')
    const j = await res.json()
    ok('/health', JSON.stringify(j))
  } catch (e) {
    return fail('/health', '连不上服务端 —— server/index.js 起了吗？' + (e?.message ?? ''))
  }

  // 2. 账号
  const me = await accountRepo.me()
  if (!me.ok) fail('/api/account/me', me.error)
  else if (me.data?.loggedIn) ok('账号', `${me.data.account} 金瓜子 ${me.data.goldenSeeds}`)
  else ok('账号', '未登录（去 /register 建个号）')

  // 3. 账本 / 历史
  const ledger = await accountRepo.ledger()
  ledger.ok ? ok('/api/account/ledger', `${(ledger.data?.rows ?? ledger.data ?? []).length} 条`)
             : fail('/api/account/ledger', ledger.error)

  const history = await accountRepo.history()
  history.ok ? ok('/api/account/history', `${(history.data?.rows ?? history.data ?? []).length} 局`)
              : fail('/api/account/history', history.error)

  // 4. 房间列表
  const rooms = await roomRepo.listRooms()
  rooms.ok ? ok('/api/room/list', `${(rooms.data?.rooms ?? []).length} 个房间`)
           : fail('/api/room/list', rooms.error)

  const passed = results.filter((r) => r.pass).length
  console.log(`%c── ${passed}/${results.length} 通过 ──`, 'color:#1565c0;font-weight:bold')
  return results
}

window.__apiCheck = check
export { check }
