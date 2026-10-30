import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { decideMahjongV2 as oldPolicy } from './mahjong-ai-v21.mjs'
import { decideMahjongV2, effectiveProgressScore, routeEffectiveTiles } from './mahjong-ai-v2.mjs'
import { buildCandidateStates, bindingAfterCall } from './mahjong-ai-candidates.mjs'
import { mahjongVisibleCounts } from './mahjong-ai-v1.mjs'

const cases = JSON.parse(fs.readFileSync(new URL('../docs/handovers/nanjing-mahjong-local-ai-v22-diagnostic-cases.json', import.meta.url), 'utf8')).cases
const get = (id) => structuredClone(cases.find((c) => c.id === id))
const result = (policy, c, extra = {}) => policy(c.observation, { ...c.options, ...extra })
const variant = (r, type, discard, tile = null) => r.diagnostic.candidateVariants.find((v) => v.action.type === type && v.projectedDiscard === discard && (tile == null || v.action.tile === tile))
const normal = (v) => v.routes.find((r) => r.route === 'normal')

test('C01 连续进张分保留 53 与 60 张的差异，30 附近无硬平台', () => {
  const c = get('C01'), old = result(oldPolicy, c), now = result(decideMahjongV2, c)
  const oldA = old.diagnostic.candidates.find((x) => x.action.tile === '1p'), oldB = old.diagnostic.candidates.find((x) => x.action.tile === '2m')
  const a = now.diagnostic.candidates.find((x) => x.action.tile === '1p'), b = now.diagnostic.candidates.find((x) => x.action.tile === '2m')
  assert.equal(oldA.score, oldB.score)
  assert.equal(normal(a).effective, 60); assert.equal(normal(b).effective, 53)
  assert.ok(normal(a).drawScore > normal(b).drawScore)
  assert.ok(a.score > b.score)
  const points = [0,3,7,29,30,31,53,60,90].map(effectiveProgressScore)
  assert.equal(points[0], 0)
  assert.ok(points.every((v,i) => i === 0 || v > points[i-1]))
  assert.ok(points.at(-1) < 17)
})

test('C02 三硬花无合法听张不领零向听与连贯收益；四硬花仍可合法听', () => {
  const c = get('C02'), old = result(oldPolicy, c), now = result(decideMahjongV2, c, { includeVariants: true })
  assert.equal(old.action.type, 'pong'); assert.equal(now.action.type, 'pass')
  const r = normal(variant(now, 'pong', '2p'))
  assert.equal(r.distance, 0); assert.equal(r.speedDistance, 1)
  assert.equal(r.qualification, 'qualification-gap'); assert.deepEqual(r.draws, [])
  assert.equal(r.continuity, 0); assert.equal(r.potential, 0); assert.equal(r.reference, null)
  c.observation.players[c.observation.seat].flowers.push('f1')
  const qualified = normal(variant(result(decideMahjongV2, c, { includeVariants: true }), 'pong', '2p'))
  assert.equal(qualified.qualification, 'legal-wait'); assert.equal(qualified.speedDistance, 0)
  assert.ok(qualified.draws.some((d) => d.tile === '5p'))
})

test('实际大胡不受四硬花限制；合法听张耗尽和资格缺口分开', () => {
  const big = ['2m','3m','4m','5m','6m','7m','7m','8m','9m','E']
  const counts = Object.fromEntries(big.map((t) => [t, big.filter((x) => x === t).length])); counts['1m'] = 3
  const result = routeEffectiveTiles('normal', big, [{ type: 'pong', tiles: ['1m','1m','1m'], from: 1 }], counts, undefined, ['Z'])
  assert.equal(result.qualification, 'legal-wait'); assert.ok(result.draws.some((d) => d.tile === 'E' && d.scoreFlowers >= 30))
  const ready = ['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E']
  const visible = Object.fromEntries(ready.map((t) => [t, ready.filter((x) => x === t).length])); visible.E = 4
  const exhausted = routeEffectiveTiles('normal', ready, [], visible)
  assert.equal(exhausted.qualification, 'exhausted'); assert.deepEqual(exhausted.exhausted, ['E'])
})

