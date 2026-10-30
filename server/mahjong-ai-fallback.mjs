/** 轻量、可中断的基础出牌策略，不读任何其他玩家的暗牌。 */
import { performance } from 'node:perf_hooks'
import { NUMBER_TILES } from '../shared/logic/mahjong/tiles.mjs'
import { mahjongVisibleCounts, estimateMahjongWin } from './mahjong-ai-v1.mjs'

export const FALLBACK_BUDGET_MS = 35
const INDEX = new Map(NUMBER_TILES.map((tile, i) => [tile, i]))
const MELDS = new Set(['pong', 'kong', 'pongkong', 'ankong'])
const cache = new Map()
class BudgetExceeded extends Error {}
function check(end) { if (performance.now() >= end) throw new BudgetExceeded() }

/** 与 v1 相同的普通/七对距离，但每 32 次搜索检查时限。 */
export function boundedShanten(hand, meldCount, end = Infinity) {
  check(end)
  const counts = Array(NUMBER_TILES.length).fill(0)
  for (const tile of hand) {
    const i = INDEX.get(tile)
    if (i == null || ++counts[i] > 4) throw new Error('手牌无效')
  }
  const key = `${meldCount}:${counts.join('')}`
  if (cache.has(key)) return cache.get(key)
  let best = 8, visits = 0
  const visited = new Set()
  function dfs(m, p, pair) {
    if ((++visits & 31) === 0) check(end)
    if (m > 4 || p > 4) return
    const state = `${m}${p}${pair}:${counts.join('')}`
    if (visited.has(state)) return
    visited.add(state)
    const i = counts.findIndex((n) => n > 0)
    if (i < 0) { best = Math.min(best, 8 - 2 * m - Math.min(p, 4 - m) - pair); return }
    if (counts[i] >= 3 && m < 4) { counts[i] -= 3; dfs(m + 1, p, pair); counts[i] += 3 }
    const suited = i < 27, rank = i % 9
    if (suited && rank <= 6 && counts[i + 1] && counts[i + 2] && m < 4) {
      counts[i]--; counts[i + 1]--; counts[i + 2]--; dfs(m + 1, p, pair); counts[i]++; counts[i + 1]++; counts[i + 2]++
    }
    if (counts[i] >= 2) { counts[i] -= 2; if (!pair) dfs(m, p, 1); dfs(m, p + 1, pair); counts[i] += 2 }
    if (suited && rank <= 7 && counts[i + 1]) { counts[i]--; counts[i + 1]--; dfs(m, p + 1, pair); counts[i]++; counts[i + 1]++ }
    if (suited && rank <= 6 && counts[i + 2]) { counts[i]--; counts[i + 2]--; dfs(m, p + 1, pair); counts[i]++; counts[i + 2]++ }
    counts[i]--; dfs(m, p, pair); counts[i]++
  }
  dfs(meldCount, 0, 0)
  if (meldCount === 0) {
    let dp = Array(8).fill(Infinity); dp[0] = 0
    for (const n of counts) {
      check(end)
      const next = dp.slice()
      for (let pairs = 0; pairs < 7; pairs++) {
        next[pairs + 1] = Math.min(next[pairs + 1], dp[pairs] + Math.max(0, 2 - n))
        if (pairs <= 5) next[pairs + 2] = Math.min(next[pairs + 2], dp[pairs] + Math.max(0, 4 - n))
      }
      dp = next
    }
    best = Math.min(best, dp[7] - 1)
  }
  if (cache.size >= 5000) cache.clear()
  cache.set(key, best)
  return best
}

function afterDiscard(hand, tile) { const copy = hand.slice(); copy.splice(copy.indexOf(tile), 1); return copy }
function tileUtility(hand, tile) {
  const i = INDEX.get(tile), count = hand.filter((t) => t === tile).length
  let utility = (count - 1) * 4
  if (i < 27) for (const [delta, weight] of [[-2, 1], [-1, 2], [1, 2], [2, 1]]) {
    const j = i + delta
    if (j >= 0 && j < 27 && Math.floor(i / 9) === Math.floor(j / 9)) utility += weight * hand.filter((t) => t === NUMBER_TILES[j]).length
  }
  return utility
}

