/** 将服务端计分明细按展示区分组，不重新判断牌型或修改计分。 */
export function resultBreakdown(score) {
  const flowers = score?.flowers ?? {}
  const breakdown = Array.isArray(score?.breakdown) ? score.breakdown : []
  const types = breakdown.filter(({ label }) => !String(label).startsWith('硬花 × ') &&
    !String(label).endsWith('（软花）') && label !== '押档' && label !== '缺一')
  const soft = [
    { label: '杠', value: flowers.softGang ?? 0 },
    { label: '押档', value: flowers.softYadang ?? 0 },
    { label: '缺一', value: flowers.softQueyi ?? 0 },
  ].filter((item) => item.value !== 0)
  return { types, typeTotal: types.reduce((sum, item) => sum + item.value, 0),
    hardCount: score?.info?.hardCount ?? flowers.hard ?? 0,
    hard: flowers.hard ?? 0, soft, softTotal: flowers.soft ?? 0, total: flowers.total ?? 0 }
}
