import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { decideMahjongV2, filterDominatedCandidates } from './mahjong-ai-v2.mjs'
import { runMahjongPolicy } from './mahjong-ai-runner.mjs'
import { boundedFallback, boundedShanten } from './mahjong-ai-fallback.mjs'
import { safeMahjongAction as v1, mahjongShanten } from './mahjong-ai-v1.mjs'
import { NUMBER_TILES } from '../shared/logic/mahjong/tiles.mjs'

const players = () => Array.from({ length: 4 }, () => ({ melds: [], flowers: [], discards: [], binding: null, ready: false }))
function obs(hand) { return { seat: 0, phase: 'turn', players: players(), myHand: hand, myActions: [...new Set(hand)].map((tile) => ({ type: 'discard', tile })), balances: [500,500,500,500], wallCount: 80, double: false } }
const hand = ['1m','1m','1m','2m','3m','4m','1p','2p','3p','4s','5s','6s','7s','8s']
const options = { identity: { seed: 3, style: 'balanced' }, budgetMs: 2000, observationId: 'synthetic-review' }

test('同为 40 花、同风险，7 张听口严格压过 3 张听口，不再进入随机池', () => {
  const state = obs(hand)
  state.players[1].discards = ['3s','3s','3s','3s','4s','4s','4s']
  const result = decideMahjongV2(state, { ...options, random: () => .99 })
  const wide = result.diagnostic.candidates.find((c) => c.action.tile === '1m')
  const narrow = result.diagnostic.candidates.find((c) => c.action.tile === '8s')
  assert.equal(wide.routes[0].effective, 7); assert.equal(narrow.routes[0].effective, 3)
  assert.ok([...wide.routes[0].reference.scenarios, ...narrow.routes[0].reference.scenarios].every((s) => s.scoreFlowers === 40))
  assert.equal(wide.risk, narrow.risk)
  assert.ok(result.diagnostic.dominated.some((a) => a.tile === '8s'))
  assert.equal(result.diagnostic.randomPool.some((a) => a.tile === '8s'), false)
  for (const n of [0, .25, .5, .75, .99]) assert.notEqual(decideMahjongV2(state, { ...options, random: () => n }).action.tile, '8s')
  let calls = 0
  const deterministic = decideMahjongV2(state, { ...options, randomize: false, random: () => { calls++; return .99 } })
  assert.equal(calls, 0, '关闭随机的对照不得抽签')
  assert.deepEqual(deterministic.action, deterministic.diagnostic.randomPool[0])
})

test('胡款更高、风险更低或接近最优的不同路线有优势时，不因听张窄被误删', () => {
  const route = (effective, flowers, score) => ({ route: 'normal', reachable: true, distance: 0, effective, score,
    reference: { scenarios: [{ scoreFlowers: flowers, payment: { selfDraw: flowers * 3, discard: [{ source: 1, amount: flowers }] } }] } })
  const a = { action: { type: 'discard', tile: '1m' }, risk: 1, immediate: 0, score: 20, routes: [route(7,40,20)] }; a.best = a.routes[0]
  const b = { action: { type: 'discard', tile: '8s' }, risk: 1, immediate: 0, score: 19, routes: [route(3,40,19)] }; b.best = b.routes[0]
  assert.deepEqual(filterDominatedCandidates([a,b]).map((c) => c.action.tile), ['1m'])
  const higher = structuredClone(b); higher.best.reference.scenarios[0].scoreFlowers = 80; higher.routes[0] = higher.best
  assert.equal(filterDominatedCandidates([a,higher]).length, 2)
  const safer = structuredClone(b); safer.risk = 0
  assert.equal(filterDominatedCandidates([a,safer]).length, 2)
  const alternate = structuredClone(b); alternate.routes.push({ route: 'qing:m', reachable: true, score: 19.5 })
  assert.equal(filterDominatedCandidates([a,alternate]).length, 2)
})

