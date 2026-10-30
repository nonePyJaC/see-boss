/** 南京麻将本地多路线策略；输入只能是已授权座位的投影。 */
import { performance } from 'node:perf_hooks'
import { NUMBER_TILES, countsOf } from '../shared/logic/mahjong/tiles.mjs'
import { scoreHand } from '../shared/logic/mahjong/score.mjs'
import { settleOnlineWin, settleOnlineKong } from '../shared/logic/mahjong/online-payments.mjs'
import { mahjongVisibleCounts, estimateMahjongWin, safeMahjongAction as baseline } from './mahjong-ai-v1.mjs'

export const POLICY_VERSION = 'nanjing-local-policy-v2'
export const POLICY_PARAMS = Object.freeze({ budgetMs: 500, cacheLimit: 20000, near: 2.5, continuity: 1.5,
  switchThreshold: 3, riskCap: 12, speedWeight: 7, drawWeight: .35, futureWeight: .42 })
const TYPES = new Set(['pong', 'kong', 'pongkong', 'ankong'])
const SUITS = ['m', 's', 'p']
const ROUTES = ['normal', ...SUITS.map((s) => `qing:${s}`), ...SUITS.map((s) => `hun:${s}`), 'triplets', 'pairs', 'doublePairs']
const cache = new Map()
const remove = (hand, tile, count = 1) => {
  const copy = hand.slice()
  for (let i = 0; i < count; i++) { const p = copy.indexOf(tile); if (p < 0) throw new Error('手牌不含所需牌'); copy.splice(p, 1) }
  return copy
}
class BudgetError extends Error {}
function guard(budget) { if (performance.now() >= budget.end) throw new BudgetError('策略计算预算耗尽') }
function suitsAllowed(route, tile) {
  if (!route.includes(':')) return true
  const [kind, suit] = route.split(':')
  return tile.endsWith(suit) || (kind === 'hun' && tile.length === 1)
}
function allowedMelds(route, melds) {
  const groups = melds.filter((m) => TYPES.has(m.type))
  if (['pairs', 'doublePairs'].includes(route)) return groups.length === 0
  if (route === 'triplets') return groups.every((m) => new Set(m.tiles).size === 1)
  return groups.every((m) => m.tiles.every((t) => suitsAllowed(route, t)))
}

