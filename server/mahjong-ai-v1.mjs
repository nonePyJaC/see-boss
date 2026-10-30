/** 南京麻将本地策略。只接受座位投影，不接收完整牌局或其他人的暗牌。 */
import { NUMBER_TILES, countsOf } from '../shared/logic/mahjong/tiles.mjs'
import { scoreHand } from '../shared/logic/mahjong/score.mjs'
import { settleOnlineWin } from '../shared/logic/mahjong/online-payments.mjs'

const tiles = NUMBER_TILES
const index = new Map(tiles.map((t, i) => [t, i]))
const meldTypes = new Set(['pong', 'kong', 'pongkong', 'ankong'])
const countMelds = (melds) => melds.filter((m) => meldTypes.has(m.type)).length
const remove = (hand, tile, amount = 1) => {
  const result = hand.slice()
  for (let i = 0; i < amount; i++) {
    const pos = result.indexOf(tile)
    if (pos < 0) throw new Error('手牌不含所需牌')
    result.splice(pos, 1)
  }
  return result
}

const globalCache = new Map()
/** 数值 -1 为成牌、0 为听牌；包含标准型和南京七对/双七对。 */
export function mahjongShanten(hand, meldCount = 0) {
  if (!Array.isArray(hand) || !Number.isInteger(meldCount) || meldCount < 0 || meldCount > 4) throw new Error('手牌无效')
  const counts = Array(tiles.length).fill(0)
  for (const tile of hand) {
    const i = index.get(tile)
    if (i == null || ++counts[i] > 4) throw new Error('手牌牌面无效')
  }
  const cacheKey = `${meldCount}:${counts.join('')}`
  const cached = globalCache.get(cacheKey)
  if (cached !== undefined) return cached
  let best = 8
  const visited = new Set()
  function dfs(melds, partials, pair) {
    if (melds > 4 || partials > 4) return
    const key = `${melds}${partials}${pair}:${counts.join('')}`
    if (visited.has(key)) return
    visited.add(key)
    let i = 0
    while (i < counts.length && !counts[i]) i++
    if (i === counts.length) {
      best = Math.min(best, 8 - 2 * melds - Math.min(partials, 4 - melds) - pair)
      return
    }
    if (counts[i] >= 3 && melds < 4) {
      counts[i] -= 3; dfs(melds + 1, partials, pair); counts[i] += 3
    }
    const suited = i < 27, rank = i % 9
    if (suited && rank <= 6 && counts[i + 1] && counts[i + 2] && melds < 4) {
      counts[i]--; counts[i + 1]--; counts[i + 2]--; dfs(melds + 1, partials, pair); counts[i]++; counts[i + 1]++; counts[i + 2]++
    }
    if (counts[i] >= 2) {
      counts[i] -= 2
      if (!pair) dfs(melds, partials, 1)
      dfs(melds, partials + 1, pair)
      counts[i] += 2
    }
    if (suited && rank <= 7 && counts[i + 1]) {
      counts[i]--; counts[i + 1]--; dfs(melds, partials + 1, pair); counts[i]++; counts[i + 1]++
    }
    if (suited && rank <= 6 && counts[i + 2]) {
      counts[i]--; counts[i + 2]--; dfs(melds, partials + 1, pair); counts[i]++; counts[i + 2]++
    }
    counts[i]--; dfs(melds, partials, pair); counts[i]++
  }
  dfs(meldCount, 0, 0)
  if (meldCount === 0) {
    // 每种牌可贡献一对或四张（两对）；14张全成对，1~3组四张均算双七对。
    let dp = Array(8).fill(Infinity)
    dp[0] = 0
    for (const n of counts) {
      const next = dp.slice()
      for (let pairs = 0; pairs < 7; pairs++) {
        next[pairs + 1] = Math.min(next[pairs + 1], dp[pairs] + Math.max(0, 2 - n))
        if (pairs <= 5) next[pairs + 2] = Math.min(next[pairs + 2], dp[pairs] + Math.max(0, 4 - n))
      }
      dp = next
    }
    best = Math.min(best, dp[7] - 1)
  }
  if (globalCache.size >= 50000) globalCache.clear()
  globalCache.set(cacheKey, best)
  return best
}

/** 只计自己的手牌和各家公开牌；被碰的弃牌由副露计一次。 */
export function mahjongVisibleCounts(obs) {
  const known = countsOf(obs.myHand ?? [])
  for (const p of obs.players ?? []) {
    for (const t of [...(p.discards ?? []), ...(p.flowers ?? []), ...(p.melds ?? []).flatMap((m) => m.tiles ?? [])]) known[t] = (known[t] ?? 0) + 1
  }
  // 被抢的补杠牌尚在对方手里，但申请补杠时已经公开；不能当成未知牌。
  if (obs.response?.kind === 'robKong' && obs.seat !== obs.response.source && obs.response.tile) {
    const t = obs.response.tile
    known[t] = (known[t] ?? 0) + 1
  }
  return Object.fromEntries(tiles.map((t) => [t, Math.max(0, Math.min(4, known[t] ?? 0))]))
}

export function mahjongEffectiveTiles(hand, meldCount, visible) {
  const shanten = mahjongShanten(hand, meldCount)
  const draws = []
  for (const tile of tiles) {
    const left = Math.max(0, 4 - (visible[tile] ?? 0))
    if (!left || hand.filter((t) => t === tile).length >= 4) continue
    if (mahjongShanten([...hand, tile], meldCount) < shanten) draws.push({ tile, left })
  }
  return { shanten, draws, count: draws.reduce((n, d) => n + d.left, 0) }
}

