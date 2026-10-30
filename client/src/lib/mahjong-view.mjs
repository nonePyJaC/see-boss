import { MAHJONG_TILES, MAHJONG_TILE_BACK, MAHJONG_TILE_DIR } from '../data/mahjong-tiles.js'

const honors = { E: '1z', S: '2z', W: '3z', N: '4z', Z: '5z', F: '6z', B: '7z' }
const byNotation = new Map(MAHJONG_TILES.map((tile) => [tile.notation, tile]))
// 原牌面路径会被缓存一年；更换素材时变更版本，确保手机获取新版。
export const TILE_ASSET_VERSION = 'clear-20261030'
const order = ['m', 'p', 's']
export function tileInfo(code) {
  if (code === 'back') return { file: MAHJONG_TILE_BACK, name: '背面' }
  return byNotation.get(honors[code] ?? code) ?? { file: null, name: String(code ?? '') }
}
export function tileUrl(code, base = (import.meta.env?.BASE_URL ?? './')) {
  const file = tileInfo(code).file
  return file ? `${base}${MAHJONG_TILE_DIR}${file}?v=${TILE_ASSET_VERSION}` : null
}
export function relativeSeat(seat, viewer) {
  return (seat - viewer + 4) % 4
}
/** 来源相对副露拥有者：下家横在右、对家横在中、上家横在左。 */
export function sidewaysIndex(meld, owner) {
  if (!['pong', 'kong', 'pongkong'].includes(meld?.type) || !Number.isInteger(meld.from)) return -1
  const relative = relativeSeat(meld.from, owner)
  if (relative === 1) return meld.type === 'kong' ? 3 : 2
  if (relative === 2) return 1
  if (relative === 3) return 0
  return -1
}
export function sortedHand(hand, lastDraw) {
  const result = (hand ?? []).map((code, index) => ({ code, index, drawn: false }))
  if (lastDraw != null) {
    const found = result.findLastIndex((t) => t.code === lastDraw)
    if (found >= 0) result[found].drawn = true
  }
  return result.sort((a, b) => {
    if (a.drawn !== b.drawn) return a.drawn ? 1 : -1
    const rank = (x) => {
      const suit = x.code?.[1], suitIndex = order.indexOf(suit)
      return suitIndex >= 0 ? suitIndex * 9 + Number(x.code[0]) : 27 + ['E', 'S', 'W', 'N'].indexOf(x.code)
    }
    return rank(a) - rank(b) || a.index - b.index
  })
}