/** 与目标约束一致的牌形距离；-1 成牌、0 听牌。不可达不视为普通胡。 */
export function routeDistance(route, hand, melds = [], visible = {}, budget = { end: Infinity }) {
  guard(budget)
  if (!ROUTES.includes(route) || !allowedMelds(route, melds)) return Infinity
  const groups = melds.filter((m) => TYPES.has(m.type)).length
  const counts = NUMBER_TILES.map((tile) => suitsAllowed(route, tile) ? hand.filter((t) => t === tile).length : 0)
  const limits = NUMBER_TILES.map((t, i) => Math.min(4, counts[i] + Math.max(0, 4 - (visible[t] ?? hand.filter((x) => x === t).length))))
  const key = `${route}:${groups}:${counts.join('')}:${['pairs', 'doublePairs'].includes(route) ? limits.join('') : ''}`
  if (cache.has(key)) return cache.get(key)
  let answer
  if (route === 'pairs' || route === 'doublePairs') {
    let dp = Array.from({ length: 8 }, () => [Infinity, Infinity]); dp[0][0] = 0
    for (let i = 0; i < counts.length; i++) {
      const next = dp.map((row) => row.slice())
      for (let n = 0; n <= 7; n++) for (let quad = 0; quad <= 1; quad++) {
        if (n < 7 && limits[i] >= 2) next[n + 1][quad] = Math.min(next[n + 1][quad], dp[n][quad] + Math.max(0, 2 - counts[i]))
        if (n < 6 && limits[i] >= 4 && route === 'doublePairs') next[n + 2][1] = Math.min(next[n + 2][1], dp[n][quad] + Math.max(0, 4 - counts[i]))
      }
      dp = next
    }
    answer = (route === 'pairs' ? dp[7][0] : dp[7][1]) - 1
  } else {
    let best = 8, visits = 0
    const seen = new Set()
    function dfs(m, p, pair, singles) {
      if ((++visits & 127) === 0) guard(budget)
      if (m > 4 || p > 4) return
      const state = `${m}${p}${pair}:${singles}:${counts.join('')}`
      if (seen.has(state)) return
      seen.add(state)
      const i = counts.findIndex((n) => n > 0)
      if (i < 0) {
        const partials = Math.min(p, 4 - m), usableSingles = Math.min(singles + (p - partials) * 2, 4 - m - partials + 1 - pair)
        const missing = (4 - m) * 3 + 2 - partials * 2 - pair * 2 - usableSingles
        best = Math.min(best, missing - 1); return
      }
      if (counts[i] >= 3 && m < 4) { counts[i] -= 3; dfs(m + 1, p, pair, singles); counts[i] += 3 }
      const suited = i < 27, rank = i % 9
      if (route !== 'triplets' && suited && rank <= 6 && counts[i + 1] && counts[i + 2] && m < 4) {
        counts[i]--; counts[i + 1]--; counts[i + 2]--; dfs(m + 1, p, pair, singles); counts[i]++; counts[i + 1]++; counts[i + 2]++
      }
      if (counts[i] >= 2) { counts[i] -= 2; if (!pair) dfs(m, p, 1, singles); dfs(m, p + 1, pair, singles); counts[i] += 2 }
      if (route !== 'triplets' && suited && rank <= 7 && counts[i + 1]) { counts[i]--; counts[i + 1]--; dfs(m, p + 1, pair, singles); counts[i]++; counts[i + 1]++ }
      if (route !== 'triplets' && suited && rank <= 6 && counts[i + 2]) { counts[i]--; counts[i + 2]--; dfs(m, p + 1, pair, singles); counts[i]++; counts[i + 2]++ }
      counts[i]--; dfs(m, p, pair, singles + 1); counts[i]++
    }
    dfs(groups, 0, 0, 0); answer = best
  }
  if (cache.size >= POLICY_PARAMS.cacheLimit) cache.clear()
  cache.set(key, answer)
  return answer
}

export function routeEffectiveTiles(route, hand, melds, visible, budget = { end: Infinity }, flowers = []) {
  const distance = routeDistance(route, hand, melds, visible, budget)
  const draws = []
  if (!Number.isFinite(distance)) return { distance, draws, count: 0 }
  for (const tile of NUMBER_TILES) {
    guard(budget)
    const left = Math.max(0, 4 - (visible[tile] ?? 0))
    if (!left || !suitsAllowed(route, tile) || hand.filter((t) => t === tile).length >= 4) continue
    const after = [...hand, tile]
    if (routeDistance(route, after, melds, { ...visible, [tile]: (visible[tile] ?? 0) + 1 }, budget) >= distance) continue
    let scoreFlowers = null
    if (distance === 0) {
      const score = scoreHand({ concealed: after, melds, flowers, winTile: tile })
      const required = route.startsWith('qing:') ? 'qingyise' : route.startsWith('hun:') ? 'hunyise' : ({ triplets: 'duiduihu', pairs: 'qidui', doublePairs: 'shuangqidui' })[route]
      if (!score.info.valid || (!score.isBigWin && !score.info.meldsConcealed && score.info.hardCount < 4) || (required && !score.info.types[required])) continue
      scoreFlowers = score.flowers.total
    }
    draws.push({ tile, left, ...(scoreFlowers != null ? { scoreFlowers } : {}) })
  }
  return { distance, draws, count: draws.reduce((sum, d) => sum + d.left, 0) }
}

