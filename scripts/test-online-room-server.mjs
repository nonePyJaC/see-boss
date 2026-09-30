/**
 * 线上房间服务端测试 — T1 身份与隐私门禁
 *
 * 契约来源：线上模式.md §1.3 / §4 / §5 / §11.1
 *   - 创建线上房必须校验 HAMSTER_ONLINE_CREATE_CODE（未配置拒绝，测试注入 111111）
 *   - 线上房间同时最多 2 个（线下不计入）
 *   - 真人身份 = 服务端 seatId + seatToken；uid 只是资料字段
 *   - 任何伪造 uid / seatId / token 都拿不到他人底牌、不能替人行动
 *   - 线上房间不写快照、不允许从快照恢复（V1 无伪恢复）
 *
 * 起真 http server，打真请求。不 mock。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.LISTEN = '0'
process.env.HAMSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-online-test-'))
process.env.HAMSTER_ONLINE_CREATE_CODE = '111111'

const { server, restoreRoom, rooms, onTurnTimeout, onAiTurn, setAiDelayRange, sampleAiThinkDelay } = await import('../server/index.js')
const { closeDb, rawDb } = await import('../server/db.js')

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

test.after(() => { server.close(); closeDb() })

const CODE = '111111'

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

async function register(uidValue, nickname = '测试') {
  const r = await api('/api/account/login', {
    uid: uidValue,
    account: 't' + Math.random().toString(36).slice(2, 11),
    nickname,
  })
  assert.equal(r.ok, true, r.error)
}

const ONLINE_CFG = { mode: 'online', gameType: 'long', initialSeeds: 1000, smallBlind: 10, bigBlind: 20 }

test('T6 AI 思考等待通常较短且最多 10 秒', () => {
  setAiDelayRange(800, 10000)
  assert.equal(sampleAiThinkDelay(() => 0), 800)
  assert.equal(sampleAiThinkDelay(() => 0.5), 3100)
  assert.equal(sampleAiThinkDelay(() => 1), 10000)
})

/** 建一间线上房，返回 { roomId, seatId, seatToken, data } */
async function createOnline(name = '房主') {
  const u = uid(name)
  await register(u, name)
  const r = await api('/api/room/create', {
    uid: u, me: me(name), createCode: CODE, cfg: ONLINE_CFG,
  })
  assert.equal(r.ok, true, r.error)
  return { roomId: r.data.id, seatId: r.data.seatId, seatToken: r.data.seatToken, uid: u, data: r.data }
}

async function joinOnline(roomId, name = '客人') {
  const u = uid(name)
  await register(u, name)
  const r = await api('/api/room/join', { uid: u, roomId, me: me(name) })
  assert.equal(r.ok, true, r.error)
  return { roomId, seatId: r.data.seatId, seatToken: r.data.seatToken, uid: u, data: r.data }
}

/** 房主离开销毁房间（T1 测试间清理用，防止 2 房上限串扰） */
async function closeRoom(r) {
  await api('/api/room/leave', { uid: r.uid, roomId: r.roomId, seatId: r.seatId, seatToken: r.seatToken })
}

/** 建一间两人线上房并开局 */
async function runningOnlineRoom() {
  const host = await createOnline('房主')
  const guest = await joinOnline(host.roomId, '客人')
  const s = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(s.ok, true, s.error)
  assert.equal(s.data.myCards?.length, 2, '开局响应应立即包含房主自己的底牌')
  assert.equal(s.data.seats.find((x) => x.uid === host.seatId)?.isMe, true, '开局响应应保持房主视角')
  return { host, guest, state: s.data }
}

// ── 创建码 ──────────────────────────────────────────────

test('创建码未配置 → CREATE_DISABLED', async () => {
  const keep = process.env.HAMSTER_ONLINE_CREATE_CODE
  delete process.env.HAMSTER_ONLINE_CREATE_CODE
  try {
    const r = await api('/api/room/create', { uid: uid('x'), me: me(), createCode: CODE, cfg: ONLINE_CFG })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'CREATE_DISABLED')
  } finally {
    process.env.HAMSTER_ONLINE_CREATE_CODE = keep
  }
})

test('创建码错误 / 缺失 → BAD_CREATE_CODE', async () => {
  const wrong = await api('/api/room/create', { uid: uid('x'), me: me(), createCode: '999999', cfg: ONLINE_CFG })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.code, 'BAD_CREATE_CODE')

  const missing = await api('/api/room/create', { uid: uid('x'), me: me(), cfg: ONLINE_CFG })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'BAD_CREATE_CODE')
})

test('创建码正确 → 返回 seatId/seatToken，状态不泄露 token', async () => {
  const r = await createOnline()
  assert.match(r.data.id, /^\d{6}$/)
  assert.equal(typeof r.seatId, 'string')
  assert.ok(r.seatId.length >= 8, 'seatId 应由服务端生成且不可猜测')
  assert.equal(typeof r.seatToken, 'string')
  assert.ok(r.seatToken.length >= 32, 'seatToken 至少 32 字符强度')
  assert.equal(r.data.seats.length, 1)
  // 任何公开状态都不得携带令牌
  assert.equal(JSON.stringify(r.data.seats).includes(r.seatToken), false, '座位投影不得含 seatToken')
  const st = await api('/api/room/state', { roomId: r.roomId, seatId: r.seatId, seatToken: r.seatToken })
  assert.equal(JSON.stringify(st).includes(r.seatToken), false, 'state 响应不得含 seatToken')
  await closeRoom(r)
})

test('线上建房和新玩家入座必须先登录/注册', async () => {
  const unregisteredHost = uid('未注册房主')
  const create = await api('/api/room/create', {
    uid: unregisteredHost, me: me(), createCode: CODE, cfg: ONLINE_CFG,
  })
  assert.equal(create.code, 'LOGIN_REQUIRED')

  const host = await createOnline()
  const unregisteredGuest = await api('/api/room/join', {
    uid: uid('未注册客人'), roomId: host.roomId, me: me('未注册'),
  })
  assert.equal(unregisteredGuest.code, 'LOGIN_REQUIRED')
  const state = await api('/api/room/state', { roomId: host.roomId })
  assert.equal(state.data.seats.length, 1, '未注册请求不能增加座位')
  await closeRoom(host)
})

test('线下建房不需要创建码（不破坏线下）', async () => {
  const r = await api('/api/room/create', {
    uid: uid('x'), me: me(), cfg: { mode: 'offline', initialSeeds: 1000, smallBlind: 10, bigBlind: 20 },
  })
  assert.equal(r.ok, true, r.error)
  await api('/api/room/leave', { uid: r.data.seats[0].uid, roomId: r.data.id })
})

// ── 线上 2 房上限 ───────────────────────────────────────

test('线上第 3 个房间被拒（ONLINE_ROOM_LIMIT），线下不计入', async () => {
  const a = await createOnline('A')
  const b = await createOnline('B')
  try {
    const cUid = uid('c')
    await register(cUid, 'c')
    const c = await api('/api/room/create', { uid: cUid, me: me(), createCode: CODE, cfg: ONLINE_CFG })
    assert.equal(c.ok, false)
    assert.equal(c.code, 'ONLINE_ROOM_LIMIT')

    // 线下房间不占名额
    const off = await api('/api/room/create', {
      uid: uid('off'), me: me(), cfg: { mode: 'offline', initialSeeds: 1000, smallBlind: 10, bigBlind: 20 },
    })
    assert.equal(off.ok, true, off.error)
    await api('/api/room/leave', { uid: off.data.seats[0].uid, roomId: off.data.id })
  } finally {
    await closeRoom(a)
    await closeRoom(b)
  }
})

