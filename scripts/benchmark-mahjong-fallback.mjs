/** 合成冷启动回退质量和耗时；不读取实战记录。 */
import { performance } from 'node:perf_hooks'
import { createMahjongSession, setMahjongReady, startMahjongHand, submitMahjongAction, buildMahjongObservation } from '../server/mahjong-room.mjs'
import { safeMahjongAction as v1, mahjongShanten, mahjongVisibleCounts, mahjongEffectiveTiles } from '../server/mahjong-ai-v1.mjs'
import { boundedFallback, FALLBACK_BUDGET_MS } from '../server/mahjong-ai-fallback.mjs'
import { NUMBER_TILES } from '../shared/logic/mahjong/tiles.mjs'
const seeded = (initial) => { let s = initial >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) }
const startSeed = Number(process.env.MJ_FALLBACK_SEED ?? 33000), count = Number(process.env.MJ_FALLBACK_SAMPLES ?? 64)
const samples = [], totals = { illegal: 0, exhausted: 0, heuristicOnly: 0, slower: 0, same: 0, faster: 0, narrowed: 0, widened: 0 }
for (let n = 0; n < count; n++) {
  let session = createMahjongSession({ initialSeeds: 500, dealer: n % 4 })
  for (let i = 0; i < 4; i++) session = setMahjongReady(session, i)
  session = startMahjongHand(session, { rng: seeded(startSeed + n), now: 1000 })
  while (session.game.phase === 'ready') {
    const seat = session.game.readyPending[0]
    session = submitMahjongAction(session, seat, { type: 'pass' }, { ...session, now: 1001 })
  }
  const seat = session.game.turn, obs = buildMahjongObservation(session, seat), reference = v1(obs)
  const start = performance.now(), candidate = boundedFallback(obs), ms = performance.now() - start
  if (!obs.myActions.some((a) => a.type === candidate.action?.type && (a.tile == null || a.tile === candidate.action.tile))) totals.illegal++
  if (candidate.exhausted) totals.exhausted++
  if (candidate.method === 'shape-heuristic') totals.heuristicOnly++
  let referenceDistance = null, actualDistance = null, referenceEffective = null, actualEffective = null
  if (reference?.type === 'discard' && candidate.action?.type === 'discard') {
    const remaining = (t) => { const h = obs.myHand.slice(); h.splice(h.indexOf(t), 1); return h }
    const groups = obs.players[seat].melds.filter((m) => ['pong','kong','pongkong','ankong'].includes(m.type)).length
    referenceDistance = mahjongShanten(remaining(reference.tile), groups); actualDistance = mahjongShanten(remaining(candidate.action.tile), groups)
    totals[actualDistance > referenceDistance ? 'slower' : actualDistance < referenceDistance ? 'faster' : 'same']++
    if (actualDistance === referenceDistance) {
      const known = mahjongVisibleCounts(obs)
      referenceEffective = mahjongEffectiveTiles(remaining(reference.tile), groups, known).count
      actualEffective = mahjongEffectiveTiles(remaining(candidate.action.tile), groups, known).count
      if (actualEffective < referenceEffective) totals.narrowed++
      if (actualEffective > referenceEffective) totals.widened++
    }
  }
  samples.push({ seed: startSeed + n, hand: obs.myHand, seat, reference, actual: candidate.action, referenceDistance, actualDistance,
    referenceEffective, actualEffective, elapsedMs: ms, exhausted: candidate.exhausted, evaluated: candidate.evaluated, method: candidate.method })
}
const times = samples.map((s) => s.elapsedMs).sort((a,b) => a-b), pct = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))]
const readyHand = ['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E']
const readySamples = []
for (const draw of NUMBER_TILES.filter((tile) => tile !== 'E')) {
  const hand = [...readyHand, draw], players = Array.from({ length: 4 }, () => ({ melds: [], flowers: [], discards: [], binding: null, ready: false }))
  const state = { seat: 0, players, myHand: hand, myActions: [...new Set(hand)].map((tile) => ({ type: 'discard', tile })), balances: [500,500,500,500], wallCount: 50 }
  const reference = v1(state), result = boundedFallback(state), remaining = hand.slice()
  remaining.splice(remaining.indexOf(result.action.tile), 1)
  readySamples.push({ draw, reference, actual: result.action, distance: mahjongShanten(remaining), exhausted: result.exhausted, evaluated: result.evaluated })
}
console.log(JSON.stringify({ kind: 'synthetic-fallback', startSeed, count, budgetMs: FALLBACK_BUDGET_MS, totals,
  timing: { mean: times.reduce((a,b) => a+b,0) / times.length, p95: pct(.95), p99: pct(.99), max: times.at(-1) }, samples,
  readyCases: { count: readySamples.length, lostReady: readySamples.filter((s) => s.distance > 0).length, samples: readySamples } }, null, 2))