/** 用公开证据形成有上限的相对风险；不声明听口或放炮概率。 */
export function publicRisk(obs, tile) {
  const visible = mahjongVisibleCounts(obs)
  const opponents = (obs.players ?? []).filter((_, i) => i !== obs.seat)
  const threat = opponents.reduce((n, p) => n + (p.ready ? 3 : 0) + Math.min(2, (p.melds ?? []).filter((m) => TYPES.has(m.type)).length) * .7, 0)
  const stage = 1 + Math.max(0, 45 - (obs.wallCount ?? 45)) / 90
  const availability = Math.max(.35, 1 - (visible[tile] ?? 0) * .14)
  return Math.min(POLICY_PARAMS.riskCap, threat * stage * availability)
}

/** 只用规则函数计算假设性胡款，未来付款人和余额均不确定。 */
export function hypotheticalPayment(obs, flowers) {
  const bindings = Object.fromEntries(obs.players.map((p, i) => [i, p.binding]).filter(([, v]) => v != null))
  const share = Math.max(0, Math.round(flowers)) * (obs.double ? 2 : 1)
  const seats = [0, 1, 2, 3].filter((s) => s !== obs.seat)
  const net = (kind, source = null) => {
    const result = settleOnlineWin({ balances: obs.balances, winners: [{ seat: obs.seat, share }],
      kind, source, sourceInGarden: source != null && obs.balances[source] === 0, bindings })
    return result.balances[obs.seat] - obs.balances[obs.seat]
  }
  return { selfDraw: net('selfDraw'), discard: seats.map((s) => ({ source: s, amount: net('discard', s) })) }
}

// 用已完成、可验证的标准例作为花数参考，再通过权威计分函数计分；不是保证能得到该牌。
const EXAMPLES = {
  normal: ['1m','2m','3m','4m','5m','6m','1p','2p','3p','4s','5s','6s','E','E'],
  qing: ['1m','2m','3m','4m','5m','6m','7m','8m','9m','1m','2m','3m','5m','5m'],
  hun: ['1m','2m','3m','4m','5m','6m','7m','8m','9m','E','E','E','S','S'],
  triplets: ['1m','1m','1m','2s','2s','2s','3p','3p','3p','E','E','E','S','S'],
  pairs: ['1m','1m','2m','2m','3s','3s','4s','4s','5p','5p','E','E','S','S'],
  doublePairs: ['1m','1m','1m','1m','2m','2m','3s','3s','4p','4p','E','E','S','S'],
}
function routeReference(obs, route, melds = obs.players[obs.seat].melds, budget = { end: Infinity }) {
  const key = route.startsWith('qing:') ? 'qing' : route.startsWith('hun:') ? 'hun' : route
  const suit = route.includes(':') ? route.split(':')[1] : 'm'
  const sample = EXAMPLES[key].map((tile) => tile.endsWith('m') && (key === 'qing' || key === 'hun') ? `${tile[0]}${suit}` : tile)
  const me = obs.players[obs.seat], groups = melds.filter((m) => TYPES.has(m.type)), need = 4 - groups.length
  let chosen = null
  if (key === 'pairs' || key === 'doublePairs') {
    const score = scoreHand({ concealed: sample, flowers: me.flowers ?? [], melds })
    if (score.info.valid) chosen = score
  } else {
    const sourceGroups = Array.from({ length: 4 }, (_, i) => sample.slice(i * 3, i * 3 + 3))
    const pairTiles = [sample[12], ...NUMBER_TILES.filter((tile) => suitsAllowed(route, tile) && tile !== sample[12])]
    for (let mask = 0; mask < 16 && !chosen; mask++) {
      guard(budget)
      if (sourceGroups.filter((_, i) => mask & (1 << i)).length !== need) continue
      const tiles = sourceGroups.filter((_, i) => mask & (1 << i)).flat()
      for (const pair of pairTiles) {
        guard(budget)
        const score = scoreHand({ concealed: [...tiles, pair, pair], flowers: me.flowers ?? [], melds })
        if (!score.info.valid) continue
        if (key === 'qing' && !score.info.types.qingyise || key === 'hun' && !score.info.types.hunyise || key === 'triplets' && !score.info.types.duiduihu) continue
        if (key === 'normal' && score.isBigWin && (me.flowers?.length ?? 0) > 0) continue
        chosen = score; break
      }
    }
  }
  if (!chosen) return null
  const flowers = chosen.flowers.total
  const payment = hypotheticalPayment(obs, flowers)
  // 30% 自摸 + 70% 三个点炮者均摊仅是固定场景权重，不是统计概率。
  const reference = payment.selfDraw * .3 + payment.discard.reduce((sum, p) => sum + p.amount, 0) / 3 * .7
  return { flowers, payment, reference }
}

