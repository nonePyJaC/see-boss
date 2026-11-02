import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.LISTEN = '0'
process.env.HAMSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'room-create-permission-'))
process.env.HAMSTER_ONLINE_CREATE_CODE = 'test-only-code'
const { server } = await import('./index.js')
const { closeDb } = await import('./db.js')
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.close(); closeDb() })
async function api(pathname, body) {
  const r = await fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return r.json()
}
const cfg = gameType => ({ mode: 'online', gameType, initialSeeds: 1000, smallBlind: 10, bigBlind: 20 })
const create = (uid, gameType, createCode = '', extra = {}) => api('/api/room/create', { uid, cfg: cfg(gameType), me: { nickname: '房主' }, createCode, ...extra })
async function leave(uid, room) {
  assert.equal((await api('/api/room/leave', { uid, roomId: room.id, seatId: room.seatId, seatToken: room.seatToken })).ok, true)
}

test('仅指定的当前登录账号无需创建码，适用于德州和南京麻将', async () => {
  assert.equal((await api('/api/account/register', { uid: 'owner-device', account: 'gaoyuan', nickname: '高原' })).ok, true)
  assert.equal((await api('/api/account/register', { uid: 'other-device', account: 'otheruser', nickname: '朋友' })).ok, true)
  assert.equal((await api('/api/account/me', { uid: 'owner-device' })).data.canCreateWithoutCode, true)
  assert.equal((await api('/api/account/me', { uid: 'other-device' })).data.canCreateWithoutCode, false)
  assert.equal((await create('other-device', 'long')).code, 'BAD_CREATE_CODE')
  assert.equal((await create('other-device', 'long', '', { account: 'gaoyuan', canCreateWithoutCode: true })).code, 'BAD_CREATE_CODE')
  assert.equal((await create('no-account', 'long', 'test-only-code')).code, 'LOGIN_REQUIRED')
  for (const game of ['long', 'nanjing']) {
    const r = await create('owner-device', game)
    assert.equal(r.ok, true, r.error)
    await leave('owner-device', r.data)
  }
  const allowed = await create('other-device', 'long', 'test-only-code')
  assert.equal(allowed.ok, true, allowed.error)
  await leave('other-device', allowed.data)
  await api('/api/account/logout', { uid: 'owner-device' })
  assert.equal((await create('owner-device', 'long')).code, 'BAD_CREATE_CODE')
  assert.equal((await create('unbound:gaoyuan', 'long')).code, 'BAD_CREATE_CODE')
  assert.equal((await create('unbound:gaoyuan', 'long', 'test-only-code')).code, 'LOGIN_REQUIRED')
  assert.equal((await api('/api/account/login', { uid: 'owner-device', account: 'gaoyuan' })).ok, true)
  delete process.env.HAMSTER_ONLINE_CREATE_CODE
  assert.equal((await create('owner-device', 'long')).code, 'CREATE_DISABLED')
})
