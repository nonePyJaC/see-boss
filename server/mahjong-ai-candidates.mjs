/** 仅基于本座位和公开信息建立“动作成功时”的条件候选，不修改输入。 */
import { settleOnlineKong } from '../shared/logic/mahjong/online-payments.mjs'
import { mahjongVisibleCounts } from './mahjong-ai-v1.mjs'

const CALLS = new Set(['pong', 'kong', 'pongkong'])
const clone = (x) => structuredClone(x)
const remove = (hand, tile, n = 1) => {
  const result = hand.slice()
  for (let i = 0; i < n; i++) { const at = result.indexOf(tile); if (at < 0) throw new Error('手牌不含所需牌'); result.splice(at, 1) }
  return result
}

/** 明确区分无绑定、已绑定和历史来源不完整。补杠只更新原副露，不新增嘴。 */
export function bindingAfterCall(me, source, action) {
  if (me.binding != null) return { binding: me.binding, status: 'existing', possibleSource: null }
  if (!['pong', 'kong'].includes(action)) return { binding: null, status: 'unchanged', possibleSource: null }
  if (!Number.isInteger(source) || source < 0 || source > 3) return { binding: null, status: 'unknown', possibleSource: null }
  const calls = (me.melds ?? []).filter((m) => CALLS.has(m.type)).map((m) => m.from)
  if (calls.length < 2) return { binding: null, status: 'not-bound', possibleSource: null }
  const recent = calls.slice(-2)
  if (recent.some((s) => !Number.isInteger(s) || s < 0 || s > 3)) return { binding: null, status: 'unknown', possibleSource: source }
  return recent.every((s) => s === source)
    ? { binding: source, status: 'new', possibleSource: null }
    : { binding: null, status: 'not-bound', possibleSource: null }
}

/** 非概率的公开抢杠/截胡不确定性成本，不能推断他人暗牌或精确听口。 */
export function claimUncertainty(obs, action) {
  if (!['pong', 'kong', 'bukong'].includes(action)) return { points: 0, basis: '无待裁定响应' }
  const opponents = (obs.players ?? []).filter((_, i) => i !== obs.seat)
  const ready = opponents.filter((p) => p.ready === true).length
  const exposed = opponents.reduce((sum, p) => sum + Math.min(2, (p.melds ?? []).filter((m) => CALLS.has(m.type) || m.type === 'ankong').length), 0)
  const late = Math.max(0, 40 - (obs.wallCount ?? 40)) / 80
  const points = Math.min(5, (action === 'bukong' ? 1.5 : .5) + ready * .6 + exposed * .2 + late)
  return { points, basis: action === 'bukong' ? '公开信息下抢补杠不确定性，非概率' : '其他家胡牌或更高优先级响应的不确定性，非概率', ready, exposed }
}

/** 条件候选均保留原先公开信息；成功的碰/直杠把牌河中的牌移入副露。 */
export function buildCandidateStates(obs, riskForDiscard = () => 0) {
  const me = obs.players[obs.seat], result = []
  for (const action of obs.myActions ?? []) {
    if (!['discard', 'pass', 'pong', 'kong', 'ankong', 'bukong'].includes(action.type)) continue
    if (action.type === 'pass' && !obs.response) continue
    const tile = action.tile ?? (['pong', 'kong'].includes(action.type) ? obs.response?.tile : null)
    const melds = clone(me.melds ?? [])
    let hand = obs.myHand.slice(), binding = { binding: me.binding ?? null, status: 'unchanged', possibleSource: null }
    let successBalances = obs.balances.slice(), guaranteed = 0, conditional = 0, payouts = [], terminal = false
    const uncertainty = claimUncertainty(obs, action.type)
    if (action.type === 'discard') hand = remove(hand, tile)
    else if (['pong', 'kong', 'ankong', 'bukong'].includes(action.type)) {
      const n = action.type === 'pong' ? 2 : action.type === 'kong' ? 3 : action.type === 'ankong' ? 4 : 1
      hand = remove(hand, tile, n)
      binding = bindingAfterCall(me, obs.response?.source, action.type)
      if (action.type === 'bukong') {
        const m = melds.find((x) => x.type === 'pong' && x.tiles[0] === tile)
        if (!m) throw new Error('补杠缺少已有碰')
        m.type = 'pongkong'; m.tiles.push(tile)
      } else melds.push({ type: action.type === 'pong' ? 'pong' : action.type === 'kong' ? 'kong' : 'ankong',
        tiles: Array(action.type === 'pong' ? 3 : 4).fill(tile), ...(['pong', 'kong'].includes(action.type) ? { from: obs.response?.source } : {}) })
      if (action.type !== 'pong') {
        const pay = settleOnlineKong({ balances: obs.balances, seat: obs.seat, type: action.type === 'kong' ? 'ming' : action.type === 'ankong' ? 'an' : 'bu', from: obs.response?.source, double: !!obs.double })
        successBalances = pay.balances; payouts = pay.transfers
        const net = pay.balances[obs.seat] - obs.balances[obs.seat]
        if (action.type === 'ankong') guaranteed = net
        else conditional = net
        terminal = successBalances.filter((x) => x === 0).length >= 2
      }
    }
    const after = (discard = null) => {
      const remaining = discard ? remove(hand, discard) : hand.slice()
      const players = obs.players.map((p) => ({ ...p, melds: clone(p.melds ?? []), discards: (p.discards ?? []).slice() }))
      players[obs.seat] = { ...players[obs.seat], melds: clone(melds), binding: binding.binding }
      if (['pong', 'kong'].includes(action.type)) {
        const river = players[obs.response.source]?.discards
        if (river?.at(-1) === tile) river.pop()
      }
      if (action.type === 'discard' || discard) players[obs.seat].discards.push(discard ?? tile)
      const view = { ...obs, players, balances: successBalances.slice(), myHand: remaining.slice(), response: action.type === 'pass' ? obs.response : null }
      const discardRisk = action.type === 'discard' ? riskForDiscard(obs, tile) : discard ? riskForDiscard(obs, discard) : 0
      const kind = ['pong', 'kong', 'bukong'].includes(action.type) ? 'conditional-success' : 'committed-on-acceptance'
      return { action: { ...action }, hand: remaining, preDiscardHand: action.type === 'discard' ? obs.myHand.slice() : hand.slice(), melds, balances: successBalances, observation: view,
        visible: mahjongVisibleCounts(view), binding, risk: discardRisk + uncertainty.points, discardRisk, uncertainty,
        immediate: guaranteed, conditionalGain: conditional, payouts, terminal, projectedDiscard: discard,
        branch: { kind, success: { immediate: guaranteed + conditional, balances: successBalances.slice(), replacement: ['kong','ankong','bukong'].includes(action.type) ? 'unknown' : null, terminal },
          ...(action.type === 'bukong' ? { robbed: { immediate: 0, meld: 'pong', replacement: false, sourceInGarden: obs.balances[obs.seat] === 0, settlement: '抢杠胡家及牌型未知，按实际规则结算' } } : {}) } }
    }
    if (action.type === 'pong') for (const discard of new Set(hand)) result.push(after(discard))
    else result.push(after())
  }
  return result
}