function stableHash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
export function policyIdentity(matchId, seat) {
  const seed = stableHash(`${POLICY_VERSION}:${matchId}:${seat}`)
  return { seed, style: ['balanced', 'speed', 'value'][seed % 3] }
}

function candidateStates(obs) {
  const me = obs.players[obs.seat], result = []
  const groups = me.melds ?? []
  for (const action of obs.myActions) {
    if (action.type === 'discard') result.push({ action, hand: remove(obs.myHand, action.tile), melds: groups, risk: publicRisk(obs, action.tile), immediate: 0 })
    else if (action.type === 'pass' && obs.response) result.push({ action, hand: obs.myHand, melds: groups, risk: 0, immediate: 0 })
    else if (['pong', 'kong', 'ankong', 'bukong'].includes(action.type)) {
      const t = action.tile ?? obs.response?.tile, n = action.type === 'pong' ? 2 : action.type === 'kong' ? 3 : action.type === 'ankong' ? 4 : 1
      const hand = remove(obs.myHand, t, n), melds = structuredClone(groups)
      if (action.type === 'bukong') { const m = melds.find((x) => x.type === 'pong' && x.tiles[0] === t); m.type = 'pongkong'; m.tiles.push(t) }
      else melds.push({ type: action.type === 'pong' ? 'pong' : action.type === 'kong' ? 'kong' : 'ankong', tiles: Array(action.type === 'pong' ? 3 : 4).fill(t), ...(action.type === 'pong' || action.type === 'kong' ? { from: obs.response.source } : {}) })
      let immediate = 0, balances = obs.balances
      if (action.type !== 'pong') { const pay = settleOnlineKong({ balances: obs.balances, seat: obs.seat, type: action.type === 'kong' ? 'ming' : action.type === 'ankong' ? 'an' : 'bu', from: obs.response?.source, double: !!obs.double }); immediate = pay.balances[obs.seat] - obs.balances[obs.seat]; balances = pay.balances }
      if (action.type === 'pong') {
        // 碰后必须打出一张，评估每种后续弃牌，但不预先提交那张牌。
        for (const tile of new Set(hand)) result.push({ action, hand: remove(hand, tile), melds, risk: publicRisk(obs, tile), immediate, balances, projectedDiscard: tile })
      } else result.push({ action, hand, melds, risk: 0, immediate, balances })
    }
  }
  return result
}

function brokenShape(hand, tile) {
  if (!tile) return 0
  const before = countsOf(hand), after = countsOf(remove(hand, tile))
  let sequencesLost = 0
  if (tile.length === 2) for (let start = Math.max(1, Number(tile[0]) - 2); start <= Math.min(7, Number(tile[0])); start++) {
    const group = [start, start + 1, start + 2].map((n) => `${n}${tile[1]}`)
    if (group.every((t) => (before[t] ?? 0) > 0) && !group.every((t) => (after[t] ?? 0) > 0)) sequencesLost++
  }
  const pairLost = before[tile] === 2 ? 1 : before[tile] === 3 ? 1.5 : 0
  return Math.min(3, Math.min(2, sequencesLost) * 1.1 + pairLost * .7)
}

