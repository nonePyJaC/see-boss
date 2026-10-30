/** 合成固定牌墙对照；不包含用户实战、密钥或网络模型。 */
import { performance } from 'node:perf_hooks'
import { createWall } from '../shared/logic/mahjong/online-wall.mjs'
import { createMahjongSession, setMahjongReady, startMahjongHand, submitMahjongAction, buildMahjongObservation, validateMahjongSnapshot } from '../server/mahjong-room.mjs'
import { safeMahjongAction as v1, mahjongShanten } from '../server/mahjong-ai-v1.mjs'
import { decideMahjongV2, policyIdentity, POLICY_VERSION } from '../server/mahjong-ai-v2.mjs'

const groups = Number(process.env.MJ_COMPARE_GROUPS ?? 12)
const startSeed = Number(process.env.MJ_COMPARE_SEED ?? 91000)
const mode = process.env.MJ_POLICY_MODE ?? 'routes-random'
const policyStyle = process.env.MJ_POLICY_STYLE ?? 'balanced'
if (!['baseline', 'routes', 'routes-random'].includes(mode)) throw new Error('未知对照模式')
if (!['balanced', 'speed', 'value'].includes(policyStyle)) throw new Error('未知风格')
const seeded = (initial) => { let state = initial >>> 0; return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296) }
const summary = { kind: 'synthetic', version: POLICY_VERSION, mode, style: policyStyle, baseline: 'c6f842b2b97e82997bcb4e27518a6782d92ca317',
  groups, startSeed, games: 0, elapsedMs: 0, illegal: 0, stale: 0, fallback: 0, decisions: 0,
  draws: 0, wins: { v1: 0, v2: 0 }, winKinds: {}, flowers: { v1: [], v2: [] }, net: { v1: 0, v2: 0 },
  seatNetV2: [0,0,0,0], lossFromDiscard: { v1: 0, v2: 0 }, paymentReasons: {}, routes: {}, changes: 0, comparison: { differing: 0, slowerShape: 0, sameShape: 0, quickerShape: 0 },
  bigChosen: 0, bigAbandoned: 0, bigCompleted: 0, bigFailed: 0, dominated: 0, randomizedPools: 0, randomizedSelections: 0,
  sameStateRandomComparison: { compared: 0, changed: 0, fallback: 0 },
  completedTypes: {}, styles: {}, decisionMs: [], records: [], decisionDiffs: [], sameStateRandomDiffs: [],
  ordinaryPairs: { compared: 0, ties: 0, over30: 0, over30Ties: 0 }, selectedIneligible: {}, selectedClaims: {}, newBindings: 0, conditionalClaims: 0, snapshotsChecked: 0 }
