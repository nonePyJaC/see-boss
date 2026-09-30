/**
 * AI 人设 —— 移植自 D:\dezhou\ai\personality.py 的行为语义。
 *
 * 六维参数都限制在 [0.05, 0.95]。加入房间时基于原型做 ±0.15 扰动并截断，
 * 之后人设参数不再永久修改：情绪/对手适应只产生单次决策的有界修正。
 */

export const PARAM_KEYS = [
  'tightLoose',          // 0=极紧 1=极松
  'passiveAggressive',   // 0=被动 1=激进
  'bluffFrequency',      // 0=不诈唬 1=常诈唬
  'callTendency',        // 0=易弃牌 1=跟注站
  'adaptivity',          // 0=不读人 1=高度适应
  'slowPlayFrequency',   // 0=不慢打 1=常慢打
]

export const PARAM_MIN = 0.05
export const PARAM_MAX = 0.95

export function clampParam(v) {
  return Math.max(PARAM_MIN, Math.min(PARAM_MAX, v))
}

/**
 * 8 个原型（基础值原样取自 personality.py from_archetype）。
 * label 是客户端可见的中文风格标签 —— 只给标签，不给数值。
 */
export const ARCHETYPES = {
  // 风格标签是「性格气质」措辞，不用「鲨鱼 / 新手 / 跟注站」这类
  // 直白暴露打法的词 —— 玩家看得见性格，但读不出策略。
  rock:            { label: '沉稳',   params: [0.15, 0.20, 0.05, 0.30, 0.40, 0.25] },
  tag:             { label: '专注',   params: [0.30, 0.60, 0.20, 0.40, 0.50, 0.30] },
  lag:             { label: '奔放',   params: [0.65, 0.75, 0.40, 0.50, 0.50, 0.15] },
  maniac:          { label: '热忱',   params: [0.85, 0.90, 0.60, 0.60, 0.30, 0.05] },
  calling_station: { label: '随和',   params: [0.70, 0.25, 0.10, 0.80, 0.20, 0.10] },
  nit:             { label: '谨慎',   params: [0.10, 0.15, 0.03, 0.25, 0.30, 0.20] },
  shark:           { label: '从容',   params: [0.40, 0.65, 0.30, 0.45, 0.80, 0.45] },
  beginner:        { label: '青涩',   params: [0.55, 0.40, 0.15, 0.65, 0.10, 0.08] },
}

export const ARCHETYPE_NAMES = Object.keys(ARCHETYPES)

function paramsFromArray(arr) {
  const p = {}
  PARAM_KEYS.forEach((k, i) => { p[k] = arr[i] })
  return p
}

/**
 * 基于原型生成一个扰动后的本次人设。
 * @param {string} archetype 原型名；未知则随机挑一个
 * @param {() => number} rng 随机源（测试注入确定性 RNG）
 * @returns {{archetype:string, params:object, styleLabel:string}}
 */
export function createPersona(archetype, rng = Math.random) {
  const name = ARCHETYPES[archetype] ? archetype : randomArchetype(rng)
  const base = ARCHETYPES[name]
  const params = paramsFromArray(
    base.params.map((v) => clampParam(Math.round((v + (rng() * 0.3 - 0.15)) * 100) / 100)),
  )
  return { archetype: name, params, styleLabel: base.label }
}

export function randomArchetype(rng = Math.random) {
  return ARCHETYPE_NAMES[Math.floor(rng() * ARCHETYPE_NAMES.length)]
}

export function randomPersona(rng = Math.random) {
  return createPersona(randomArchetype(rng), rng)
}
