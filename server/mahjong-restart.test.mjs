import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { createWall } from '../shared/logic/mahjong/online-wall.mjs'
import { isFlower } from '../shared/logic/mahjong/tiles.mjs'
import { dealSeatSequence } from '../shared/logic/mahjong/online-game.mjs'
import { startMahjongHand, submitMahjongAction } from './mahjong-room.mjs'

async function freePort() {
  const socket = net.createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('独立服务进程重启后恢复麻将座位和正在进行的手牌', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-mj-restart-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let child
  t.after(async () => { if (child && child.exitCode == null) { child.kill(); await once(child, 'exit') } })
  async function boot() {
    child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(),
      env: { ...process.env, LISTEN: '1', PORT: String(port), HAMSTER_DATA_DIR: dir, HAMSTER_ONLINE_CREATE_CODE: 'test-code', NODE_ENV: 'test' },
      stdio: 'ignore', windowsHide: true })
    for (let i = 0; i < 120; i++) {
      if (child.exitCode != null) throw new Error('服务进程提前退出')
      try { if ((await fetch(base + '/health')).ok) return } catch { /* 等待监听 */ }
      await pause(100)
    }
    throw new Error('服务未启动')
  }
  async function api(url, body) {
    const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return response.json()
  }
  await boot()
  const uid = 'restart-user'
  assert.equal((await api('/api/account/register', { uid, account: 'mjrestart123', nickname: '恢复测试' })).ok, true)
  const created = await api('/api/room/create', { uid, me: { nickname: '恢复测试' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 1000, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const cred = { uid, roomId: created.data.id, seatId: created.data.seatId, seatToken: created.data.seatToken }
  for (let i = 0; i < 3; i++) assert.equal((await api('/api/room/add-ai', cred)).ok, true)
  const initial = { matchId: created.data.matchId, handId: 0 }
  assert.equal((await api('/api/mahjong/ready', { ...cred, ...initial })).ok, true)
  assert.equal((await api('/api/room/start', { ...cred, ...initial })).ok, true)
  let before
  for (let i = 0; i < 100; i++) {
    before = (await api('/api/room/state', cred)).data
    if (before.phase === 'turn' && before.turn === 0) break
    await pause(50)
  }
  assert.equal(before.phase, 'turn')
  assert.equal(before.turn, 0)
  child.kill()
  await once(child, 'exit')
  await boot()
  const after = await api('/api/room/state', cred)
  assert.equal(after.ok, true, after.error)
  assert.equal(after.data.matchId, before.matchId)
  assert.equal(after.data.handId, before.handId)
  assert.equal(after.data.windowId, before.windowId)
  assert.equal(after.data.deadlineAt, before.deadlineAt)
  assert.deepEqual(after.data.myHand, before.myHand)
  assert.deepEqual(after.data.wallLayout, before.wallLayout)
  assert.equal((await api('/api/room/leave', cred)).ok, true)
})

test('启动清理过期快照时保留麻将战绩，包括房号被其他玩法复用', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-mj-expiry-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let child
  t.after(async () => { if (child && child.exitCode == null) { child.kill(); await once(child, 'exit') } })
  async function boot() {
    child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(),
      env: { ...process.env, LISTEN: '1', PORT: String(port), HAMSTER_DATA_DIR: dir, HAMSTER_ONLINE_CREATE_CODE: 'test-code', NODE_ENV: 'test' },
      stdio: 'ignore', windowsHide: true })
    for (let i = 0; i < 120; i++) {
      if (child.exitCode != null) throw new Error('服务进程提前退出')
      try { if ((await fetch(base + '/health')).ok) return } catch { /* 等待监听 */ }
      await pause(100)
    }
    throw new Error('服务未启动')
  }
  await boot()
  const uid = 'expiry-user'
  const req = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  assert.equal((await req('/api/account/register', { uid, account: 'mjexpiry123', nickname: '过期测试' })).ok, true)
  child.kill(); await once(child, 'exit')
  const db = new DatabaseSync(path.join(dir, 'hamster.db'))
  for (const [roomId, mode] of [['123456', 'mahjong'], ['234567', 'offline']]) {
    db.prepare("INSERT INTO room_snapshots (room_id, mode, state, updated_at) VALUES (?, ?, '{}', datetime('now','-2 days'))").run(roomId, mode)
    db.prepare("INSERT INTO history (room_no, mode, round_no, payload, created_by) VALUES (?, 'mahjong', 1, '{}', 'mjexpiry123')").run(roomId)
  }
  db.close()
  await boot()
  const history = await req('/api/account/history', { uid })
  assert.equal(history.ok, true)
  assert.deepEqual(history.data.rows.map((r) => r.room_no).sort(), ['123456', '234567'])
  const check = new DatabaseSync(path.join(dir, 'hamster.db'))
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM room_snapshots').get().n, 0)
  check.close()
})

