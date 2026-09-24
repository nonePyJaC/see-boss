/**
 * 造一个「未开局」的房间 —— 用来验房主的 锁/排序/开始 状态机。
 * seed-demo-room.mjs 和 seed-turn-room.mjs 都会直接开局，
 * 但房主控制的状态机要从「刚建房」那一步才开始走。
 */
const BASE = process.env.API_BASE || 'http://127.0.0.1:8080'

async function api(path, body = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

const names = ['房主甲', '玩家乙', '玩家丙', '玩家丁']
const players = []
for (const n of names) {
  const uid = 'wait-' + n + '-' + Math.random().toString(36).slice(2, 6)
  const r = await api('/api/account/login', { uid, account: n + '号', nickname: n })
  if (!r.ok) throw new Error('登录失败: ' + r.error)
  players.push({ uid, nickname: r.data.nickname })
}

const c = await api('/api/room/create', {
  uid: players[0].uid,
  me: { nickname: players[0].nickname, avatar: 1 },
  cfg: { mode: 'offline', initialSeeds: 1000, smallBlind: 100, bigBlind: 200 },
})
if (!c.ok) throw new Error('建房失败: ' + c.error)
const no = c.data.id

for (const p of players.slice(1)) {
  await api('/api/room/join', { uid: p.uid, roomId: no, me: { nickname: p.nickname, avatar: 1 } })
}

const st = await api('/api/room/state', { uid: players[0].uid, roomId: no })
console.log('\n房间 ' + no + '  初始 1000 / 小麦 100 / 大麦 200')
console.log('座位: ' + st.data.seats.map((s) => s.nickname).join('  '))
console.log('状态: 未开局（turnUid=' + st.data.turnUid + ', pot=' + st.data.pot + '）\n')
console.log('── 房主打开（测锁/排序/开始）──')
console.log(BASE + '/index.html#/room/offline?uid=' + players[0].uid + '&room=' + no + '\n')
console.log('── 其他人 ──')
for (const p of players.slice(1)) {
  console.log(p.nickname + ': ' + BASE + '/index.html#/room/offline?uid=' + p.uid + '&room=' + no)
}
