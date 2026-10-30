/** 每次启动独立 worker，模拟线上冷缓存；只用合成手牌。 */
import { performance } from 'node:perf_hooks'
import { createMahjongSession, setMahjongReady, startMahjongHand, submitMahjongAction, buildMahjongObservation } from '../server/mahjong-room.mjs'
import { runMahjongPolicy } from '../server/mahjong-ai-runner.mjs'
import { policyIdentity } from '../server/mahjong-ai-v2.mjs'
const seeded = (initial) => { let state = initial >>> 0; return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296) }
const samples = [], seed = 22000
for (let n = 0; n < 24; n++) {
  let session = createMahjongSession({ initialSeeds: 500, dealer: n % 4 })
  session.matchId = `cold-synthetic-${seed+n}`
  for (let seat = 0; seat < 4; seat++) session = setMahjongReady(session, seat)
  session = startMahjongHand(session, { rng: seeded(seed + n), now: 1000 })
  while (session.game.phase === 'ready') {
    const seat = session.game.readyPending[0]
    session = submitMahjongAction(session, seat, { type: 'pass' }, { ...session, now: 1001 })
  }
  const seat = session.game.turn, obs = buildMahjongObservation(session, seat), t = performance.now()
  const result = await runMahjongPolicy(obs, { identity: policyIdentity(session.matchId, seat), observationId: `${seed+n}:1:1:${seat}` })
  samples.push({ seed: seed+n, ms: performance.now() - t, fallback: result.diagnostic.fallback,
    legal: obs.myActions.some((a) => a.type === result.action?.type && (a.tile == null || a.tile === result.action?.tile)) })
}
const sorted = samples.map((s) => s.ms).sort((a,b) => a-b), p = (n) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * n))]
console.log(JSON.stringify({ kind: 'synthetic-cold-workers', count: samples.length, illegal: samples.filter((s) => !s.legal).length,
  fallbacks: samples.reduce((o, s) => { if (s.fallback) o[s.fallback] = (o[s.fallback] ?? 0) + 1; return o }, {}),
  mean: sorted.reduce((a,b) => a+b,0) / sorted.length, p95: p(.95), p99: p(.99), max: sorted.at(-1), samples }, null, 2))