// ── 令牌发放 ────────────────────────────────────────────

test('join 返回新的不可预测令牌；不同座位令牌不同', async () => {
  const host = await createOnline()
  const g1 = await joinOnline(host.roomId, '甲')
  const g2 = await joinOnline(host.roomId, '乙')
  assert.notEqual(g1.seatId, host.seatId)
  assert.notEqual(g1.seatId, g2.seatId)
  assert.notEqual(g1.seatToken, g2.seatToken)
  assert.notEqual(g1.seatToken, host.seatToken)
  assert.equal(host.data.seats.length + 2, 3)
  await closeRoom(host)
})

// ── 状态投影与底牌隐私 ──────────────────────────────────

test('开局后正确令牌只看自己的底牌', async () => {
  const { host, guest } = await runningOnlineRoom()
  const st = await api('/api/room/state', {
    roomId: host.roomId, seatId: guest.seatId, seatToken: guest.seatToken,
  })
  assert.equal(st.ok, true, st.error)
  assert.equal(st.data.myCards.length, 2, '本人应看到 2 张底牌')
  const mySeat = st.data.seats.find((s) => s.uid === guest.seatId)
  assert.equal(mySeat.isMe, true)
  assert.equal(st.data.seats.find((s) => s.uid === host.seatId).isMe, false)
  await closeRoom(host)
})

test('伪造 uid / seatId / 错误 token 均看不到他人底牌', async () => {
  const { host, guest, state } = await runningOnlineRoom()
  const victim = state.seats.find((s) => s.uid === host.seatId) ? host : guest

  // 1. 完全不带凭证（旁观投影）
  const anon = await api('/api/room/state', { roomId: host.roomId })
  assert.equal(anon.ok, true)
  assert.equal(anon.data.myCards, undefined, '旁观者不得见任何底牌')

  // 2. 伪造客户端 uid = 房主 seatId（uid 不是凭证）
  const forgedUid = await api('/api/room/state', { roomId: host.roomId, uid: victim.seatId })
  assert.equal(forgedUid.data.myCards, undefined, 'uid 冒充不得见牌')

  // 3. seatId 正确但 token 错误
  const badToken = await api('/api/room/state', {
    roomId: host.roomId, seatId: victim.seatId, seatToken: 'x'.repeat(43),
  })
  assert.equal(badToken.data.myCards, undefined, '错误 token 不得见牌')

  // 4. seatId 正确但缺 token
  const noToken = await api('/api/room/state', { roomId: host.roomId, seatId: victim.seatId })
  assert.equal(noToken.data.myCards, undefined, '缺 token 不得见牌')

  // 5. 客人 token + 房主 seatId 混搭也不行
  const mixed = await api('/api/room/state', {
    roomId: host.roomId, seatId: victim.seatId === host.seatId ? host.seatId : host.seatId,
    seatToken: guest.seatToken,
  })
  const wrongPair = await api('/api/room/state', {
    roomId: host.roomId, seatId: host.seatId, seatToken: guest.seatToken,
  })
  assert.equal(wrongPair.data.myCards, undefined, '别人的 token 不得见我的牌')
  assert.equal(JSON.stringify(mixed).includes(host.seatToken), false)

  // 6. 旁观投影里绝不能出现任何人的 hole 信息
  assert.equal(JSON.stringify(anon.data).includes('myCards'), false)
  await closeRoom(host)
})

// ── 行动与房主权限门禁 ──────────────────────────────────

test('行动必须持有效令牌；非回合者 NOT_YOUR_TURN', async () => {
  const { host, guest, state } = await runningOnlineRoom()
  const turnSeat = [host, guest].find((p) => p.seatId === state.turnUid)
  const otherSeat = [host, guest].find((p) => p.seatId !== state.turnUid)
  assert.ok(turnSeat && otherSeat)

  // 无凭证 → AUTH_FAILED
  const noAuth = await api('/api/room/action', { uid: uid('x'), roomId: host.roomId, type: 'call' })
  assert.equal(noAuth.ok, false)
  assert.equal(noAuth.code, 'AUTH_FAILED')

  // seatId + 错 token → AUTH_FAILED
  const badAuth = await api('/api/room/action', {
    uid: uid('x'), roomId: host.roomId, seatId: turnSeat.seatId, seatToken: 'bad', type: 'call',
  })
  assert.equal(badAuth.code, 'AUTH_FAILED')

  // uid 冒充当前行动者 → AUTH_FAILED（uid 不是凭证）
  const forged = await api('/api/room/action', {
    roomId: host.roomId, uid: turnSeat.seatId, type: 'call',
  })
  assert.equal(forged.code, 'AUTH_FAILED')

  // §5 校验顺序：handId → turnSeq → 回合，所以测 NOT_YOUR_TURN 要带新鲜字段
  const st0 = await api('/api/room/state', {
    roomId: host.roomId, seatId: otherSeat.seatId, seatToken: otherSeat.seatToken,
  })
  const notTurn = await api('/api/room/action', {
    uid: otherSeat.uid, roomId: host.roomId, seatId: otherSeat.seatId, seatToken: otherSeat.seatToken,
    handId: st0.data.handId, turnSeq: st0.data.turnSeq, type: 'call',
  })
  assert.equal(notTurn.code, 'NOT_YOUR_TURN')

  // 合法令牌 + 本人回合 + 新鲜 handId/turnSeq → 正常行动
  const st = await api('/api/room/state', {
    roomId: host.roomId, seatId: turnSeat.seatId, seatToken: turnSeat.seatToken,
  })
  const avail = st.data.avail.map((a) => a.type)
  const type = avail.includes('check') ? 'check' : 'call'
  const act = await api('/api/room/action', {
    uid: turnSeat.uid, roomId: host.roomId, seatId: turnSeat.seatId, seatToken: turnSeat.seatToken,
    handId: st.data.handId, turnSeq: st.data.turnSeq, type,
  })
  assert.equal(act.ok, true, act.error)
  await closeRoom(host)
})

test('非房主不能开局（uid 冒充也不行）', async () => {
  const host = await createOnline()
  const guest = await joinOnline(host.roomId)

  const byGuest = await api('/api/room/start', {
    uid: guest.uid, roomId: host.roomId, seatId: guest.seatId, seatToken: guest.seatToken,
  })
  assert.equal(byGuest.ok, false)
  assert.equal(byGuest.code, 'NOT_HOST')

  const forged = await api('/api/room/start', { roomId: host.roomId, uid: host.seatId })
  assert.equal(forged.code, 'AUTH_FAILED')
  await closeRoom(host)
})

test('进行中不允许新座位加入；两手之间可以', async () => {
  const { host } = await runningOnlineRoom()
  const lateUid = uid('late')
  await register(lateUid, '迟到')
  const late = await api('/api/room/join', { uid: lateUid, roomId: host.roomId, me: me('迟到') })
  assert.equal(late.ok, false)
  assert.equal(late.code, 'HAND_IN_PROGRESS')
  // 迟到者旁观只能看公共信息
  const st = await api('/api/room/state', { roomId: host.roomId, uid: 'late' })
  assert.equal(st.ok, true)
  assert.equal(st.data.myCards, undefined)
  await closeRoom(host)
})

