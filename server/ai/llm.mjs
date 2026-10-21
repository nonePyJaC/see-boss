/**
 * LLM 决策 —— 让 AI 的这一步交给大模型，而不是本地策略。
 *
 * 触发条件：房间开了 useLLM 开关 + 服务端配了 sk-key。
 * 两者缺一都退回本地 decideAction（见 server/index.js 的调用点）。
 *
 * 设计约束：
 *   1. 只喂公开信息 + 自己的底牌。绝不把别人的底牌、Room 对象、
 *      完整 hands 传进去 —— 提示词就是数据边界。
 *   2. 返回值必须是合法动作。模型吐什么都要校验，
 *      不合法就退回本地策略，绝不让牌局卡住。
 *   3. 超时/报错/限流都算降级，不抛给上层。
 *   4. 提示词和响应都不落库、不进日志正文（只记 seat 和耗时）。
 *
 * 走 OpenAI 兼容的 chat/completions 接口 —— sk-key 那套就是这套协议，
 * 所以 baseURL / model 都能用环境变量换，不写死。
 */

const API_BASE = process.env.LLM_API_BASE || 'https://api.stepfun.com/v1'
const API_KEY = process.env.LLM_API_KEY || process.env.SK_KEY || ''
const MODEL = process.env.LLM_MODEL || 'step-5-preview'
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 12000)

/** 没配 key 就等于功能关闭 */
export function llmEnabled() {
  return Boolean(API_KEY)
}

/** 阶段中文名 + 公共牌张数，给提示词用 */
const PHASE_LABEL = {
  preflop: '翻牌前（还没有公共牌）',
  flop: '翻牌圈（3 张公共牌）',
  turn: '转牌圈（4 张公共牌）',
  river: '河牌圈（5 张公共牌）',
}

/** 牌面转可读文本，比如 "♠A ♥K ♥10"。
 *  接受两种写法：sA / hT（T=10）和 s14 / h10 */
function cardText(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return '（无）'
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' }
  const RANK = { A: 'A', K: 'K', Q: 'Q', J: 'J', T: '10', 10: '10',
                 14: 'A', 13: 'K', 12: 'Q', 11: 'J' }
  return cards.map((c) => {
    const m = /^([shdc])(\d{1,2}|[AJQKT])$/i.exec(String(c))
    if (!m) return String(c)
    const suit = SUIT[m[1].toLowerCase()]
    const r = m[2].toUpperCase()
    const rank = RANK[r] ?? (/^\d+$/.test(r) ? r : r)
    return suit + rank
  }).join(' ')
}

/** 性格参数 → 一句人话，塞进提示词让模型知道「我是谁」 */
function personaText(persona) {
  if (!persona) return '均衡型'
  const p = persona.params ?? {}
  const bits = []
  if (p.tightLoose < 0.35) bits.push('起手紧')
  else if (p.tightLoose > 0.65) bits.push('起手松')
  if (p.passiveAggressive > 0.65) bits.push('打法激进')
  else if (p.passiveAggressive < 0.35) bits.push('打法被动')
  if (p.bluffFrequency > 0.5) bits.push('爱诈唬')
  if (p.callTendency > 0.65) bits.push('爱跟注')
  else if (p.callTendency < 0.35) bits.push('容易弃牌')
  if (p.slowPlayFrequency > 0.5) bits.push('会慢打')
  return bits.length ? bits.join('、') : '均衡型'
}

/** 上一手结果 → 一句人话。recentHands 是 unshift 的，[0] 是最新一手 */
function lastHandText(recentHands, mySeatId) {
  if (!Array.isArray(recentHands) || recentHands.length === 0) {
    return '这是本桌第一手，还没有历史。'
  }
  const last = recentHands[0]
  const winnings = last?.result?.winnings ?? []
  const winners = winnings.map((w) => {
    const who = w.uid === mySeatId ? '我' : (w.nickname ?? w.uid)
    return who + '（' + (w.handName ?? w.hand ?? '赢') + '，+' + (w.amount ?? 0) + '）'
  }).join('、')
  return '上一手赢家：' + (winners || '无人（平局或全弃）') +
    '；公共牌 ' + cardText(last?.communityCards ?? [])
}

