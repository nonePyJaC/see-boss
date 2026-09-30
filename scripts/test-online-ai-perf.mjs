/**
 * 线上 AI 性能采样脚本（§12 门禁数据点）。
 *
 * 在进程内起服务，开 2 个房间（各 1 真人 + 3 AI），AI 延迟压成 0，
 * 连续打 N 手牌，全程采样：
 *   - AI 单次决策耗时（服务端 room.aiStats.samples）
 *   - /api/room/state 往返延迟（AI 行动期间）
 *   - Node 事件循环延迟（5ms 探针漂移）
 *   - RSS
 *
 * 门禁（目标 2 核 2G 机复核，本机只做开发期数据点）：
 *   决策 P95 ≤120ms；state P95 ≤250ms；事件循环 P99 ≤150ms；RSS ≤300MB
 *
 * 运行：node scripts/test-online-ai-perf.mjs [手数上限]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.LISTEN = '0'
process.env.HAMSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-perf-'))
process.env.HAMSTER_ONLINE_CREATE_CODE = '111111'

const HANDS = Number(process.argv[2]) || 6

const { server, rooms, setAiDelayRange } = await import('../server/index.js')
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`
setAiDelayRange(0, 0)

const CODE = '111111'
const uid = (n) => 'p-' + n + '-' + Math.random().toString(36).slice(2, 6)
const CFG = { mode: 'online', gameType: 'long', initialSeeds: 2000, smallBlind: 10, bigBlind: 20 }

async function api(p, b = {}) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  })
  return r.json()
}

async function setupRoom(tag) {
  const u = uid(tag)
  const r = await api('/api/room/create', { uid: u, me: { nickname: tag, avatar: 1 }, createCode: CODE, cfg: CFG })
  if (!r.ok) throw new Error('create: ' + r.error)
  const host = { uid: u, roomId: r.data.id, seatId: r.data.seatId, seatToken: r.data.seatToken }
  for (let i = 0; i < 3; i++) {
    const a = await api('/api/room/add-ai', {
      uid: u, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
    })
    if (!a.ok) throw new Error('add-ai: ' + a.error)
  }
  return host
}

const stateLat = []
async function driveHand(host) {
  for (let i = 0; i < 800; i++) {
    const t0 = performance.now()
    const r = await api('/api/room/state', { roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken })
    stateLat.push(performance.now() - t0)
    const st = r.data
    if (st.finished) return st
    if (st.turnUid === host.seatId && st.avail?.length) {
      const t = st.avail.map((a) => a.type)
      const type = t.includes('check') ? 'check' : 'call'
      await api('/api/room/action', {
        uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
        handId: st.handId, turnSeq: st.turnSeq, type,
      })
    } else {
      await new Promise((r2) => setTimeout(r2, 15))
    }
  }
  throw new Error('hand stuck')
}

// 事件循环延迟探针：10ms tick 的实际间隔漂移
const elpSamples = []
{
  let last = performance.now()
  const t = setInterval(() => {
    const now = performance.now()
    elpSamples.push(now - last - 10)
    last = now
  }, 10)
  t.unref?.()
}

const rss0 = process.memoryUsage().rss
const t0 = performance.now()

const A = await setupRoom('A房主')
const B = await setupRoom('B房主')

let hands = 0
for (let h = 0; h < HANDS; h++) {
  for (const host of [A, B]) {
    const s = await api('/api/room/start', {
      uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
    })
    if (!s.ok) throw new Error('start: ' + s.error)
  }
  // 两房并行推进
  await Promise.all([driveHand(A), driveHand(B)])
  hands += 2
}

const rss1 = process.memoryUsage().rss
const wallMs = performance.now() - t0

// ── 汇总 ──
const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p / 100))]
}

const aiSamples = [A, B].flatMap((h) => rooms.get(h.roomId)?.aiStats.samples ?? [])
const aiStats = [A, B].map((h) => rooms.get(h.roomId)?.aiStats)

console.log('\n===== §12 门禁数据点 =====')
console.log(`手数：${hands}（2 房并行），总耗时 ${(wallMs / 1000).toFixed(1)}s`)
console.log(`AI 决策：${aiSamples.length} 次`)
console.log(`  P50=${pct(aiSamples, 50).toFixed(1)}ms  P95=${pct(aiSamples, 95).toFixed(1)}ms  P99=${pct(aiSamples, 99).toFixed(1)}ms  max=${Math.max(...aiSamples).toFixed(1)}ms`)
console.log(`state RTT：${stateLat.length} 次`)
console.log(`  P50=${pct(stateLat, 50).toFixed(1)}ms  P95=${pct(stateLat, 95).toFixed(1)}ms  P99=${pct(stateLat, 99).toFixed(1)}ms`)
console.log(`事件循环漂移：${elpSamples.length} 次`)
console.log(`  P50=${pct(elpSamples, 50).toFixed(1)}ms  P99=${pct(elpSamples, 99).toFixed(1)}ms  max=${Math.max(...elpSamples).toFixed(1)}ms`)
console.log(`RSS：${(rss0 / 1048576).toFixed(0)}MB → ${(rss1 / 1048576).toFixed(0)}MB`)

for (const [i, h] of [A, B].entries()) {
  console.log(`  房${i + 1} aiStats: ${JSON.stringify({ ...h2o(aiStats[i]) })}`)
}
function h2o(s) { return s ? { decisions: s.decisions, maxMs: s.maxMs.toFixed(1) } : null }

// 收尾
for (const h of [A, B]) {
  await api('/api/room/leave', { uid: h.uid, roomId: h.roomId, seatId: h.seatId, seatToken: h.seatToken })
}
server.close()
process.exit(0)
