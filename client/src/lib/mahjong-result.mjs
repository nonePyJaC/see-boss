/** 将服务端计分明细按展示区分组，不重新判断牌型或修改计分。 */
export function resultBreakdown(score) {
  const flowers = score?.flowers ?? {}
  const breakdown = Array.isArray(score?.breakdown) ? score.breakdown : []
  const scored = breakdown.filter(({ label }) => !String(label).startsWith('硬花 × ') &&
    !String(label).endsWith('（软花）') && label !== '押档' && label !== '缺一')
  const bonusLabels = new Set(['天胡', '地胡', '花开', '杠开'])
  const types = scored.filter(({ label }) => !bonusLabels.has(label))
  const bonuses = scored.filter(({ label }) => bonusLabels.has(label))
  const soft = [
    { label: '杠', value: flowers.softGang ?? 0 },
    { label: '押档', value: flowers.softYadang ?? 0 },
    { label: '缺一', value: flowers.softQueyi ?? 0 },
  ].filter((item) => item.value !== 0)
  return { types, typeTotal: types.reduce((sum, item) => sum + item.value, 0), bonuses,
    bonusTotal: bonuses.reduce((sum, item) => sum + item.value, 0),
    hardCount: score?.info?.hardCount ?? flowers.hard ?? 0,
    hard: flowers.hard ?? 0, soft, softTotal: flowers.soft ?? 0, total: flowers.total ?? 0 }
}

/** 按实际流水计算每位玩家本手净收付，不用应收金额推断。 */
export function resultNetTransfers(ledger, seats = 4) {
  const totals = Array(seats).fill(0)
  for (const entry of ledger ?? []) for (const transfer of entry.transfers ?? []) {
    if (Number.isInteger(transfer.from) && Number.isInteger(transfer.to) && transfer.from >= 0 && transfer.from < seats && transfer.to >= 0 && transfer.to < seats && Number.isFinite(transfer.paid)) {
      totals[transfer.from] -= transfer.paid; totals[transfer.to] += transfer.paid
    }
  }
  return totals
}