test('未听牌必须有完整进张集合覆盖才淘汰同路线劣势，差异化进张继续保留', () => {
  const ref = { flowers: 40, reference: 64, payment: { selfDraw: 120, discard: [{ source: 1, amount: 40 }] } }
  const route = (draws, score) => ({ route: 'normal', reachable: true, distance: 1, effective: draws.reduce((n, d) => n + d.left, 0), draws,
    reference: ref, score, pairProgress: 1, quadProgress: 1, shapeCost: 0 })
  const a = { action: { type: 'discard', tile: '1m' }, risk: 0, immediate: 0, score: 20, routes: [route([{ tile: '2m', left: 3 }, { tile: '3m', left: 4 }], 20)] }; a.best = a.routes[0]
  const b = { action: { type: 'discard', tile: '8s' }, risk: 0, immediate: 0, score: 19.7, routes: [route([{ tile: '2m', left: 3 }], 19.7)] }; b.best = b.routes[0]
  assert.deepEqual(filterDominatedCandidates([a,b]).map((c) => c.action.tile), ['1m'])
  const different = structuredClone(b); different.best.draws = [{ tile: '4m', left: 3 }]; different.routes[0] = different.best
  assert.equal(filterDominatedCandidates([a,different]).length, 2)
  const differentShape = structuredClone(b); differentShape.best.shapeCost = 0; differentShape.routes[0] = differentShape.best
  const worseA = structuredClone(a); worseA.best.shapeCost = 1; worseA.routes[0] = worseA.best
  assert.equal(filterDominatedCandidates([worseA,differentShape]).length, 2)
})

test('预算内基础向听与 v1 一致，牌值次序不影响已听牌回退', () => {
  const state = obs(['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E','9p'])
  state.myActions.sort((a,b) => a.tile === '1m' ? -1 : b.tile === '1m' ? 1 : 0)
  assert.equal(v1(state).tile, '9p')
  const fallback = boundedFallback(state, { budgetMs: 100 })
  const remaining = state.myHand.slice(); remaining.splice(remaining.indexOf(fallback.action.tile), 1)
  assert.equal(mahjongShanten(remaining), 0, '紧急回退应维持听牌')
  assert.notEqual(fallback.action.tile, '1m')
  assert.ok(fallback.evaluated > 0)
  const noTime = boundedFallback(state, { budgetMs: 0 })
  assert.equal(noTime.method, 'shape-heuristic')
  assert.notEqual(noTime.action.tile, '1m', '即使预算耗尽也应先比较全部合法弃牌的牌形')
  for (const tile of new Set(state.myHand)) {
    const h = state.myHand.slice(); h.splice(h.indexOf(tile), 1)
    assert.equal(boundedShanten(h, 0), mahjongShanten(h, 0))
  }
})

test('受限距离在充足预算下与独立 v1 基线一致', () => {
  let seed = 31819
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
  for (const melds of [0, 1, 2]) for (let n = 0; n < 40; n++) {
    const hand = []
    while (hand.length < 13 - melds * 3) {
      const tile = NUMBER_TILES[Math.floor(random() * NUMBER_TILES.length)]
      if (hand.filter((t) => t === tile).length < 4) hand.push(tile)
    }
    assert.equal(boundedShanten(hand, melds), mahjongShanten(hand, melds))
  }
})

test('园子负收益胡牌仍可选择过，紧急回退不强行胡', () => {
  const state = obs(['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E'])
  state.seat = 1; state.balances = [0,1000,1000,1000]; state.wallCount = 1
  state.response = { kind: 'discard', source: 0, tile: 'E', sourceInGarden: true }
  state.myActions = [{ type: 'win' }, { type: 'pass' }]
  assert.equal(boundedFallback(state).action.type, 'pass')
})

test('两个线程繁忙和工作线程超时都运行受限基础策略，且结果合法', async () => {
  const state = obs(['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E','9p'])
  const first = runMahjongPolicy(state, { ...options, budgetMs: 500 })
  const second = runMahjongPolicy(state, { ...options, budgetMs: 500 })
  const begin = performance.now()
  const heartbeat = new Promise((resolve) => setTimeout(() => resolve(performance.now() - begin), 0))
  const busy = await runMahjongPolicy(state, options)
  assert.equal(busy.diagnostic.fallback, '并发预算繁忙')
  assert.ok(['bounded-shanten', 'shape-heuristic'].includes(busy.diagnostic.fallbackDetail.method))
  assert.notEqual(busy.action.tile, '1m')
  assert.ok(performance.now() - begin < 150, '繁忙回退应有执行时间上限')
  assert.ok(await heartbeat < 150, '线程繁忙时事件循环仍应及时响应')
  await Promise.all([first, second])
  const timeout = await runMahjongPolicy(state, options, { timeoutMs: 1 })
  assert.equal(timeout.diagnostic.fallback, '计算超时')
  assert.ok(['bounded-shanten', 'shape-heuristic'].includes(timeout.diagnostic.fallbackDetail.method))
  for (const result of [busy, timeout]) {
    assert.ok(state.myActions.some((a) => a.type === result.action.type && a.tile === result.action.tile))
    const remaining = state.myHand.slice(); remaining.splice(remaining.indexOf(result.action.tile), 1)
    assert.equal(mahjongShanten(remaining), 0)
  }
})
