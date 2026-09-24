/**
 * 清理服务器上的数据。
 *
 * 用法：
 *   node scripts/wipe-server.mjs --token <口令> --stats          只看不动
 *   node scripts/wipe-server.mjs --token <口令> --mode clear-others   保留账号，清其他
 *   node scripts/wipe-server.mjs --token <口令> --mode clear-all      连账号一起清
 *
 *   --yes   跳过确认（默认会问一次）
 *   --base  默认 http://8.133.3.206
 *
 * 口令也可用环境变量 HAMSTER_ADMIN_TOKEN，不用每次 --token。
 *
 * 两种模式：
 *   clear-others  账号和登录态、金瓜子数字都留着，只清账本明细、
 *                 历史战绩、房间快照 + 内存房间。
 *                 适合「实测攒了一堆垃圾房和战绩，人还想用原账号」。
 *   clear-all     全清。所有人重新注册，金瓜子归零。
 *                 ⚠️ 不可逆。
 */

const argv = process.argv.slice(2)
const arg = (n) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (n) => argv.includes('--' + n)

const BASE = arg('base') || 'http://8.133.3.206'
const TOKEN = arg('token') || process.env.HAMSTER_ADMIN_TOKEN
const MODE = arg('mode')

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

const LABELS = {
  'clear-all': '连账号一起清（所有人重新注册、金瓜子归零）',
  'clear-others': '保留账号，只清账本/历史/房间',
}

async function main() {
  // 先看现在有多少东西
  const stats = await api('/api/admin/stats', { uid: 'admin', token: TOKEN })
  if (!stats.ok) {
    console.error('看不到数据：', stats.error)
    console.error('（检查 token 对不对，以及服务端有没有配 HAMSTER_ADMIN_TOKEN）')
    process.exit(1)
  }
  const s = stats.data
  console.log('当前数据：')
  console.log('  账号        ' + s.accounts)
  console.log('  账本明细    ' + s.ledger)
  console.log('  历史战绩    ' + s.history)
  console.log('  房间快照    ' + s.rooms)
  console.log('  内存房间    ' + s.memoryRooms)

  if (has('stats') || has('dry-run')) return

  if (!MODE || !LABELS[MODE]) {
    console.error('\n需要 --mode，二选一：')
    console.error('  clear-others   保留账号，清账本/历史/房间')
    console.error('  clear-all      连账号一起清（不可逆）')
    process.exit(1)
  }

  const total = s.accounts + s.ledger + s.history + s.rooms + s.memoryRooms
  if (total === 0) {
    console.log('\n已经是空的了，没什么要清。')
    return
  }

  console.log('\n即将执行：' + LABELS[MODE])
  if (MODE === 'clear-all') {
    console.log('  ⚠️  账号会被删掉，所有人要重新注册，金瓜子归零。')
  }
  console.log('  正在进行的对局会被打断。')

  if (!has('yes')) {
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

  const r = await api('/api/admin/wipe', { uid: 'admin', token: TOKEN, mode: MODE })
  if (!r.ok) {
    console.error('清理失败：', r.error)
    process.exit(1)
  }
  const d = r.data
  console.log('\n清理完成（' + (d.label || MODE) + '）')
  console.log('  删前行数  ' + JSON.stringify(d.before))
  console.log('  各表删除  ' + JSON.stringify(d.removed))
  console.log('  内存房间  ' + d.wipedMemoryRooms + ' 个')

  const after = await api('/api/admin/stats', { uid: 'admin', token: TOKEN })
  if (after.ok) {
    console.log('  删后行数  ' + JSON.stringify({
      accounts: after.data.accounts,
      ledger: after.data.ledger,
      history: after.data.history,
      rooms: after.data.rooms,
      memoryRooms: after.data.memoryRooms,
    }))
  }
}

main().catch((e) => { console.error('异常：', e?.message ?? e); process.exit(1) })