test('C03 第三嘴成功后以新责任和限额估算，且不修改真实观察或重复牌张', () => {
  const c = get('C03'), before = JSON.stringify(c.observation), old = result(oldPolicy, c), now = result(decideMahjongV2, c, { includeVariants: true })
  const v = variant(now, 'pong', '9p'), r = normal(v), prior = old.diagnostic.candidates.find((x) => x.action.type === 'pong').routes.find((x) => x.route === 'normal')
  assert.equal(prior.reference.scenarios[0].payment.selfDraw, 35)
  assert.deepEqual(v.binding, { binding: 1, status: 'new', possibleSource: null })
  const payment = r.reference.scenarios.find((s) => s.tile === 'E').payment
  assert.equal(payment.selfDraw, 5); assert.deepEqual(payment.discard.map((x) => x.amount), [5,5,5])
  const built = buildCandidateStates(c.observation).find((x) => x.action.type === 'pong' && x.projectedDiscard === '9p')
  assert.deepEqual(built.visible, mahjongVisibleCounts(c.observation))
  assert.equal(JSON.stringify(c.observation), before)
})

test('两嘴、第三直杠、暗杠、补杠、已有绑定及来源缺失按规则判断', () => {
  const m = (from, type = 'pong') => ({ type, tiles: ['1m','1m','1m'], ...(from == null ? {} : { from }) })
  assert.equal(bindingAfterCall({ binding: null, melds: [m(1)] }, 1, 'pong').status, 'not-bound')
  assert.deepEqual(bindingAfterCall({ binding: null, melds: [m(1), m(1)] }, 1, 'kong'), { binding: 1, status: 'new', possibleSource: null })
  assert.equal(bindingAfterCall({ binding: null, melds: [m(1), m(2)] }, 1, 'pong').status, 'not-bound')
  assert.equal(bindingAfterCall({ binding: null, melds: [m(1), m(1)] }, null, 'ankong').status, 'unchanged')
  assert.equal(bindingAfterCall({ binding: null, melds: [m(1), m(1)] }, null, 'bukong').status, 'unchanged')
  assert.equal(bindingAfterCall({ binding: 2, melds: [m(1), m(1)] }, 1, 'pong').binding, 2)
  assert.deepEqual(bindingAfterCall({ binding: null, melds: [m(1), m(null)] }, 1, 'pong'), { binding: null, status: 'unknown', possibleSource: 1 })
  assert.equal(bindingAfterCall({ binding: null, melds: [m(1, 'pongkong'), m(1)] }, 1, 'pong').binding, 1)
})

test('C04 补杠成功收款与抢杠分开，风险来源只使用公开数据', () => {
  const c = get('C04'), before = JSON.stringify(c.observation), old = result(oldPolicy, c), now = result(decideMahjongV2, c, { includeVariants: true })
  const previous = old.diagnostic.candidates.find((v) => v.action.type === 'bukong')
  const v = variant(now, 'bukong', null, '2s')
  assert.equal(previous.immediate, 15)
  assert.equal(v.immediate, 0); assert.equal(v.conditionalGain, 15)
  assert.equal(v.branch.success.immediate, 15); assert.equal(v.branch.success.replacement, 'unknown')
  assert.equal(v.branch.robbed.immediate, 0); assert.equal(v.branch.robbed.replacement, false); assert.equal(v.branch.robbed.meld, 'pong')
  assert.ok(v.risk > 0); assert.ok(v.uncertainty.basis.includes('非概率'))
  assert.equal(JSON.stringify(c.observation), before)
  c.observation.balances[c.observation.seat] = 0
  const garden = buildCandidateStates(c.observation).find((x) => x.action.type === 'bukong')
  assert.equal(garden.branch.robbed.sourceInGarden, true)
})

test('杠后两家园子导致整场结束时不再给未来胡牌收益', () => {
  const c = get('C03'), o = c.observation
  o.players[0].melds = []; o.players[0].binding = null
  o.myHand = ['3m','3m','3m','1m','2m','4m','5m','6m','1p','2p','3p','4s','5s']
  o.myActions = [{ type: 'kong' }, { type: 'pass' }]; o.balances = [100,5,0,100]
  const r = result(decideMahjongV2, c, { includeVariants: true }), v = variant(r, 'kong', null)
  assert.equal(v.branch.success.terminal, true); assert.equal(v.conditionalGain, 5)
  assert.equal(v.routes[0].route, 'match-end'); assert.equal(v.routes[0].futureScore, 0)
})
