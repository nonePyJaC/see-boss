import test from 'node:test'
import assert from 'node:assert/strict'
import { createMahjongSession, setMahjongReady, startMahjongHand, buildMahjongObservation, projectMahjongSession } from './mahjong-room.mjs'
import { safeMahjongAction as v1, mahjongVisibleCounts } from './mahjong-ai-v1.mjs'
import { decideMahjongV2, routeDistance, routeEffectiveTiles, hypotheticalPayment, publicRisk, policyIdentity, POLICY_PARAMS } from './mahjong-ai-v2.mjs'
import { runMahjongPolicy } from './mahjong-ai-runner.mjs'

const players = () => Array.from({ length: 4 }, () => ({ melds: [], flowers: ['Z'], discards: [], binding: null, ready: false }))
const observation = (hand, extra = {}) => ({ seat: 0, phase: 'turn', players: players(), myHand: hand,
  myActions: [...new Set(hand)].map((tile) => ({ type: 'discard', tile })), balances: [500,500,500,500], double: false, wallCount: 80, ...extra })
const opt = { identity: { seed: 3, style: 'value' }, random: () => 0, budgetMs: 2000, observationId: 'synthetic-a' }
const a01 = ['4m','5m','7m','1m','9m','1m','2m','6m','1m','6m','4m','2s','3s','4s']

test('A01 提供完整手牌时快胡和清一色都比较，存在拆条追清一色的收益取舍', () => {
  const result = decideMahjongV2(observation(a01), opt)
  assert.equal(result.diagnostic.fallback, null)
  assert.equal(result.route, 'qing:m')
  assert.match(result.action.tile, /^[234]s$/)
  const routes = result.diagnostic.candidates.find((c) => c.action.tile === result.action.tile).routes
  assert.ok(routes.some((r) => r.route === 'normal' && r.reachable))
  assert.ok(routes.some((r) => r.route === 'qing:m' && r.effective > 0 && r.reference.payment))
})

test('A02 牌墙将尽、关键张已见时有效进张减少并允许改线', () => {
  const early = observation(a01), late = structuredClone(early)
  const visible = mahjongVisibleCounts(early)
  for (const tile of ['2m','3m','5m','7m','8m']) for (let n = visible[tile]; n < 4; n++) late.players[1].discards.push(tile)
  late.wallCount = 4
  const previousRoute = 'qing:m'
  const first = decideMahjongV2(early, { ...opt, previousRoute })
  const second = decideMahjongV2(late, { ...opt, previousRoute })
  assert.notEqual(second.route, 'qing:m')
  const q = (r) => r.diagnostic.candidates.find((c) => c.action.tile === first.action.tile)?.routes.find((x) => x.route === 'qing:m')
  assert.ok(q(second).effective < q(first).effective)
})

test('A03 宽听明显占优时不会为了风格任意拆牌', () => {
  const hand = ['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E','9p']
  const result = decideMahjongV2(observation(hand, { wallCount: 8 }), opt)
  assert.equal(result.action.tile, '9p')
})

test('A04 七对和一至三组四张的双七对都按约束计算，手牌杠失效但花杠保留', () => {
  for (const hand of [
    ['1m','1m','1m','1m','2p','2p','3p','3p','4s','4s','E','E','W','W'],
    ['1m','1m','1m','1m','2p','2p','2p','2p','4s','4s','E','E','W','W'],
    ['1m','1m','1m','1m','2p','2p','2p','2p','4s','4s','4s','4s','E','E'],
  ]) {
    assert.equal(routeDistance('doublePairs', hand), -1)
    assert.equal(routeDistance('doublePairs', hand, [{ type: 'ankong', tiles: ['S','S','S','S'] }]), Infinity)
    assert.equal(routeDistance('doublePairs', hand, [{ type: 'huagang', tiles: ['Z','Z','Z','Z'] }]), -1)
  }
  const hand = ['1m','1m','1m','1m','2m','2m','3p','3p','4s','4s','E','E','W','N']
  const obs = observation(hand)
  obs.myActions.push({ type: 'ankong', tile: '1m' })
  const decision = decideMahjongV2(obs, { ...opt, budgetMs: 5000 })
  const kong = decision.diagnostic.candidates.find((c) => c.action.type === 'ankong')
  assert.equal(kong.routes.find((r) => r.route === 'pairs').reachable, false)
  assert.equal(kong.routes.find((r) => r.route === 'doublePairs').reachable, false)
})

test('A05 已副露异色导致清一色不可达，暗手异色则不直接判死', () => {
  const h = ['1m','2m','3m','4m','5m','6m','7m','8m','9m','2s']
  assert.equal(routeDistance('qing:m', h, [{ type: 'pong', tiles: ['1p','1p','1p'] }]), Infinity)
  assert.ok(Number.isFinite(routeDistance('qing:m', h)))
  const effective = routeEffectiveTiles('qing:m', h, [], Object.fromEntries(h.map((t) => [t, h.filter((x) => x === t).length])))
  assert.ok(effective.draws.every((d) => d.tile.endsWith('m')))
  const offSuit = ['1m','2m','3m','4m','5m','6m','7m','8m','9m','1m','2m','3m','E']
  assert.equal(routeDistance('qing:m', offSuit), 1, '异色暗牌须留出换牌代价，不能虚报听牌')
})

