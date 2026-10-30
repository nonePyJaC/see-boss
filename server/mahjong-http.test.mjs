import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWall } from '../shared/logic/mahjong/online-wall.mjs'
import { isFlower } from '../shared/logic/mahjong/tiles.mjs'
import { dealSeatSequence } from '../shared/logic/mahjong/online-game.mjs'
import { setMahjongReady, startMahjongHand, submitMahjongAction } from './mahjong-room.mjs'
import { buildMahjongObservation } from './mahjong-room.mjs'
import { safeMahjongAction } from './mahjong-ai.mjs'
import { HAMSTERS } from '../shared/assets/hamsters.mjs'
import { POLICY_VERSION } from './mahjong-ai-v2.mjs'

process.env.LISTEN = '0'
process.env.HAMSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-mahjong-test-'))
process.env.HAMSTER_ONLINE_CREATE_CODE = 'test-code'
const { server, rooms, restoreRoom, setMahjongAiDelay, setMahjongPolicyRunner } = await import('./index.js')
const { closeDb, loadRoomSnapshot, rawDb } = await import('./db.js')
const { saveMahjongSnapshot, makeMahjongHandRecord } = await import('./mahjong-store.mjs')
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { for (const room of rooms.values()) if (room.mjTimer) clearTimeout(room.mjTimer); server.close(); closeDb() })
async function api(pathname, body) {
  const r = await fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return r.json()
}
async function register(n) {
  const uid = `mj-uid-${n}`
  const r = await api('/api/account/register', { uid, account: `mjtest${n}abcd`, nickname: `麻友${n}` })
  assert.equal(r.ok, true, r.error)
  return uid
}
const credential = (data, uid) => ({ uid, roomId: data.id, seatId: data.seatId, seatToken: data.seatToken })

