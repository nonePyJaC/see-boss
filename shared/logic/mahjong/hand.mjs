/**
 * 胡牌与牌型判定 —— 南京麻将
 *
 * 输入一副「成牌」（暗牌 + 副露 + 花堆 + 胡的那张牌），输出：
 *   - 是否构成合法胡型（识别纠错的第一道校验：认错牌大多会在这里露馅）
 *   - 命中的牌型（不互斥的牌型全部叠加，互斥牌型由型本身天然分开）
 *   - 软花来源（杠 2 颗 / 押档 1 颗 / 缺一 1 颗）
 *   - 门清、诈胡提示
 *
 * 口径（2026-10-07 与牌桌确认，见《南京麻将规则口径确认.md》）：
 *   - 中发白与梅兰竹菊春夏秋冬都是硬花，不参与组型
 *   - 门清 = 没有碰；直杠/暗杠/花杠都不算开门（碰后补杠记为 pongkong，属于碰）
 *   - 七对 / 双七对必须门清无副露；双七对 = 五对 + 一个四张（14 张）
 *   - 全球独钓 = 四副露（碰/杠）+ 手上只剩一对（含胡牌）
 *   - 无花果 = 无硬花且门清
 *   - 押档（软花 1）= 胡的那张牌是嵌张（如 1、3 胡 2）
 *   - 缺一（软花 1）= 万条饼缺一门（风牌不算门；清一色天然缺两门，同样计）
 */

import {
  DRAGON_FLOWERS,
  ALL_TILES,
  countsOf,
  isFlower,
  isRun,
  isTriplet,
  isWind,
  numberOf,
  suitOf,
  validateCounts,
} from './tiles.mjs'

export const MELD = {
  PONG: 'pong',           // 碰
  KONG: 'kong',           // 直杠（吃别人打出的第四张）
  PONG_KONG: 'pongkong',  // 碰后补杠
  AN_KONG: 'ankong',      // 暗杠
  HUA_KONG: 'huagang',    // 花杠（四张相同的中/发/白）
}

/** 占一个面子位的副露（花杠不占面子位） */
const HAND_MELDS = [MELD.PONG, MELD.KONG, MELD.PONG_KONG, MELD.AN_KONG]
/** 所有杠（算杠钱与软花） */
export const GANG_MELDS = [MELD.KONG, MELD.PONG_KONG, MELD.AN_KONG, MELD.HUA_KONG]

export const HAND_TYPE_LABEL = {
  qidui: '七对',
  shuangqidui: '双七对',
  duiduihu: '对对胡',
  hunyise: '混一色',
  qingyise: '清一色',
  wuhuaguo: '无花果',
  quanqiududiao: '全球独钓',
}

const SOFT_GANG = 2
const SOFT_YADANG = 1
const SOFT_QUEYI = 1

function validateMeld(meld) {
  const tiles = meld?.tiles ?? []
  if (meld?.type === MELD.PONG) {
    if (tiles.length !== 3 || !isTriplet(tiles)) return '碰必须是三张相同的牌'
    return null
  }
  if (GANG_MELDS.includes(meld?.type)) {
    if (meld.type === MELD.HUA_KONG) {
      const group = tiles.slice().sort().join(',')
      if (tiles.length !== 4 || !(DRAGON_FLOWERS.some((t) => tiles.every((x) => x === t)) || group === 'f1,f2,f3,f4' || group === 'f5,f6,f7,f8')) return '花杠必须是四中、四发、四白或一套花牌'
      return null
    }
    if (tiles.length !== 4 || new Set(tiles).size !== 1 || isFlower(tiles[0])) return '手牌杠必须是四张相同的非花牌'
    return null
  }
  return `未知副露类型: ${String(meld?.type)}`
}

/** 标准型拆解：返回所有「四面子 + 一将」拆法（上限 32 种，防极端牌型爆炸） */
export function decomposeStandard(counts) {
  const results = []
  const c = { ...counts }
  const sets = []
  let pair = null

  const pick = () => Object.keys(c).filter((k) => c[k] > 0).sort()[0]

  function rec() {
    if (results.length >= 32) return
    const first = pick()
    if (first === undefined) {
      if (pair) results.push({ sets: sets.map((s) => s.slice()), pair: pair.slice() })
      return
    }
    if (c[first] >= 3) {
      c[first] -= 3
      sets.push([first, first, first])
      rec()
      sets.pop()
      c[first] += 3
    }
    const suit = suitOf(first)
    const num = numberOf(first)
    if (suit && num <= 7) {
      const b = `${num + 1}${suit}`
      const d = `${num + 2}${suit}`
      if (c[b] > 0 && c[d] > 0) {
        c[first] -= 1
        c[b] -= 1
        c[d] -= 1
        sets.push([first, b, d])
        rec()
        sets.pop()
        c[first] += 1
        c[b] += 1
        c[d] += 1
      }
    }
    if (!pair && c[first] >= 2) {
      c[first] -= 2
      pair = [first, first]
      rec()
      pair = null
      c[first] += 2
    }
  }

  rec()
  return results
}

/** 对对胡的暗牌形态：一个对子 + 其余全是刻子 */
function isAllTriplets(counts) {
  const vals = Object.values(counts)
  return vals.filter((v) => v % 3 === 2).length === 1 && vals.every((v) => v % 3 !== 1)
}