test('非门清小胡不足四硬花时，不把该听张作为合法有效胡牌', () => {
  const hand = ['1m','2m','3m','1p','2p','3p','1s','2s','3s','E']
  const melds = [{ type: 'pong', tiles: ['4m','4m','4m'], from: 3 }]
  const obs = observation(hand); obs.players[0].melds = melds
  const visible = mahjongVisibleCounts(obs)
  const low = routeEffectiveTiles('normal', hand, melds, visible, undefined, ['Z','Z','F'])
  const enough = routeEffectiveTiles('normal', hand, melds, visible, undefined, ['Z','Z','F','F'])
  assert.equal(low.draws.some((d) => d.tile === 'E'), false)
  assert.equal(enough.draws.some((d) => d.tile === 'E'), true)
})

test('A06 假设付款按园子、余额上限、三嘴和倍率计算', () => {
  const obs = observation(a01), full = hypotheticalPayment(obs, 80)
  const limited = structuredClone(obs); limited.balances = [500,0,10,5]
  const capped = hypotheticalPayment(limited, 80)
  assert.ok(full.selfDraw > capped.selfDraw)
  assert.ok(capped.discard.find((x) => x.source === 1).amount < 0)
  const bound = structuredClone(obs); bound.players[0].binding = 1; bound.balances[1] = 5
  assert.equal(hypotheticalPayment(bound, 80).selfDraw, 5)
})

test('A07 已打过的牌不被视为绝对安全，公开威胁影响但有上限', () => {
  const obs = observation(a01); obs.players[1].ready = true; obs.players[1].discards = ['2s']
  assert.ok(publicRisk(obs, '2s') > 0)
  assert.ok(publicRisk(obs, '2s') <= 12)
})

test('A08 负收益合法胡可按园子付款评估，不被移出合法选项', () => {
  const hand = ['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E']
  const obs = observation(hand, { seat: 1, phase: 'response', balances: [0,1000,1000,1000], wallCount: 1,
    response: { kind: 'discard', source: 0, tile: 'E', sourceInGarden: true }, myActions: [{ type: 'win' }, { type: 'pass' }] })
  assert.equal(decideMahjongV2(obs, opt).action.type, 'pass')
  assert.equal(decideMahjongV2({ ...obs, wallCount: 100 }, opt).action.type, 'win')
})

test('A09 固定风格和种子重复决策可重现，只在接近候选中随机', () => {
  const obs = observation(a01), fixed = { identity: policyIdentity('match-fixed', 0), observationId: 'match-fixed:1:5:0', budgetMs: 2000 }
  const a = decideMahjongV2(obs, fixed), b = decideMahjongV2(obs, fixed)
  assert.deepEqual(a.action, b.action); assert.equal(a.route, b.route)
  const eligible = a.diagnostic.candidates.filter((c) => a.diagnostic.randomPool.some((action) => action.type === c.action.type && action.tile === c.action.tile))
  const chosen = a.diagnostic.candidates.find((c) => c.action.tile === a.action.tile)
  assert.ok(eligible[0].score - chosen.score <= POLICY_PARAMS.near)
  const different = new Set([0, .3, .6, .99].map((n) => decideMahjongV2(obs, { ...fixed, random: () => n }).action.tile))
  assert.ok(different.size > 1)
  const fast = decideMahjongV2(obs, { ...opt, identity: { seed: 3, style: 'speed' } })
  const value = decideMahjongV2(obs, { ...opt, identity: { seed: 3, style: 'value' } })
  assert.equal(fast.route, 'normal'); assert.equal(value.route, 'qing:m')
})

test('A10 之前路线只是小幅偏好，可因条件变化改线', () => {
  const obs = observation(a01, { wallCount: 3 })
  const result = decideMahjongV2(obs, { ...opt, previousRoute: 'qing:m' })
  assert.notEqual(result.route, 'qing:m')
})

test('A11 单动作、预算耗尽和工作线程回退均保持合法', async () => {
  const obs = observation(a01), fallback = decideMahjongV2(obs, { ...opt, budgetMs: 0 })
  assert.equal(fallback.diagnostic.fallback, '预算耗尽')
  assert.deepEqual(fallback.action, v1(obs))
  assert.deepEqual(decideMahjongV2({ myActions: [{ type: 'pass' }] }).action, { type: 'pass' })
  const result = await runMahjongPolicy(obs, { identity: policyIdentity('test-match', 0), observationId: 'test:1:1:0', budgetMs: 200 })
  assert.ok(obs.myActions.some((a) => a.type === result.action?.type && a.tile === result.action.tile))
  let responsive = false
  const pending = runMahjongPolicy(obs, { identity: policyIdentity('test-match', 0), observationId: 'test:1:2:0' })
  await new Promise((resolve) => setTimeout(() => { responsive = true; resolve() }, 5))
  assert.equal(responsive, true, '本地策略运行时事件循环应能处理其他请求')
  await pending
})

test('A12 只用座位投影，不依赖对手暗牌和牌墙顺序，策略记忆不进公开状态', () => {
  let session = createMahjongSession()
  for (let i = 0; i < 4; i++) session = setMahjongReady(session, i)
  session = startMahjongHand(session, { rng: () => .51 })
  session.localPolicy = { handId: session.handId, routes: { 0: 'qing:m' } }
  const other = structuredClone(session)
  ;[other.game.players[1].hand, other.game.players[2].hand] = [other.game.players[2].hand, other.game.players[1].hand]
  other.game.wall.reverse()
  assert.deepEqual(buildMahjongObservation(session, 0), buildMahjongObservation(other, 0))
  assert.equal('localPolicy' in projectMahjongSession(session, 0), false)
  const a = buildMahjongObservation(session, 0), b = buildMahjongObservation(other, 0)
  const first = decideMahjongV2(a, opt), second = decideMahjongV2(b, opt)
  assert.deepEqual(first.action, second.action)
  assert.deepEqual(first.diagnostic.candidates, second.diagnostic.candidates)
})
