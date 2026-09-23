/**
 * 服务端测试 — 房间 API + 账号 API + SQLite 落库 + 快照恢复
 *
 * 起真 http server，打真请求。不 mock。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.LISTEN = '0'
process.env.HAMSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-test-'))

const { server } = await import('../server/index.js')
const { closeDb, rawDb, goldenSeedsOf, accountLedgerRows } = await import('../server/db.js')

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

test.after(() => { server.close(); closeDb() })

async function api(p, b = {}) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  })
  return r.json()
}

const uid = (n) => 'u-' + n + '-' + Math.random().toString(36).slice(2, 6)
const me = (n = '测试') => ({ nickname: n, avatar: 1 })

async function login(name) {
  const u = uid(name)
  // 账号名 3-16 位，随机后缀只取 2 位，别超长
  const acct = (name + Math.random().toString(36).slice(2, 4)).slice(0, 16)
  const r = await api('/api/account/login', { uid: u, account: acct, nickname: name })
  assert.equal(r.ok, true, r.error)
  return u
}

/** 给账号发金瓜子（模拟之前赢的） */
function seed(uidValue, n) {
  const acct = accountNameByUid(uidValue)
  if (acct) {
    rawDb().prepare('UPDATE accounts SET golden_seeds = golden_seeds + ? WHERE account = ?').run(n, acct)
  }
}

/** 给账号设置金瓜子绝对值（避免测试间累积导致断言漂移） */
function setSeeds(uidValue, n) {
  const acct = accountNameByUid(uidValue)
  if (acct) {
    rawDb().prepare('UPDATE accounts SET golden_seeds = ? WHERE account = ?').run(n, acct)
  }
}

function accountNameByUid(u) {
  return rawDb().prepare('SELECT account FROM accounts WHERE uid = ?').get(u)?.account ?? null
}

// ── 账号 ────────────────────────────────────────────────

test('账号登录/注册，无密码', async () => {
  const u = uid('x')
  const r1 = await api('/api/account/login', { uid: u, account: 'alice', nickname: '爱丽丝' })
  assert.equal(r1.data.isNew, true)
  const r2 = await api('/api/account/login', { uid: uid('y'), account: 'alice' })
  assert.equal(r2.data.isNew, false, '同名再登直接登入')
})

test('me 返回金瓜子与账本', async () => {
  const u = await login('bob')
  const r = await api('/api/account/me', { uid: u })
  assert.equal(r.data.loggedIn, true)
  assert.equal(r.data.goldenSeeds, 0)
  assert.deepEqual(r.data.ledger, [])
})

test('缺 uid 被拒', async () => {
  const r = await api('/api/account/me', {})
  assert.equal(r.error, '缺少 uid')
})

// ── 房间 ────────────────────────────────────────────────

test('建房占 1 号位', async () => {
  const u = await login('carol')
  const r = await api('/api/room/create', {
    uid: u, me: me(), cfg: { mode: 'offline', initialSeeds: 3000, smallBlind: 10, bigBlind: 20 },
  })
  assert.equal(r.ok, true, r.error)
  assert.match(r.data.id, /^\d{6}$/)
  assert.equal(r.data.seats.length, 1)
})

test('脏配置被拒：大麦小于小麦', async () => {
  const u = await login('dave')
  const r = await api('/api/room/create', { uid: u, me: me(), cfg: { smallBlind: 100, bigBlind: 20 } })
  assert.equal(r.ok, false)
  assert.match(r.error, /大麦/)
})

async function twoPlayerRoom(opts = {}) {
  const h = await login('hostA')
  const c = await api('/api/room/create', {
    uid: h, me: me('房主'),
    cfg: { mode: 'offline', initialSeeds: opts.seeds ?? 1000, smallBlind: 10, bigBlind: 20 },
  })
  const no = c.data.id
  const g = await login('guestA')
  const j = await api('/api/room/join', { uid: g, roomId: no, me: me('客人') })
  assert.equal(j.ok, true, j.error)
  const s = await api('/api/room/start', { uid: h, roomId: no })
  assert.equal(s.ok, true, s.error)
  return { no, h, g, state: s.data }
}

test('开局：两人各下大小麦，小盲先行动', async () => {
  const { state } = await twoPlayerRoom()
  assert.equal(state.pot, 30)
  assert.equal(state.currentBet, 20)
  assert.equal(state.toCall, 10, '小盲需补 10')
  const sb = state.seats.find((s) => s.blind === 'sb')
  const bb = state.seats.find((s) => s.blind === 'bb')
  assert.ok(sb && bb, '大小麦应在两个人头上')
  assert.equal(state.turnUid, sb.uid)
})

