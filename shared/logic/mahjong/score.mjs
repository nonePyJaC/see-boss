/**
 * 南京麻将计分 —— 花数与明细
 *
 * 口径（2026-10-07 确认，见《南京麻将规则口径确认.md》）：
 *   - 小胡：屁胡 10 / 门清 20（门清替代屁胡，不叠加）
 *   - 大胡：对对胡 30、混一色 30、清一色 40、无花果 40、七对 50、全球独钓 60、双七对 100
 *     互斥牌型不叠加，其余全部叠加（例：门清 + 混一色 + 对对胡 = 20 + 30 + 30 = 80）
 *   - 天胡 +50 / 地胡 +30：与手牌牌型叠加，不计小胡底、不计门清
 *   - 花开 +10 / 杠开 +10（杠开另有「被杠者包三家」结算，见 table.mjs）
 *   - 硬花每张 1 花；杠 2 颗软花（始终计入）
 *   - 押档/缺一是小胡加分项：大胡不再计算（shapeSoftOnlySmall）
 *   - 杠钱独立结算（见 table.mjs 的 settleKong），不进胡牌结算
 *   - 总花数 = 小胡底或大胡牌型 + 门清 + 硬花 + 软花 + 天地胡 + 花开/杠开
 *   - 常规局 ×1；翻倍局全部 ×2（含杠钱与罚分，结算时统一乘）
 */

import { HAND_TYPE_LABEL, analyzeHand } from './hand.mjs'

export const DEFAULT_RULES = {
  pricePerFlower: 1,
  pihu: 10,
  menqing: 20,
  big: {
    duiduihu: 30,
    hunyise: 30,
    qingyise: 40,
    wuhuaguo: 40,
    qidui: 50,
    quanqiududiao: 60,
    shuangqidui: 100,
  },
  menqingBonus: 20,
  tianhu: 50,
  dihu: 30,
  huakai: 10,
  gangkai: 10,
  /** 押档/缺一是小胡加分项：true = 大胡不再计算（杠软花不受影响） */
  shapeSoftOnlySmall: true,
  /** 明杠=被杠者一人付；暗杠/花杠=其余三家各付 */
  gangPay: { ming: 10, an: 5, hua: 10 },
}

/** 不参与门清叠加的牌型（天胡/地胡由 flags 单独排除） */
const MENQING_EXCLUDE = ['qidui', 'shuangqidui', 'wuhuaguo']

export function mergeRules(rules = {}) {
  return {
    ...DEFAULT_RULES,
    ...rules,
    big: { ...DEFAULT_RULES.big, ...(rules.big ?? {}) },
    gangPay: { ...DEFAULT_RULES.gangPay, ...(rules.gangPay ?? {}) },
  }
}

/**
 * 计算一副成牌的花数明细。
 *
 * @param {object} handInput  analyzeHand 的输入
 * @param {{tianhu?:boolean, dihu?:boolean, huakai?:boolean, gangkai?:boolean}} [flags]
 * @param {object} [rules]
 */
export function scoreHand(handInput, flags = {}, rules = DEFAULT_RULES) {
  const R = mergeRules(rules)
  const info = analyzeHand(handInput)
  const { tianhu = false, dihu = false, huakai = false, gangkai = false } = flags

  const bigTypes = Object.entries(info.types).filter(([, v]) => v).map(([k]) => k)
  const bigFlowers = bigTypes.reduce((sum, k) => sum + (R.big[k] ?? 0), 0)
  const hasBig = bigTypes.length > 0 || tianhu || dihu
  const hard = info.hardCount

  const smallBase = hasBig ? 0 : (info.meldsConcealed ? R.menqing : R.pihu)
  const menqingAllowed = info.meldsConcealed && !bigTypes.some((k) => MENQING_EXCLUDE.includes(k)) && !tianhu && !dihu
  const menqingFlowers = hasBig && menqingAllowed ? R.menqingBonus : 0

  const tianhuFlowers = tianhu ? R.tianhu : 0
  const dihuFlowers = dihu ? R.dihu : 0
  const huakaiFlowers = huakai ? R.huakai : 0
  const gangkaiFlowers = gangkai ? R.gangkai : 0

  // 杠软花始终计入；押档/缺一是小胡加分项，大胡不再计算
  const shapeSoft = R.shapeSoftOnlySmall && hasBig ? 0 : 1
  const softGang = info.soft.gang
  const softYadang = info.soft.yadang * shapeSoft
  const softQueyi = info.soft.queyi * shapeSoft
  const soft = softGang + softYadang + softQueyi

  const total = smallBase + bigFlowers + menqingFlowers + tianhuFlowers + dihuFlowers + huakaiFlowers + gangkaiFlowers + hard + soft

  const breakdown = []
  if (smallBase) breakdown.push({ label: info.meldsConcealed ? '门清' : '屁胡', value: smallBase })
  for (const k of bigTypes) breakdown.push({ label: HAND_TYPE_LABEL[k], value: R.big[k] ?? 0 })
  if (menqingFlowers) breakdown.push({ label: '门清（叠加）', value: menqingFlowers })
  if (tianhuFlowers) breakdown.push({ label: '天胡', value: tianhuFlowers })
  if (dihuFlowers) breakdown.push({ label: '地胡', value: dihuFlowers })
  if (huakaiFlowers) breakdown.push({ label: '花开', value: huakaiFlowers })
  if (gangkaiFlowers) breakdown.push({ label: '杠开', value: gangkaiFlowers })
  if (hard) breakdown.push({ label: `硬花 × ${hard}`, value: hard })
  if (softGang) breakdown.push({ label: `杠 × ${info.gangCount}（软花）`, value: softGang })
  if (softYadang) breakdown.push({ label: '押档', value: softYadang })
  if (softQueyi) breakdown.push({ label: '缺一', value: softQueyi })

  const labels = [...info.typeLabels]
  if (tianhu) labels.push('天胡')
  if (dihu) labels.push('地胡')
  if (huakai) labels.push('花开')
  if (gangkai) labels.push('杠开')
  if (!hasBig && info.meldsConcealed) labels.push('门清')

  return {
    info,
    labels,
    breakdown,
    flowers: {
      small: smallBase,
      big: bigFlowers,
      menqing: menqingFlowers,
      tianhu: tianhuFlowers,
      dihu: dihuFlowers,
      huakai: huakaiFlowers,
      gangkai: gangkaiFlowers,
      hard,
      soft,
      softGang,
      softYadang,
      softQueyi,
      total,
    },
    isBigWin: hasBig,
    hint: info.hint,
  }
}
