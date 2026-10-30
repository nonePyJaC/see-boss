/**
 * 南京麻将牌模型 —— 仓鼠聚会
 *
 * 牌面编码：
 *   万子 1m~9m ｜ 条子 1s~9s ｜ 饼子 1p~9p
 *   风牌 E 东 / S 南 / W 西 / N 北
 *   硬花：Z 中 / F 发 / B 白（各 4 张）+ f1~f8 梅兰竹菊春夏秋冬（各 1 张）
 *
 * 南京麻将里「中发白」与「梅兰竹菊春夏秋冬」都是硬花，抓到手即摆进花堆，
 * 不参与组型；参与组型的只有 34 种数字牌与风牌。
 */

export const SUITS = ['m', 's', 'p']
export const SUIT_LABEL = { m: '万', s: '条', p: '饼' }
export const WINDS = ['E', 'S', 'W', 'N']
export const WIND_LABEL = { E: '东', S: '南', W: '西', N: '北' }

/** 花牌：中发白 + 梅兰竹菊春夏秋冬，共 20 张 */
export const DRAGON_FLOWERS = ['Z', 'F', 'B']
export const SEASON_FLOWERS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8']
export const FLOWERS = [...DRAGON_FLOWERS, ...SEASON_FLOWERS]
export const FLOWER_LABEL = {
  Z: '中', F: '发', B: '白',
  f1: '梅', f2: '兰', f3: '竹', f4: '菊',
  f5: '春', f6: '夏', f7: '秋', f8: '冬',
}

/** 参与组型的 34 种牌 */
export const NUMBER_TILES = [
  ...SUITS.flatMap((s) => Array.from({ length: 9 }, (_, i) => `${i + 1}${s}`)),
  ...WINDS,
]

export const ALL_TILES = [...NUMBER_TILES, ...FLOWERS]

/** 中文名，UI 展示用 */
export const TILE_LABEL = Object.fromEntries([
  ...SUITS.flatMap((s) => Array.from({ length: 9 }, (_, i) => [`${i + 1}${s}`, `${i + 1}${SUIT_LABEL[s]}`])),
  ...WINDS.map((w) => [w, WIND_LABEL[w]]),
  ...Object.entries(FLOWER_LABEL),
])

export function isFlower(code) {
  return FLOWERS.includes(code)
}

export function isWind(code) {
  return WINDS.includes(code)
}

export function isDragon(code) {
  return DRAGON_FLOWERS.includes(code)
}

/** 花色：万 m / 条 s / 饼 p；风牌与花牌返回 null */
export function suitOf(code) {
  return isFlower(code) || isWind(code) ? null : code[1]
}

/** 数字：1~9；风牌与花牌返回 null */
export function numberOf(code) {
  const s = suitOf(code)
  return s ? Number(code[0]) : null
}

/** 每种牌允许的最大张数：中发白 4 张，梅兰竹菊春夏秋冬各 1 张，数字/风牌 4 张 */
export function maxCopies(code) {
  if (isDragon(code)) return 4
  if (isFlower(code)) return 1
  return 4
}

export function parseTile(code) {
  if (!ALL_TILES.includes(code)) throw new Error(`无效的牌面编码: ${String(code)}`)
  return {
    code,
    suit: suitOf(code),
    num: numberOf(code),
    flower: isFlower(code),
    wind: isWind(code),
    label: TILE_LABEL[code],
  }
}

export function countsOf(codes) {
  const counts = {}
  for (const c of codes) counts[c] = (counts[c] ?? 0) + 1
  return counts
}

/** 张数校验：任何一张牌超过上限都算非法（识别纠错的第一道校验） */
export function validateCounts(codes) {
  const errors = []
  for (const [code, n] of Object.entries(countsOf(codes))) {
    const max = maxCopies(code)
    if (n > max) errors.push(`${TILE_LABEL[code] ?? code} 出现 ${n} 张，超过 ${max} 张`)
  }
  return errors
}

/** 顺子：同花色连续三张 */
export function isRun(codes) {
  if (codes.length !== 3) return false
  const suit = suitOf(codes[0])
  if (!suit) return false
  if (!codes.every((c) => suitOf(c) === suit)) return false
  const nums = codes.map(numberOf).sort((a, b) => a - b)
  return nums[1] === nums[0] + 1 && nums[2] === nums[1] + 1
}

/** 刻子：三张相同 */
export function isTriplet(codes) {
  return codes.length === 3 && codes[0] === codes[1] && codes[1] === codes[2]
}