const started = performance.now()
for (let group = 0; group < groups; group++) {
  const seed = startSeed + group, wall = createWall(seeded(seed))
  for (let v2Seat = 0; v2Seat < 4; v2Seat++) {
    let session = createMahjongSession({ initialSeeds: 1000, dealer: 0 })
    session.matchId = `synthetic-${seed}-${v2Seat}`
    for (let i = 0; i < 4; i++) session = setMahjongReady(session, i)
    session = startMahjongHand(session, { now: 1000, wall, rng: seeded(seed + 11) })
    let steps = 0, previousRoute = null, everBig = false
    const identity = { ...policyIdentity(session.matchId, v2Seat), style: policyStyle }
    const style = summary.styles[identity.style] ??= { decisions: 0, actions: {}, routes: {} }
    while (session.game.phase !== 'finished' && steps++ < 1200) {
      const seat = [0,1,2,3].find((i) => buildMahjongObservation(session, i).myActions.length)
      if (seat == null) throw new Error(`没有合法动作 ${seed}/${v2Seat}/${session.game.phase}`)
      const obs = buildMahjongObservation(session, seat)
      let action
      if (seat === v2Seat) {
        const start = performance.now()
        const result = mode === 'baseline'
          ? { action: v1(obs), route: null, diagnostic: {} }
          : decideMahjongV2(obs, { identity, previousRoute, randomize: mode === 'routes-random', observationId: `${seed}:${v2Seat}:${session.windowId}:${seat}` })
        summary.decisionMs.push(performance.now() - start); summary.decisions++
        if (result.diagnostic.fallback) summary.fallback++
        const cs = result.diagnostic.candidates ?? []
        const chosenDetails = cs.find((c) => JSON.stringify(c.action) === JSON.stringify(result.action))
        const chosenRoute = chosenDetails?.routes?.[0]
        if (chosenRoute?.distance === 0 && !chosenRoute.effective) summary.selectedIneligible[chosenRoute.qualification] = (summary.selectedIneligible[chosenRoute.qualification] ?? 0) + 1
        if (['pong','kong','ankong','bukong'].includes(result.action?.type)) {
          summary.selectedClaims[result.action.type] = (summary.selectedClaims[result.action.type] ?? 0) + 1
          if (chosenDetails?.binding?.status === 'new') summary.newBindings++
          if (chosenDetails?.branch?.kind === 'conditional-success') summary.conditionalClaims++
        }
        const ordinary = cs.map((c) => ({ c, r: c.routes?.[0] })).filter(({r}) => r?.route === 'normal')
        for (let i = 0; i < ordinary.length; i++) for (let j = i + 1; j < ordinary.length; j++) {
          const a = ordinary[i], b = ordinary[j]
          if (a.r.distance !== b.r.distance || a.r.qualification !== b.r.qualification) continue
          summary.ordinaryPairs.compared++
          const tie = Math.abs(a.c.score - b.c.score) < 1e-9
          if (tie) summary.ordinaryPairs.ties++
          if (a.r.effective > 30 && b.r.effective > 30 && a.r.effective !== b.r.effective) { summary.ordinaryPairs.over30++; if (tie) summary.ordinaryPairs.over30Ties++ }
        }
        summary.dominated += result.diagnostic.dominated?.length ?? 0
        if (result.diagnostic.randomPool?.length > 1) summary.randomizedPools++
        if (mode === 'routes-random' && result.diagnostic.randomPool?.length > 1 && JSON.stringify(result.action) !== JSON.stringify(result.diagnostic.randomPool[0])) summary.randomizedSelections++
        if (mode === 'routes-random') {
          const deterministic = decideMahjongV2(obs, { identity, previousRoute, randomize: false, observationId: `${seed}:${v2Seat}:${session.windowId}:${seat}` })
          if (result.diagnostic.fallback || deterministic.diagnostic.fallback) summary.sameStateRandomComparison.fallback++
          else {
            summary.sameStateRandomComparison.compared++
            if (JSON.stringify(result.action) !== JSON.stringify(deterministic.action)) {
              summary.sameStateRandomComparison.changed++
              summary.sameStateRandomDiffs.push({ seed, seat, window: session.windowId, identity, previousRoute, hand: obs.myHand,
                players: obs.players, balances: obs.balances, wallCount: obs.wallCount, actions: obs.myActions, response: obs.response,
                context: obs.myContext, double: obs.double,
                noRandom: deterministic.action, random: result.action, pool: result.diagnostic.randomPool,
                candidates: result.diagnostic.candidates.slice(0, 4).map((c) => ({ action: c.action, score: c.score, risk: c.risk,
                  route: c.routes?.[0]?.route, distance: c.routes?.[0]?.distance, effective: c.routes?.[0]?.effective })) })
            }
          }
        }
        action = result.action
        const base = v1(obs)
        if (JSON.stringify(base) !== JSON.stringify(action)) {
          summary.comparison.differing++
          summary.decisionDiffs.push({ seed, seat, window: session.windowId, identity, previousRoute, baseline: base, chosen: action, route: result.route,
            hand: obs.myHand, players: obs.players, balances: obs.balances, wallCount: obs.wallCount, actions: obs.myActions,
            response: obs.response, context: obs.myContext, double: obs.double,
            candidates: (result.diagnostic.candidates ?? []).slice(0, 4).map((c) => ({ action: c.action, score: c.score, risk: c.risk,
              route: c.routes?.[0]?.route, distance: c.routes?.[0]?.distance, effective: c.routes?.[0]?.effective })),
            dominated: result.diagnostic.dominated ?? [], pool: result.diagnostic.randomPool ?? [] })
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
      try { session = submitMahjongAction(session, seat, action, { matchId: session.matchId, handId: session.handId, windowId: session.windowId, now: 1001 }); validateMahjongSnapshot(session); summary.snapshotsChecked++ }
      catch (error) { summary.stale++; throw error }
    }
    if (session.game.phase !== 'finished') throw new Error(`对局未推进 ${seed}/${v2Seat}`)
    const game = session.game, result = game.result, v2Net = game.balances[v2Seat] - 1000
    if (game.balances.reduce((a,b) => a+b,0) !== 4000) throw new Error('余额不守恒')
    summary.games++; summary.net.v2 += v2Net; summary.seatNetV2[v2Seat] += v2Net
    summary.net.v1 += game.balances.reduce((sum, amount, i) => sum + (i === v2Seat ? 0 : amount - 1000), 0)
    if (result.type === 'draw') summary.draws++
    let targetCompleted = false
    for (const winner of result.winners ?? []) {
      const key = winner.seat === v2Seat ? 'v2' : 'v1'
      summary.wins[key]++; summary.flowers[key].push(winner.score.flowers.total)
      const kind = `${key}:${result.kind}`; summary.winKinds[kind] = (summary.winKinds[kind] ?? 0) + 1
      for (const label of winner.score.labels) summary.completedTypes[label] = (summary.completedTypes[label] ?? 0) + 1
      const types = winner.score.info.types
      const matched = previousRoute?.startsWith('qing:') ? types.qingyise : previousRoute?.startsWith('hun:') ? types.hunyise : previousRoute === 'triplets' ? types.duiduihu : previousRoute === 'pairs' ? types.qidui : previousRoute === 'doublePairs' ? types.shuangqidui : false
      if (winner.seat === v2Seat && matched) { summary.bigCompleted++; targetCompleted = true }
    }
    if (everBig && !targetCompleted) summary.bigFailed++
    for (const entry of game.ledger) for (const t of entry.transfers) {
      summary.paymentReasons[t.reason] = (summary.paymentReasons[t.reason] ?? 0) + t.paid
      if (entry.event === '胡牌' && t.from === result.source && result.kind === 'discard') summary.lossFromDiscard[t.from === v2Seat ? 'v2' : 'v1'] += t.paid
    }
    summary.records.push({ seed, v2Seat, style: identity.style, v2Net, balances: game.balances, outcome: result.type, kind: result.kind ?? null,
      source: result.source ?? null, winners: (result.winners ?? []).map((w) => ({ seat: w.seat, flowers: w.score.flowers.total, types: w.score.labels })), everBig, lastRoute: previousRoute, targetCompleted, steps })
  }
  process.stderr.write(`合成对照 ${group + 1}/${groups} 组完成\n`)
}
summary.elapsedMs = Math.round(performance.now() - started)
const sorted = summary.decisionMs.slice().sort((a,b) => a-b)
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
summary.timing = { mean: sorted.reduce((a,b) => a+b,0) / (sorted.length || 1), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) ?? 0 }
delete summary.decisionMs
console.log(JSON.stringify(summary, null, 2))
