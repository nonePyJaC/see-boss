/**
 * CloudBase 连通性自检
 *
 * 用法：
 *   npm run dev
 *   浏览器打开 http://localhost:5173
 *   F12 Console 执行：await window.__cbCheck()
 *
 * 依次检查：
 *   1. 环境变量是否配齐
 *   2. SDK 初始化和匿名登录
 *   3. 表是否存在（users / rooms / ...）
 *   4. RLS 是否生效（读不到别人的数据）
 *   5. 写入权限（users upsert 自己）
 *   6. RPC 是否可用（transfer_seeds）
 *   7. 实时订阅（按 VITE_REALTIME_MODE）
 */

import { repo, usingCloud, dataSourceName, CB_CONFIG, REALTIME_MODE } from './src/data/repo.js'

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
  console.log('%c── CloudBase 连通性自检 ──', 'color:#1565c0;font-weight:bold;font-size:14px')
  console.log(`数据源: ${dataSourceName} | 实时策略: ${REALTIME_MODE}`)

  // 1. 环境变量
  if (!usingCloud) {
    fail('数据源', '当前是 local 模式。要测云端请把 .env 的 VITE_DATA_SOURCE 改成 cloud 并重启')
    return summary()
  }
  if (!CB_CONFIG.env) return fail('环境变量', '缺 VITE_CLOUDBASE_ENV_ID')
  if (!CB_CONFIG.accessKey) return fail('环境变量', '缺 VITE_CLOUDBASE_PUBLISHABLE_KEY')
  ok('环境变量', `env=${CB_CONFIG.env} region=${CB_CONFIG.region}`)

  // 2. 匿名登录
  let uid
  try {
    ;({ uid } = await repo.signIn())
    if (!uid) throw new Error('uid 为空')
    ok('匿名登录', `uid=${uid}`)
  } catch (e) {
    return fail('匿名登录', e.message + ' ← 检查「身份认证 → 登录方式」是否开启匿名登录')
  }

  // 3. 表是否存在
  const { getApp } = await import('./src/data/cloud-repo-internal.js')
  const app = getApp()
  const db = app.rdb()

  const TABLES = ['users', 'seed_ledger', 'rooms', 'room_members', 'hands', 'decks', 'history']
  for (const t of TABLES) {
    try {
      const { error } = await db.from(t).select('*').limit(1)
      if (error) throw new Error(error.message)
      ok(`表 ${t}`)
    } catch (e) {
      fail(`表 ${t}`, e.message + ' ← 检查 db/schema.sql 是否执行')
    }
  }

  // 4. RLS：读 users 应只能看到自己（或空）
  try {
    const { data, error } = await db.from('users').select('id')
    if (error) throw new Error(error.message)
    const others = (data ?? []).filter((r) => r.id !== uid)
    if (others.length > 0) fail('RLS 隔离', `读到了 ${others.length} 个他人记录，RLS 未生效！`)
    else ok('RLS 隔离', `可见 ${(data ?? []).length} 条，均为本人`)
  } catch (e) {
    fail('RLS 隔离', e.message)
  }

  // 5. 写入：upsert 自己的档案
  try {
    await repo.upsertProfile({ uid, nickname: '自检用户', avatar: 1, goldenSeeds: 0 })
    ok('写入 users')
  } catch (e) {
    fail('写入 users', e.message + ' ← 检查 RLS 的 users_insert_own 策略')
  }

  // 6. RPC
  try {
    await repo.transferSeeds(uid, uid, 1) // 自己转自己应是 no-op
    ok('RPC transfer_seeds')
  } catch (e) {
    fail('RPC transfer_seeds', e.message + ' ← 检查 db/schema.sql 第 15 段')
  }

  // 7. 实时订阅
  try {
    let got = false
    const stop = repo.subscribeRoom('000000', () => { got = true })
    await new Promise((r) => setTimeout(r, 2500))
    stop()
    ok('实时订阅', `mode=${REALTIME_MODE}（房间不存在属预期，无报错即可）`)
  } catch (e) {
    fail('实时订阅', e.message)
  }

  return summary()
}

function summary() {
  const pass = results.filter((r) => r.pass).length
  const total = results.length
  console.log(
    `%c── 结果: ${pass}/${total} 通过 ──`,
    `color:${pass === total ? '#2e7d32' : '#c62828'};font-weight:bold;font-size:14px`
  )
  return { pass, total, results }
}

window.__cbCheck = check
console.log('%c自检已就绪，执行 await window.__cbCheck()', 'color:#1565c0;font-weight:bold')
