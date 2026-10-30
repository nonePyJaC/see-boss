/** 南京麻将线上账务：本场瓜子，按事件同时结算，余额不足按比例分配。 */

const SEATS = [0, 1, 2, 3]

function assertSeat(seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) throw new Error('座位无效')
}

function assertAmount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('金额必须是非负安全整数')
}

/**
 * 同一事件以事件前余额分别限制每个付款人；本事件中收到的钱不能用于本事件付款。
 * obligations: {from, to, amount, reason}；同一付款人的款项按最大余数分配。
 */
export function applyPayments(balances, obligations) {
  if (!Array.isArray(balances) || balances.length !== 4) throw new Error('需要四家余额')
  balances.forEach(assertAmount)
  if (!Array.isArray(obligations)) throw new Error('付款义务无效')
  const entries = obligations.map((o, index) => {
    assertSeat(o.from); assertSeat(o.to); assertAmount(o.amount)
    if (o.from === o.to) throw new Error('付款人不能是收款人')
    return { ...o, index, paid: 0 }
  })
  for (const from of SEATS) {
    const group = entries.filter((e) => e.from === from && e.amount > 0)
    const total = group.reduce((sum, e) => sum + BigInt(e.amount), 0n)
    if (!total) continue
    const available = BigInt(balances[from]) < total ? BigInt(balances[from]) : total
    let allocated = 0n
    for (const e of group) {
      const numerator = BigInt(e.amount) * available
      e.paid = Number(numerator / total)
      e.remainder = numerator % total
      allocated += BigInt(e.paid)
    }
    group.sort((a, b) => a.remainder === b.remainder
      ? ((a.to - from + 4) % 4) - ((b.to - from + 4) % 4) || a.index - b.index
      : a.remainder > b.remainder ? -1 : 1)
    let remainder = Number(available - allocated)
    for (const e of group) if (remainder > 0) { e.paid++; remainder-- }
  }
  const next = balances.slice()
  const transfers = entries.map(({ remainder, index, ...e }) => e)
  for (const e of transfers) { next[e.from] -= e.paid; next[e.to] += e.paid }
  if (next.some((n) => !Number.isSafeInteger(n))) throw new Error('余额超出安全整数范围')
  return { balances: next, transfers }
}

/** 仅生成胡款义务；sourceInGarden 是出牌或补杠开始时固定的园子快照。 */
export function winObligations({ winners, source, kind, sourceInGarden = false, balances, bindings = {}, kongSource = null }) {
  if (!Array.isArray(balances) || balances.length !== 4) throw new Error('需要四家余额')
  balances.forEach(assertAmount)
  if (!Array.isArray(winners) || !winners.length) throw new Error('缺少胡家')
  if (!['discard', 'robKong', 'selfDraw'].includes(kind)) throw new Error('胡牌来源无效')
  if (kind !== 'selfDraw') assertSeat(source)
  if (kind === 'selfDraw' && winners.length !== 1) throw new Error('自摸必须只有一位胡家')
  if (kongSource != null) assertSeat(kongSource)
  const seen = new Set()
  const obligations = []
  const pay = (from, to, amount, reason) => obligations.push({ from, to, amount, reason })
  for (const w of winners) {
    assertSeat(w.seat); assertAmount(w.share)
    if (seen.has(w.seat) || (kind !== 'selfDraw' && w.seat === source)) throw new Error('胡家无效')
    seen.add(w.seat)
    const s = w.seat
    if (kind === 'discard' && sourceInGarden) {
      pay(s, source, w.share, '园子点炮反付')
      continue
    }
    if (kind === 'robKong' && sourceInGarden) {
      for (const to of SEATS.filter((i) => i !== s)) pay(s, to, w.share, '抢园子补杠赔付')
      continue
    }
    const responsible = bindings[s]
    if (responsible != null) { assertSeat(responsible); if (responsible === s) throw new Error('三嘴责任人无效') }
    if (responsible != null && (balances[responsible] > 0 || (kind !== 'selfDraw' && responsible === source && !sourceInGarden))) {
      pay(responsible, s, w.share * 3, '三嘴包胡')
    } else if (responsible != null && balances[responsible] === 0) {
      for (const from of SEATS.filter((i) => i !== s && i !== responsible && balances[i] > 0)) pay(from, s, w.share, '三嘴责任人园子免付')
    } else if (kind === 'robKong') {
      pay(source, s, w.share * 3, '抢补杠')
    } else if (kind === 'selfDraw') {
      if (kongSource != null && balances[kongSource] > 0 && responsible == null) {
        if (kongSource === s) throw new Error('点杠者无效')
        pay(kongSource, s, w.share * 3, '点杠包胡')
      } else {
        for (const from of SEATS.filter((i) => i !== s && balances[i] > 0)) pay(from, s, w.share, '自摸')
      }
    } else {
      const replacement = bindings[source]
      if (replacement != null) { assertSeat(replacement); if (replacement === source) throw new Error('三嘴责任人无效') }
      const payer = replacement != null && replacement !== s && balances[replacement] > 0 ? replacement : source
      pay(payer, s, w.share, payer === source ? '点炮' : '三嘴代付点炮')
    }
  }
  for (const e of obligations) assertAmount(e.amount)
  return obligations
}

export function settleOnlineWin(input) {
  const obligations = winObligations(input)
  return applyPayments(input.balances, obligations)
}

export function settleOnlineKong({ balances, seat, type, from, double = false }) {
  assertSeat(seat)
  if (!['ming', 'an', 'bu', 'hua'].includes(type)) throw new Error('杠类型无效')
  if (!Array.isArray(balances) || balances.length !== 4) throw new Error('需要四家余额')
  balances.forEach(assertAmount)
  if (type === 'ming') { assertSeat(from); if (from === seat) throw new Error('被杠者无效') }
  const amount = (type === 'ming' || type === 'hua' ? 10 : 5) * (double ? 2 : 1)
  const payers = type === 'ming' ? [from] : SEATS.filter((i) => i !== seat)
  return applyPayments(balances, payers.filter((i) => balances[i] > 0).map((i) => ({ from: i, to: seat, amount, reason: type + '杠' })))
}