function chooseDiscard(hand, meldCount, visible) {
  const candidates = [...new Set(hand)].map((tile) => {
    const remaining = remove(hand, tile)
    return { tile, remaining, shanten: mahjongShanten(remaining, meldCount) }
  })
  const best = Math.min(...candidates.map((c) => c.shanten))
  for (const c of candidates.filter((v) => v.shanten === best)) c.effective = mahjongEffectiveTiles(c.remaining, meldCount, visible).count
  candidates.sort((a, b) => a.shanten - b.shanten || (b.effective ?? 0) - (a.effective ?? 0) || (visible[b.tile] ?? 0) - (visible[a.tile] ?? 0) || tiles.indexOf(a.tile) - tiles.indexOf(b.tile))
  return candidates[0]
}

/** 真实付款按当前公开余额预估单个胡家；其他未响应玩家的选择未知。 */
export function estimateMahjongWin(obs) {
  const seat = obs.seat, me = obs.players[seat], response = obs.response
  const kind = response ? (response.kind === 'robKong' ? 'robKong' : 'discard') : 'selfDraw'
  const draw = obs.myContext?.draw
  const hand = { concealed: response ? [...obs.myHand, response.tile] : obs.myHand.slice(), melds: me.melds,
    flowers: me.flowers, winTile: response?.tile ?? obs.myContext?.lastDraw ?? null }
  const score = scoreHand(hand, { tianhu: !!obs.myContext?.initialDealerTurn, dihu: !!me.ready,
    gangkai: kind === 'selfDraw' && draw?.reason === 'kong',
    huakai: kind === 'selfDraw' && !!draw?.flower && draw.reason !== 'kong' })
  if (!score.info.valid) throw new Error('不能估算无效胡牌')
  const bindings = Object.fromEntries(obs.players.map((p, i) => [i, p.binding]).filter(([, v]) => v != null))
  const result = settleOnlineWin({ balances: obs.balances, winners: [{ seat, share: score.flowers.total * (obs.double ? 2 : 1) }],
    kind, source: response?.source ?? null, sourceInGarden: response?.sourceInGarden ?? false, bindings,
    kongSource: kind === 'selfDraw' && draw?.reason === 'kong' ? draw.kongSource : null })
  return { net: result.balances[seat] - obs.balances[seat], score: score.flowers.total, transfers: result.transfers }
}

/** 策略只从引擎给出的合法动作选择。 */
export function decideMahjongAction(obs) {
  const actions = obs?.myActions ?? []
  if (!actions.length) return null
  if (actions.length === 1) return { ...actions[0] }
  const pick = (type) => actions.find((a) => a.type === type)
  const me = obs.players[obs.seat], meldCount = countMelds(me.melds), known = mahjongVisibleCounts(obs)
  const win = pick('win')
  if (win) {
    try {
      const estimate = estimateMahjongWin(obs)
      // 负收益胡牌与继续留下的潜在损失比较；这是近似决策，不保证对其他人结果的预测。
      const exposure = Math.min(obs.balances[obs.seat], Math.ceil((obs.wallCount ?? 0) / 12) * 10 * (obs.double ? 2 : 1))
      if (estimate.net >= 0 || -estimate.net <= exposure) return { ...win }
    } catch { return { ...win } }
  }
  if (pick('ready')) return { ...pick('ready') }
  if (obs.response) {
    const pass = pick('pass')
    const current = mahjongShanten(obs.myHand, meldCount)
    const responseTile = obs.response.tile
    const handMelds = me.melds.filter((m) => meldTypes.has(m.type))
    const hardCount = me.flowers.length + me.melds.filter((m) => m.type === 'huagang').reduce((n, m) => n + m.tiles.length, 0)
    const pong = pick('pong')
    if (pong && (hardCount >= 4 || handMelds.some((m) => ['pong', 'pongkong'].includes(m.type)))) {
      const after = remove(obs.myHand, responseTile, 2)
      const candidate = chooseDiscard(after, meldCount + 1, known)
      if (candidate.shanten < current) return { ...pong }
    }
    const kong = pick('kong')
    if (kong) {
      const after = remove(obs.myHand, responseTile, 3)
      if (mahjongShanten(after, meldCount + 1) <= current) return { ...kong }
    }
    return { ...(pass ?? actions[0]) }
  }
  const discards = actions.filter((a) => a.type === 'discard')
  if (discards.length) {
    const best = chooseDiscard(obs.myHand, meldCount, known)
    for (const a of actions.filter((x) => x.type === 'ankong' || x.type === 'bukong')) {
      const after = remove(obs.myHand, a.tile, a.type === 'ankong' ? 4 : 1)
      const nextMeldCount = meldCount + (a.type === 'ankong' ? 1 : 0)
      if (mahjongShanten(after, nextMeldCount) <= best.shanten) return { ...a }
    }
    return { ...(discards.find((a) => a.tile === best.tile) ?? discards[0]) }
  }
  return { ...(pick('pass') ?? actions[0]) }
}

/** 策略异常也必须返回引擎允许的动作。 */
export function safeMahjongAction(obs) {
  const actions = obs?.myActions ?? []
  try {
    const result = decideMahjongAction(obs)
    const legal = actions.find((a) => a.type === result?.type && (a.tile == null || a.tile === result.tile))
    if (legal) return { ...legal }
  } catch { /* 输入异常或计算失败时退回保守合法动作 */ }
  const fallback = actions.find((a) => a.type === 'pass') ?? actions.find((a) => a.type === 'discard') ?? actions[0]
  return fallback ? { ...fallback } : null
}