/**
 * 位置标签。
 *
 * 德州的打法高度依赖位置（按钮位最后发言最占优，小盲/大盲翻前最被动）。
 * 引擎的座位顺序就是发言顺序，所以按 seats 数组下标就能推出位置。
 *
 * @param seats 全部座位（含我），顺序 = 引擎座位顺序
 * @param myIdx 我的下标
 * @param sbIdx 小盲下标（引擎 sbIndex）
 */
function positionLabel(seats, myIdx, sbIdx) {
  const n = seats.length
  if (n < 2 || myIdx < 0) return ''
  const alive = seats.filter((s) => !s.folded).length
  // 单挑时小盲=按钮位且翻前先行动，位置语义完全不同，单独说
  if (alive <= 2) return '单挑（heads-up）'

  const bbIdx = (sbIdx + 1) % n
  // 按钮位 = 小盲前一位
  const btnIdx = (sbIdx - 1 + n) % n
  const bits = []
  if (myIdx === btnIdx) bits.push('按钮位（最后发言，最占优）')
  else if (myIdx === sbIdx) bits.push('小盲位')
  else if (myIdx === bbIdx) bits.push('大盲位')
  // 枪口位 = 大盲下家，翻前第一个发言
  else if (myIdx === (bbIdx + 1) % n) bits.push('枪口位（翻前最先发言）')
  else bits.push('中间位')

  // 距离按钮几个座位
  const dist = (btnIdx - myIdx + n) % n
  if (dist > 0 && dist <= 3) bits.push('距按钮 ' + dist + ' 位（后位）')
  else if (dist > 3) bits.push('距按钮 ' + dist + ' 位（前位）')
  return bits.join('，')
}

/**
 * 组装提示词。
 *
 * 包含：
 *   位置（按钮/小盲/大盲/枪口/中间位）、自己的底牌、当前阶段、公共牌、
 *   池子、盲注、我的后手、别人后手、我的性格、上一手结果、
 *   本手已发生的公开行动（按发言顺序）、可选动作。
 */