test('起手花杠和旧暗杠结束态经真实重启后均可同房重开', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-mj-ended-'))
  const port = await freePort(), base = `http://127.0.0.1:${port}`
  let child
  t.after(async () => { if (child && child.exitCode == null) { child.kill(); await once(child, 'exit') } })
  async function boot() {
    child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(),
      env: { ...process.env, LISTEN: '1', PORT: String(port), HAMSTER_DATA_DIR: dir, HAMSTER_ONLINE_CREATE_CODE: 'test-code', NODE_ENV: 'test' },
      stdio: 'ignore', windowsHide: true })
    for (let i = 0; i < 120; i++) {
      if (child.exitCode != null) throw new Error('服务进程提前退出')
      try { if ((await fetch(base + '/health')).ok) return } catch { /* 等待监听 */ }
      await pause(100)
    }
    throw new Error('服务未启动')
  }
  const req = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  function arrangedWall(dealerTiles) {
    const tiles = createWall(() => 0.5)
    const dealer = dealerTiles.map((tile) => {
      const index = tiles.indexOf(tile); assert.ok(index >= 0); return tiles.splice(index, 1)[0]
    })
    const fill = (a, n) => { while (a.length < n) a.push(tiles.splice(tiles.findIndex((x) => !isFlower(x)), 1)[0]) }
    fill(dealer, 14); const others = [[], [], []]; for (const hand of others) fill(hand, 13)
    const hands = [dealer, ...others]
    return [...dealSeatSequence(0).map((s) => hands[s].shift()), ...tiles]
  }
  await boot()
  const uid = 'ended-restart-user'
  assert.equal((await req('/api/account/register', { uid, account: 'mjended123', nickname: '结束恢复' })).ok, true)
  const created = await req('/api/room/create', { uid, me: { nickname: '结束恢复' }, createCode: 'test-code',
    cfg: { mode: 'online', gameType: 'nanjing', initialSeeds: 10, dealerSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const cred = { uid, roomId: created.data.id, seatId: created.data.seatId, seatToken: created.data.seatToken }
  for (let i = 0; i < 3; i++) assert.equal((await req('/api/room/add-ai', cred)).ok, true)
  let identity = { matchId: created.data.matchId, handId: 0 }
  for (const flowerCase of [true, false]) {
    assert.equal((await req('/api/mahjong/ready', { ...cred, ...identity })).ok, true)
    child.kill(); await once(child, 'exit')
    const db = new DatabaseSync(path.join(dir, 'hamster.db'))
    const row = db.prepare('SELECT state FROM room_snapshots WHERE room_id=?').get(cred.roomId)
    const snapshot = JSON.parse(row.state)
    let session = startMahjongHand(snapshot.session, { wall: arrangedWall(flowerCase ? ['f1', 'f2', 'f3', 'f4'] : ['1m', '1m', '1m', '1m']) })
    if (!flowerCase) {
      while (session.game.phase === 'ready') session = submitMahjongAction(session, session.game.readyPending[0], { type: 'pass' }, session)
      session.game.initialDealerTurn = false
      session.game.players[0].lastDraw = '1m'
      session.game.balances = [10, 5, 5, 20]
      session = submitMahjongAction(session, 0, { type: 'ankong', tile: '1m' }, session)
      session.game.players[0].lastDraw = '1m' // 模拟旧版本已落盘状态
    }
    assert.equal(session.game.result.matchOver, true)
    if (flowerCase) assert.equal(session.windowId, 0)
    snapshot.session = session
    db.prepare('UPDATE room_snapshots SET state=? WHERE room_id=?').run(JSON.stringify(snapshot), cred.roomId)
    db.close()
    await boot()
    const state = await req('/api/room/state', cred)
    assert.equal(state.ok, true, state.error)
    assert.equal(state.data.result.matchOver, true)
    const reset = await req('/api/mahjong/reset', { ...cred, matchId: session.matchId, handId: session.handId })
    assert.equal(reset.ok, true, reset.error)
    assert.notEqual(reset.data.matchId, session.matchId)
    identity = { matchId: reset.data.matchId, handId: reset.data.handId }
  }
  assert.equal((await req('/api/room/leave', cred)).ok, true)
})
