// LLM 自身公开打法与可变辅助风格。仅房间内存；不改基础人设、不进入本地策略。
export const LLM_STYLES = Object.freeze({
  base: '基础风格', balanced: '均衡取舍', pressure: '偏主动争取底池',
  patient: '偏稳健选择投入', tricky: '有依据地混合诱导与诈唬',
})
const WINDOW = 8

export function normalizeNextStyle(value) {
  if (typeof value !== 'string') return null
  const style = value.trim().toLowerCase()
  return Object.hasOwn(LLM_STYLES, style) ? style : null
}

function own(rt, seatId) {
  rt.llmSelf ??= new Map()
  let state = rt.llmSelf.get(seatId)
  if (!state) { state = { style: 'base', hands: [] }; rt.llmSelf.set(seatId, state) }
  return state
}

export function beginSelfHand(rt, seatId, handId) {
  if (!Number.isSafeInteger(handId) || handId < 0) return null
  const state = own(rt, seatId)
  const existing = state.hands.find(h => h.handId === handId)
  if (existing) return existing
  if (state.hands.at(-1)?.handId > handId) return null
  const hand = { handId, completed: false, folded: false, entered: false,
    bets: 0, calls: 0, checks: 0, faced: 0, foldToBet: 0 }
  state.hands.push(hand)
  if (state.hands.length > WINDOW + 1) state.hands.shift()
  return hand
}

export function recordSelfAction(rt, seatId, action) {
  if (!['fold', 'check', 'call', 'bet', 'raise', 'allin'].includes(action.type)) return
  const hand = beginSelfHand(rt, seatId, action.handId)
  if (!hand || hand.completed) return
  const kind = action.type === 'allin'
    ? Number.isFinite(action.raiseTo) && Number.isFinite(action.currentBetBefore)
      ? action.raiseTo > action.currentBetBefore ? 'raise' : 'call' : null
    : action.type === 'bet' ? 'raise' : action.type
  const paid = Number.isFinite(action.paidAmount) && action.paidAmount > 0
  if (kind === 'raise' && paid) hand.bets++
  if (kind === 'call' && paid) hand.calls++
  if (kind === 'check') hand.checks++
  if (kind === 'fold') hand.folded = true
  if (action.facedBet === true) { hand.faced++; if (kind === 'fold') hand.foldToBet++ }
  if (action.phase === 'preflop' && paid && (kind === 'raise' || kind === 'call')) hand.entered = true
}

export function finishSelfHand(rt, seatId, handId, folded) {
  const hand = beginSelfHand(rt, seatId, handId)
  if (!hand || hand.completed) return
  hand.completed = true
  hand.folded = folded === true
}

export function llmSelfContext(rt, seatId) {
  const state = own(rt, seatId), hands = state.hands.filter(h => h.completed).slice(-WINDOW)
  let consecutiveFolds = 0
  for (let i = hands.length - 1; i >= 0 && hands[i].folded; i--) consecutiveFolds++
  const sum = key => hands.reduce((n, h) => n + h[key], 0)
  return { style: state.style, history: { hands: hands.length, foldedHands: hands.filter(h => h.folded).length,
    consecutiveFolds, enteredHands: hands.filter(h => h.entered).length,
    bets: sum('bets'), calls: sum('calls'), checks: sum('checks'), faced: sum('faced'), foldToBet: sum('foldToBet') } }
}

export function applyNextStyle(rt, seatId, value) {
  const next = normalizeNextStyle(value)
  if (!next) return null
  const state = own(rt, seatId), previous = state.style
  if (next === previous) return null
  state.style = next
  return { from: previous, to: next }
}

export function selfHistoryText(history) {
  const keys = ['hands', 'foldedHands', 'consecutiveFolds', 'enteredHands', 'bets', 'calls', 'checks', 'faced', 'foldToBet']
  if (!history || !keys.every(k => Number.isSafeInteger(history[k]) && history[k] >= 0)) return '自身历史未提供，不假定频率。'
  if (!history.hands) return '暂无已完成手牌；本手动作见完整历史。'
  return `近${history.hands}手：弃${history.foldedHands}、连弃${history.consecutiveFolds}；翻前自愿入池${history.enteredHands}；下注/加注${history.bets}、跟注${history.calls}、过牌${history.checks}；面对下注${history.faced}次弃${history.foldToBet}。`
}

export function currentStyleText(style, baseText) {
  const id = normalizeNextStyle(style) ?? 'base'
  return (id === 'base' ? baseText : LLM_STYLES[id]) + `（当前${id}）`
}
