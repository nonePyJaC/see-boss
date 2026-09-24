/**
 * 清理阿里云服务器上的业务数据。
 *
 * 用法：
 *   node scripts/wipe-server.mjs --token <HAMSTER_ADMIN_TOKEN> [--yes] [--only rooms|accounts|history|ledger]
 *
 *   node scripts/wipe-server.mjs --token xxx --stats       只看各表行数，不动数据
 *   node scripts/wipe-server.mjs --token xxx --dry-run     同上
 *   node scripts/wipe-server.mjs --token xxx               全清（会问一次确认）
 *   node scripts/wipe-server.mjs --token xxx --only rooms  只清房间快照
 *   node scripts/wipe-server.mjs --token xxx --yes         跳过确认
 *
 * 默认地址 http://8.133.3.206 ，可用 --base 覆盖。
 *
 * ⚠️ 不可逆。清掉的东西：账号、金瓜子账本、历史战绩、房间快照 +
 *    服务器内存里所有房间（正在玩的人下一拉就掉出房间）。
 */

const argv = process.argv.slice(2)

function arg(name) {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes('--' + name)

const BASE = arg('base') || 'http://8.133.3.206'
const TOKEN = arg('token') || process.env.HAMSTER_ADMIN_TOKEN
const ONLY = arg('only')

if (!TOKEN) {
  console.error('缺少 token。用 --token <值>，或先设 HAMSTER_ADMIN_TOKEN 环境变量')
  process.exit(1)
}

const api = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

async function main() {
  // 先看现在有多少东西
  const stats = await api('/api/admin/stats', { uid: 'admin', token: TOKEN })
  if (!stats.ok) {
    console.error('看不到数据：', stats.error)
    process.exit(1)
  }
  const s = stats.data
  console.log('当前数据：')
  console.log(`  账号        ${s.accounts}`)
  console.log(`  账本明细    ${s.ledger}`)
  console.log(`  历史战绩    ${s.history}`)
  console.log(`  房间快照    ${s.rooms}`)
  console.log(`  内存房间    ${s.memoryRooms}`)

  if (has('stats') || has('dry-run')) return

  const total = s.accounts + s.ledger + s.history + s.rooms
  if (total === 0 && s.memoryRooms === 0) {
    console.log('\n已经是空的了，没什么要清。')
    return
  }

  const what = ONLY ? { [ONLY]: true } : {}

  if (!has('yes')) {
    const scope = ONLY ? `「${ONLY}」` : '全部数据'
    console.log(`\n⚠️  即将清掉${scope}，不可恢复。`)
    if (!ONLY) console.log('   正在进行的对局会被打断，所有人下一拉就掉出房间。')
    const readline = require('node:readline').createInterface({
      input: process.stdin, output: process.stdout,
    })
    const ans = await new Promise((res) => readline.question('确认？输入 yes 继续：', res))
    readline.close()
    if (String(ans).trim().toLowerCase() !== 'yes') {
      console.log('已取消。')
      return
    }
  }

  const r = await api('/api/admin/wipe', { uid: 'admin', token: TOKEN, what })
  if (!r.ok) {
    console.error('清理失败：', r.error)
    process.exit(1)
  }
  const d = r.data
  console.log('\n清理完成：')
  console.log('  删前行数 ', JSON.stringify(d.before))
  console.log('  各表删除 ', JSON.stringify(d.removed))
  console.log('  内存房间 ', d.wipedMemoryRooms, '个')

  const after = await api('/api/admin/stats', { uid: 'admin', token: TOKEN })
  if (after.ok) {
    console.log('  删后行数 ', JSON.stringify({
      accounts: after.data.accounts,
      ledger: after.data.ledger,
      history: after.data.history,
      rooms: after.data.rooms,
      memoryRooms: after.data.memoryRooms,
    }))
  }
}

main().catch((e) => { console.error('异常：', e?.message ?? e); process.exit(1) })