test('四真人入座、准备、动作认证、隐私及快照恢复', async () => {
  const uids = []
  for (let i = 0; i < 4; i++) uids.push(await register(i))
  const created = await api('/api/room/create', { uid: uids[0], me: { nickname: '房主' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 100, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const host = credential(created.data, uids[0]), creds = [host]
  for (let i = 1; i < 4; i++) {
    const joined = await api('/api/room/join', { uid: uids[i], roomId: host.roomId, me: { nickname: `玩家${i}` } })
    assert.equal(joined.ok, true, joined.error)
    creds.push(credential(joined.data, uids[i]))
  }
  const extraUid = await register(5)
  assert.equal((await api('/api/room/join', { uid: extraUid, roomId: host.roomId })).ok, false)
  const identity = { matchId: created.data.matchId, handId: 0 }
  for (const c of creds) assert.equal((await api('/api/mahjong/ready', { ...c, ...identity })).ok, true)
  const started = await api('/api/room/start', { ...host, ...identity })
  assert.equal(started.ok, true, started.error)
  const spectator = await api('/api/room/state', { roomId: host.roomId })
  assert.equal(spectator.ok, true)
  assert.equal('myHand' in spectator.data, false)
  assert.equal('wall' in spectator.data, false)
  assert.ok(spectator.data.players.every((p) => !('hand' in p)))
  for (const c of creds) {
    const own = await api('/api/room/state', c)
    assert.equal(own.ok, true)
    assert.equal(own.data.myHand.length, own.data.dealer === creds.indexOf(c) ? 14 : 13)
  }
  const wrong = await api('/api/room/action', { ...host, seatToken: 'wrong', matchId: started.data.matchId,
    handId: started.data.handId, windowId: started.data.windowId, action: { type: 'discard', tile: '1m' } })
  assert.equal(wrong.ok, false)
  const oldRoom = rooms.get(host.roomId), snapshot = loadRoomSnapshot(host.roomId)
  if (oldRoom.mjTimer) clearTimeout(oldRoom.mjTimer)
  rooms.delete(host.roomId)
  assert.ok(restoreRoom(snapshot))
  const restored = await api('/api/room/state', host)
  assert.deepEqual(restored.data.myHand, started.data.myHand)
  assert.equal(restored.data.matchId, started.data.matchId)
  assert.equal(restored.data.windowId, started.data.windowId)
  const left = await api('/api/room/leave', host)
  assert.equal(left.ok, true)
  assert.equal((await api('/api/room/state', creds[1])).data.hostUid, creds[1].seatId)
  for (const c of creds.slice(1)) await api('/api/room/leave', c)
  assert.equal(rooms.has(host.roomId), false)
  assert.equal(rawDb().prepare('SELECT COUNT(*) AS n FROM account_ledger').get().n, 0)
})

test('一真人可添加三个自动准备的 AI', async () => {
  const uid = await register(6)
  const created = await api('/api/room/create', { uid, me: { nickname: '房主' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 100, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const host = credential(created.data, uid)
  for (let i = 0; i < 3; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
  const identity = { matchId: created.data.matchId, handId: 0 }
  assert.equal((await api('/api/mahjong/ready', { ...host, ...identity })).ok, true)
  const started = await api('/api/room/start', { ...host, ...identity })
  assert.equal(started.ok, true, started.error)
  assert.equal(started.data.seats.filter((s) => s.isAI).length, 3)
  const bots = started.data.seats.filter((s) => s.isAI)
  assert.equal(new Set(bots.map((s) => s.avatar)).size, 3)
  assert.ok(bots.every((s) => HAMSTERS.some((h) => h.id === s.avatar && h.name === s.nickname)))
  await api('/api/room/leave', host)
})

test('线上 AI 调度器按本地策略选择并提交合法动作', async () => {
  const uid = await register(90)
  const created = await api('/api/room/create', { uid, me: { nickname: '房主' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 1000, dealerSeat: 1 } })
  assert.equal(created.ok, true, created.error)
  const host = credential(created.data, uid)
  for (let i = 0; i < 3; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
  const initial = { matchId: created.data.matchId, handId: 0 }
  assert.equal((await api('/api/mahjong/ready', { ...host, ...initial })).ok, true)
  const started = await api('/api/room/start', { ...host, ...initial })
  assert.equal(started.ok, true, started.error)
  let captured = null
  for (let attempt = 0; attempt < 400 && !captured; attempt++) {
    const room = rooms.get(host.roomId), session = room.mahjongSession
    const hostObs = buildMahjongObservation(session, 0)
    if (session.game.phase === 'ready' && hostObs.myActions.some((a) => a.type === 'pass')) {
      const r = await api('/api/room/action', { ...host, matchId: session.matchId, handId: session.handId, windowId: session.windowId, action: { type: 'pass' } })
      assert.equal(r.ok, true, r.error)
      continue
    }
    if (session.game.phase === 'turn' && session.game.turn === 1) {
      const obs = buildMahjongObservation(session, 1)
      const choice = safeMahjongAction(obs)
      if (choice?.type === 'discard') captured = { legal: obs.myActions, eventCount: session.game.events.length }
    }
    if (!captured) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(captured, '没有捕获 AI 出牌回合')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(rooms.get(host.roomId).mahjongSession.game.events.slice(captured.eventCount).some((e) => e.type === 'discard' && e.seat === 1), false, 'AI 不应瞬间出牌')
  let actual
  for (let attempt = 0; attempt < 200 && !actual; attempt++) {
    const events = rooms.get(host.roomId).mahjongSession.game.events.slice(captured.eventCount)
    actual = events.find((e) => e.type === 'discard' && e.seat === 1)
    if (!actual) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(captured.legal.some((action) => action.type === 'discard' && action.tile === actual?.tile), '自动出牌必须来自合法动作')
  const view = await api('/api/room/state', host)
  assert.equal(JSON.stringify(view.data).includes('localPolicy'), false)
  assert.equal(JSON.stringify(view.data).includes('observationId'), false)
  const reviewDir = path.join(process.env.HAMSTER_DATA_DIR, 'ai-reviews')
  const reviews = fs.readdirSync(reviewDir).flatMap((name) => fs.readFileSync(path.join(reviewDir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
  const review = reviews.findLast((record) => record.room === host.roomId && record.model === POLICY_VERSION)
  assert.ok(review?.input?.messages?.[0]?.content.includes('diagnostic'), '私有复盘应保留真实策略诊断')
  assert.equal(JSON.stringify(review).includes(host.seatToken), false)
  await api('/api/room/leave', host)
})

test('异步策略结果返回前窗口已变化时不能提交旧动作', async (t) => {
  let complete, observed
  setMahjongAiDelay(0)
  setMahjongPolicyRunner((obs) => { observed = obs; return new Promise((resolve) => { complete = resolve }) })
  t.after(() => { setMahjongAiDelay(1200); setMahjongPolicyRunner() })
  const uid = await register(91)
  const created = await api('/api/room/create', { uid, me: { nickname: '房主' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 1000, dealerSeat: 1 } })
  const host = credential(created.data, uid)
  for (let i = 0; i < 3; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
  const initial = { matchId: created.data.matchId, handId: 0 }
  assert.equal((await api('/api/mahjong/ready', { ...host, ...initial })).ok, true)
  let started = await api('/api/room/start', { ...host, ...initial })
  assert.equal(started.ok, true, started.error)
  if (started.data.phase === 'ready' && started.data.myActions.some((a) => a.type === 'pass')) {
    started = await api('/api/room/action', { ...host, matchId: started.data.matchId, handId: started.data.handId, windowId: started.data.windowId, action: { type: 'pass' } })
    assert.equal(started.ok, true, started.error)
  }
  for (let i = 0; i < 100 && !complete; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(complete, '未捕获异步决策')
  const room = rooms.get(host.roomId), before = room.mahjongSession.game.events.length
  room.mahjongSession.windowId++
  complete({ action: observed.myActions[0], route: 'qing:m', diagnostic: {} })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(room.mahjongSession.game.events.length, before)
  assert.equal(room.mahjongSession.localPolicy, undefined)
  await api('/api/room/leave', host)
})

test('四真人通过接口完整一手、恢复与战绩幂等，再准备下一手', async () => {
  const uids = []
  for (let i = 20; i < 24; i++) uids.push(await register(i))
  const created = await api('/api/room/create', { uid: uids[0], me: { nickname: '房主' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 1000, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const host = credential(created.data, uids[0]), creds = [host]
  for (let i = 1; i < 4; i++) {
    const joined = await api('/api/room/join', { uid: uids[i], roomId: host.roomId, me: { nickname: `玩家${i}` } })
    assert.equal(joined.ok, true, joined.error); creds.push(credential(joined.data, uids[i]))
  }
  const initial = { matchId: created.data.matchId, handId: 0 }
  for (const c of creds) assert.equal((await api('/api/mahjong/ready', { ...c, ...initial })).ok, true)
  const started = await api('/api/room/start', { ...host, ...initial })
  assert.equal(started.ok, true, started.error)
  let latest = started.data, steps = 0, replayChecked = false
  while (latest.phase !== 'finished' && steps++ < 400) {
    let acted = false
    for (const c of creds) {
      const view = await api('/api/room/state', c)
      assert.equal(view.ok, true, view.error)
      latest = view.data
      if (latest.phase === 'finished') break
      assert.equal('revealedHands' in latest, false)
      const actions = latest.myActions ?? []
      if (!actions.length) continue
      const action = actions.find((a) => a.type === 'pass') ?? actions.find((a) => a.type === 'discard') ?? actions[0]
      const request = { ...c, matchId: latest.matchId, handId: latest.handId, windowId: latest.windowId, action }
      const applied = await api('/api/room/action', request)
      assert.equal(applied.ok, true, applied.error)
      latest = applied.data
      if (!replayChecked) { assert.equal((await api('/api/room/action', request)).ok, false); replayChecked = true }
      if (steps === 5 && latest.phase !== 'finished') {
        const oldRoom = rooms.get(host.roomId), snap = loadRoomSnapshot(host.roomId)
        if (oldRoom.mjTimer) clearTimeout(oldRoom.mjTimer)
        rooms.delete(host.roomId)
        assert.ok(restoreRoom(snap))
      }
      acted = true
      break
    }
    assert.ok(acted || latest.phase === 'finished', `stuck at ${latest.phase}`)
  }
  assert.equal(latest.phase, 'finished')
  const spectatorEnd = await api('/api/room/state', { roomId: host.roomId })
  assert.deepEqual(spectatorEnd.data.revealedHands, rooms.get(host.roomId).mahjongSession.game.players.map((p) => p.hand))
  assert.equal(latest.balances.reduce((a, b) => a + b, 0), 4000)
  const rows = rawDb().prepare("SELECT payload FROM history WHERE mode='mahjong' AND room_no=?").all(host.roomId)
  assert.equal(rows.length, 1)
  assert.ok(!rows[0].payload.includes(host.seatToken))
  if (!latest.result.matchOver) {
    const identity = { matchId: latest.matchId, handId: latest.handId }
    for (const c of creds) assert.equal((await api('/api/mahjong/ready', { ...c, ...identity })).ok, true)
    const next = await api('/api/room/start', { ...host, ...identity })
    assert.equal(next.ok, true, next.error)
    assert.equal(next.data.handId, 2)
    if (next.data.phase !== 'finished') assert.equal('revealedHands' in next.data, false)
  }
  for (const c of creds) await api('/api/room/leave', c)
  assert.equal(rawDb().prepare('SELECT COUNT(*) AS n FROM account_ledger').get().n, 0)
})

test('四真人以及一、二、三真人混合 AI 均能连续完成两手', async (t) => {
  setMahjongAiDelay(30)
  setMahjongPolicyRunner(async (obs) => ({ action: safeMahjongAction(obs), diagnostic: { reason: '测试用基线' } }))
  t.after(() => { setMahjongAiDelay(1200); setMahjongPolicyRunner() })
  for (let humans = 1; humans <= 4; humans++) {
    const uids = []
    for (let i = 0; i < humans; i++) uids.push(await register(30 + humans * 4 + i))
    const created = await api('/api/room/create', { uid: uids[0], me: { nickname: '房主' }, createCode: 'test-code',
      cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 1000, dealerSeat: 0 } })
    assert.equal(created.ok, true, created.error)
    const host = credential(created.data, uids[0]), creds = [host]
    for (let i = 1; i < humans; i++) {
      const joined = await api('/api/room/join', { uid: uids[i], roomId: host.roomId, me: { nickname: `玩家${i}` } })
      assert.equal(joined.ok, true, joined.error); creds.push(credential(joined.data, uids[i]))
    }
    for (let i = humans; i < 4; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
    let identity = { matchId: created.data.matchId, handId: 0 }
    for (let hand = 0; hand < 2; hand++) {
      for (const c of creds) assert.equal((await api('/api/mahjong/ready', { ...c, ...identity })).ok, true)
      let response = await api('/api/room/start', { ...host, ...identity })
      assert.equal(response.ok, true, response.error)
      let state = response.data, steps = 0
      while (state.phase !== 'finished' && steps++ < 700) {
        let acted = false
        for (const c of creds) {
          response = await api('/api/room/state', c)
          assert.equal(response.ok, true, response.error)
          state = response.data
          if (state.phase === 'finished') break
          const actions = state.myActions ?? []
          if (!actions.length) continue
          const action = actions.find((a) => a.type === 'pass') ?? actions.find((a) => a.type === 'discard') ?? actions[0]
          response = await api('/api/room/action', { ...c, matchId: state.matchId, handId: state.handId, windowId: state.windowId, action })
          if (response.ok) state = response.data
          acted = true
          break
        }
        if (!acted && state.phase !== 'finished') await new Promise((resolve) => setTimeout(resolve, 60))
      }
      assert.equal(state.phase, 'finished', `${humans} 真人第 ${hand + 1} 手未结束`)
      assert.equal(state.result.matchOver, false)
      assert.equal(state.balances.reduce((a, b) => a + b, 0), 4000)
      identity = { matchId: state.matchId, handId: state.handId }
    }
    const rows = rawDb().prepare("SELECT payload FROM history WHERE mode='mahjong' AND room_no=?").all(host.roomId)
    assert.equal(rows.length, 2)
    for (const c of creds) await api('/api/room/leave', c)
  }
})

test('一真人与三个真实 v2.2 工作线程连续两手，恢复后继续', { timeout: 240000 }, async (t) => {
  setMahjongAiDelay(0)
  setMahjongPolicyRunner()
  t.after(() => { setMahjongAiDelay(1200); setMahjongPolicyRunner() })
  const uid = await register(96)
  const created = await api('/api/room/create', { uid, me: { nickname: '房主' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 1000, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const host = credential(created.data, uid)
  t.after(() => { const room = rooms.get(host.roomId); if (room?.mjTimer) clearTimeout(room.mjTimer); rooms.delete(host.roomId) })
  for (let i = 0; i < 3; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
  let identity = { matchId: created.data.matchId, handId: 0 }, restored = false
  for (let hand = 1; hand <= 2; hand++) {
    assert.equal((await api('/api/mahjong/ready', { ...host, ...identity })).ok, true)
    let response = await api('/api/room/start', { ...host, ...identity })
    assert.equal(response.ok, true, response.error)
    let state = response.data, steps = 0
    while (state.phase !== 'finished' && steps++ < 15000) {
      response = await api('/api/room/state', host)
      assert.equal(response.ok, true, response.error)
      state = response.data
      if (state.phase === 'finished') break
      const actions = state.myActions ?? []
      if (actions.length) {
        const action = actions.find((a) => a.type === 'pass') ?? actions.find((a) => a.type === 'discard') ?? actions[0]
        response = await api('/api/room/action', { ...host, matchId: state.matchId, handId: state.handId, windowId: state.windowId, action })
        if (response.ok) state = response.data
        if (!restored && state.windowId > 5 && state.phase !== 'finished') {
          const room = rooms.get(host.roomId), snapshot = loadRoomSnapshot(host.roomId)
          if (room.mjTimer) clearTimeout(room.mjTimer)
          rooms.delete(host.roomId)
          assert.ok(restoreRoom(snapshot)); restored = true
        }
      } else await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(state.phase, 'finished', `第 ${hand} 手未结束`)
    assert.equal(state.result.matchOver, false)
    assert.equal(state.balances.reduce((a,b) => a+b, 0), 4000)
    identity = { matchId: state.matchId, handId: state.handId }
  }
  assert.ok(restored)
  const reviewDir = path.join(process.env.HAMSTER_DATA_DIR, 'ai-reviews')
  const records = fs.readdirSync(reviewDir).flatMap((name) => fs.readFileSync(path.join(reviewDir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
    .filter((record) => record.room === host.roomId && record.model === POLICY_VERSION)
  for (const hand of [1,2]) {
    const decisions = records.filter((r) => r.hand === hand).map((r) => JSON.parse(r.input.messages[0].content).diagnostic)
    assert.ok(decisions.some((d) => !d.fallback && d.candidates?.length), `第 ${hand} 手没有真实策略评分`)
  }
  assert.equal(rawDb().prepare("SELECT COUNT(*) AS n FROM history WHERE mode='mahjong' AND room_no=?").get(host.roomId).n, 2)
  await api('/api/room/leave', host)
})

test('同房重开生成新场次，旧战绩保留并拒绝旧场请求', async () => {
  const uid = await register(60)
  const created = await api('/api/room/create', { uid, me: { nickname: '房主' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 100, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const host = credential(created.data, uid)
  for (let i = 0; i < 3; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
  const initial = { matchId: created.data.matchId, handId: 0 }
  assert.equal((await api('/api/mahjong/ready', { ...host, ...initial })).ok, true)
  const started = await api('/api/room/start', { ...host, ...initial })
  assert.equal(started.ok, true, started.error)
  const room = rooms.get(host.roomId)
  if (room.mjTimer) clearTimeout(room.mjTimer)
  room.mahjongSession.game.phase = 'finished'
  room.mahjongSession.game.result = { type: 'draw', winners: [], matchOver: true }
  room.mahjongSession.deadlineAt = null
  const seats = room.seats.map((s, i) => ({ nickname: s.nickname, kind: s.kind, account: i === 0 ? 'mjtest60abcd' : null }))
  const record = makeMahjongHandRecord(room.mahjongSession, seats)
  const snap = loadRoomSnapshot(host.roomId)
  saveMahjongSnapshot({ roomId: host.roomId, snapshot: { ...snap.state, session: room.mahjongSession }, handRecord: record })
  const old = { matchId: started.data.matchId, handId: started.data.handId }
  const reset = await api('/api/mahjong/reset', { ...host, ...old })
  assert.equal(reset.ok, true, reset.error)
  assert.notEqual(reset.data.matchId, old.matchId)
  assert.equal(reset.data.handId, 0)
  assert.deepEqual(reset.data.ready, [false, true, true, true])
  assert.equal((await api('/api/mahjong/ready', { ...host, ...old })).ok, false)
  assert.equal(rawDb().prepare("SELECT COUNT(*) AS n FROM history WHERE room_no=? AND mode='mahjong'").get(host.roomId).n, 1)
  await api('/api/room/leave', host)
})

test('对局中退出并切换账号，完成手战绩仍归入座时账号', async () => {
  const uid = await register(70)
  const created = await api('/api/room/create', { uid, me: { nickname: '原玩家' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 1000, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const host = credential(created.data, uid)
  for (let i = 0; i < 3; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
  const initial = { matchId: created.data.matchId, handId: 0 }
  assert.equal((await api('/api/mahjong/ready', { ...host, ...initial })).ok, true)
  const started = await api('/api/room/start', { ...host, ...initial })
  assert.equal(started.ok, true, started.error)
  assert.equal((await api('/api/account/logout', { uid })).ok, true)
  assert.equal((await api('/api/account/register', { uid, account: 'mjother70', nickname: '新账号70' })).ok, true)
  const room = rooms.get(host.roomId)
  if (room.mjTimer) clearTimeout(room.mjTimer)
  room.mahjongSession.game.phase = 'finished'
  room.mahjongSession.game.result = { type: 'draw', winners: [], matchOver: false }
  room.mahjongSession.deadlineAt = null
  const ready = await api('/api/mahjong/ready', { ...host, matchId: started.data.matchId, handId: started.data.handId })
  assert.equal(ready.ok, true, ready.error)
  const row = rawDb().prepare("SELECT payload FROM history WHERE room_no=? AND mode='mahjong'").get(host.roomId)
  const record = JSON.parse(row.payload)
  assert.equal(record.seats[0].account, 'mjtest70abcd')
  assert.equal((await api('/api/account/history', { uid })).data.rows.some((r) => r.room_no === host.roomId), false)
  const originalUid = 'original-device-70'
  assert.equal((await api('/api/account/login', { uid: originalUid, account: 'mjtest70abcd' })).ok, true)
  assert.equal((await api('/api/account/history', { uid: originalUid })).data.rows.some((r) => r.room_no === host.roomId), true)
  assert.equal((await api('/api/room/leave', host)).ok, true)
})

test('最后真人退出时，中止战绩保留入座时账号', async () => {
  const uid = await register(71)
  const created = await api('/api/room/create', { uid, me: { nickname: '原玩家' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 1000, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const host = credential(created.data, uid)
  for (let i = 0; i < 3; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
  const initial = { matchId: created.data.matchId, handId: 0 }
  assert.equal((await api('/api/mahjong/ready', { ...host, ...initial })).ok, true)
  assert.equal((await api('/api/room/start', { ...host, ...initial })).ok, true)
  assert.equal((await api('/api/account/logout', { uid })).ok, true)
  assert.equal((await api('/api/room/leave', host)).ok, true)
  const row = rawDb().prepare("SELECT payload FROM history WHERE room_no=? AND mode='mahjong'").get(host.roomId)
  assert.equal(JSON.parse(row.payload).seats[0].account, 'mjtest71abcd')
})

function wallForRecovery(dealerTiles) {
  const tiles = createWall(() => 0.5)
  const dealer = dealerTiles.map((tile) => {
    const index = tiles.indexOf(tile); assert.ok(index >= 0); return tiles.splice(index, 1)[0]
  })
  const fill = (a, n) => { while (a.length < n) a.push(tiles.splice(tiles.findIndex((x) => !isFlower(x)), 1)[0]) }
  fill(dealer, 14)
  const others = [[], [], []]; for (const hand of others) fill(hand, 13)
  const hands = [dealer, ...others]
  return [...dealSeatSequence(0).map((s) => hands[s].shift()), ...tiles]
}

test('花杠首手结束及旧暗杠结束态的快照都能恢复并同房重开', async () => {
  for (const [n, flowers] of [[80, true], [81, false]]) {
    const uid = await register(n)
    const created = await api('/api/room/create', { uid, me: { nickname: '房主' }, createCode: 'test-code',
      cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: flowers ? 10 : 100, dealerSeat: 0 } })
    assert.equal(created.ok, true, created.error)
    const host = credential(created.data, uid)
    for (let i = 0; i < 3; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
    const room = rooms.get(host.roomId)
    let session = setMahjongReady(room.mahjongSession, 0)
    session = startMahjongHand(session, { wall: wallForRecovery(flowers ? ['f1', 'f2', 'f3', 'f4'] : ['1m', '1m', '1m', '1m']) })
    if (!flowers) {
      while (session.game.phase === 'ready') session = submitMahjongAction(session, session.game.readyPending[0], { type: 'pass' }, session)
      session.game.initialDealerTurn = false
      session.game.players[0].lastDraw = '1m'
      session.game.balances = [100, 5, 5, 100]
      session = submitMahjongAction(session, 0, { type: 'ankong', tile: '1m' }, session)
      session.game.players[0].lastDraw = '1m' // 老版本结束态残留
    }
    assert.equal(session.game.result.matchOver, true)
    const snap = loadRoomSnapshot(host.roomId)
    saveMahjongSnapshot({ roomId: host.roomId, snapshot: { ...snap.state, session }, handRecord: makeMahjongHandRecord(session, room.seats) })
    rooms.delete(host.roomId)
    assert.ok(restoreRoom(loadRoomSnapshot(host.roomId)))
    const state = await api('/api/room/state', host)
    assert.equal(state.ok, true, state.error)
    assert.equal(state.data.result.matchOver, true)
    const reset = await api('/api/mahjong/reset', { ...host, matchId: session.matchId, handId: session.handId })
    assert.equal(reset.ok, true, reset.error)
    assert.notEqual(reset.data.matchId, session.matchId)
    await api('/api/room/leave', host)
  }
})

test('加入者登出后重启房间，战绩仍归入座时账号', async () => {
  const hostUid = await register(82), guestUid = await register(83)
  const created = await api('/api/room/create', { uid: hostUid, me: { nickname: '房主' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 1000, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const host = credential(created.data, hostUid)
  const joined = await api('/api/room/join', { uid: guestUid, roomId: host.roomId, me: { nickname: '客人' } })
  assert.equal(joined.ok, true, joined.error)
  const guest = credential(joined.data, guestUid)
  for (let i = 0; i < 2; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
  const initial = { matchId: created.data.matchId, handId: 0 }
  for (const c of [host, guest]) assert.equal((await api('/api/mahjong/ready', { ...c, ...initial })).ok, true)
  assert.equal((await api('/api/room/start', { ...host, ...initial })).ok, true)
  assert.equal((await api('/api/account/logout', { uid: guestUid })).ok, true)
  const room = rooms.get(host.roomId)
  if (room.mjTimer) clearTimeout(room.mjTimer)
  rooms.delete(host.roomId)
  assert.ok(restoreRoom(loadRoomSnapshot(host.roomId)))
  assert.equal((await api('/api/room/state', guest)).ok, true)
  const newUid = 'guest-new-device-83'
  assert.equal((await api('/api/account/login', { uid: newUid, account: 'mjtest83abcd' })).ok, true)
  assert.equal((await api('/api/room/join', { uid: newUid, roomId: host.roomId, me: { nickname: '客人' } })).ok, false)
  assert.equal((await api('/api/room/leave', guest)).ok, true)
  assert.equal((await api('/api/room/leave', host)).ok, true)
  const row = rawDb().prepare("SELECT payload FROM history WHERE room_no=? AND mode='mahjong'").get(host.roomId)
  assert.equal(JSON.parse(row.payload).seats[1].account, 'mjtest83abcd')
  assert.equal((await api('/api/account/history', { uid: newUid })).data.rows.some((r) => r.room_no === host.roomId), true)
})

test('旧快照缺少入座账号时不把设备后来登录的账号冒认为原玩家', async () => {
  const uid = await register(84)
  const created = await api('/api/room/create', { uid, me: { nickname: '旧座位' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 1000, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const host = credential(created.data, uid)
  for (let i = 0; i < 3; i++) assert.equal((await api('/api/room/add-ai', host)).ok, true)
  const initial = { matchId: created.data.matchId, handId: 0 }
  assert.equal((await api('/api/mahjong/ready', { ...host, ...initial })).ok, true)
  assert.equal((await api('/api/room/start', { ...host, ...initial })).ok, true)
  const room = rooms.get(host.roomId)
  if (room.mjTimer) clearTimeout(room.mjTimer)
  const snap = loadRoomSnapshot(host.roomId)
  delete snap.state.seats[0].account
  saveMahjongSnapshot({ roomId: host.roomId, snapshot: snap.state })
  assert.equal((await api('/api/account/logout', { uid })).ok, true)
  assert.equal((await api('/api/account/register', { uid, account: 'mjother84', nickname: '后来账号84' })).ok, true)
  rooms.delete(host.roomId)
  assert.ok(restoreRoom(loadRoomSnapshot(host.roomId)))
  assert.equal((await api('/api/room/leave', host)).ok, true)
  const row = rawDb().prepare("SELECT payload FROM history WHERE room_no=? AND mode='mahjong'").get(host.roomId)
  assert.equal(JSON.parse(row.payload).seats[0].account, null)
  assert.equal((await api('/api/account/history', { uid })).data.rows.some((r) => r.room_no === host.roomId), false)
})
