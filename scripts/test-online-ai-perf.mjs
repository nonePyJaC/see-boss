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

const HANDS = process.argv[2] == null ? 6 : Number(process.argv[2])
if (!Number.isInteger(HANDS) || HANDS < 1) throw new Error('手数上限必须是正整数')

process.env.LISTEN = '0'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-perf-'))
process.env.HAMSTER_DATA_DIR = DATA_DIR
process.env.HAMSTER_ONLINE_CREATE_CODE = '111111'

const { server, rooms, setAiDelayRange } = await import('../server/index.js')
const { closeDb } = await import('../server/db.js')
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`
setAiDelayRange(0, 0)

const CODE = '111111'
const uid = (n) => 'p-' + n + '-' + Math.random().toString(36).slice(2, 6)
const CFG = { mode: 'online', gameType: 'long', initialSeeds: 2000, smallBlind: 10, bigBlind: 20 }
const hosts = []
const stateLat = []
const elpSamples = []
let accountSequence = 0
let probe = null

async function api(p, b = {}) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  })
  if (!r.ok) throw new Error(`${p} HTTP ${r.status}`)
  return r.json()
}

async function register(u, nickname) {
  const account = `p${process.pid.toString(36)}${++accountSequence}`.slice(0, 16)
  const r = await api('/api/account/login', { uid: u, account, nickname })
  if (!r.ok) throw new Error(`register: ${r.error || r.code || 'failed'}`)
}

async function setupRoom(tag) {
  const u = uid(tag)
  await register(u, tag)
  const r = await api('/api/room/create', { uid: u, me: { nickname: tag, avatar: 1 }, createCode: CODE, cfg: CFG })
  if (!r.ok) throw new Error('create: ' + (r.error || r.code || 'failed'))
  const host = { uid: u, roomId: r.data.id, seatId: r.data.seatId, seatToken: r.data.seatToken }
  hosts.push(host)
  for (let i = 0; i < 3; i++) {
    const a = await api('/api/room/add-ai', {
      uid: u, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
    })
    if (!a.ok) throw new Error('add-ai: ' + (a.error || a.code || 'failed'))
  }
  return host
}

async function driveHand(host) {
  for (let i = 0; i < 800; i++) {
    const t0 = performance.now()
    const r = await api('/api/room/state', { roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken })
    stateLat.push(performance.now() - t0)
    if (!r.ok || !r.data) throw new Error('state: ' + (r.error || r.code || 'missing data'))
    const st = r.data
    if (st.finished) return st
    if (st.turnUid === host.seatId) {
      if (!Array.isArray(st.avail) || st.avail.length === 0) throw new Error('human turn has no legal actions')
      const t = st.avail.map((a) => a.type)
      const type = t.includes('check') ? 'check' : 'call'
      const action = await api('/api/room/action', {
        uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
        handId: st.handId, turnSeq: st.turnSeq, type,
      })
      if (!action.ok) throw new Error('action: ' + (action.error || action.code || 'failed'))
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
  throw new Error(`hand stuck in room ${host.roomId}`)
}

async function sample() {
  // 事件循环延迟探针：10ms tick 的实际间隔漂移
  let last = performance.now()
  probe = setInterval(() => {
    const now = performance.now()
    elpSamples.push(now - last - 10)
    last = now
  }, 10)
  probe.unref?.()

  const rss0 = process.memoryUsage().rss
  const t0 = performance.now()
  const A = await setupRoom('A房主')
  const B = await setupRoom('B房主')

  // 故障注入控制（review C-R3）：AI_PERF_FAULT=persona-params 让每个 AI 人设的
  // params 读取抛错 → decideAction 全程安全降级。正常门禁必须因此非零退出，
  // 而不是输出漂亮的 0ms 假成绩。注入点在 add-ai 之后、首手开始之前。
  if (process.env.AI_PERF_FAULT === 'persona-params') {
    for (const host of [A, B]) {
      for (const persona of rooms.get(host.roomId)?.aiRuntime?.personas.values() ?? []) {
        Object.defineProperty(persona, 'params', {
          configurable: true,
          get() { throw new Error('AI_PERF_FAULT=persona-params 注入故障') },
        })
      }
    }
  }

  let hands = 0
  for (let h = 0; h < HANDS; h++) {
    for (const host of [A, B]) {
      const s = await api('/api/room/start', {
        uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
      })
      if (!s.ok || !s.data) throw new Error('start: ' + (s.error || s.code || 'missing data'))
    }
    const completed = await Promise.all([driveHand(A), driveHand(B)])
    if (!completed.every((state) => state.finished)) throw new Error('a room did not finish its hand')
    hands += completed.length
  }

  const rss1 = process.memoryUsage().rss
  const wallMs = performance.now() - t0
  const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(s.length * p / 100))]
  }
  const aiStats = [A, B].map((host) => rooms.get(host.roomId)?.aiStats)
  const aiSamples = aiStats.flatMap((stats) => stats?.samples ?? [])

  if (hands !== HANDS * 2) throw new Error(`completed ${hands} hands; expected ${HANDS * 2}`)
  if (stateLat.length === 0) throw new Error('zero state samples')
  if (elpSamples.length === 0) throw new Error('zero event-loop samples')
  if (aiSamples.length === 0) throw new Error('zero AI samples')
  if (aiStats.some((stats) => !stats || stats.decisions === 0 || stats.samples.length !== stats.decisions)) {
    throw new Error('AI sample counts do not match decisions in both rooms')
  }
  const degraded = aiStats.reduce((sum, stats) => sum + (stats?.degraded ?? 0), 0)
  if (degraded > 0) {
    throw new Error(`AI 决策降级 ${degraded} 次：样本来自兜底而非真实策略，性能成绩无效`)
  }

  // ── 汇总 ──
  console.log('\n===== §12 门禁数据点 =====')
  console.log(`手数：${hands}（2 房并行），总耗时 ${(wallMs / 1000).toFixed(1)}s`)
  console.log(`AI 决策：${aiSamples.length} 次`)
  console.log(`  P50=${pct(aiSamples, 50).toFixed(1)}ms  P95=${pct(aiSamples, 95).toFixed(1)}ms  P99=${pct(aiSamples, 99).toFixed(1)}ms  max=${Math.max(...aiSamples).toFixed(1)}ms`)
  console.log(`state RTT：${stateLat.length} 次`)
  console.log(`  P50=${pct(stateLat, 50).toFixed(1)}ms  P95=${pct(stateLat, 95).toFixed(1)}ms  P99=${pct(stateLat, 99).toFixed(1)}ms`)
  console.log(`事件循环漂移：${elpSamples.length} 次`)
  console.log(`  P50=${pct(elpSamples, 50).toFixed(1)}ms  P99=${pct(elpSamples, 99).toFixed(1)}ms  max=${Math.max(...elpSamples).toFixed(1)}ms`)
  console.log(`RSS：${(rss0 / 1048576).toFixed(0)}MB → ${(rss1 / 1048576).toFixed(0)}MB`)

  for (const [i, stats] of aiStats.entries()) {
    console.log(`  房${i + 1} aiStats: ${JSON.stringify({ decisions: stats.decisions, degraded: stats.degraded ?? 0, maxMs: stats.maxMs.toFixed(1) })}`)
  }
}

// 收尾
let mainError
const cleanupErrors = []
try {
  await sample()
} catch (error) {
  mainError = error
} finally {
  if (probe) clearInterval(probe)
  for (const host of hosts) {
    try {
      const response = await api('/api/room/leave', {
        uid: host.uid, roomId: host.roomId, seatId: host.seatId, seatToken: host.seatToken,
      })
      if (!response.ok && response.code !== 'ROOM_NOT_FOUND') throw new Error(response.error || response.code || 'leave failed')
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (rooms.size !== 0) cleanupErrors.push(new Error(`rooms remain after cleanup: ${rooms.size}`))
  try {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    closeDb()
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch (error) {
    cleanupErrors.push(error)
  }
}
if (mainError && cleanupErrors.length) {
  throw new AggregateError([mainError, ...cleanupErrors], 'performance run and cleanup failed')
}
if (mainError) throw mainError
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'performance script cleanup failed')