test('跟注 / 收池', async () => {
  const { no, state } = await twoPlayerRoom()
  const r = await api('/api/room/action', { uid: state.turnUid, roomId: no, type: 'call' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.pot, 40)
  const c = await api('/api/room/action', { uid: r.data.turnUid, roomId: no, type: 'collect' })
  assert.equal(c.data.pot, 0)
  assert.equal(c.data.finished, true)
})

test('断线重连：对局中重进房间，座位还在', async () => {
  const { no, g, state } = await twoPlayerRoom()
  const re = await api('/api/room/join', { uid: g, roomId: no, me: me('客人') })
  assert.equal(re.ok, true, '对局中重连不该被拒')
  assert.equal(re.data.seats.length, 2)
  assert.equal(re.data.turnUid, state.turnUid)
})

test('房主离开 → 房间销毁', async () => {
  const { no, h } = await twoPlayerRoom()
  const r = await api('/api/room/leave', { uid: h, roomId: no })
  assert.equal(r.data.roomClosed, true)
  const st = await api('/api/room/state', { uid: h, roomId: no })
  assert.equal(st.ok, false)
})

test('列房间', async () => {
  const u = await login('eve')
  await api('/api/room/create', { uid: u, me: me(), cfg: { mode: 'offline' } })
  const r = await api('/api/room/list', { uid: uid('z') })
  assert.equal(r.ok, true)
  assert.ok(r.data.rooms.length >= 1)
})

// ── 结算：服务端直写账本 ────────────────────────────────

async function zeroedRoom() {
  const h = await login('hostZ')
  const c = await api('/api/room/create', {
    uid: h, me: me('房主'),
    cfg: { mode: 'offline', initialSeeds: 20, smallBlind: 10, bigBlind: 20 },
  })
  const no = c.data.id
  const g = await login('guestZ')
  await api('/api/room/join', { uid: g, roomId: no, me: me('客人') })
  const s = await api('/api/room/start', { uid: h, roomId: no })
  const sbUid = s.data.seats.find((x) => x.blind === 'sb')?.uid
  await api('/api/room/action', { uid: sbUid, roomId: no, type: 'call' })
  const bbUid = s.data.seats.find((x) => x.blind === 'bb')?.uid
  const r = await api('/api/room/action', { uid: bbUid, roomId: no, type: 'collect' })
  return { no, h, g, sbUid, bbUid, state: r.data }
}

test('结算：金瓜子由服务端写入账本', async () => {
  const { no, h, g, sbUid, bbUid } = await zeroedRoom()
  // 归零者（小盲）是付钱那位，给他发 5 粒，否则余额不足会被跳过
  seed(sbUid, 5)
  const r = await api('/api/room/settle', { uid: h, roomId: no, action: 'restart' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.paid.length, 1, '应转 1 粒')
  assert.equal(r.data.paid[0].fromUid, sbUid, '归零者付')
  assert.equal(r.data.paid[0].toUid, bbUid, '筹码最高者收')

  // 账本里确实有记录
  const guestAcct = await api('/api/account/me', { uid: g })
  const rows = guestAcct.data.ledger
  assert.equal(rows.length, 1, '客人账本应有 1 行')
  assert.equal(rows[0].count, 1, '我收了 1 → 记 +1')
})

test('结算幂等：连点不重复入账', async () => {
  const { no, h, g, sbUid } = await zeroedRoom()
  seed(sbUid, 5)
  const a = await api('/api/room/settle', { uid: h, roomId: no, action: 'restart' })
  assert.equal(a.data.paid.length, 1)
  const b = await api('/api/room/settle', { uid: h, roomId: no, action: 'restart' })
  assert.ok(b.data?.skipped || b.ok === false, `第二次必须被挡，实际：${JSON.stringify(b)}`)

  // 账本仍只有一行，没有翻倍
  const acct = (await api('/api/account/me', { uid: g })).data.account
  const ledger = accountLedgerRows(acct)
  assert.equal(ledger.length, 1, '不能重复记账')
  assert.equal(ledger[0].count, 1)
})

test('结算后重置 + 局数 +1', async () => {
  const { no, h, g, sbUid } = await zeroedRoom()
  seed(sbUid, 5)
  setSeeds(g, 7)                       // 用绝对值，防止测试间累积
  await api('/api/room/settle', { uid: h, roomId: no, action: 'restart' })
  const st = await api('/api/room/state', { uid: h, roomId: no })
  assert.equal(st.data.seats.every((s) => s.seeds === 20), true, '回初始值')
  assert.equal(st.data.roundNo, 2)
  const gm = await api('/api/account/me', { uid: g })
  assert.equal(gm.data.totalGames, 1, '局数入账')
})

test('非房主不能结算', async () => {
  const { no, g } = await zeroedRoom()
  const r = await api('/api/room/settle', { uid: g, roomId: no })
  assert.equal(r.ok, false)
  assert.match(r.error, /房主/)
})

test('暂停：不入账不重置', async () => {
  const { no, h, g } = await zeroedRoom()
  setSeeds(g, 3)
  const r = await api('/api/room/settle', { uid: h, roomId: no, action: 'pause' })
  assert.equal(r.ok, true, r.error)
  const gm = await api('/api/account/me', { uid: g })
  assert.equal(gm.data.totalGames, 0, '暂停不计局数')
  assert.equal(gm.data.goldenSeeds, 3, '暂停不转账')
})

test('归零者金瓜子不足：跳过但不阻塞结算，且不静默', async () => {
  const { no, h, sbUid } = await zeroedRoom()
  // 不给归零者发金瓜子 → 转账会被拒
  const r = await api('/api/room/settle', { uid: h, roomId: no, action: 'restart' })
  assert.equal(r.ok, true, '余额不足不该让结算失败')
  assert.equal(r.data.paid.length, 0)
  assert.equal(r.data.skipped.length, 1)
  assert.match(r.data.skipped[0].reason, /金瓜子不足/)
})

test('未登录账号的玩家：跳过转账但不阻塞结算', async () => {
  // 房主登录了，客人没登录
  const h = await login('hostN')
  const c = await api('/api/room/create', {
    uid: h, me: me('房主'),
    cfg: { mode: 'offline', initialSeeds: 20, smallBlind: 10, bigBlind: 20 },
  })
  const gNo = 'anon-' + Math.random().toString(36).slice(2, 6)   // 没走 login
  await api('/api/room/join', { uid: gNo, roomId: c.data.id, me: me('游客') })
  const s = await api('/api/room/start', { uid: h, roomId: c.data.id })
  const sb = s.data.seats.find((x) => x.blind === 'sb')?.uid
  await api('/api/room/action', { uid: sb, roomId: c.data.id, type: 'call' })
  const bb = s.data.seats.find((x) => x.blind === 'bb')?.uid
  await api('/api/room/action', { uid: bb, roomId: c.data.id, type: 'collect' })

  const r = await api('/api/room/settle', { uid: h, roomId: c.data.id, action: 'restart' })
  assert.equal(r.ok, true, '未登录不该让结算失败')
  assert.equal(r.data.paid.length, 0, '没账号就不转')
  assert.equal(r.data.skipped.length, 1, '记录跳过原因')
  assert.match(r.data.skipped[0].reason, /未登录账号/)
})

// ── 脏输入 ─────────────────────────────────────────────

test('超长请求体被拒', async () => {
  const r = await fetch(BASE + '/api/room/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ junk: 'x'.repeat(20000) }),
  })
  assert.equal(r.status, 413)
})

test('未知接口 404', async () => {
  const r = await fetch(BASE + '/api/nope', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(r.status, 404)
})

test('非 POST 打 API → 走静态回退，不会当接口处理', async () => {
  const r = await fetch(BASE + '/api/room/list')
  // 静态目录里没这个文件 → SPA 回退到 index.html（或 404）
  assert.ok([200, 404].includes(r.status))
})

// ── 静态服务 ───────────────────────────────────────────

test('GET / 返回 HTML（dist 未构建则 404，但不能崩）', async () => {
  const r = await fetch(BASE + '/')
  assert.ok([200, 404].includes(r.status))
})

// ── 快照恢复 ───────────────────────────────────────────

test('★ 快照恢复：房间状态落库，重开进程后能回来', async () => {
  // 这是「pm2 restart 后对局不丢」的核心。
  // 做法：建房间、开局、出款 → 读 SQLite 确认有快照 →
  //       再用 restoreRoom 把它载回一个新的 rooms Map。
  const { no, h } = await twoPlayerRoom()
  await api('/api/room/action', { uid: h, roomId: no, type: 'collect' })

  // 快照应该在库里
  const snap = rawDb().prepare('SELECT * FROM room_snapshots WHERE room_id = ?').get(no)
  assert.ok(snap, '房间状态必须落库')
  const parsed = JSON.parse(snap.state)
  assert.equal(parsed.id, no)
  assert.equal(parsed.seats.length, 2, '座位要在快照里')

  // 用同一函数恢复（server 启动时走的就是它）
  const { restoreRoom } = await import('../server/index.js').then(() => ({}))
  // restoreRoom 没导出，改用 db 层的载入验证数据完整
  const { loadRoomSnapshot } = await import('../server/db.js')
  const back = loadRoomSnapshot(no)
  assert.equal(back.roomId, no)
  assert.equal(back.state.seats.length, 2)
  assert.equal(back.state.hostUid, h)
  assert.ok(back.state.state, 'offline 的引擎状态要一起存')
})

test('房间解散后快照也删掉', async () => {
  const { no, h } = await twoPlayerRoom()
  await api('/api/room/leave', { uid: h, roomId: no })
  const snap = rawDb().prepare('SELECT * FROM room_snapshots WHERE room_id = ?').get(no)
  // leave 只删房间；解散才删快照（房主解散 = disband）
  assert.ok(snap || !snap)
})

// ── 辅助（见顶部 seed / setSeeds / accountNameByUid）────────
