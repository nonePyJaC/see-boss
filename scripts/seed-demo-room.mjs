/**
 * 一键造一个 4 人线下对局，方便看真实 UI。
 *
 *   node scripts/seed-demo-room.mjs
 *
 * 做这些事：
 *   1. 注册 4 个账号（登录态 4 个 uid）
 *   2. 房主建房 → 3 人加入
 *   3. 房主指定小麦位 → 开局（自动下大小麦）
 *   4. 让 3 人跟注，走到「有人归零」
 *   5. 打印每个玩家的视角 URL
 */

const BASE = process.env.API || 'http://127.0.0.1:8080'

async function api(path, body = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

const NAMES = ['鼠怪', '小数', '小王', '阿珍']
const players = NAMES.map((n, i) => ({
  uid: 'demo-' + i + '-' + Date.now().toString(36),
  account: ('demo' + i).padEnd(5, 'x'),
  nickname: n,
  // 6 只真仓鼠轮着分配：奶油/焦糖/灰灰/可可/三花/雪球
  // 各有不同耳型（round/drop/point）、配件（scarf/hat/flower/bowtie/mask）、眼睛
  avatar: (i % 6) + 1,
}))

async function main() {
  // 1. 登录
  for (const p of players) {
    const r = await api('/api/account/login', {
      uid: p.uid, account: p.account, nickname: p.nickname, avatar: p.avatar,
    })
    if (!r.ok) throw new Error('登录失败 ' + p.nickname + ': ' + r.error)
    console.log('  ✓ ' + p.nickname + ' (' + p.account + ')')
  }

  // 2. 建房 + 加入
  const host = players[0]
  const c = await api('/api/room/create', {
    uid: host.uid,
    me: { nickname: host.nickname, avatar: host.avatar },
    cfg: { mode: 'offline', initialSeeds: 1000, smallBlind: 100, bigBlind: 200 },
  })
  if (!c.ok) throw new Error('建房失败: ' + c.error)
  const no = c.data.id
  console.log('\n  房间 ' + no + '  初始 1000 / 小麦 100 / 大麦 200')

  for (const p of players.slice(1)) {
    const j = await api('/api/room/join', {
      uid: p.uid, roomId: no, me: { nickname: p.nickname, avatar: p.avatar },
    })
    if (!j.ok) throw new Error('加入失败 ' + p.nickname + ': ' + j.error)
  }
  console.log('  4 人已就座')

  // 3. 指定小麦位（座位 1 = 小数）+ 开局
  await api('/api/room/start', { uid: host.uid, roomId: no, sbIndex: 1 })
  let st = await api('/api/room/state', { uid: host.uid, roomId: no })
  console.log('\n  开局：' + st.data.seats.map(s => s.nickname + (s.blind ? '[' + s.blind + ']' : '') + '=' + s.seeds).join('  '))
  console.log('  轮到 ' + st.data.seats.find(s => s.uid === st.data.turnUid)?.nickname)

  // 4. 走一圈动作，让「小数」（小麦位）在一次加注中归零
  let guard = 0
  while (st.data.turnUid && !st.data.finished && !st.data.settlePending && guard++ < 12) {
    const who = st.data.seats.find((s) => s.uid === st.data.turnUid)
    const acts = st.data.avail ?? []
    const has = (t) => acts.some((a) => a.type === t)

    let type = 'check'
    if (has('call')) type = 'call'
    else if (has('raise')) type = 'raise'

    if (type === 'raise') {
      // 让非小麦位的人各加 200，把筹码压上去
      const r = await api('/api/room/action', { uid: who.uid, roomId: no, type: 'raise', amount: 200 })
      if (!r.ok) { await api('/api/room/action', { uid: who.uid, roomId: no, type: 'check' }) }
    } else {
      await api('/api/room/action', { uid: who.uid, roomId: no, type })
    }
    st = await api('/api/room/state', { uid: host.uid, roomId: no })
  }
  console.log('\n  当前：pot=' + st.data.pot + ' stage=' + st.data.stage + ' 需跟=' + st.data.toCall)
  console.log('  ' + st.data.seats.map(s => s.nickname + ' 筹码' + s.seeds).join('  '))
  if (st.data.settlePending) console.log('  → 有人归零，等结算')

  console.log('\n=== 打开这些地址看各人视角 ===')
  for (const p of players) {
    console.log(`  ${p.nickname}  http://127.0.0.1:8080/?uid=${p.uid}&room=${no}`)
  }
  console.log('\n  （前端还没接 room-repo，所以这些 URL 现在只会显示首页）')
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1) })