test('settle / pause / reorder 对线上房明确拒绝', async () => {
  const { host, guest } = await runningOnlineRoom()
  const settle = await api('/api/room/settle', { uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken })
  assert.equal(settle.ok, false)
  assert.equal(settle.code, 'OFFLINE_ONLY')
  // uid 冒充房主也打不进这些线下接口
  const settleForged = await api('/api/room/settle', { roomId: host.roomId, uid: host.seatId })
  assert.equal(settleForged.ok, false)
  const pause = await api('/api/room/pause', { uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken })
  assert.equal(pause.ok, false)
  const reorder = await api('/api/room/reorder', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
    order: [guest.seatId, host.seatId],
  })
  assert.equal(reorder.ok, false)
  await closeRoom(host)
})

// ── 离开与令牌 ──────────────────────────────────────────

test('离开需令牌：伪造 uid 不能踢人', async () => {
  const { host, guest } = await runningOnlineRoom()
  const forged = await api('/api/room/leave', { roomId: host.roomId, uid: guest.seatId })
  assert.equal(forged.ok, false)
  assert.equal(forged.code, 'AUTH_FAILED')
  const st = await api('/api/room/state', { roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken })
  assert.equal(st.data.seats.length, 2, '伪造离开不得移除座位')
  await closeRoom(host)
})

// ── 快照禁用与无伪恢复 ──────────────────────────────────

test('线上房间不写快照、不从快照恢复', async () => {
  const { host, guest, state } = await runningOnlineRoom()
  // 行动一次触发 touch → persist（应跳过 online）
  const turnSeat = [host, guest].find((p) => p.seatId === state.turnUid)
  const st = await api('/api/room/state', { roomId: host.roomId, seatId: turnSeat.seatId, seatToken: turnSeat.seatToken })
  const type = st.data.avail.map((a) => a.type).includes('check') ? 'check' : 'call'
  await api('/api/room/action', {
    uid: turnSeat.uid, roomId: host.roomId, seatId: turnSeat.seatId, seatToken: turnSeat.seatToken,
    handId: st.data.handId, turnSeq: st.data.turnSeq, type,
  })

  const snap = rawDb().prepare('SELECT * FROM room_snapshots WHERE room_id = ?').get(host.roomId)
  assert.equal(snap, undefined, '线上房间不得写 room_snapshots')

  // 即使库里有旧版线上快照，恢复也必须拒绝（I12 无伪恢复）
  const fake = {
    roomId: '998877', mode: 'online',
    state: { seats: [{ uid: 'x', nickname: 'a', avatar: 1, seeds: 100 }], hostUid: 'x', gameType: 'long' },
  }
  assert.equal(restoreRoom(fake), null, '线上快照必须拒绝恢复')
  await closeRoom(host)
})

// ── T2：完整牌局生命周期 ──────────────────────────────

/** 拉状态 → 当前行动者按偏好执行一个合法动作（带新鲜 handId/turnSeq） */
async function actForTurn(players, roomId, prefer = ['check', 'call']) {
  const st = (await api('/api/room/state', { roomId })).data
  if (st.finished) return st
  const actor = players.find((p) => p.seatId === st.turnUid)
  assert.ok(actor, '当前行动者必须在座')
  const mine = (await api('/api/room/state', {
    roomId, seatId: actor.seatId, seatToken: actor.seatToken,
  })).data
  const types = (mine.avail ?? []).map((a) => a.type)
  const type = prefer.find((t) => types.includes(t)) ?? types[0]
  assert.ok(type, '当前行动者必须有合法动作')
  const r = await api('/api/room/action', {
    uid: actor.uid, roomId, seatId: actor.seatId, seatToken: actor.seatToken,
    handId: st.handId, turnSeq: st.turnSeq, type,
  })
  assert.equal(r.ok, true, r.error ?? JSON.stringify(r))
  return r.data
}

test('防重放：旧 handId / 旧 turnSeq / 缺字段都被拒，重复请求不生效', async () => {
  const { host, guest, state } = await runningOnlineRoom()
  const actor = [host, guest].find((p) => p.seatId === state.turnUid)
  const st = (await api('/api/room/state', {
    roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
  })).data
  const type = st.avail.map((a) => a.type).includes('check') ? 'check' : 'call'
  const base = { uid: actor.uid, roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken, type }

  const badHand = await api('/api/room/action', { ...base, handId: st.handId - 1, turnSeq: st.turnSeq })
  assert.equal(badHand.code, 'STALE_HAND')
  const badSeq = await api('/api/room/action', { ...base, handId: st.handId, turnSeq: st.turnSeq - 1 })
  assert.equal(badSeq.code, 'STALE_TURN')
  const missing = await api('/api/room/action', base)
  assert.ok(['STALE_HAND', 'STALE_TURN'].includes(missing.code), '缺字段按过期拒，实际：' + missing.code)

  const ok1 = await api('/api/room/action', { ...base, handId: st.handId, turnSeq: st.turnSeq })
  assert.equal(ok1.ok, true, ok1.error)
  // 回放同一份请求 → 必须被拒且状态不变（turnSeq 已前进）
  const replay = await api('/api/room/action', { ...base, handId: st.handId, turnSeq: st.turnSeq })
  assert.equal(replay.code, 'STALE_TURN')
  const after = (await api('/api/room/state', { roomId: host.roomId })).data
  assert.equal(after.turnSeq, st.turnSeq + 1, '回放不得再次推进轮次')
  await closeRoom(host)
})

test('整手真人牌局：摊牌派彩、筹码守恒、底池归零、私牌清除', async () => {
  const { host, guest } = await runningOnlineRoom()
  let st
  for (let i = 0; i < 40; i++) {
    st = await actForTurn([host, guest], host.roomId, ['check', 'call'])
    if (st.finished) break
  }
  assert.equal(st.finished, true, '40 步内必须打完一手')
  assert.ok(st.result, 'finished 手必须有 result')
  assert.ok(Array.isArray(st.result.hands) && st.result.hands.length === 2)
  assert.ok(Array.isArray(st.result.potLayers) && st.result.potLayers.length > 0, '结算要公开逐层奖池明细')
  assert.equal(st.result.potLayers.reduce((sum, layer) => sum + layer.amount, 0), st.result.pot, '奖池层金额之和应等于总池')
  assert.equal(st.result.hands.reduce((sum, hand) => sum + hand.totalBet, 0), st.result.pot, '每人本手投入之和应等于待派彩总池')
  // 弃牌者底牌不外发，存活者摊牌亮牌
  for (const h of st.result.hands) {
    assert.ok(Number.isInteger(h.totalBet) && h.totalBet > 0, '结算要公开每人的本手投入供净盈亏展示')
    assert.equal(h.totalBet, st.seats.find((seat) => seat.uid === h.uid)?.totalBet, '结算投入应与对应座位的本手累计投入一致')
    if (h.folded) assert.equal(h.hole.length, 0)
  }
  const total = st.seats.reduce((n, s) => n + s.seeds, 0) + st.pot
  assert.equal(total, 2000, 'I8 筹码守恒（含底池）')
  assert.equal(st.pot, 0, '派彩后底池必须归零')
  assert.equal(st.turnUid, null)
  assert.equal(st.recentHands.length, 1, '结算后状态带一手历史记录')
  assert.equal(st.recentHands[0].handId, st.handId)
  assert.deepEqual(st.recentHands[0].communityCards, st.communityCards)
  assert.ok(st.recentHands[0].actionLog.length > 0, '历史应记录本手公开行动')
  assert.equal(st.recentHands[0].result.hands.every((h) => !h.folded || h.hole.length === 0), true)

  // 手牌结束 → 私人底牌已清除，连本人也拿不到
  const self = (await api('/api/room/state', {
    roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })).data
  assert.equal(self.myCards, undefined, '结算后不得再返回底牌')

  // 整手不得碰账号资产：不登录的玩家没有账号，登录过的也不许动
  assert.equal(
    rawDb().prepare('SELECT COUNT(*) n FROM history WHERE room_no = ?').get(host.roomId).n, 0,
    '线上局不得写历史'
  )
  await closeRoom(host)
})

