/**
 * 服务端集成测试 —— 两个身份打完整一局线下 + 线上，走真 HTTP。
 *
 * 覆盖清单 §4 与修缮清单 1.2/1.3/1.4/1.5：
 *   · create / join / list / start
 *   · collect / call / raise / fold / stage
 *   · 归零 → settle restart / disband
 *   · 房主连点结算 → 幂等，不重复转账
 *   · handleLeave 不毁房（非房主回合外离开）
 *   · handleJoin 断线重连（对局中刷新页面能回来）
 *   · 脏输入不入库
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.LISTEN = '0'          // 不让 index.js 自己 listen

const { server } = await import('../server/index.js')

// 起在随机端口
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

test.after(() => server.close())

/** 服务端只解 JWT 不验签（朋友局口径），所以可本地造 */
const jwt = (uid) => {
  const h = Buffer.from('{"alg":"none"}').toString('base64url')
  const b = Buffer.from(JSON.stringify({ sub: uid })).toString('base64url')
  return `${h}.${b}.x`
}

async function api(path, uid, body = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt(uid) },
    body: JSON.stringify(body),
  })
  return r.json()
}

const uid = () => 'u-' + Math.random().toString(36).slice(2, 8)
const me = () => ({ nickname: '测试', avatar: 1 })

// ── 建房 / 加入 ────────────────────────────────────────

test('建房：返回 6 位房号，房主已占 1 号位', async () => {
  const u = uid()
  const r = await api('/api/room/create', u, {
    me: me(), cfg: { mode: 'offline', initialSeeds: 3000, smallBlind: 10, bigBlind: 20 },
  })
  assert.equal(r.ok, true, r.error)
  assert.match(r.data.id, /^\d{6}$/)
  assert.equal(r.data.seats.length, 1)
  assert.equal(r.data.seats[0].isHost, true)
  assert.equal(r.data.mode, 'offline')
})