/** 优先评估摸牌与孤张，再按向听和有效张排序；超时保留已完成候选。 */
export function boundedFallback(obs, { budgetMs = FALLBACK_BUDGET_MS } = {}) {
  const actions = obs?.myActions ?? []
  if (!actions.length) return { action: null, evaluated: 0, exhausted: false, method: 'empty' }
  const win = actions.find((a) => a.type === 'win')
  if (win) {
    try {
      const estimate = estimateMahjongWin(obs), exposure = Math.min(obs.balances[obs.seat], Math.ceil((obs.wallCount ?? 0) / 12) * 10 * (obs.double ? 2 : 1))
      if (estimate.net >= 0 || -estimate.net <= exposure) return { action: { ...win }, evaluated: 0, exhausted: false, method: 'win' }
    } catch { return { action: { ...win }, evaluated: 0, exhausted: false, method: 'win' } }
  }
  const ready = actions.find((a) => a.type === 'ready')
  if (ready) return { action: { ...ready }, evaluated: 0, exhausted: false, method: 'ready' }
  const pass = actions.find((a) => a.type === 'pass')
  if (obs.response && pass) return { action: { ...pass }, evaluated: 0, exhausted: false, method: 'pass' }
  const hand = obs.myHand ?? []
  const discards = actions.filter((a) => a.type === 'discard' && hand.includes(a.tile))
  if (!discards.length) return { action: { ...(pass ?? actions[0]) }, evaluated: 0, exhausted: false, method: 'only-legal' }
  const end = performance.now() + Math.max(0, budgetMs), meldCount = (obs.players?.[obs.seat]?.melds ?? []).filter((m) => MELDS.has(m.type)).length
  const candidates = discards.map((action) => ({ action, hand: afterDiscard(hand, action.tile), utility: tileUtility(hand, action.tile) }))
    .sort((a, b) => a.utility - b.utility || INDEX.get(a.action.tile) - INDEX.get(b.action.tile))
  let best = candidates[0], evaluated = 0, exhausted = false
  const drawn = obs.myContext?.lastDraw
  const evaluationOrder = candidates.slice().sort((a, b) => Number(b.action.tile === drawn) - Number(a.action.tile === drawn) || a.utility - b.utility || INDEX.get(a.action.tile) - INDEX.get(b.action.tile))
  const finished = []
  try {
    // 已摸到的牌先评估，避免限时中遗漏“摸打保持原听口”。
    for (const candidate of evaluationOrder) {
      candidate.shanten = boundedShanten(candidate.hand, meldCount, end)
      finished.push(candidate); evaluated++
      if (!Number.isFinite(best.shanten) || candidate.shanten < best.shanten || (candidate.shanten === best.shanten && candidate.utility < best.utility)) best = candidate
    }
    const visible = mahjongVisibleCounts(obs)
    const bestDistance = best.shanten
    for (const candidate of finished.filter((c) => c.shanten === bestDistance)) {
      let effective = 0
      for (const tile of NUMBER_TILES) {
        check(end)
        const left = Math.max(0, 4 - (visible[tile] ?? 0))
        if (left && candidate.hand.filter((t) => t === tile).length < 4 && boundedShanten([...candidate.hand, tile], meldCount, end) < candidate.shanten) effective += left
      }
      candidate.effective = effective
      if (best.effective == null || effective > best.effective || (effective === best.effective && INDEX.get(candidate.action.tile) < INDEX.get(best.action.tile))) best = candidate
    }
  } catch (error) { if (!(error instanceof BudgetExceeded)) throw error; exhausted = true }
  return { action: { ...best.action }, evaluated, exhausted, method: evaluated ? 'bounded-shanten' : 'shape-heuristic' }
}
