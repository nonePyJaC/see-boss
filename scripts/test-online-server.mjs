/**
 * 本地联调：两个身份打完整一局
 * 验证 create / join / start / action / showdown 全链路
 *
 * 前置: $env:PORT='8088'; node server/index.js
 * 运行: node scripts/test-online-server.mjs
 */
const BASE = 'http://localhost:8088'
const UID_A = 'uid-alice-001'
const UID_B = 'uid-bob-002'
const UID_C = 'uid-carol-003'

/** 造一个和真 JWT 同构的三段 token（服务端只解第二段取 sub） */
function fakeJwt(uid) {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: uid, role: 'anon', is_anonymous: true })).toString('base64url')
  return `${head}.${payload}.sig`
}

async function call(path, uid, body = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fakeJwt(uid)}` },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  return { status: r.status, ...j }
}

let fails = 0
function check(label, cond, extra = '') {
  if (cond) console.log(`  OK   ${label}`)
  else { console.log(`  FAIL ${label} ${extra}`); fails++ }
}

function showSeats(st) {
  return (st.seats || []).map((s) => `${s.nickname}:种${s.seeds}/${s.bet}${s.folded ? '(弃)' : ''}${s.allIn ? '(全)' : ''}`).join('  ')
}

// ── 1. 建房 ──
console.log('\n[1] A 创建房间')
const c = await call('/api/online/create', UID_A, {
  me: { nickname: '阿仓', avatar: 1 },
  initialSeeds: 1000, smallBlind: 10, bigBlind: 20, gameType: 'long',
})
check('创建成功', c.ok === true, c.error || '')
check('房主自动占 1 号位', c.data?.seats?.length === 1)
check('isHost 正确', c.data?.seats?.[0]?.isHost === true)
const ROOM = c.data?.id
check('房间号是 6 位', /^\d{6}$/.test(ROOM || ''), ROOM)
console.log('  房间号 =', ROOM)

// ── 2. 加入 ──
console.log('\n[2] B、C 加入')
const j1 = await call('/api/online/join', UID_B, { roomId: ROOM, me: { nickname: '仓鼠B', avatar: 2 } })
const j2 = await call('/api/online/join', UID_C, { roomId: ROOM, me: { nickname: '仓鼠C', avatar: 3 } })
check('B 加入成功', j1.ok === true, j1.error || '')
check('C 加入成功', j2.ok === true, j2.error || '')
check('座位数 3', j2.data?.seats?.length === 3)
check('B 不是房主', j1.data?.seats?.find((s) => s.isMe)?.isHost === false)

// 重复 join 不应重复占座
const jDup = await call('/api/online/join', UID_B, { roomId: ROOM, me: { nickname: '仓鼠B', avatar: 2 } })
check('重复加入不重复占座', jDup.data?.seats?.length === 3)

// ── 3. 非房主开局应被拒 ──
console.log('\n[3] 权限校验')
const badStart = await call('/api/online/start', UID_B, { roomId: ROOM })
check('非房主开局被拒', badStart.ok === false, badStart.data && 'unexpected ok')

// ── 4. 开局发牌 ──
console.log('\n[4] 房主开局')
const s = await call('/api/online/start', UID_A, { roomId: ROOM })
check('开局成功', s.ok === true, s.error || '')
check('进入 preflop', s.data?.phase === 'preflop', s.data?.phase)
check('盲注已扣 pot=30', s.data?.pot === 30, String(s.data?.pot))
check('已指定回合', !!s.data?.turnUid)
check('A 拿到自己的 2 张底牌', Array.isArray(s.data?.myCards) && s.data.myCards.length === 2, JSON.stringify(s.data?.myCards))

// B 的视角：有自己的牌，但看不到 A 的
const sB = await call('/api/online/state', UID_B, { roomId: ROOM })
check('B 有自己的底牌', sB.data?.myCards?.length === 2)
check('B 看不到 A 的底牌', JSON.stringify(sB.data).includes('myCards') && !JSON.stringify(sB.data).includes(s.data?.myCards?.[0] + ',' + s.data?.myCards?.[1]))

// ── 5. 回合校验 ──
console.log('\n[5] 回合校验')
const turn = s.data?.turnUid
const other = turn === UID_A ? UID_B : UID_A
const wrong = await call('/api/online/action', other, { roomId: ROOM, type: 'call' })
check('非回合玩家行动被拒', wrong.ok === false)

// ── 6. 打到摊牌 ──
console.log('\n[6] 自动打完整局')
let last = await call('/api/online/state', s.data.turnUid, { roomId: ROOM })
let guard = 0
while (last.data && !last.data.finished && guard++ < 80) {
  const t = last.data.turnUid
  // 用「当前该动的人」的身份重新拉 state，才能拿到他的 availableActions
  const fresh = await call('/api/online/state', t, { roomId: ROOM })
  if (!fresh.ok) { console.log('  state 失败:', fresh.error); break }
  last = fresh
  const acts = last.data.availableActions || []
  if (!acts.length) {
    console.log('  无可执行动作, phase=' + last.data.phase)
    break
  }
  const pick = acts.find((a) => a.type === 'call')?.type
    || acts.find((a) => a.type === 'check')?.type
    || acts.find((a) => a.type === 'fold')?.type
  const r = await call('/api/online/action', t, { roomId: ROOM, type: pick })
  if (!r.ok) { console.log('  动作失败:', r.error); break }
  last = r
}
check('对局已结束', last.data?.finished === true, 'guard=' + guard)
check('有结算结果', !!last.data?.result, JSON.stringify(last.data?.result)?.slice(0, 120))
check('公共牌 5 张', last.data?.communityCards?.length === 5, String(last.data?.communityCards?.length))
console.log('  结算:', JSON.stringify(last.data?.result))

// ── 7. 房主退出 → 整房销毁 ──
console.log('\n[7] 零留存')
const lv = await call('/api/online/leave', UID_A, { roomId: ROOM })
check('房主退出返回 roomClosed', lv.data?.roomClosed === true)
const gone = await call('/api/online/state', UID_B, { roomId: ROOM })
check('房间已销毁', gone.ok === false)

// ── 8. 鉴权 ──
console.log('\n[8] 鉴权')
const noAuth = await fetch(BASE + '/api/online/state', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"roomId":"123456"}',
})
check('无 token 返回 401', noAuth.status === 401)

console.log(`\n结果: ${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
process.exit(fails ? 1 : 0)