/** 七对型：全部是对子（含双七对：至少一个四张 + 其余对子） */
function sevenPairsShape(counts) {
  const vals = Object.values(counts)
  if (vals.some((v) => v !== 2 && v !== 4)) return null
  if (vals.filter((v) => v === 4).length === 1 && vals.filter((v) => v === 2).length === 5) return 'double_seven_pairs'
  return vals.length === 7 ? 'seven_pairs' : null
}

/**
 * 分析一副成牌。
 *
 * @param {object} input
 * @param {string[]} input.concealed  暗牌（含胡的那张）
 * @param {Array<{type:string, tiles:string[], from?:number}>} [input.melds] 副露
 * @param {string[]} [input.flowers]  花堆（硬花）
 * @param {string|null} [input.winTile] 胡的那张牌（判押档用）
 */
export function analyzeHand(input = {}) {
  const concealed = input.concealed ?? []
  const melds = input.melds ?? []
  const flowers = input.flowers ?? []
  const winTile = input.winTile ?? null

  const errors = [...validateCounts([...concealed, ...melds.flatMap((m) => m.tiles ?? []), ...flowers])]
  const allInputTiles = [...concealed, ...melds.flatMap((m) => m.tiles ?? []), ...flowers]
  if (allInputTiles.some((t) => !ALL_TILES.includes(t))) errors.push('存在无效牌面')
  if (concealed.some(isFlower)) errors.push('花牌不能用于手牌组型')
  if (flowers.some((t) => !isFlower(t))) errors.push('花堆只能放花牌')
  if (melds.some((m) => m?.type === MELD.PONG && (m.tiles ?? []).some(isFlower))) errors.push('花牌不能碰')
  for (const m of melds) {
    const err = validateMeld(m)
    if (err) errors.push(err)
  }

  const handMelds = melds.filter((m) => HAND_MELDS.includes(m.type))
  const gangMelds = melds.filter((m) => GANG_MELDS.includes(m.type))
  const meldsConcealed = !melds.some((m) => m.type === MELD.PONG || m.type === MELD.PONG_KONG)

  const counts = countsOf(concealed)
  const allTiles = [...concealed, ...handMelds.flatMap((m) => m.tiles ?? [])]
  /** 硬花总数：花堆 + 花杠里的四张（花杠的牌只记在副露里，避免与花堆重复） */
  const hardCount = flowers.length + melds
    .filter((m) => m.type === MELD.HUA_KONG)
    .reduce((sum, m) => sum + (m.tiles?.length ?? 0), 0)

  const expected = 14 - 3 * handMelds.length
  let shape = 'invalid'
  let decompositions = []
  if (handMelds.length <= 4 && concealed.length === expected) {
    if (handMelds.length === 0 && concealed.length === 14) {
      shape = sevenPairsShape(counts) ?? 'invalid'
    }
    if (shape === 'invalid') {
      decompositions = decomposeStandard(counts)
      if (decompositions.length > 0) shape = 'standard'
    }
  }
  if (shape === 'invalid' && errors.length === 0) {
    errors.push(`暗牌 ${concealed.length} 张，与副露数量对不上（应为 ${expected} 张）`)
  }

  const isStandard = shape === 'standard'
  const suits = new Set(allTiles.map(suitOf).filter(Boolean))
  const hasWind = allTiles.some((c) => isWind(c))

  const types = {
    qidui: shape === 'seven_pairs',
    shuangqidui: shape === 'double_seven_pairs',
    duiduihu: isStandard && isAllTriplets(counts),
    hunyise: suits.size === 1 && hasWind,
    qingyise: suits.size === 1 && !hasWind,
    quanqiududiao: handMelds.length === 4 && concealed.length === 2 && concealed[0] === concealed[1],
    wuhuaguo: false,
  }
  // 无花果：零硬花。口径「无花果小牌必须是门清」——小胡必须门清，
  // 已经是其他大胡的牌（不可能再是小牌）则不再要求门清。
  const hasOtherBig = types.duiduihu || types.hunyise || types.qingyise
    || types.qidui || types.shuangqidui || types.quanqiududiao
  types.wuhuaguo = hardCount === 0 && (meldsConcealed || hasOtherBig)

  // 押档：存在一种拆法让胡的那张成为嵌张（1、3 胡 2）
  let yadang = false
  if (isStandard && winTile && numberOf(winTile) != null) {
    const winNum = numberOf(winTile)
    yadang = decompositions.some((d) =>
      d.sets.some((set) => isRun(set) && set.includes(winTile) && set.map(numberOf).sort((a, b) => a - b)[1] === winNum),
    )
  }

  // 缺一：万条饼缺一门（风牌与花牌不算门）
  const queyi = suits.size <= 2

  const gangCount = gangMelds.length
  const soft = {
    gang: gangCount * SOFT_GANG,
    yadang: yadang ? SOFT_YADANG : 0,
    queyi: queyi ? SOFT_QUEYI : 0,
  }

  const isBigWin = Object.values(types).some(Boolean)
  const valid = shape !== 'invalid' && errors.length === 0
  const hint = valid && !isBigWin && !meldsConcealed && hardCount < 4
    ? '非门清小胡通常需≥4张硬花，请核对牌型是否合法'
    : null

  return {
    valid,
    shape,
    errors,
    meldsConcealed,
    gangCount,
    types,
    typeLabels: Object.entries(types).filter(([, v]) => v).map(([k]) => HAND_TYPE_LABEL[k]),
    soft,
    hardCount,
    isBigWin,
    hint,
    concealedCount: concealed.length,
  }
}