export function decideMahjongV2(obs, options = {}) {
  const start = performance.now(), budget = { end: start + Math.max(0, options.budgetMs ?? POLICY_PARAMS.budgetMs) }
  const actions = obs?.myActions ?? [], version = POLICY_VERSION
  const identity = options.identity ?? policyIdentity(options.matchId ?? 'synthetic', obs?.seat ?? 0)
  const diagnostic = { version, observationId: options.observationId ?? null, style: identity.style, candidates: [], fallback: null }
  const chooseBaseline = (reason) => { diagnostic.fallback = reason; return { action: baseline(obs), diagnostic, route: null, ms: performance.now() - start } }
  if (!actions.length) return { action: null, diagnostic, route: null, ms: performance.now() - start }
  if (actions.length === 1) return { action: { ...actions[0] }, diagnostic, route: null, ms: performance.now() - start }
  try {
    const win = actions.find((a) => a.type === 'win')
    if (win) {
      const estimate = estimateMahjongWin(obs), exposure = Math.min(obs.balances[obs.seat], Math.ceil((obs.wallCount ?? 0) / 12) * 10 * (obs.double ? 2 : 1))
      if (estimate.net >= 0 || -estimate.net <= exposure) return { action: { ...win }, diagnostic: { ...diagnostic, reason: `当前合法胡单家估算净收付 ${estimate.net}` }, route: null, ms: performance.now() - start }
    }
    const ready = actions.find((a) => a.type === 'ready')
    if (ready) return { action: { ...ready }, diagnostic: { ...diagnostic, reason: '起手可报听' }, route: null, ms: performance.now() - start }
    const visible = mahjongVisibleCounts(obs), candidates = candidateStates(obs)
    const referenceCache = new Map()
    const stage = Math.max(.08, Math.min(1, (obs.wallCount ?? 0) / 65))
    const styleBias = identity.style === 'speed' ? -.7 : identity.style === 'value' ? .7 : 0
    for (const candidate of candidates) {
      guard(budget)
      candidate.routes = []
      for (const route of ROUTES) {
        guard(budget)
        const effective = routeEffectiveTiles(route, candidate.hand, candidate.melds, visible, budget, obs.players[obs.seat].flowers ?? [])
        const distance = effective.distance
        if (!Number.isFinite(distance)) { candidate.routes.push({ route, reachable: false }); continue }
        const excess = candidate.hand.filter((t) => !suitsAllowed(route, t))
        const validSmall = route !== 'normal' || !candidate.melds.some((m) => ['pong', 'pongkong'].includes(m.type)) ||
          (obs.players[obs.seat].flowers?.length ?? 0) + candidate.melds.filter((m) => m.type === 'huagang').reduce((n, m) => n + m.tiles.length, 0) >= 4
        const referenceKey = `${route}:${JSON.stringify(candidate.balances ?? obs.balances)}:${JSON.stringify(candidate.melds)}`
        if (!referenceCache.has(referenceKey)) referenceCache.set(referenceKey, routeReference({ ...obs, balances: candidate.balances ?? obs.balances }, route, candidate.melds, budget))
        let ref = referenceCache.get(referenceKey)
        if (distance === 0 && effective.draws.length) {
          const scenarios = effective.draws.map((d) => {
            const payment = hypotheticalPayment({ ...obs, balances: candidate.balances ?? obs.balances }, d.scoreFlowers)
            return { ...d, payment, reference: payment.selfDraw * .3 + payment.discard.reduce((sum, item) => sum + item.amount, 0) / 3 * .7 }
          })
          ref = { basis: '当前可成牌听张的静态假设', scenarios,
            reference: scenarios.reduce((sum, item) => sum + item.left * item.reference, 0) / effective.count }
        } else if (ref) ref = { ...ref, basis: '示例牌型与当前余额的静态假设，未来成牌未知' }
        const difficulty = 1 + Math.max(0, distance) * .55
        const handCounts = countsOf(candidate.hand)
        const pairCount = Object.values(handCounts).reduce((sum, n) => sum + Math.floor(n / 2), 0)
        const pairProgress = ['pairs', 'doublePairs'].includes(route) ? Math.min(1, Math.max(.15, (pairCount - 2) * .2)) : 1
        const quadProgress = route === 'doublePairs' ? Math.max(.15, ...Object.values(handCounts).map((n) => n >= 4 ? 1 : n === 3 ? .7 : n === 2 ? .35 : .15)) : 1
        // 示例生成失败不代表路线不可达；仅暂不计入该路线未来收益。
        const potential = (ref?.reference ?? 0) * stage / difficulty * (validSmall ? 1 : .25) * (effective.count ? 1 : .05) * pairProgress * quadProgress
        const bias = route === 'normal' ? -styleBias : styleBias
        const shapeCost = brokenShape(obs.myHand, candidate.action.type === 'discard' ? candidate.action.tile : candidate.projectedDiscard)
        const score = -distance * POLICY_PARAMS.speedWeight + potential * POLICY_PARAMS.futureWeight + bias + Math.min(30, effective.count) * POLICY_PARAMS.drawWeight + Math.min(candidate.immediate, 30) * .15 - candidate.risk - shapeCost
        candidate.routes.push({ route, reachable: true, distance, excess, draws: effective.draws, effective: effective.count, reference: ref, referenceUnavailable: !ref, potential, continuity: 0, shapeCost, pairProgress, quadProgress, score, validSmall })
      }
      const maximum = Math.max(...candidate.routes.map((r) => r.score ?? -Infinity))
      const previous = candidate.routes.find((r) => r.route === options.previousRoute && r.reachable)
      if (previous && maximum - previous.score <= POLICY_PARAMS.switchThreshold) { previous.continuity = POLICY_PARAMS.continuity; previous.score += POLICY_PARAMS.continuity }
      candidate.routes.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      candidate.best = candidate.routes[0]
      candidate.score = candidate.best?.score ?? -Infinity
    }
    if (!candidates.length) return chooseBaseline('无可评估候选')
    const unique = new Map()
    for (const candidate of candidates) {
      const key = JSON.stringify(candidate.action), previous = unique.get(key)
      if (!previous || candidate.score > previous.score) unique.set(key, candidate)
    }
    const ranked = [...unique.values()].filter((candidate) => Number.isFinite(candidate.score))
    if (!ranked.length) return chooseBaseline('没有可比较的候选路线')
    ranked.sort((a, b) => b.score - a.score || JSON.stringify(a.action).localeCompare(JSON.stringify(b.action)))
    const near = ranked.filter((c) => ranked[0].score - c.score <= POLICY_PARAMS.near)
    const random = options.random ?? (() => stableHash(`${identity.seed}:${options.observationId ?? JSON.stringify(obs)}`) / 4294967296)
    const weights = near.map((c) => Math.exp((c.score - ranked[0].score) / 2))
    let target = random() * weights.reduce((sum, w) => sum + w, 0), chosen = near.at(-1)
    for (let i = 0; i < near.length; i++) { target -= weights[i]; if (target <= 0) { chosen = near[i]; break } }
    diagnostic.candidates = ranked.map((c) => ({ action: c.action, projectedDiscard: c.projectedDiscard, score: c.score, risk: c.risk, immediate: c.immediate, routes: c.routes }))
    diagnostic.reason = `${chosen.best.route}：距离 ${chosen.best.distance}，有效未见 ${chosen.best.effective}，公开风险 ${chosen.risk.toFixed(1)}`
    return { action: { ...chosen.action }, diagnostic, route: chosen.best.route, ms: performance.now() - start }
  } catch (error) { return chooseBaseline(error instanceof BudgetError ? '预算耗尽' : '策略异常') }
}