export function buildPrompt(obs, persona, recentHands) {
  const phase = PHASE_LABEL[obs.phase] ?? obs.phase
  const players = obs.publicPlayers ?? []
  const myIdx = players.findIndex((p) => p.seatId === obs.mySeatId)

  // 位置：从座位顺序推（引擎 seats 顺序就是发言顺序）
  const sbIdx = Number.isInteger(obs.sbIndex) ? obs.sbIndex : 0
  const pos = positionLabel(players, myIdx, sbIdx)

  // 其他人：带上位置标签，按座位顺序列（不是随机顺序）
  const others = players
    .filter((p) => p.seatId !== obs.mySeatId)
    .map((p, i) => {
      const idx = players.indexOf(p)
      const tag = p.folded ? '已弃牌' : p.allIn ? '已全下' : '在局'
      const role = idx === sbIdx ? '小盲' : idx === (sbIdx + 1) % players.length ? '大盲' : ''
      const roleTxt = role ? '（' + role + '）' : ''
      return `  ${i + 1}. ${p.nickname ?? p.seatId}${roleTxt}：后手 ${p.seeds}，本手已下 ${p.bet}（${tag}）`
    })
    .join('\n')

  const acts = (obs.legalActions ?? []).map((a) => {
    if (a.type === 'raise') {
      const lo = a.min ?? a.minRaise ?? 0
      const hi = a.max ?? a.maxRaise ?? 0
      return `raise（加注到 ${lo} ~ ${hi}）`
    }
    if (a.type === 'call') return `call（跟 ${a.amount ?? obs.currentBet}）`
    return a.type
  }).join(' / ')

  // 本手行动：按发生顺序编号，明确「这是发言顺序」
  const history = (obs.publicActions ?? []).slice(-14).map((a, i) => {
    const who = a.seatId === obs.mySeatId ? '我' : (a.nickname ?? a.seatId)
    const amt = a.amount ? ' ' + a.amount : ''
    return `  ${i + 1}. ${who} ${a.type}${amt}`
  }).join('\n')

  return [
    '你是德州扑克牌桌上的一位玩家，现在轮到你行动。',
    '',
    '【我的位置】' + (pos || '未知'),
    '【我的底牌】' + cardText(obs.myCards),
    '【当前阶段】' + phase,
    '【公共牌】' + cardText(obs.board),
    '【公共池】' + obs.pot,
    '【盲注】小盲 ' + (obs.smallBlind ?? '?') + ' / 大盲 ' + (obs.bigBlind ?? obs.currentBet ?? '?'),
    '【我的后手】' + obs.mySeeds + '（本手已下 ' + obs.myBet + '，当前需跟到 ' + obs.currentBet + '）',
    '【其他玩家】（按座位顺序，小盲→大盲→…）',
    others || '  （无）',
    '【我的性格】' + personaText(persona),
    '【上一手】' + lastHandText(recentHands, obs.mySeatId),
    '【本手已发生的行动】（按发言顺序）',
    history || '  （还没有人行动）',
    '',
    '【你可以做的动作】' + acts,
    '',
    '请按你的性格、位置和当前局面决定这一步。位置很重要：',
    '后位（靠近按钮）信息多、可以宽松些；前位（小盲/枪口）要谨慎。',
    '要考虑是造池、控池还是诈唬；加注尺度要符合下注轮次',
    '（比如 3bet、4bet 的常规大小），别乱来。',
    '',
    '只回一行 JSON，不要解释，不要 markdown 代码块：',
    '{"action":"fold|check|call|raise|allin","amount":加注到的总金额(仅raise需要),"reason":"一句话思路"}',
  ].join('\n')
}

/**
 * 从模型回复里抠出动作。
 * 模型经常裹一层 ```json 或者多说两句，这里只认第一个 { ... }。
 * 导出是为了能单测 —— 解析是最容易出错的一环。
 */
export function parseDecision(text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''))
  if (!m) return null
  let obj
  try {
    obj = JSON.parse(m[0])
  } catch {
    return null
  }
  const type = String(obj?.action ?? '').toLowerCase()
  if (!['fold', 'check', 'call', 'raise', 'allin'].includes(type)) return null
  const out = { type, reason: String(obj?.reason ?? '').slice(0, 120) }
  if (type === 'raise') {
    const amt = Number(obj.amount)
    if (Number.isFinite(amt) && amt > 0) out.amount = Math.floor(amt)
  }
  return out
}

/**
 * 调一次 LLM 拿决策。
 *
 * @returns {Promise<{action, reason, ms, degraded, error?}>}
 *   任何失败都返回 degraded:true 且 action:null，由调用方退回本地策略。
 */
export async function llmDecide(obs, persona, recentHands) {
  if (!llmEnabled()) {
    return { action: null, degraded: true, error: '未配置 sk-key' }
  }
  const prompt = buildPrompt(obs, persona, recentHands)
  const t0 = Date.now()

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 200,
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      // 429/5xx 都算降级，不重试 —— 牌桌上等不起
      return { action: null, degraded: true, error: 'HTTP ' + res.status, ms: Date.now() - t0 }
    }
    const j = await res.json()
    const text = j?.choices?.[0]?.message?.content ?? ''
    const act = parseDecision(text)
    if (!act) {
      return { action: null, degraded: true, error: '解析不出动作', ms: Date.now() - t0 }
    }
    return { action: act, reason: act.reason, degraded: false, ms: Date.now() - t0 }
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    return {
      action: null,
      degraded: true,
      error: aborted ? '超时' : (e?.message ?? String(e)),
      ms: Date.now() - t0,
    }
  } finally {
    clearTimeout(timer)
  }
}
