/**
 * 双身份实测：小麦大麦轮转 + 金瓜子互见
 *
 * 浏览器里 signInAnonymously 是幂等的（已有会话时不会新建身份），
 * 所以直接用 fetch 走 CloudBase 匿名登录 + PostgREST，
 * 在同一进程里维持多个独立 JWT。
 *
 * 用法: node scripts/test-blind-rotation.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
// SDK 装在 client/node_modules
const require = createRequire(path.join(ROOT, '..', 'client', 'index.cjs'))
const cloudbase = require('@cloudbase/js-sdk')

const ENV_ID = 'see-boss-d2gjggfbz8808d1d4'
const REGION = 'ap-shanghai'
const KEY = fs.readFileSync(path.join(ROOT, '..', 'client', '.env'), 'utf8')
  .match(/VITE_CLOUDBASE_PUBLISHABLE_KEY=(.+)/)[1].trim()

const URL_ = `https://${ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest`

/** 匿名登录，返回 { jwt, uid, db } */
async function anonLogin() {
  const app = cloudbase.init({ env: ENV_ID, accessKey: KEY, region: REGION })
  await app.auth.signInAnonymously()
  const st = await app.auth.getLoginState()
  const uid = st.user.uid
  const jwt = st.credentials?.access_token || st.access_token
  if (!jwt) throw new Error('拿不到 access_token')

  const call = (method, p, body) =>
    fetch(URL_ + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        Prefer: 'return=representation',
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.text() }))

  return {
    uid,
    api: {
      async rpc(fn, args) {
        const { status, body } = await call('POST', `/rpc/${fn}`, args)
        if (status >= 400) {
          let msg = body
          try {
            const j = JSON.parse(body)
            msg = j.message || j.hint || j.details || body
          } catch {}
          return { ok: false, status, message: msg }
        }
        return { ok: true, status, data: body ? JSON.parse(body) : null }
      },

      async insert(table, row) {
        const { status, body } = await call('POST', `/${table}`, row)
        if (status >= 400) return { ok: false, status, message: body }
        return { ok: true, status, data: JSON.parse(body || '[]') }
      },

      async select(table, qs) {
        const { status, body } = await call('GET', `/${table}?${qs}`)
        if (status >= 400) return { ok: false, status, message: body }
        return { ok: true, status, data: JSON.parse(body || '[]') }
      },

      async delete(table, qs) {
        const { status, body } = await call('DELETE', `/${table}?${qs}`)
        return { ok: status < 400, status, message: body }
      },
    },
  }
}

/** SDK 把凭据写进全局 localStorage，这里给 Node 一个最小 shim */
let localStorageShim
function localStorageShimGet(app) {
  return localStorageShim.get('credentials_' + ENV_ID)
}

if (typeof globalThis.localStorage === 'undefined') {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
  localStorageShim = globalThis.localStorage
}

function actor(jwt) {
  const call = (method, path, body) =>
    fetch(URL_ + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        Prefer: 'return=representation',
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.text() }))

  return {
    /** RPC，返回 { ok, data } 或 { ok:false, message } */
    async rpc(fn, args) {
      const { status, body } = await call('POST', `/rpc/${fn}`, args)
      if (status >= 400) {
        let msg = body
        try {
          const j = JSON.parse(body)
          msg = j.message || j.hint || j.details || body
        } catch {}
        return { ok: false, status, message: msg }
      }
      return { ok: true, status, data: body ? JSON.parse(body) : null }
    },

    async insert(table, row) {
      const { status, body } = await call('POST', `/${table}`, row)
      if (status >= 400) return { ok: false, status, message: body }
      return { ok: true, status, data: JSON.parse(body || '[]') }
    },

    async select(table, qs) {
      const { status, body } = await call('GET', `/${table}?${qs}`)
      if (status >= 400) return { ok: false, status, message: body }
      return { ok: true, status, data: JSON.parse(body || '[]') }
    },

    async delete(table, qs) {
      const { status, body } = await call('DELETE', `/${table}?${qs}`)
      return { ok: status < 400, status, message: body }
    },
  }
}

