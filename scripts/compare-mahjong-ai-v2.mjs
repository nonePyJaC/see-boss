/** 合成固定牌墙对照；不包含用户实战、密钥或网络模型。 */
import { performance } from 'node:perf_hooks'
import { createWall } from '../shared/logic/mahjong/online-wall.mjs'
import { createMahjongSession, setMahjongReady, startMahjongHand, submitMahjongAction, buildMahjongObservation } from '../server/mahjong-room.mjs'
import { safeMahjongAction as v1, mahjongShanten } from '../server/mahjong-ai-v1.mjs'
import { decideMahjongV2, policyIdentity, POLICY_VERSION } from '../server/mahjong-ai-v2.mjs'

const groups = Number(process.env.MJ_COMPARE_GROUPS ?? 12)
const startSeed = Number(process.env.MJ_COMPARE_SEED ?? 91000)
const seeded = (initial) => { let state = initial >>> 0; return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296) }
const summary = { kind: 'synthetic', version: POLICY_VERSION, baseline: 'c6f842b2b97e82997bcb4e27518a6782d92ca317',
  groups, startSeed, games: 0, elapsedMs: 0, illegal: 0, stale: 0, fallback: 0, decisions: 0,
  draws: 0, wins: { v1: 0, v2: 0 }, winKinds: {}, flowers: { v1: [], v2: [] }, net: { v1: 0, v2: 0 },
  seatNetV2: [0,0,0,0], lossFromDiscard: { v1: 0, v2: 0 }, paymentReasons: {}, routes: {}, changes: 0, comparison: { differing: 0, slowerShape: 0, sameShape: 0, quickerShape: 0 },
  bigChosen: 0, bigAbandoned: 0, bigCompleted: 0, bigFailed: 0, completedTypes: {}, styles: {}, decisionMs: [], records: [] }
const started = performance.now()
for (let group = 0; group < groups; group++) {
  const seed = startSeed + group, wall = createWall(seeded(seed))
  for (let v2Seat = 0; v2Seat < 4; v2Seat++) {
    let session = createMahjongSession({ initialSeeds: 1000, dealer: 0 })
    session.matchId = `synthetic-${seed}-${v2Seat}`
    for (let i = 0; i < 4; i++) session = setMahjongReady(session, i)
    session = startMahjongHand(session, { now: 1000, wall, rng: seeded(seed + 11) })
    let steps = 0, previousRoute = null, everBig = false
    const identity = policyIdentity(session.matchId, v2Seat)
    const style = summary.styles[identity.style] ??= { decisions: 0, actions: {}, routes: {} }
    while (session.game.phase !== 'finished' && steps++ < 1200) {
      const seat = [0,1,2,3].find((i) => buildMahjongObservation(session, i).myActions.length)
      if (seat == null) throw new Error(`没有合法动作 ${seed}/${v2Seat}/${session.game.phase}`)
      const obs = buildMahjongObservation(session, seat)
      let action
      if (seat === v2Seat) {
        const start = performance.now()
        const result = decideMahjongV2(obs, { identity, previousRoute, observationId: `${seed}:${v2Seat}:${session.windowId}:${seat}` })
        summary.decisionMs.push(performance.now() - start); summary.decisions++
        if (result.diagnostic.fallback) summary.fallback++
        action = result.action
        const base = v1(obs)
        if (JSON.stringify(base) !== JSON.stringify(action)) {
          summary.comparison.differing++
          if (base?.type === 'discard' && action?.type === 'discard') {
            const remove = (tile) => { const hand = obs.myHand.slice(); hand.splice(hand.indexOf(tile), 1); return hand }
            const groups = obs.players[seat].melds.filter((m) => ['pong','kong','pongkong','ankong'].includes(m.type)).length
            const delta = mahjongShanten(remove(action.tile), groups) - mahjongShanten(remove(base.tile), groups)
            summary.comparison[delta > 0 ? 'slowerShape' : delta < 0 ? 'quickerShape' : 'sameShape']++
          }
        }
        style.decisions++; style.actions[action?.type] = (style.actions[action?.type] ?? 0) + 1
        if (result.route) {
          summary.routes[result.route] = (summary.routes[result.route] ?? 0) + 1
          style.routes[result.route] = (style.routes[result.route] ?? 0) + 1
          const big = result.route !== 'normal'
          if (big) { summary.bigChosen++; everBig = true }
          if (previousRoute && previousRoute !== result.route) { summary.changes++; if (previousRoute !== 'normal') summary.bigAbandoned++ }
          previousRoute = result.route
        }
      } else action = v1(obs)
      if (!obs.myActions.some((a) => a.type === action?.type && (a.tile == null || a.tile === action.tile))) { summary.illegal++; throw new Error('策略输出非法动作') }
      try { session = submitMahjongAction(session, seat, action, { matchId: session.matchId, handId: session.handId, windowId: session.windowId, now: 1001 }) }
      catch (error) { summary.stale++; throw error }
    }
    if (session.game.phase !== 'finished') throw new Error(`对局未推进 ${seed}/${v2Seat}`)
    const game = session.game, result = game.result, v2Net = game.balances[v2Seat] - 1000
    if (game.balances.reduce((a,b) => a+b,0) !== 4000) throw new Error('余额不守恒')
    summary.games++; summary.net.v2 += v2Net; summary.seatNetV2[v2Seat] += v2Net
    summary.net.v1 += game.balances.reduce((sum, amount, i) => sum + (i === v2Seat ? 0 : amount - 1000), 0)
    if (result.type === 'draw') summary.draws++
    for (const winner of result.winners ?? []) {
      const key = winner.seat === v2Seat ? 'v2' : 'v1'
      summary.wins[key]++; summary.flowers[key].push(winner.score.flowers.total)
      const kind = `${key}:${result.kind}`; summary.winKinds[kind] = (summary.winKinds[kind] ?? 0) + 1
      for (const label of winner.score.labels) summary.completedTypes[label] = (summary.completedTypes[label] ?? 0) + 1
      if (winner.seat === v2Seat && everBig && winner.score.isBigWin) summary.bigCompleted++
    }
    if (everBig && !(result.winners ?? []).some((w) => w.seat === v2Seat && w.score.isBigWin)) summary.bigFailed++
    for (const entry of game.ledger) for (const t of entry.transfers) {
      summary.paymentReasons[t.reason] = (summary.paymentReasons[t.reason] ?? 0) + t.paid
      if (entry.event === '胡牌' && t.from === result.source && result.kind === 'discard') summary.lossFromDiscard[t.from === v2Seat ? 'v2' : 'v1'] += t.paid
    }
    summary.records.push({ seed, v2Seat, style: identity.style, v2Net, balances: game.balances, outcome: result.type, kind: result.kind ?? null,
      source: result.source ?? null, winners: (result.winners ?? []).map((w) => ({ seat: w.seat, flowers: w.score.flowers.total, types: w.score.labels })), everBig, steps })
  }
  process.stderr.write(`合成对照 ${group + 1}/${groups} 组完成\n`)
}
summary.elapsedMs = Math.round(performance.now() - started)
const sorted = summary.decisionMs.slice().sort((a,b) => a-b)
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
summary.timing = { mean: sorted.reduce((a,b) => a+b,0) / (sorted.length || 1), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) ?? 0 }
delete summary.decisionMs
console.log(JSON.stringify(summary, null, 2))
