/** 在对应座位可用区域内尽量放大公开花牌和副露，牌多时允许缩小并提供大图查看。 */
export function groupTileWidth({ width, height, side, kind, flowers = [], melds = [] }) {
  const desired = Math.min(width * .021, height * .045, 20)
  const vertical = side === 'left' || side === 'right'
  if (kind === 'flowers') {
    const units = Math.max(1, flowers.length)
    const available = vertical ? height * .44 : width * (side === 'top' ? .12 : .22)
    return Math.max(1, Math.min(desired, available / units))
  }
  const units = Math.max(1, melds.reduce((sum, meld) => sum + (meld.tiles?.length ?? 0) +
    (Number.isInteger(meld.from) && ['pong', 'kong', 'pongkong'].includes(meld.type) ? .37 : 0), 0))
  const gap = Math.max(0, melds.length - 1) * 3
  const available = vertical ? height * .44 - gap : side === 'top' ? width * .23 - gap : width * .22 * 2 - gap
  return Math.max(1, Math.min(desired, available / units))
}

/** 利用本家尚未使用的副露区域，按实际张数放大手牌。 */
export function handTileWidth({ width, height, count, hasMelds }) {
  const area = width * (hasMelds ? .59 : .75)
  const desired = Math.min(height * .112, width * .06, 46)
  return Math.max(1, Math.min(desired, (area - 9) / Math.max(1, count)))
}
