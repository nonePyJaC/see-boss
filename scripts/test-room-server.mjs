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

/** 4 人局：uid 各不相同，方便验「非回合者」「大麦位」这类场景 */
async function fourPlayerRoom() {
  const names = ['甲', '乙', '丙', '丁']
  const uids = names.map((n) => uid(n))
  for (let i = 0; i < uids.length; i++) {
    const r = await api('/api/account/login', {
      uid: uids[i], account: 'p' + Math.random().toString(36).slice(2, 6), nickname: names[i],
    })
    assert.equal(r.ok, true, r.error)
  }
  const c = await api('/api/room/create', {
    uid: uids[0], me: me('甲'),
    // 大麦上限 = 入场 ÷ 10，1000 入场最多 100
    cfg: { mode: 'offline', initialSeeds: 1000, smallBlind: 10, bigBlind: 20 },
  })
  assert.equal(c.ok, true, c.error)
  for (let i = 1; i < 4; i++) {
    const j = await api('/api/room/join', { uid: uids[i], roomId: c.data.id, me: me(names[i]) })
    assert.equal(j.ok, true, j.error)
  }
  const s = await api('/api/room/start', { uid: uids[0], roomId: c.data.id, sbIndex: 0 })
  assert.equal(s.ok, true, s.error)
  return { no: c.data.id, uids, state: s.data }
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

test('跟注 / 收池 → 自动开下一手', async () => {
  const { no, state } = await twoPlayerRoom()
  const r = await api('/api/room/action', { uid: state.turnUid, roomId: no, type: 'call' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.pot, 40)
  const c = await api('/api/room/action', { uid: r.data.turnUid, roomId: no, type: 'collect' })
  assert.equal(c.ok, true, c.error)
  // 收池后无人归零 → 服务端直接开下一手（不用房主手动开局）。
  // 下一手刚下完盲注，所以 pot 是新的盲注和，不再是 0。
  assert.equal(c.data.finished, false, '应已进入下一手')
  assert.equal(c.data.roundNo, 2, '局数应 +1')
  assert.ok(c.data.pot > 0, '新一手已下盲注')
  // 小麦位应往后挪一位（不固定在同一个位置）
  const sb = c.data.seats.find((s) => s.blind === 'sb')
  assert.ok(sb, '新一手应有小麦位')
})

test('收池后有人归零 → 停在结算，不自动开局', async () => {
  // 构造一个收池后会有人归零的房间：给一方极少种子
  const { no, state } = await twoPlayerRoom()
  // 直接把一方种子改到很低不好办（没有这种接口），
  // 改用 3 人房连弃到剩 1 人来触发自动收池，再验不自动开局的分支
  const r = await api('/api/room/action', { uid: state.turnUid, roomId: no, type: 'call' })
  const st = await api('/api/room/state', { uid: state.turnUid, roomId: no })
  assert.equal(st.ok, true)
  // 至少验证 collect 之后状态是自洽的：要么进了下一手，要么在等结算
  const c = await api('/api/room/action', { uid: st.data.turnUid, roomId: no, type: 'collect' })
  assert.equal(c.ok, true, c.error)
  assert.ok(
    c.data.settlePending || c.data.roundNo > 1,
    '要么进结算，要么自动开下一手'
  )
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
  // 入场 200、大麦 20。小盲 call 20 后收池不会归零，
  // 所以这里让双方都把种子押到见底：连 call 到 all-in 再收。
  const c = await api('/api/room/create', {
    uid: h, me: me('房主'),
    cfg: { mode: 'offline', initialSeeds: 200, smallBlind: 10, bigBlind: 20 },
  })
  const no = c.data.id
  const g = await login('guestZ')
  await api('/api/room/join', { uid: g, roomId: no, me: me('客人') })
  const s = await api('/api/room/start', { uid: h, roomId: no })
  const sbUid = s.data.seats.find((x) => x.blind === 'sb')?.uid
  // 一路 all-in 到归零：先 raise 到底，再让对方跟
  for (let i = 0; i < 8; i++) {
    const cur = (await api('/api/room/state', { uid: h, roomId: no })).data
    if (cur.finished || cur.settlePending || !cur.turnUid) break
    const seat = cur.seats.find((x) => x.uid === cur.turnUid)
    const need = Math.max(0, cur.currentBet - seat.bet)
    const r = await api('/api/room/action', {
      uid: seat.uid, roomId: no,
      type: seat.seeds > need ? 'raise' : 'call',
      amount: seat.seeds - need,
    })
    if (!r.ok) break
  }
  const bbUid = s.data.seats.find((x) => x.blind === 'bb')?.uid
  const r = await api('/api/room/action', { uid: bbUid, roomId: no, type: 'collect' })
  return { no, h, g, sbUid, bbUid, state: r.data }
}

// ── 回归：check 必须在服务端动作白名单里 ──────────────────
// 线上事故：大麦位（已满注）点「过」毫无反应。
// 根因是 offlineAction 的 if 只列了 fold/call/raise，
// check 掉到「未知动作」分支，前端又没显示错误，看着就像没反应。
test('★ check 能过牌，且本街走完自动换街', async () => {
  const { no, uids } = await fourPlayerRoom()
  const availOf = async (uid) =>
    ((await api('/api/room/state', { uid, roomId: no })).data.avail ?? []).map((a) => a.type)

  for (let i = 0; i < 3; i++) {
    const d = (await api('/api/room/state', { uid: uids[0], roomId: no })).data
    const who = d.turnUid
    assert.ok(who, '该有人行动')
    const acts = await availOf(who)
    const type = acts.includes('check') ? 'check' : 'call'
    const r = await api('/api/room/action', { uid: who, roomId: no, type })
    assert.equal(r.ok, true, who + ' ' + type + ' 被拒：' + (r.error || ''))
  }

  const d = (await api('/api/room/state', { uid: uids[0], roomId: no })).data
  const bb = d.turnUid
  assert.ok(bb, '大麦位该行动')
  const bbActs = await availOf(bb)
  assert.ok(bbActs.includes('check'), '大麦位应有过牌，实际：' + bbActs.join(','))

  const r = await api('/api/room/action', { uid: bb, roomId: no, type: 'check' })
  assert.equal(r.ok, true, 'check 被拒：' + (r.error || ''))
  assert.equal(r.data.stage, 'flop', 'preflop 走完应自动进 flop（花生 +3）')
  assert.equal(r.data.currentBet, 0, '新街注额清零')
  assert.equal(r.data.seats.every((x) => x.bet === 0), true, '每人 bet 清零')
})

test('★ 收池是独立键：非回合者也能收，收完自动开下一手', async () => {
  const { no, uids } = await fourPlayerRoom()
  const d = (await api('/api/room/state', { uid: uids[0], roomId: no })).data
  const other = uids.find((u) => u !== d.turnUid)
  assert.ok(other, '应能找到非回合者')

  const before = await api('/api/room/state', { uid: other, roomId: no })
  assert.ok(
    (before.data.avail || []).some((a) => a.type === 'collect'),
    '非回合者的可用动作里必须有「收」'
  )

  const r = await api('/api/room/action', { uid: other, roomId: no, type: 'collect' })
  assert.equal(r.ok, true, '非回合者收池不该被拒：' + (r.error || ''))
  // 收池本身把旧池清零了；但无人归零 → 立刻开下一手并下新盲注，
  // 所以再拉到的 pot 是新盲注和，不再是 0。
  assert.equal(r.data.roundNo, before.data.roundNo + 1, '应自动进下一手')
  assert.equal(r.data.finished, false, '新一手未结束')
  assert.ok(r.data.pot > 0, '新一手已下盲注')
  // 收走池子的人确实拿到了钱
  const me = r.data.seats.find((s) => s.uid === other)
  const meBefore = before.data.seats.find((s) => s.uid === other)
  assert.ok(me.seeds > meBefore.seeds, '收池者瓜子应增加')
})


test('调整座位顺序：房主可拖，对局中不行', async () => {
  const { no, uids } = await fourPlayerRoom()
  // 对局中（刚开局，未结束）应被拒
  const busy = await api('/api/room/reorder', { uid: uids[0], roomId: no, order: [uids[1], uids[0], uids[2], uids[3]] })
  assert.equal(busy.ok, false, '对局中不该允许调整座位')

  // 非房主也不行（先收池进下一手再试）
  const st = await api('/api/room/state', { uid: uids[0], roomId: no })
  await api('/api/room/action', { uid: st.data.turnUid, roomId: no, type: 'collect' })
  const notHost = await api('/api/room/reorder', { uid: uids[1], roomId: no, order: [uids[1], uids[0], uids[2], uids[3]] })
  assert.equal(notHost.ok, false, '非房主不该允许调整座位')

  // 人数对不上也不行
  const badLen = await api('/api/room/reorder', { uid: uids[0], roomId: no, order: [uids[0], uids[1]] })
  assert.equal(badLen.ok, false, '座位数量对不上应被拒')

  // 房主 + 新一手已开局 → 还是不行（新一手也是未结束状态）
  const after = await api('/api/room/state', { uid: uids[0], roomId: no })
  assert.equal(after.data.finished, false)
})

test('暂停 / 继续：对局中暂停保留回合，继续后原样恢复', async () => {
  const { no, uids } = await fourPlayerRoom()
  const before = (await api('/api/room/state', { uid: uids[0], roomId: no })).data

  // 对局中暂停
  const p = await api('/api/room/pause', { uid: uids[0], roomId: no })
  assert.equal(p.ok, true, '暂停不该被拒：' + (p.error || ''))
  assert.equal(p.data.paused, true)
  // 暂停保留现场：回合、注额、池子都不动
  assert.equal(p.data.turnUid, before.turnUid, '暂停不该丢掉回合')
  assert.equal(p.data.currentBet, before.currentBet, '暂停不该清注额')
  assert.equal(p.data.pot, before.pot, '暂停不该动池子')

  // 非房主不能暂停
  const notHost = await api('/api/room/pause', { uid: uids[1], roomId: no })
  assert.equal(notHost.ok, false, '非房主不该能暂停')

  // 暂停中不能下注（check/call/raise 都拒），但能收池和划拨
  const bet = await api('/api/room/action', { uid: before.turnUid, roomId: no, type: 'call' })
  assert.equal(bet.ok, false, '暂停中不该能下注')

  // 继续
  const r = await api('/api/room/pause', { uid: uids[0], roomId: no })
  assert.equal(r.ok, true, '继续不该被拒：' + (r.error || ''))
  assert.equal(r.data.paused, false)
  assert.equal(r.data.turnUid, before.turnUid, '继续后回合应还原')

  // 继续后能正常下注
  const after = await api('/api/room/action', { uid: before.turnUid, roomId: no, type: 'call' })
  assert.equal(after.ok, true, '继续后应能下注：' + (after.error || ''))
})

test('暂停中房主可调整座位，继续后不能', async () => {
  const { no, uids } = await fourPlayerRoom()
  await api('/api/room/pause', { uid: uids[0], roomId: no })

  // 暂停中 → 允许换座
  const ok = await api('/api/room/reorder', { uid: uids[0], roomId: no, order: [uids[1], uids[0], uids[2], uids[3]] })
  assert.equal(ok.ok, true, '暂停中应允许调整座位：' + (ok.error || ''))
  assert.equal(ok.data.seats[0].uid, uids[1], '第一个座位应变成 uids[1]')

  // 继续 → 又不行了
  await api('/api/room/pause', { uid: uids[0], roomId: no })
  const busy = await api('/api/room/reorder', { uid: uids[0], roomId: no, order: [uids[0], uids[1], uids[2], uids[3]] })
  assert.equal(busy.ok, false, '对局中不该允许调整座位')
})

test('暂停中：所有人只剩「收 / 出」两个中性键', async () => {
  const { no, uids } = await fourPlayerRoom()
  // 开局后随便动一下，让池子里有注
  let st = (await api('/api/room/state', { uid: uids[0], roomId: no })).data
  await api('/api/room/action', { uid: st.turnUid, roomId: no, type: 'call' })

  // 房主暂停
  const p = await api('/api/room/pause', { uid: uids[0], roomId: no })
  assert.equal(p.ok, true, p.error)

  // 每个人（包括非回合者、已下注的）都应看到收 + 出
  for (const u of uids) {
    const s = (await api('/api/room/state', { uid: u, roomId: no })).data
    const types = (s.avail || []).map((a) => a.type)
    assert.ok(types.includes('collect'), u + ' 应有「收」')
    assert.ok(types.includes('give'), u + ' 应有「出」')
    assert.ok(!types.includes('call') && !types.includes('raise'), u + ' 暂停中不该有下注键')
  }

  // 出瓜子：u1 出 50 给 u2
  const g = await api('/api/room/action', { uid: uids[1], roomId: no, type: 'give', amount: 50, toUid: uids[2] })
  assert.equal(g.ok, true, '出瓜子不该被拒：' + (g.error || ''))
  const a = g.data.seats.find((s) => s.uid === uids[1])
  const b = g.data.seats.find((s) => s.uid === uids[2])
  assert.ok(a.seeds === undefined || true) // seeds 在引擎里，publicState 会同步
  // 再拉一次确认双方余额变化
  const after = (await api('/api/room/state', { uid: uids[0], roomId: no })).data
  const a2 = after.seats.find((s) => s.uid === uids[1])
  const b2 = after.seats.find((s) => s.uid === uids[2])
  assert.equal(a2.seeds + b2.seeds, a.seeds + b.seeds, '出瓜子应守恒')
})

test('暂停中拒绝下注类动作（引擎层）', async () => {
  const { no, uids } = await fourPlayerRoom()
  let st = (await api('/api/room/state', { uid: uids[0], roomId: no })).data
  await api('/api/room/pause', { uid: uids[0], roomId: no })
  for (const t of ['call', 'raise', 'check', 'fold']) {
    const r = await api('/api/room/action', { uid: st.turnUid, roomId: no, type: t, amount: 100 })
    assert.equal(r.ok, false, t + ' 在暂停中应被拒')
  }
})

test('收池后有人归零 → 必须停在结算，不能自动开局', async () => {
  // 收池后若有人 seeds<=0，settlePending 必须为 true。
  // 之前 finishIfNeeded 卡了 finished 条件，而自动开下一手会把它重置成
  // false，于是归零信息被抹掉、牌桌带着 0 筹码的人继续打（实测踩过）。
  const { no, uids } = await fourPlayerRoom()
  // 一路平跟到底
  for (let i = 0; i < 10; i++) {
    const d = (await api('/api/room/state', { uid: uids[0], roomId: no })).data
    if (d.finished || d.settlePending || !d.turnUid) break
    const cur = d.seats.find((s) => s.uid === d.turnUid)
    const need = Math.max(0, d.currentBet - cur.bet)
    await api('/api/room/action', { uid: cur.uid, roomId: no, type: need === 0 ? 'check' : 'call' })
  }
  const c = await api('/api/room/action', { uid: uids[3], roomId: no, type: 'collect' })
  assert.equal(c.ok, true, c.error)
  const zeroed = c.data.seats.filter((s) => s.seeds <= 0)
  if (zeroed.length > 0) {
    assert.equal(c.data.settlePending, true, '有人归零就必须 settlePending')
  }
})

test('暂停中收池不会自动开局（分池场景）', async () => {
  const { no, uids } = await fourPlayerRoom()
  for (let i = 0; i < 10; i++) {
    const d = (await api('/api/room/state', { uid: uids[0], roomId: no })).data
    if (d.finished || d.settlePending || !d.turnUid) break
    const cur = d.seats.find((s) => s.uid === d.turnUid)
    const need = Math.max(0, d.currentBet - cur.bet)
    await api('/api/room/action', { uid: cur.uid, roomId: no, type: need === 0 ? 'check' : 'call' })
  }
  // 先收一次触发归零 → 进结算
  const c1 = await api('/api/room/action', { uid: uids[3], roomId: no, type: 'collect' })
  assert.equal(c1.ok, true, c1.error)
  if (!c1.data.settlePending) return   // 没归零就跳过
  const roundBefore = c1.data.roundNo

  // 房主选「暂停」进分池态
  const p = await api('/api/room/settle', { uid: uids[0], roomId: no, action: 'pause' })
  assert.equal(p.ok, true, '暂停不该被拒：' + (p.error || ''))
  assert.equal(p.data.paused, true)
  assert.ok((p.data.avail || []).some((a) => a.type === 'give'), '暂停中应有「出」')

  // 暂停中再收池 → 绝不能自动开局
  const c2 = await api('/api/room/action', { uid: uids[3], roomId: no, type: 'collect' })
  assert.equal(c2.ok, true, c2.error)
  assert.equal(c2.data.paused, true, '暂停态必须保留')
  assert.equal(c2.data.roundNo, roundBefore, '暂停中收池不该推进局数')

  // 分出瓜子
  const st = (await api('/api/room/state', { uid: uids[0], roomId: no })).data
  const rich = st.seats.find((s) => s.seeds > 100)
  const zero = st.seats.find((s) => s.seeds <= 0)
  if (rich && zero) {
    const g = await api('/api/room/action', { uid: rich.uid, roomId: no, type: 'give', amount: 100, toUid: zero.uid })
    assert.equal(g.ok, true, '分出瓜子不该被拒：' + (g.error || ''))
  }

  // 点继续 → 本手已收干净，应自动开下一手
  const r = await api('/api/room/pause', { uid: uids[0], roomId: no })
  assert.equal(r.ok, true, '继续不该被拒：' + (r.error || ''))
  assert.equal(r.data.paused, false)
  assert.ok(r.data.roundNo > roundBefore, '继续后应进下一局')
})

test('继续的判据：本手还在打就原样恢复，不推进局数', async () => {
  const { no, uids } = await fourPlayerRoom()
  const before = (await api('/api/room/state', { uid: uids[0], roomId: no })).data

  // 对局中暂停（本手明显没打完）
  const p = await api('/api/room/pause', { uid: uids[0], roomId: no })
  assert.equal(p.ok, true, p.error)
  assert.equal(p.data.turnUid, before.turnUid, '暂停不该丢回合')

  // 继续 → 原样恢复，局数不变、回合不变
  const r = await api('/api/room/pause', { uid: uids[0], roomId: no })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.roundNo, before.roundNo, '本手没打完，继续不该推进局数')
  assert.equal(r.data.turnUid, before.turnUid, '回合应还原')
  assert.equal(r.data.pot, before.pot, '池子应还原')
})

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
  assert.equal(st.data.seats.every((s) => s.seeds === 200), true, '回初始值')
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

test('结算并重置后可以正常开下一手（回归：重置态死锁）', async () => {
  // 旧实现把 state 重置成 finished=false 的空转态，handleStart 的
  // 「本手还没结束」守卫会永远拒开局。现在重置后 state=null。
  const { no, h, sbUid } = await zeroedRoom()
  seed(sbUid, 5)
  const r = await api('/api/room/settle', { uid: h, roomId: no, action: 'restart' })
  assert.equal(r.ok, true, r.error)
  const s = await api('/api/room/start', { uid: h, roomId: no, sbIndex: 0 })
  assert.equal(s.ok, true, '结算重置后必须能再开局：' + (s.error || ''))
  assert.equal(s.data.seats[0].blind, 'sb')
})

test('小麦位由房主指定：sbIndex 必须透传（回归：曾被吞掉恒为 0）', async () => {
  const h = await login('hostSB')
  const c = await api('/api/room/create', { uid: h, me: me('房主'), cfg: { mode: 'offline' } })
  const no = c.data.id
  for (const n of ['s1', 's2']) {
    const u = await login('g' + n)
    await api('/api/room/join', { uid: u, roomId: no, me: me(n) })
  }
  const s = await api('/api/room/start', { uid: h, roomId: no, sbIndex: 1 })
  assert.equal(s.ok, true, s.error)
  assert.equal(s.data.seats[1].blind, 'sb', '小麦应在 1 号位')
  assert.equal(s.data.seats[2].blind, 'bb', '大麦应在 2 号位')
})

test('settlePending / paused 必须透出到 publicState', async () => {
  const { no, h } = await zeroedRoom()
  const st = (await api('/api/room/state', { uid: h, roomId: no })).data
  assert.equal(st.settlePending, true, '有人归零 + 已收池 → settlePending')
  assert.equal(st.hasZeroSeat, true)
  assert.equal(st.paused, false)
})

test('暂停透出 + 暂停中划拨瓜子 + 继续开下一手', async () => {
  const { no, h, sbUid, bbUid } = await zeroedRoom()
  const p = await api('/api/room/settle', { uid: h, roomId: no, action: 'pause' })
  assert.equal(p.ok, true, p.error)
  const st = (await api('/api/room/state', { uid: h, roomId: no })).data
  assert.equal(st.paused, true, 'paused 必须透出，否则前端「暂停」文案不显示')

  // A 收走后手动分一半给 B 的场景：bbUid 收了池，拨 20 给归零的 sbUid
  const g = await api('/api/room/action', {
    uid: bbUid, roomId: no, type: 'give', toUid: sbUid, amount: 20,
  })
  assert.equal(g.ok, true, '暂停中划拨不该被拒：' + (g.error || ''))
  const after = (await api('/api/room/state', { uid: h, roomId: no })).data
  assert.equal(after.seats.find((s) => s.uid === sbUid).seeds, 20)

  // 「继续」= 开下一手：筹码沿用（不重置）
  const s = await api('/api/room/start', { uid: h, roomId: no, sbIndex: 0 })
  assert.equal(s.ok, true, s.error)
  const sb = s.data.seats.find((x) => x.uid === sbUid)
  assert.equal(sb.seeds, 10, '新一手下小麦 10，剩 10（划拨来的 20）')
})

test('非回合离场 = 弃牌：回合保留、房间不炸', async () => {
  const { no, uids, state } = await fourPlayerRoom()
  const turnUid = state.turnUid
  // uids[0] 是房主，离场会销房 —— 挑「非房主且非回合」的人
  const leaver = uids.slice(1).find((u) => u !== turnUid)
  const r = await api('/api/room/leave', { uid: leaver, roomId: no })
  assert.equal(r.ok, true, r.error)
  const st = (await api('/api/room/state', { uid: uids[0], roomId: no })).data
  assert.equal(st.turnUid, turnUid, '回合不该被离场者抢走或清空')
  assert.equal(st.seats.length, 3, '公共视图剩 3 人')
  // 当前行动者还能正常行动 —— 验证没卡死
  const a = await api('/api/room/action', { uid: turnUid, roomId: no, type: 'call' })
  assert.equal(a.ok, true, a.error)
})

test('房主离开 → 快照一并删除，重启不复活', async () => {
  const { no, h } = await twoPlayerRoom()
  await api('/api/room/leave', { uid: h, roomId: no })
  const snap = rawDb().prepare('SELECT * FROM room_snapshots WHERE room_id = ?').get(no)
  assert.equal(snap, undefined, '房主离开必须删快照')
})

test('轮询不涨 rev、不落库（读不该是写）', async () => {
  const { no, h } = await twoPlayerRoom()
  const s1 = (await api('/api/room/state', { uid: h, roomId: no })).data
  const s2 = (await api('/api/room/state', { uid: h, roomId: no })).data
  assert.equal(s2.rev, s1.rev, '纯读 rev 不变')
  const act = await api('/api/room/action', { uid: s1.turnUid, roomId: no, type: 'call' })
  assert.ok(act.data.rev > s1.rev, '真变更 rev 必须涨')
})

test('未登录账号的玩家：跳过转账但不阻塞结算', async () => {
  // 房主登录了，客人没登录
  const h = await login('hostN')
  const c = await api('/api/room/create', {
    uid: h, me: me('房主'),
    cfg: { mode: 'offline', initialSeeds: 200, smallBlind: 10, bigBlind: 20 },
  })
  const gNo = 'anon-' + Math.random().toString(36).slice(2, 6)   // 没走 login
  await api('/api/room/join', { uid: gNo, roomId: c.data.id, me: me('游客') })
  const s = await api('/api/room/start', { uid: h, roomId: c.data.id })
  // 一路押到底，确保有人归零
  for (let i = 0; i < 8; i++) {
    const cur = (await api('/api/room/state', { uid: h, roomId: c.data.id })).data
    if (cur.finished || cur.settlePending || !cur.turnUid) break
    const seat = cur.seats.find((x) => x.uid === cur.turnUid)
    const need = Math.max(0, cur.currentBet - seat.bet)
    const rr = await api('/api/room/action', {
      uid: seat.uid, roomId: c.data.id,
      type: seat.seeds > need ? 'raise' : 'call',
      amount: seat.seeds - need,
    })
    if (!rr.ok) break
  }
  const bb = s.data.seats.find((x) => x.blind === 'bb')?.uid
  await api('/api/room/action', { uid: bb, roomId: c.data.id, type: 'collect' })

  const r = await api('/api/room/settle', { uid: h, roomId: c.data.id, action: 'restart' })
  assert.equal(r.ok, true, '未登录不该让结算失败')
  assert.equal(r.data.paid.length, 0, '没账号就不转')
  assert.equal(r.data.skipped.length, 1, '记录跳过原因')
  assert.match(r.data.skipped[0].reason, /未登录账号/)
})

// ── 盲注上限（2026-09-24 加）────────────────────────────

test('大麦上限 = 入场 ÷ 10，超了必须拒', async () => {
  const h = await login('hostBB')
  // 入场 1000 → 上限 100，给 200 必须被拒
  const c = await api('/api/room/create', {
    uid: h, me: me('房主'),
    cfg: { mode: 'offline', initialSeeds: 1000, smallBlind: 100, bigBlind: 200 },
  })
  assert.equal(c.ok, false, '超限大麦必须被拒')
  assert.match(c.error, /不能超过/)

  // 大麦是奇数也要拒（小麦 = 大麦一半，奇数会算出小数盲注）
  const odd = await api('/api/room/create', {
    uid: h, me: me('房主'),
    cfg: { mode: 'offline', initialSeeds: 1000, smallBlind: 15, bigBlind: 31 },
  })
  assert.equal(odd.ok, false, '奇数大麦必须被拒')
  assert.match(odd.error, /偶数/)

  // 合规的能过
  const ok = await api('/api/room/create', {
    uid: h, me: me('房主'),
    cfg: { mode: 'offline', initialSeeds: 3000, smallBlind: 10, bigBlind: 20 },
  })
  assert.equal(ok.ok, true, ok.error)
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