const logins = await Promise.all([anonLogin(), anonLogin(), anonLogin()])
const [a, b, c] = logins.map((l) => ({ ...l, api: actor(l.jwt) }))
console.log('uidA =', a.uid)
console.log('uidB =', b.uid)
console.log('uidC =', c.uid)

for (const [x, nick] of [[a, '玩家A'], [b, '玩家B'], [c, '玩家C']]) {
  await x.api.insert('users', { id: x.uid, nickname: nick, avatar: 1, golden_seeds: 0, total_games: 0 })
}

const roomNo = String(Math.floor(100000 + Math.random() * 900000))
await a.api.insert('rooms', {
  id: roomNo, mode: 'offline', game_type: 'long', host_uid: a.uid,
  initial_seeds: 1000, small_blind: 10, big_blind: 20, max_seats: 8, status: 'waiting',
})
await a.api.insert('room_members', { room_id: roomNo, user_id: a.uid, seat_no: 1, nickname: '玩家A', avatar: 1, seeds: 1000 })
await b.api.insert('room_members', { room_id: roomNo, user_id: b.uid, seat_no: 2, nickname: '玩家B', avatar: 1, seeds: 1000 })
await c.api.insert('room_members', { room_id: roomNo, user_id: c.uid, seat_no: 3, nickname: '玩家C', avatar: 1, seeds: 1000 })
console.log('\n房间 =', roomNo)

const medals = (seats) =>
  seats.map((s) => `${s.nickname}=${s.blind ? (s.blind === 'sb' ? '小麦' : '大麦') : '空'}`).join('  ')

async function showBlinds(tag) {
  const r = await a.api.rpc('room_snapshot', { p_room_id: roomNo, p_guest: false })
  if (!r.ok) throw new Error('snapshot 失败: ' + r.message)
  console.log(`${tag}: ${medals(r.data.seats)}`)
  return r.data
}

// 第一轮：A 小 B 大
let r = await a.api.rpc('set_blinds', { p_room_id: roomNo, p_sb_uid: a.uid, p_bb_uid: b.uid })
if (!r.ok) throw new Error('set_blinds 失败: ' + r.message)
await showBlinds('初始（A 小 B 大）')

await a.api.rpc('rotate_blinds', { p_room_id: roomNo })
await showBlinds('第1次收款后期望 A空 B小 C大')

await a.api.rpc('rotate_blinds', { p_room_id: roomNo })
await showBlinds('第2次收款后期望 B空 C小 A大')

await a.api.rpc('rotate_blinds', { p_room_id: roomNo })
await showBlinds('第3次收款后期望 C空 A小 B大')

// ── 金瓜子互见 ──
await b.api.rpc('transfer_seeds', { p_from_uid: b.uid, p_to_uid: a.uid, p_amount: 3 })
const ga = await a.api.select('users', `id=eq.${a.uid}&select=id,golden_seeds`)
const gb = await a.api.select('users', `id=eq.${b.uid}&select=id,golden_seeds`)
const gc = await a.api.select('users', `id=eq.${c.uid}&select=id,golden_seeds`)
console.log('\n互见测试（A 的视角读同房间用户的 users 行）:')
console.log('  A =', ga.ok ? ga.data[0]?.golden_seeds : '读不到 ' + ga.message)
console.log('  B =', gb.ok ? gb.data[0]?.golden_seeds : '读不到 ' + gb.message)
console.log('  C =', gc.ok ? gc.data[0]?.golden_seeds : '读不到（RLS 未放开）')

// ── 非房主轮转，应被拒 ──
const bad = await b.api.rpc('rotate_blinds', { p_room_id: roomNo })
console.log('\n非房主轮转:', bad.ok ? '未被拒绝（BUG）' : '被正确拒绝 → ' + bad.message)

// ── 非房主拖拽排序，应被拒 ──
const bad2 = await b.api.rpc('reorder_seats', { p_room_id: roomNo, p_uids: [b.uid, c.uid, a.uid] })
console.log('非房主排序:', bad2.ok ? '未被拒绝（BUG）' : '被正确拒绝 → ' + bad2.message)

// ── 清理 ──
await a.api.delete('room_members', `room_id=eq.${roomNo}`)
await a.api.delete('rooms', `id=eq.${roomNo}`)
console.log('\n已清理测试房间', roomNo)
