import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { captureSeatRequest, isCurrentSeatRequest } from '../client/src/lib/seat-state-request.mjs'

process.env.LISTEN = '0'
process.env.HAMSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'online-seat-client-'))
process.env.HAMSTER_ONLINE_CREATE_CODE = '111111'
const { server } = await import('../server/index.js')
const { closeDb } = await import('../server/db.js')
const repo = await import('../client/src/data/room-repo.js')
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const realFetch = globalThis.fetch, realInterval = globalThis.setInterval, realClear = globalThis.clearInterval
const priorStorage = globalThis.localStorage, priorLocation = globalThis.location
const saved = new Map(), hosts = [], watchers = []
let ticks = [], delayState = null, sequence = 0
globalThis.localStorage = { getItem: (k) => saved.get(k) ?? null,
  setItem: (k, v) => saved.set(k, String(v)), removeItem: (k) => saved.delete(k) }
globalThis.location = { search: '', hash: '' }
// 只拦客户端的轮询定时器；服务端回合计时仍使用真实 setTimeout。
globalThis.setInterval = (tick) => { ticks.push(tick); return tick }
globalThis.clearInterval = () => {}
globalThis.fetch = async (url, options) => {
  if (url === '/api/room/state' && delayState) {
    const delayed = delayState
    delayState = null
    delayed.queued.resolve()
    await delayed.release.promise
    const response = await realFetch(new URL(url, base), options)
    delayed.done.resolve()
    return response
  }
  return realFetch(new URL(url, base), options)
}
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
async function api(route, body) {
  const response = await realFetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json()
  assert.equal(value.ok, true, value.error)
  return value.data
}
async function fixture() {
  const n = ++sequence, hostUid = 'seat-host-' + n, guestUid = 'seat-guest-' + n
  await api('/api/account/register', { uid: hostUid, account: 'seathost' + n, nickname: '房主测' + n })
  await api('/api/account/register', { uid: guestUid, account: 'seatguest' + n, nickname: '朋友测' + n })
  const created = await api('/api/room/create', { uid: hostUid, createCode: '111111',
    me: { nickname: '房主测' + n }, cfg: { mode: 'online', gameType: 'long', initialSeeds: 1000, smallBlind: 10, bigBlind: 20 } })
  const host = { uid: hostUid, roomId: created.id, seatId: created.seatId, seatToken: created.seatToken }
  hosts.push(host)
  saved.set('hamster-poker:uid', guestUid)
  return { host, roomId: created.id, guestUid }
}
function delayNextState() {
  const delayed = { queued: deferred(), release: deferred(), done: deferred() }
  delayState = delayed
  return delayed
}
test.afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.stop()
  for (const host of hosts.splice(0)) await api('/api/room/leave', host)
  ticks = []; delayState = null; saved.clear()
})
test.after(async () => {
  globalThis.fetch = realFetch; globalThis.setInterval = realInterval; globalThis.clearInterval = realClear
  globalThis.localStorage = priorStorage; globalThis.location = priorLocation
  await new Promise((resolve) => server.close(resolve)); closeDb()
  fs.rmSync(process.env.HAMSTER_DATA_DIR, { recursive: true, force: true })
})

test('真实入座开局后，迟到的匿名回包不得清空朋友的新凭证或底牌', async () => {
  const { host, roomId } = await fixture()
  let cred = null, state = null, accepted = 0
  const delayed = delayNextState()
  const watcher = repo.watchRoom(roomId, (r) => {
    accepted++; state = r.data
    if (cred && !state.seats.some((s) => s.isMe)) cred = null
  }, undefined, () => cred)
  watchers.push(watcher)
  await delayed.queued.promise
  try {
    const joined = await repo.joinRoom(roomId, { nickname: '朋友' })
    assert.equal(joined.ok, true)
    cred = { seatId: joined.data.seatId, seatToken: joined.data.seatToken }
    repo.saveSeatCred(roomId, joined.data)
    await api('/api/room/start', host)
    state = (await repo.onlineState(roomId, cred)).data
    assert.equal(state.myCards.length, 2)
    const newCred = { ...cred }
    delayed.release.resolve(); await delayed.done.promise; await nextTurn()
    assert.equal(accepted, 0, '即使匿名回包的rev等于最新rev，也必须丢弃')
    assert.deepEqual(cred, newCred)
    assert.equal(state.myCards.length, 2)
    await ticks[0]()
    assert.equal(accepted, 1, '后续携带新凭证的轮询正常交付')
    assert.equal(state.seats.find((s) => s.isMe).uid, cred.seatId)
    assert.equal(state.myCards.length, 2)
    assert.deepEqual(repo.loadSeatCred(roomId), cred)
  } finally { delayed.release.resolve() }
})

test('同座位换发令牌后丢弃旧令牌响应，随后刷新仍取得本人的两张牌', async () => {
  const { host, roomId } = await fixture()
  const first = await repo.joinRoom(roomId, { nickname: '朋友' })
  let cred = { seatId: first.data.seatId, seatToken: first.data.seatToken }, responses = []
  await api('/api/room/start', host)
  const delayed = delayNextState()
  watchers.push(repo.watchRoom(roomId, (r) => responses.push(r), undefined, () => cred))
  await delayed.queued.promise
  try {
    const renewed = await repo.joinRoom(roomId, { nickname: '朋友' })
    assert.equal(renewed.ok, true)
    assert.equal(renewed.data.seatId, cred.seatId)
    assert.notEqual(renewed.data.seatToken, cred.seatToken)
    cred = { seatId: renewed.data.seatId, seatToken: renewed.data.seatToken }
    delayed.release.resolve(); await delayed.done.promise; await nextTurn()
    assert.equal(responses.length, 0)
    await ticks[0]()
    assert.equal(responses.length, 1)
    assert.equal(responses[0].data.myCards.length, 2)
  } finally { delayed.release.resolve() }
})

test('始终没有座位的旁观者仍能看公共局面且看不到任何底牌', async () => {
  const { roomId } = await fixture()
  let response
  watchers.push(repo.watchRoom(roomId, (r) => { response = r }, undefined, () => null))
  while (!response) await nextTurn()
  assert.equal(response.ok, true)
  assert.ok(!response.data.seats.some((s) => s.isMe))
  assert.equal(response.data.myCards, undefined)
})

test('首次拉取和入座响应绑定原房间，换房或凭证原地变化后判为过期', () => {
  const cred = { seatId: 'seat-a', seatToken: 'test-token' }
  const request = captureSeatRequest('123456', cred)
  assert.equal(isCurrentSeatRequest(request, '123456', { ...cred }), true)
  assert.equal(isCurrentSeatRequest(request, '654321', cred), false)
  cred.seatToken = 'renewed-test-token'
  assert.equal(isCurrentSeatRequest(request, '123456', cred), false)
  assert.equal(isCurrentSeatRequest(captureSeatRequest('123456', null), '123456', cred), false)
})