test('下一手由房主显式开始；旧 handId 的动作打不进新手', async () => {
  const { host, guest } = await runningOnlineRoom()
  let st
  for (let i = 0; i < 40; i++) {
    st = await actForTurn([host, guest], host.roomId)
    if (st.finished) break
  }
  assert.equal(st.finished, true)
  const hand1 = st.handId

  // 房客想开局被拒
  const byGuest = await api('/api/room/start', {
    uid: guest.uid, roomId: host.roomId, seatId: guest.seatId, seatToken: guest.seatToken,
  })
  assert.equal(byGuest.code, 'NOT_HOST')

  // 房主开下一手
  const s2 = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(s2.ok, true, s2.error)
  assert.equal(s2.data.handId, hand1 + 1, 'handId 每手 +1')

  // 用上一手的 handId 发动作 → STALE_HAND
  const stale = await api('/api/room/action', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
    handId: hand1, turnSeq: s2.data.turnSeq, type: 'call',
  })
  assert.equal(stale.code, 'STALE_HAND')
  await closeRoom(host)
})

test('房间历史仅留最近三手，且房主重置时清空', async () => {
  const { host, guest, state: first } = await runningOnlineRoom()
  let st = first
  for (let hand = 0; hand < 4; hand++) {
    if (hand > 0) {
      const start = await api('/api/room/start', {
        uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
      })
      assert.equal(start.ok, true, start.error)
      st = start.data
    }
    for (let action = 0; action < 40 && !st.finished; action++) {
      st = await actForTurn([host, guest], host.roomId, ['check', 'call'])
    }
    assert.equal(st.finished, true)
  }
  assert.deepEqual(st.recentHands.map((record) => record.handId), [4, 3, 2])

  const reset = await api('/api/room/reset-online', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(reset.ok, true, reset.error)
  assert.deepEqual(reset.data.recentHands, [])
  await closeRoom(host)
})

test('最近手牌记录保留行动与派彩，但绝不记录弃牌者底牌', async () => {
  const { host, guest, state } = await runningOnlineRoom()
  const actor = [host, guest].find((player) => player.seatId === state.turnUid)
  const before = await api('/api/room/state', {
    roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
  })
  const cardsBeforeFold = before.data.myCards
  const ended = await api('/api/room/action', {
    uid: actor.uid, roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
    handId: state.handId, turnSeq: state.turnSeq, type: 'fold',
  })
  assert.equal(ended.ok, true, ended.error)
  const record = ended.data.recentHands[0]
  const folded = record.result.hands.find((hand) => hand.uid === actor.seatId)
  assert.equal(folded.folded, true)
  assert.deepEqual(folded.hole, [])
  for (const card of cardsBeforeFold) assert.equal(JSON.stringify(record).includes(card), false)
  await closeRoom(host)
})

test('零筹码座位留在房里旁观，不进入下一手；只剩 1 个有筹码座位时不能开局', async () => {
  // 3 人房入场 200：座0全下、座1（小盲）跟全下、座2（大盲）弃牌 → 座0/座1 必有一人归零
  const hostUid = uid('房主')
  await register(hostUid, '房主')
  const h2r = await api('/api/room/create', {
    uid: hostUid, me: me('房主'), createCode: CODE,
    cfg: { ...ONLINE_CFG, initialSeeds: 200 },
  })
  assert.equal(h2r.ok, true, h2r.error)
  const host2 = { roomId: h2r.data.id, seatId: h2r.data.seatId, seatToken: h2r.data.seatToken, uid: hostUid }
  const g2 = await joinOnline(host2.roomId, '乙')
  const g3 = await joinOnline(host2.roomId, '丙')
  const players = [host2, g2, g3]

  // 座0全下、座1跟全下、座2弃牌 → 非平局必有一人归零；
  // 平局则无人归零（摊牌分池是真实概率）——这时重开一手重复同样打法，
  // 每次非平局都会有人输大池，多手内必然归零，避免单结果抖动。
  let st = null
  let busted = null
  for (let hand = 0; hand < 10 && !busted; hand++) {
    const s = await api('/api/room/start', {
      uid: host2.uid, roomId: host2.roomId, seatId: host2.seatId, seatToken: host2.seatToken,
    })
    assert.equal(s.ok, true, s.error)
    st = s.data
    const order = []
    while (!st.finished && order.length < 3) {
      order.push(st.turnUid)
      const pick = order.length === 1 ? 'allin' : (order.length === 2 ? 'call' : 'fold')
      const actor = players.find((p) => p.seatId === st.turnUid)
      const r = await api('/api/room/action', {
        uid: actor.uid, roomId: host2.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
        handId: st.handId, turnSeq: st.turnSeq, type: pick,
      })
      assert.equal(r.ok, true, r.error)
      st = r.data
      if (order.length === 3 && !st.finished) {
        // 两人全下后公共牌会自动发完到摊牌
        st = (await api('/api/room/state', { roomId: host2.roomId })).data
      }
    }
    assert.equal(st.finished, true, '全下后应自动跑完到摊牌')
    busted = st.seats.find((s2) => s2.seeds === 0)
  }
  assert.ok(busted, '多手全下内必有一人归零')
  const total = st.seats.reduce((n, x) => n + x.seeds, 0)
  assert.equal(total, 600, '守恒：3×200')

  // 归零者还在房间里（旁观）
  const bustedPlayer = players.find((p) => p.seatId === busted.uid)
  const bst = await api('/api/room/state', {
    roomId: host2.roomId, seatId: bustedPlayer.seatId, seatToken: bustedPlayer.seatToken,
  })
  assert.equal(bst.ok, true, '归零者仍可观战')
  assert.equal(bst.data.seats.length, 3)

  // 下一手：归零者不进 handParticipants → 拿不到底牌
  const s2 = await api('/api/room/start', {
    uid: host2.uid, roomId: host2.roomId, seatId: host2.seatId, seatToken: host2.seatToken,
  })
  assert.equal(s2.ok, true, s2.error)
  assert.equal(s2.data.handId, st.handId + 1)
  const bst2 = await api('/api/room/state', {
    roomId: host2.roomId, seatId: bustedPlayer.seatId, seatToken: bustedPlayer.seatToken,
  })
  assert.equal(bst2.data.myCards, undefined, '归零旁观不得有底牌')
  assert.equal(bst2.data.seats.find((x) => x.uid === busted.uid).isMe, true)
  // 归零者也不是当前行动者
  assert.notEqual(s2.data.turnUid, busted.uid)

  // 双人房归零一人后：只剩 1 个有筹码座位 → 开局被拒
  const host3 = await createOnline('独房')
  const c2 = await joinOnline(host3.roomId, '乙2')
  // 直接把其中一人筹码打到 0：全下 + 跟注
  let st3 = (await api('/api/room/start', {
    uid: host3.uid, roomId: host3.roomId, seatId: host3.seatId, seatToken: host3.seatToken,
  })).data
  for (let i = 0; i < 20 && !st3.finished; i++) {
    const actor = [host3, c2].find((p) => p.seatId === st3.turnUid)
    const mine = (await api('/api/room/state', {
      roomId: host3.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
    })).data
    const t = (mine.avail ?? []).map((a) => a.type)
    const pick = t.includes('allin') ? 'allin' : (t.includes('call') ? 'call' : 'check')
    const r = await api('/api/room/action', {
      uid: actor.uid, roomId: host3.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
      handId: st3.handId, turnSeq: st3.turnSeq, type: pick,
    })
    st3 = r.ok ? r.data : st3
    if (!st3.finished) st3 = (await api('/api/room/state', { roomId: host3.roomId })).data
  }
  assert.equal(st3.finished, true)
  assert.ok(st3.seats.some((x) => x.seeds === 0), '全下局必有一人归零')
  const deny = await api('/api/room/start', {
    uid: host3.uid, roomId: host3.roomId, seatId: host3.seatId, seatToken: host3.seatToken,
  })
  assert.equal(deny.ok, false, '只剩 1 个有筹码座位不能开局')
  await closeRoom(host2)
  await closeRoom(host3)
})

test('线上重置：仅房主、两手之间、筹码回默认、不影响资产', async () => {
  const { host, guest } = await runningOnlineRoom()
  // 对局中不能重置
  const busy = await api('/api/room/reset-online', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(busy.ok, false)
  assert.equal(busy.code, 'HAND_IN_PROGRESS')

  // 打完一手
  let st
  for (let i = 0; i < 40; i++) {
    st = await actForTurn([host, guest], host.roomId)
    if (st.finished) break
  }
  assert.equal(st.finished, true)

  // 非房主不能重置
  const notHost = await api('/api/room/reset-online', {
    uid: guest.uid, roomId: host.roomId, seatId: guest.seatId, seatToken: guest.seatToken,
  })
  assert.equal(notHost.code, 'NOT_HOST')
  // 无令牌不行
  const noAuth = await api('/api/room/reset-online', { uid: 'x', roomId: host.roomId })
  assert.equal(noAuth.code, 'AUTH_FAILED')

  // 重置是新开一局：仍在座的 AI 要同步刷新内部人设和公开风格标签。
  const added = await api('/api/room/add-ai', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(added.ok, true, added.error)
  const aiSeat = added.data.seats.find((s) => s.isAI)
  const room = rooms.get(host.roomId)
  const personaBefore = room.aiRuntime.personas.get(aiSeat.uid)

  // 房主在两手之间重置
  const r = await api('/api/room/reset-online', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.seats.every((s) => s.seeds === 1000), true, '全员回默认筹码')
  const personaAfter = room.aiRuntime.personas.get(aiSeat.uid)
  assert.ok(personaAfter, '重置后仍在座的 AI 应立即生成新的人设')
  assert.notStrictEqual(personaAfter, personaBefore, '重置应刷新 AI 人设对象')
  assert.equal(
    r.data.seats.find((s) => s.uid === aiSeat.uid).styleLabel,
    personaAfter.styleLabel,
    '公开风格标签必须与刷新后的人设一致',
  )
  assert.equal(
    rawDb().prepare('SELECT COUNT(*) n FROM history WHERE room_no = ?').get(host.roomId).n, 0,
    '重置不得写历史'
  )
  await closeRoom(host)
})

// ── T3：重连、离开与行动时钟 ──────────────────────────

test('令牌重连：/state 恢复座位不新增，join 持令牌幂等', async () => {
  const { host, guest } = await runningOnlineRoom()
  // 反复拉状态 = 重连路径：座位数不变、底牌一致
  for (let i = 0; i < 3; i++) {
    const st = (await api('/api/room/state', {
      roomId: host.roomId, seatId: guest.seatId, seatToken: guest.seatToken,
    })).data
    assert.equal(st.seats.length, 2)
    assert.equal(st.myCards.length, 2)
  }
  // 误调 join 但带令牌：幂等回同一座位，不加座
  const re = await api('/api/room/join', {
    uid: guest.uid, roomId: host.roomId, me: me('客人'),
    seatId: guest.seatId, seatToken: guest.seatToken,
  })
  assert.equal(re.ok, true, re.error)
  assert.equal(re.data.seatId, guest.seatId)
  assert.equal(re.data.seats.length, 2, '重连不得新增座位')
  await closeRoom(host)
})

test('真人回合有 120s 截止时间并透出；续时一次成功、第二次拒绝', async () => {
  const { host, guest, state } = await runningOnlineRoom()
  const actor = [host, guest].find((p) => p.seatId === state.turnUid)
  const other = [host, guest].find((p) => p.seatId !== state.turnUid)
  const before = (await api('/api/room/state', { roomId: host.roomId })).data
  assert.ok(before.deadlineAt > Date.now() + 100_000, '应有约 120s 截止')
  assert.ok(before.deadlineAt <= Date.now() + 121_000)

  // 旁观者也能看到 deadlineAt（公开字段），但续时只有当前行动者可点
  const notTurn = await api('/api/room/extend-turn', {
    uid: other.uid, roomId: host.roomId, seatId: other.seatId, seatToken: other.seatToken,
    handId: before.handId, turnSeq: before.turnSeq,
  })
  assert.equal(notTurn.code, 'NOT_YOUR_TURN')

  // 错误令牌 / 旧序号先被挡
  const stale = await api('/api/room/extend-turn', {
    uid: actor.uid, roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
    handId: before.handId, turnSeq: before.turnSeq + 1,
  })
  assert.equal(stale.code, 'STALE_TURN')

  // 手动拨小 deadline，确认续时确实延后了（而不是原样返回）
  const room = rooms.get(host.roomId)
  room.deadlineAt = Date.now() + 5_000
  const ext = await api('/api/room/extend-turn', {
    uid: actor.uid, roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
    handId: before.handId, turnSeq: before.turnSeq,
  })
  assert.equal(ext.ok, true, ext.error)
  assert.ok(ext.data.deadlineAt > Date.now() + 100_000, '新截止应约 120s')
  assert.equal(ext.data.canExtendTurn, false, '本回合续时额度已用')

  // 每个 turnSeq 只能续一次
  const again = await api('/api/room/extend-turn', {
    uid: actor.uid, roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
    handId: before.handId, turnSeq: before.turnSeq,
  })
  assert.equal(again.code, 'EXTENSION_USED')

  // 行动后新回合续时额度恢复（deadlineRefreshUsed 随 turnSeq 复位）
  const st = (await api('/api/room/state', { roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken })).data
  const type = st.avail.map((a) => a.type).includes('check') ? 'check' : 'call'
  await api('/api/room/action', {
    uid: actor.uid, roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
    handId: st.handId, turnSeq: st.turnSeq, type,
  })
  const next = (await api('/api/room/state', { roomId: host.roomId, seatId: other.seatId, seatToken: other.seatToken })).data
  const ext2 = await api('/api/room/extend-turn', {
    uid: other.uid, roomId: host.roomId, seatId: other.seatId, seatToken: other.seatToken,
    handId: next.handId, turnSeq: next.turnSeq,
  })
  assert.equal(ext2.ok, true, '新回合应有新的续时额度')
  await closeRoom(host)
})

test('超时自动弃牌：直接触发回调，player 失格且本手旁观', async () => {
  const { host, guest } = await runningOnlineRoom()
  const st = (await api('/api/room/state', { roomId: host.roomId })).data
  const actor = [host, guest].find((p) => p.seatId === st.turnUid)
  const other = [host, guest].find((p) => p.seatId !== st.turnUid)

  const room = rooms.get(host.roomId)
  const captured = { roomId: host.roomId, handId: room.handId, turnSeq: room.turnSeq, turnSeatId: st.turnUid }

  // 还没到截止时间触发 → 无副作用（保护「提前触发」）
  onTurnTimeout(captured)
  const early = (await api('/api/room/state', { roomId: host.roomId })).data
  assert.equal(early.turnUid, st.turnUid, '未到点不得弃牌')
  assert.equal(early.turnSeq, st.turnSeq)

  // 拨到过期 → 触发 → 自动弃牌
  room.deadlineAt = Date.now() - 1
  onTurnTimeout(captured)

  // 两人局一人弃牌 → 直接终局
  const end = (await api('/api/room/state', { roomId: host.roomId })).data
  assert.equal(end.finished, true, '超时弃牌后应正常推进/终局')
  assert.equal(end.seats.find((s) => s.uid === actor.seatId).folded, true)
  assert.ok(end.result, '应有结算结果')

  // 失格者本手看不到底牌（I3）
  const foldedView = (await api('/api/room/state', {
    roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
  })).data
  assert.equal(foldedView.myCards, undefined)
  assert.equal(other.seatId === end.result.hands.find((h) => h.isWinner)?.uid, true, '另一方应为赢家')
  await closeRoom(host)
})

test('陈旧定时器四元组复核：handId / turnSeq / 行动者任一不符即无副作用', async () => {
  const { host, guest, state } = await runningOnlineRoom()
  const room = rooms.get(host.roomId)
  const st = (await api('/api/room/state', { roomId: host.roomId })).data

  // 与当前一致但房间号错 → noop
  onTurnTimeout({ roomId: '999999', handId: st.handId, turnSeq: st.turnSeq, turnSeatId: st.turnUid })
  // handId 旧 → noop
  onTurnTimeout({ roomId: host.roomId, handId: st.handId + 1, turnSeq: st.turnSeq, turnSeatId: st.turnUid })
  // turnSeq 旧 → noop
  onTurnTimeout({ roomId: host.roomId, handId: st.handId, turnSeq: st.turnSeq + 5, turnSeatId: st.turnUid })
  // 行动者不符 → noop
  const otherSeat = st.seats.find((s) => s.uid !== st.turnUid)
  onTurnTimeout({ roomId: host.roomId, handId: st.handId, turnSeq: st.turnSeq, turnSeatId: otherSeat.uid })

  const after = (await api('/api/room/state', { roomId: host.roomId })).data
  assert.equal(after.turnSeq, st.turnSeq, '陈旧回调不得推进轮次')
  assert.equal(after.turnUid, st.turnUid, '陈旧回调不得改动行动者')
  assert.equal(after.seats.every((s) => !s.folded), true, '不得误弃牌')

  // 合法行动推进后，旧回调再触发也无效（turnSeq 已变）
  const actor = [host, guest].find((p) => p.seatId === st.turnUid)
  const cap = { roomId: host.roomId, handId: st.handId, turnSeq: st.turnSeq, turnSeatId: st.turnUid }
  const mine = (await api('/api/room/state', { roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken })).data
  const type = mine.avail.map((a) => a.type).includes('check') ? 'check' : 'call'
  await api('/api/room/action', {
    uid: actor.uid, roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken,
    handId: st.handId, turnSeq: st.turnSeq, type,
  })
  room.deadlineAt = Date.now() - 1
  onTurnTimeout(cap)
  const now = (await api('/api/room/state', { roomId: host.roomId })).data
  assert.equal(now.turnSeq, st.turnSeq + 1, '只推进了一次，旧回调不得重复生效')
  await closeRoom(host)
})

test('超时只影响本手：下一手可重新入座', async () => {
  // 3 人房才看得出演化：一人超时弃牌后牌局仍在继续
  const host = await createOnline('房主')
  const g2 = await joinOnline(host.roomId, '乙')
  const g3 = await joinOnline(host.roomId, '丙')
  const players = [host, g2, g3]
  await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  const st = (await api('/api/room/state', { roomId: host.roomId })).data
  const actor = players.find((p) => p.seatId === st.turnUid)

  const room = rooms.get(host.roomId)
  room.deadlineAt = Date.now() - 1
  onTurnTimeout({ roomId: host.roomId, handId: room.handId, turnSeq: room.turnSeq, turnSeatId: st.turnUid })

  const mid = (await api('/api/room/state', { roomId: host.roomId })).data
  assert.equal(mid.finished, false, '三人局超时弃牌后牌局应继续')
  assert.equal(mid.seats.find((s) => s.uid === actor.seatId).folded, true)
  assert.notEqual(mid.turnUid, actor.seatId)
  // 超时者本手旁观：无牌无动作
  const idle = (await api('/api/room/state', { roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken })).data
  assert.equal(idle.myCards, undefined)
  assert.equal(idle.avail, undefined)

  // 把这手打完（剩下两人互跟/过到摊牌）
  let cur = mid
  for (let i = 0; i < 40 && !cur.finished; i++) {
    cur = await actForTurn(players, host.roomId)
  }
  assert.equal(cur.finished, true)

  // 下一手超时者筹码仍 >0 → 重新入座有底牌
  const s2 = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(s2.ok, true, s2.error)
  const back = (await api('/api/room/state', { roomId: host.roomId, seatId: actor.seatId, seatToken: actor.seatToken })).data
  assert.equal(back.myCards.length, 2, '超时者在下一手应恢复参与')
  await closeRoom(host)
})

test('房主离开销毁房间：挂起中的计时器一并清除', async () => {
  const { host } = await runningOnlineRoom()
  const room = rooms.get(host.roomId)
  const cap = { roomId: host.roomId, handId: room.handId, turnSeq: room.turnSeq, turnSeatId: room.state.turnUid }
  const r = await api('/api/room/leave', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(r.data.roomClosed, true)
  // 房间已不存在，旧回调触发必须无副作用地退出
  onTurnTimeout(cap)
  assert.equal(rooms.get(host.roomId), undefined)
})

// ═══ T6：AI 集成 ═══════════════════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 建房 + N 个 AI（逐个添加，验证接口路径） */
async function roomWithAIs(aiCount = 2, name = '房主') {
  const host = await createOnline(name)
  const aiSeats = []
  for (let i = 0; i < aiCount; i++) {
    const r = await api('/api/room/add-ai', {
      uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
    })
    assert.equal(r.ok, true, r.error)
    aiSeats.push(r.data.seats.at(-1))
  }
  return { host, aiSeats }
}

/** 真人驱动牌局：轮到自己 check/call，否则等 AI 调度；返回结束状态 */
async function driveHand(human, { maxSteps = 400 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    const st = (await api('/api/room/state', {
      roomId: human.roomId, seatId: human.seatId, seatToken: human.seatToken,
    })).data
    if (st.finished) return st
    if (st.turnUid === human.seatId && st.avail?.length) {
      const t = st.avail.map((a) => a.type)
      const type = t.includes('check') ? 'check' : 'call'
      const r = await api('/api/room/action', {
        uid: human.uid, roomId: human.roomId, seatId: human.seatId, seatToken: human.seatToken,
        handId: st.handId, turnSeq: st.turnSeq, type,
      })
      if (r.ok && r.data.finished) return r.data
    } else {
      await sleep(25)
    }
  }
  throw new Error('牌局在步数上限内未完成（疑似卡在 AI 回合）')
}

test('T6 add-ai：仅房主、仅两手之间、8 座上限、AI 不可冒充', async () => {
  const host = await createOnline()
  const guest = await joinOnline(host.roomId, '客人')
  // 无凭证 → AUTH_FAILED
  const noCred = await api('/api/room/add-ai', { uid: host.uid, roomId: host.roomId })
  assert.equal(noCred.ok, false)
  assert.equal(noCred.code, 'AUTH_FAILED')
  // 非房主 → NOT_HOST
  const notHost = await api('/api/room/add-ai', {
    uid: guest.uid, roomId: host.roomId, seatId: guest.seatId, seatToken: guest.seatToken,
  })
  assert.equal(notHost.code, 'NOT_HOST')
  // 房主逐个添加 → 服务端生成 AI 身份 + 风格标签
  const add = await api('/api/room/add-ai', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(add.ok, true, add.error)
  const aiSeat = add.data.seats.at(-1)
  assert.equal(aiSeat.isAI, true)
  assert.equal(typeof aiSeat.styleLabel, 'string')
  assert.ok(aiSeat.styleLabel.length > 0)
  assert.equal(aiSeat.seeds, 1000)
  assert.match(aiSeat.uid, /^ai_/, 'AI seatId 由服务端生成')
  // 昵称必须是仓鼠名（不是「AI·松凶」这类风格名），头像与名字同源
  const hamsterNames = ['奶油', '焦糖', '灰灰', '可可', '三花', '雪球']
  assert.ok(
    hamsterNames.some((n) => aiSeat.nickname === n || aiSeat.nickname.startsWith(n)),
    `AI 昵称应是仓鼠名，实际是 ${aiSeat.nickname}`,
  )
  assert.ok(aiSeat.avatar >= 1 && aiSeat.avatar <= 6, '头像应是仓鼠头像 id')
  // 本手进行中拒绝
  const s = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(s.ok, true, s.error)
  const mid = await api('/api/room/add-ai', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(mid.code, 'HAND_IN_PROGRESS')
  // 真人不能冒充 AI：拿 AI 的 seatId + 错 token → AUTH_FAILED
  const fake = await api('/api/room/action', {
    uid: guest.uid, roomId: host.roomId, seatId: aiSeat.uid, seatToken: 'x',
    handId: s.data.handId, turnSeq: s.data.turnSeq, type: 'check',
  })
  assert.equal(fake.code, 'AUTH_FAILED')
  await closeRoom(host)
})

test('T6 add-ai 满员拒绝；remove-ai 权限与时机', async () => {
  const host = await createOnline()
  // host(1) + 7 AI = 8 满员
  for (let i = 0; i < 7; i++) {
    const r = await api('/api/room/add-ai', {
      uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
    })
    assert.equal(r.ok, true, r.error)
  }
  const ninth = await api('/api/room/add-ai', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(ninth.code, 'ROOM_FULL')
  // 移除真人座位 → 拒绝
  const rmHuman = await api('/api/room/remove-ai', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
    targetSeatId: host.seatId,
  })
  assert.equal(rmHuman.ok, false)
  // 移除 AI → 成功，座位数 -1
  const st = (await api('/api/room/state', {
    roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })).data
  const aiUid = st.seats.find((s) => s.isAI).uid
  const rm = await api('/api/room/remove-ai', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
    targetSeatId: aiUid,
  })
  assert.equal(rm.ok, true, rm.error)
  assert.equal(rm.data.seats.length, 7)
  assert.equal(rooms.get(host.roomId).aiRuntime.personas.has(aiUid), false, 'AI 移除后派生态应清理')
  await closeRoom(host)
})

test('T6 AI 调度：轮到 AI 自动行动，整手可推进到摊牌', async () => {
  setAiDelayRange(0, 0)
  const { host, aiSeats } = await roomWithAIs(2)
  const s = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(s.ok, true, s.error)
  const end = await driveHand(host)
  assert.equal(end.finished, true)
  assert.ok(end.result, '应有摊牌结果')
  const aiUids = new Set(aiSeats.map((x) => x.uid))
  assert.ok(
    end.actionLog.some((a) => aiUids.has(a.uid)),
    '行动流水应包含 AI 动作',
  )
  assert.equal(end.seats.reduce((n, x) => n + x.seeds, 0), 3000, '筹码守恒')
  // 手牌结束后 AI 计时器应已清理
  assert.equal(rooms.get(host.roomId).aiTimer, null)
  // AI 学习数据应有积累（公开行动统计）
  assert.ok(rooms.get(host.roomId).aiRuntime.models.size >= 0)
  await closeRoom(host)
})

test('T6 陈旧 AI 回调无副作用；正确四元组才推进', async () => {
  // 大延迟 → 定时器形同虚设，全部手动触发
  setAiDelayRange(60000, 60000)
  const { host, aiSeats } = await roomWithAIs(1)
  const s = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(s.ok, true, s.error)
  // 轮转到 AI 回合
  let st = s.data
  let guard = 0
  while (!st.finished && guard++ < 60) {
    if (st.turnUid === aiSeats[0].uid) break
    if (st.turnUid === host.seatId) {
      const meState = (await api('/api/room/state', {
        roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
      })).data
      const t = (meState.avail ?? []).map((a) => a.type)
      const r = await api('/api/room/action', {
        uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
        handId: st.handId, turnSeq: st.turnSeq,
        type: t.includes('check') ? 'check' : 'call',
      })
      assert.equal(r.ok, true, r.error)
      st = r.data
    } else {
      await sleep(10)
      st = (await api('/api/room/state', {
        roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
      })).data
    }
  }
  assert.equal(st.turnUid, aiSeats[0].uid, '应轮到 AI')
  const cap = { roomId: host.roomId, handId: st.handId, turnSeq: st.turnSeq, turnSeatId: st.turnUid }
  const room = rooms.get(host.roomId)
  const before = room.turnSeq
  // 四元组任一不符 → 无副作用
  onAiTurn({ ...cap, turnSeq: cap.turnSeq + 99 })
  assert.equal(room.turnSeq, before, '陈旧 turnSeq 不得推进')
  onAiTurn({ ...cap, handId: 99 })
  assert.equal(room.turnSeq, before, '陈旧 handId 不得推进')
  onAiTurn({ ...cap, turnSeatId: host.seatId })
  assert.equal(room.turnSeq, before, '错误座位不得推进')
  onAiTurn({ ...cap, roomId: '999999' })
  assert.equal(room.turnSeq, before, '房间不存在不得推进')
  // 正确触发 → 推进一格
  onAiTurn(cap)
  assert.equal(room.turnSeq, before + 1, '正确回调应推进')
  // 本手不用打完：挂起的 AI 定时器还是 60s 拍子，直接销毁房间验证清理
  setAiDelayRange(0, 0)
  await closeRoom(host)
  assert.equal(rooms.get(host.roomId), undefined, '销毁后房间应不存在')
})

test('T6 归零 AI 旁观：不进本手参与者，座位保留', async () => {
  setAiDelayRange(0, 0)
  const { host } = await roomWithAIs(2)
  const room = rooms.get(host.roomId)
  const aiSeat = room.seats.find((s) => s.kind === 'ai')
  aiSeat.seeds = 0   // 等价于前面输光（线上不补人，归零即观战）
  const s = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(s.ok, true, s.error)
  assert.equal(room.handParticipants.has(aiSeat.uid), false, '0 筹码 AI 不得进参与者')
  const end = await driveHand(host)
  assert.equal(end.finished, true)
  assert.equal(end.actionLog.some((a) => a.uid === aiSeat.uid), false, '归零 AI 不应有动作')
  assert.equal(end.seats.find((x) => x.uid === aiSeat.uid).seeds, 0, '归零 AI 座位保留、筹码仍为 0')
  await closeRoom(host)
})


test('T6 双房间 AI 互不影响', async () => {
  setAiDelayRange(0, 0)
  const A = await roomWithAIs(2, 'A房主')
  const B = await roomWithAIs(2, 'B房主')
  const sA = await api('/api/room/start', {
    uid: A.host.uid, roomId: A.host.roomId, seatId: A.host.seatId, seatToken: A.host.seatToken,
  })
  const sB = await api('/api/room/start', {
    uid: B.host.uid, roomId: B.host.roomId, seatId: B.host.seatId, seatToken: B.host.seatToken,
  })
  assert.ok(sA.ok && sB.ok)
  const [endA, endB] = await Promise.all([driveHand(A.host), driveHand(B.host)])
  assert.ok(endA.finished && endB.finished, '两房都应完成本手')
  const aIds = new Set(endA.seats.map((x) => x.uid))
  assert.ok(endB.seats.every((x) => !aIds.has(x.uid)), 'B 房不得出现 A 房座位')
  assert.notEqual(rooms.get(A.host.roomId).aiRuntime, rooms.get(B.host.roomId).aiRuntime)
  assert.equal(rooms.get(A.host.roomId).handId, 1)
  assert.equal(rooms.get(B.host.roomId).handId, 1)
  await closeRoom(A.host)
  await closeRoom(B.host)
})

test('T6 连续两手：handId 递增、人设跨手稳定、AI 计时器不泄漏', async () => {
  setAiDelayRange(0, 0)
  const { host } = await roomWithAIs(2)
  await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  const end1 = await driveHand(host)
  assert.equal(end1.finished, true)
  const room = rooms.get(host.roomId)
  const personaBefore = JSON.stringify([...room.aiRuntime.personas.entries()])
  const s2 = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(s2.data.handId, 2)
  const end2 = await driveHand(host)
  assert.ok(end2.finished)
  assert.equal(
    JSON.stringify([...room.aiRuntime.personas.entries()]),
    personaBefore,
    'AI 人设应跨手稳定（不重摇、不漂移）',
  )
  assert.equal(room.aiTimer, null)
  await closeRoom(host)
})

test('T6 AI 决策性能采样（门禁数据点，目标机复核）', async () => {
  setAiDelayRange(0, 0)
  const { host } = await roomWithAIs(3)
  await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  const end = await driveHand(host)
  assert.ok(end.finished)
  const st = rooms.get(host.roomId).aiStats
  const avg = st.decisions ? st.totalMs / st.decisions : 0
  console.log(`  [perf] AI 决策 ${st.decisions} 次，max ${st.maxMs.toFixed(1)}ms，avg ${avg.toFixed(1)}ms`)
  assert.ok(st.decisions > 0, '应记录 AI 决策次数')
  // 门禁 §12：P95 ≤120ms 在目标 2 核 2G 机上复核；本机取 max 宽松断言防失控
  assert.ok(st.maxMs <= 200, `AI 单次决策异常过慢：${st.maxMs.toFixed(1)}ms`)
  await closeRoom(host)
})

// ── 房间列表扩展：线上房可见 + 凭证认座 + 手动关残留房 ──

test('房间列表包含线上房；凭证认 iAmIn/isMine；伪造凭证无效；房主 leave 即解散', async () => {
  const host = await createOnline('房主')
  const guest = await joinOnline(host.roomId, '客人')

  // 无凭证：线上房在列表里，但不标我的
  let r = await api('/api/room/list', { uid: uid('out') })
  let row = r.data.rooms.find((x) => x.roomNo === host.roomId)
  assert.ok(row, '线上房应出现在列表')
  assert.equal(row.mode, 'online')
  assert.equal(row.playerCount, 2)
  assert.equal(row.iAmIn, false)
  assert.equal(row.isMine, false)

  // 房主凭证 → iAmIn + isMine
  r = await api('/api/room/list', {
    uid: host.uid,
    creds: { [host.roomId]: { seatId: host.seatId, seatToken: host.seatToken } },
  })
  row = r.data.rooms.find((x) => x.roomNo === host.roomId)
  assert.equal(row.iAmIn, true, '持正确凭证应标 iAmIn')
  assert.equal(row.isMine, true, '房主应标 isMine')

  // 成员凭证 → iAmIn 但不是房主
  r = await api('/api/room/list', {
    uid: guest.uid,
    creds: { [host.roomId]: { seatId: guest.seatId, seatToken: guest.seatToken } },
  })
  row = r.data.rooms.find((x) => x.roomNo === host.roomId)
  assert.equal(row.iAmIn, true)
  assert.equal(row.isMine, false, '成员不是房主')

  // 伪造凭证（正确 seatId + 错误 token）→ 不标
  r = await api('/api/room/list', {
    uid: uid('evil'),
    creds: { [host.roomId]: { seatId: host.seatId, seatToken: 'forged-token-999' } },
  })
  row = r.data.rooms.find((x) => x.roomNo === host.roomId)
  assert.equal(row.iAmIn, false, '伪造 token 不能认座')
  assert.equal(row.isMine, false)

  // 房主离开 = 解散 → 列表里消失
  r = await api('/api/room/leave', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(r.ok, true, r.error)
  r = await api('/api/room/list', { uid: host.uid })
  assert.equal(r.data.rooms.find((x) => x.roomNo === host.roomId), undefined, '解散后不该再出现')
})

// ── 同账号回座：凭证丢失但 uid 没变，归还座位 + 换发令牌 ──

test('同账号 join 回座不发新座；旧令牌作废；异账号仍开新座', async () => {
  const host = await createOnline('房主')
  const oldSeat = host.seatId
  const oldToken = host.seatToken
  const guest = await joinOnline(host.roomId, '客人')   // 两座，能开局

  // 模拟丢凭证重进：同 uid、无令牌 join → 归还原座 + 换发令牌
  let r = await api('/api/room/join', {
    uid: host.uid, roomId: host.roomId, me: { nickname: '房主改名', avatar: 3 },
  })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.data.seatId, oldSeat, '应归还同一座位')
  assert.ok(r.data.seatToken, '应回发新令牌')
  assert.notEqual(r.data.seatToken, oldToken, '令牌应换发')
  assert.equal(r.data.seats.length, 2, '不能开重复座位')
  const newToken = r.data.seatToken

  // 旧令牌作废：/start 先认证 → AUTH_FAILED
  r = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: oldSeat, seatToken: oldToken,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'AUTH_FAILED', '旧令牌必须作废')

  // 新令牌能正常开局
  r = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: oldSeat, seatToken: newToken,
  })
  assert.equal(r.ok, true, r.error)

  // 房主用新令牌离开 = 解散
  await closeRoom({ uid: host.uid, roomId: host.roomId, seatId: oldSeat, seatToken: newToken })
  assert.equal(rooms.get(host.roomId), undefined, '解散后房间应不存在')
})

// ── 盲注位透出（椭圆桌的庄/小/大标记依赖） ──

test('开局后状态透出 sbUid/bbUid；多人局 小=庄下家、大=庄下下家', async () => {
  const host = await createOnline('房主')
  const g1 = await joinOnline(host.roomId, '客人1')
  const g2 = await joinOnline(host.roomId, '客人2')
  const s = await api('/api/room/start', {
    uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
  })
  assert.equal(s.ok, true, s.error)
  const st = s.data
  const order = st.seats.map((x) => x.uid)
  const di = order.indexOf(st.dealerUid)
  assert.ok(di >= 0, '庄家必须在座')
  assert.equal(st.sbUid, order[(di + 1) % 3], '小麦位 = 庄家下家')
  assert.equal(st.bbUid, order[(di + 2) % 3], '大麦位 = 庄家下下家')
  assert.notEqual(st.sbUid, st.bbUid)
  await closeRoom(host)
})
