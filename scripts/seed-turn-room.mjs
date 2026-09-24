/**
 * 造一个「停在某人回合上」的房间，专门用来手动点按钮。
 * seed-demo-room.mjs 会一路走到结算，那时候没人有回合、按钮全灰，
 * 没法验交互。这个脚本开完局就停。
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

const names = ['甲一号', '乙二号', '丙三号', '丁四号']
const players = []
for (let i = 0; i < 4; i++) {
  const uid = 'demo-' + i + '-' + Math.random().toString(36).slice(2, 8)
  const r = await api('/api/account/login', { uid, account: names[i], nickname: names[i] })
  if (!r.ok) throw new Error('登录失败: ' + r.error)
  players.push({ uid, nickname: r.data.nickname, avatar: r.data.avatar ?? 1 })
}

const c = await api('/api/room/create', {
  uid: players[0].uid,
  me: { nickname: players[0].nickname, avatar: players[0].avatar },
  cfg: { mode: 'offline', initialSeeds: 1000, smallBlind: 100, bigBlind: 200 },
})
if (!c.ok) throw new Error('建房失败: ' + c.error)
const no = c.data.id

for (const p of players.slice(1)) {
  const j = await api('/api/room/join', {
    uid: p.uid, roomId: no, me: { nickname: p.nickname, avatar: p.avatar },
  })
  if (!j.ok) throw new Error('加入失败: ' + j.error)
}

await api('/api/room/start', { uid: players[0].uid, roomId: no, sbIndex: 1 })
const st = await api('/api/room/state', { uid: players[0].uid, roomId: no })

const turnIdx = st.data.seats.findIndex((s) => s.uid === st.data.turnUid)
const turn = players[turnIdx]

console.log('\n房间 ' + no + '  initial 1000 / sb 100 / bb 200')
console.log('座位: ' + st.data.seats.map((s) => s.nickname + '=' + s.seeds).join('  '))
console.log('当前回合: ' + turn.nickname + '  (uid ' + turn.uid + ')\n')
console.log('── 用这个 URL 打开（按钮全亮）──')
console.log('http://127.0.0.1:8080/index.html#/room/offline?uid=' + turn.uid + '&room=' + no + '\n')
console.log('── 其他视角（按钮全灰）──')
for (const p of players) {
  if (p.uid === turn.uid) continue
  console.log(p.nickname + ': ...?uid=' + p.uid + '&room=' + no)
}