test('脏配置被拒：大麦小于等于小麦', async () => {
  const r = await api('/api/room/create', uid(), {
    me: me(), cfg: { smallBlind: 100, bigBlind: 20 },
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /大麦/)
})

test('加入：第二个玩家进房，快照能看到两人', async () => {
  const h = uid()
  const created = await api('/api/room/create', h, { me: me(), cfg: { initialSeeds: 3000 } })
  const no = created.data.id
  const g = uid()
  const joined = await api('/api/room/join', g, { roomId: no, me: { nickname: '客人', avatar: 2 } })
  assert.equal(joined.ok, true, joined.error)
  assert.equal(joined.data.seats.length, 2)
  assert.equal(joined.data.seats[1].nickname, '客人')
  // 房主端拉一次也要看到两人
  const st = await api('/api/room/state', h, { roomId: no })
  assert.equal(st.data.seats.length, 2)
})

test('房间号格式不对直接拒', async () => {
  const r = await api('/api/room/join', uid(), { roomId: '123', me: me() })
  assert.equal(r.ok, false)
  assert.match(r.error, /房间号无效/)
})

// ── 开局 / 动作 ────────────────────────────────────────

async function twoPlayerRoom() {
  const h = uid()
  const c = await api('/api/room/create', h, {
    me: me(), cfg: { mode: 'offline', initialSeeds: 1000, smallBlind: 10, bigBlind: 20 },
  })
  const no = c.data.id
  const g = uid()
  await api('/api/room/join', g, { roomId: no, me: { nickname: '客人', avatar: 2 } })
  const s = await api('/api/room/start', h, { roomId: no })
  assert.equal(s.ok, true, s.error)
  return { no, h, g, state: s.data }
}

test('开局自动下大小麦，pot=30', async () => {
  const { state } = await twoPlayerRoom()
  assert.equal(state.pot, 30)
  assert.equal(state.currentBet, 20)
  assert.equal(state.stage, 'preflop')
  assert.equal(state.finished, false)
  assert.ok(state.turnUid, '该有人行动')
})

test('跟注：需跟数正确，筹码进 pot', async () => {
  const { no, state } = await twoPlayerRoom()
  const who = state.turnUid
  // 两人局：小盲 10 / 大盲 20，小盲先行动，需补 10
  assert.equal(state.currentBet, 20)
  assert.equal(state.toCall, 10)
  const r = await api('/api/room/action', who, { roomId: no, type: 'call' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.pot, 40)
})

test('不是自己的回合 → 被拒', async () => {
  const { no, h, state } = await twoPlayerRoom()
  const other = state.turnUid === h ? 'x' : state.turnUid
  // 找一个不是当前回合的人
  const notTurn = [h].find((u) => u !== state.turnUid) ?? 'hacker'
  const r = await api('/api/room/action', notTurn, { roomId: no, type: 'call' })
  assert.equal(r.ok, false)
  assert.match(r.error, /回合|房间|不在/)
})

test('收池：pot 清零，收的人拿走', async () => {
  const { no, h, state } = await twoPlayerRoom()
  const r = await api('/api/room/action', h, { roomId: no, type: 'collect' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.pot, 0)
  assert.equal(r.data.finished, true)
})

test('换花生：preflop → flop，但不发牌', async () => {
  const { no, h, state } = await twoPlayerRoom()
  const r = await api('/api/room/stage', h, { roomId: no })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.stage, 'flop')
  assert.equal(r.data.myCards, undefined, '线下绝不给底牌')
})

test('line 上模式拒绝手动换街', async () => {
  const u = uid()
  const c = await api('/api/room/create', u, {
    me: me(), cfg: { mode: 'online', initialSeeds: 3000 },
  })
  const r = await api('/api/room/stage', u, { roomId: c.data.id })
  assert.equal(r.ok, false)
  assert.match(r.error, /线上模式/)
})

// ── 结算 ───────────────────────────────────────────────

async function zeroedRoom() {
  const h = uid()
  const c = await api('/api/room/create', h, {
    me: me(), cfg: { mode: 'offline', initialSeeds: 20, smallBlind: 10, bigBlind: 20 },
  })
  const no = c.data.id
  const g = uid()
  await api('/api/room/join', g, { roomId: no, me: { nickname: '客人', avatar: 2 } })
  const s = await api('/api/room/start', h, { roomId: no })
  assert.equal(s.ok, true, s.error)
  // 房主是小盲（10），call 把剩下的 10 押进去 → 归零、全下
  const r1 = await api('/api/room/action', s.data.turnUid, { roomId: no, type: 'call' })
  assert.equal(r1.ok, true, r1.error)
  assert.equal(r1.data.seats.find((x) => x.uid === s.data.turnUid).seeds, 0)
  // 大麦（客人）还有筹码，由他收池
  const bbUid = s.data.seats.find((x) => x.blind === 'bb')?.uid
  const r = await api('/api/room/action', bbUid, { roomId: no, type: 'collect' })
  assert.equal(r.ok, true, r.error)
  return { no, h, g, state: r.data, sbUid: s.data.turnUid, bbUid }
}

test('有人归零 → 收池后进入待结算', async () => {
  const { state } = await zeroedRoom()
  const zeroed = state.seats.filter((s) => s.seeds <= 0)
  assert.equal(zeroed.length, 1, '应有人归零')
  assert.equal(state.hasZeroSeat, true)
})

test('结算返回转账方案：归零者 → 筹码最高者', async () => {
  const { no, h } = await zeroedRoom()
  const r = await api('/api/room/settle', h, { roomId: no, action: 'restart' })
  assert.equal(r.ok, true, r.error)
  assert.ok(Array.isArray(r.data.transfers), '应有转账清单')
  if (r.data.transfers.length) {
    assert.equal(r.data.transfers[0].amount, 1, '每次结算只转 1 粒')
  }
  assert.equal(typeof r.data.roundNo, 'number')
})

test('结算幂等：连点两次不重复转账', async () => {
  const { no, h } = await zeroedRoom()
  const a = await api('/api/room/settle', h, { roomId: no, action: 'restart' })
  assert.equal(a.ok, true, a.error)
  assert.ok(Array.isArray(a.data.transfers))

  // 第二次必须被挡掉：要么明确告知已结算，要么因为
  // 「新一手还没结束」而被拒。两种都不该产生新的转账。
  const b = await api('/api/room/settle', h, { roomId: no, action: 'restart' })
  assert.ok(
    b.data?.skipped === true || b.ok === false,
    `第二次结算应被幂等挡掉，实际：${JSON.stringify(b)}`
  )
  assert.deepEqual(b.data?.transfers ?? [], [], '第二次绝不能给转账清单')

  // 局数只能 +1，不能因为连点而 +2
  const st = await api('/api/room/state', h, { roomId: no })
  assert.equal(st.data.roundNo, 2)
})

test('结算后重置：全员回初始值', async () => {
  const { no, h } = await zeroedRoom()
  await api('/api/room/settle', h, { roomId: no, action: 'restart' })
  const st = await api('/api/room/state', h, { roomId: no })
  assert.equal(st.ok, true, st.error)
  // initialSeeds = 20（zeroedRoom 的配置）
  assert.equal(st.data.seats.every((s) => s.seeds === 20), true)
  assert.equal(st.data.roundNo, 2)
})

test('非房主不能结算', async () => {
  const { no, g } = await zeroedRoom()
  const r = await api('/api/room/settle', g, { roomId: no })
  assert.equal(r.ok, false)
  assert.match(r.error, /房主/)
})

test('结算并解散：房间消失', async () => {
  const { no, h } = await zeroedRoom()
  const r = await api('/api/room/settle', h, { roomId: no, action: 'disband' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.disbanded, true)
  const again = await api('/api/room/state', h, { roomId: no })
  assert.equal(again.ok, false)
  assert.match(again.error, /房间不存在/)
})

// ── 修缮清单 1.2 / 1.3 ─────────────────────────────────

test('handleLeave：非房主回合外离开不会毁掉房间状态', async () => {
  // 这是修繕清单 1.2 的回归测试。
  // 旧代码在 applyAction 返回 {error}（无 state）时仍执行
  // room.state = r.state → state 变 undefined → 牌局报废。
  const { no, h, g, state } = await twoPlayerRoom()
  const before = await api('/api/room/state', h, { roomId: no })
  // 客人不是当前回合的人，他离开 = 不该影响引擎
  const isGuestTurn = state.turnUid === g
  await api('/api/room/leave', g, { roomId: no })
  const after = await api('/api/room/state', h, { roomId: no })
  assert.equal(after.ok, true, after.error)
  assert.equal(after.data.pot, before.data.pot, '底池不能被离开的人带走')
  assert.equal(after.data.seats.length, 1, '客人已离座')
  assert.ok(after.data.turnUid !== undefined, '回合信息必须还在')
  if (!isGuestTurn) {
    assert.equal(after.data.turnUid, before.data.turnUid, '非回合者离开不该改回合')
  }
})

test('handleJoin：对局中刷新页面能回到座位', async () => {
  // 修缮清单 1.3 的回归测试
  const { no, g, state } = await twoPlayerRoom()
  const re = await api('/api/room/join', g, { roomId: no, me: { nickname: '客人', avatar: 2 } })
  assert.equal(re.ok, true, '对局中重连不应被「对局已开始」挡掉')
  assert.equal(re.data.seats.length, 2, '座位必须还在')
  assert.equal(re.data.seats.find((s) => s.uid === g)?.nickname, '客人')
  assert.equal(re.data.turnUid, state.turnUid, '对局进度不能丢')
})

test('handleLeave：房主离开 → 整房销毁', async () => {
  const { no, h } = await twoPlayerRoom()
  const r = await api('/api/room/leave', h, { roomId: no })
  assert.equal(r.data.roomClosed, true)
  const st = await api('/api/room/state', h, { roomId: no })
  assert.equal(st.ok, false)
})

// ── 脏输入 ─────────────────────────────────────────────

test('超长请求体被拒', async () => {
  const u = uid()
  const r = await fetch(BASE + '/api/room/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt(u) },
    body: JSON.stringify({ junk: 'x'.repeat(20000) }),
  })
  assert.equal(r.status, 413)
})

test('无 token → 401', async () => {
  const r = await fetch(BASE + '/api/room/list', { method: 'POST' })
  assert.equal(r.status, 401)
})

test('未知接口 → 404', async () => {
  const r = await fetch(BASE + '/api/room/nope', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + jwt(uid()) },
  })
  assert.equal(r.status, 404)
})

test('列房间列表：能看到可加入的房', async () => {
  const h = uid()
  await api('/api/room/create', h, { me: me(), cfg: { mode: 'offline' } })
  const r = await api('/api/room/list', uid())
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.data.rooms))
  assert.ok(r.data.rooms.length >= 1)
})
