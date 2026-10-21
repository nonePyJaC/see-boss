/**
 * LLM 决策 —— 让 AI 的这一步交给大模型，而不是本地策略。
 *
 * 触发条件：房间开了 useLLM 开关 + 选了模型 + 该模型配了 key。
 * 缺任何一项都退回本地 decideAction（见 server/index.js 的调用点）。
 *
 * 设计约束：
 *   1. 只喂公开信息 + 自己的底牌。绝不把别人的底牌、Room 对象、
 *      完整 hands 传进去 —— 提示词就是数据边界。
 *   2. 返回值必须是合法动作。模型吐什么都要校验，
 *      不合法就退回本地策略，绝不让牌局卡住。
 *   3. 超时/报错/限流都算降级，不抛给上层。
 *   4. 提示词和响应都不落库、不进日志正文（只记 seat 和耗时）。
 *
 * 走 OpenAI 兼容的 chat/completions 接口，所以各家都能接。
 */

/**
 * 模型注册表。
 *
 * key 只从环境变量读，不进仓库 —— 仓库里只有模型名和 baseURL。
 * 真实 key 由服务器上的 pm2 环境变量提供（见 ecosystem.server.config.cjs）。
 *
 * 想加第三个模型：在这里加一项 + 在服务器配对应 key，不用改别处。
 */
const MODELS = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    base: process.env.DEEPSEEK_BASE || 'https://api.deepseek.com',
    key: process.env.DEEPSEEK_API_KEY || '',
    // 深度思考靠换模型实现（deepseek-reasoner）
    thinkingModel: 'deepseek-reasoner',
  },
  stepfun: {
    id: 'stepfun',
    label: 'StepFun',
    model: process.env.STEPFUN_MODEL || 'step-5-preview',
    base: process.env.STEPFUN_BASE || 'https://api.stepfun.com/v1',
    key: process.env.STEPFUN_API_KEY || '',
    // 深度思考靠 reasoning_effort 参数实现
    thinkingParam: 'reasoning_effort',
    // ⚠️ 这是个通用推理模型，不适合牌桌实时决策，实测数据：
    //    · 思考过程算进 max_tokens，给到 3000 仍被截断、content 始终为空
    //      （finish_reason: length，reasoning_content 里只有分析没有 JSON）
    //    · 单次耗时 22~50 秒，牌桌上一个人要等半分钟才能动
    //    所以默认不推荐；保留是因为 key 已配、想试的人可以自己选，
    //    选之前会看到下面这条提示。
    warn: '该模型思考很慢（20 秒以上）且经常不返回结果，建议用 DeepSeek',
  },
}

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 12000)

/** 模型 id → 配置。id 不存在返回 null */
export function getModel(id) {
  return MODELS[String(id)] ?? null
}

/** 给前端下拉用：只列配了 key 的模型 */
export function availableModels() {
  return Object.values(MODELS)
    .filter((m) => m.key)
    .map((m) => ({ id: m.id, label: m.label, model: m.model, warn: m.warn ?? '' }))
}

/** 有没有任何一个模型可用 */
export function llmEnabled() {
  return Object.values(MODELS).some((m) => m.key)
}

/** 某个模型可用吗（配了 key） */
export function modelReady(id) {
  const m = getModel(id)
  return Boolean(m?.key)
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

  // 本手行动：按发生顺序编号，明确「这是发言顺序」。
  // 动作名翻成人话，并带上该动作投入的金额 —— 模型必须能看出
  // 注额结构（谁下了小盲、谁加注到多少、当前要跟多少）。
  const ACT_LABEL = {
    blind: '下盲注',
    blind_allin: '盲注全下',
    fold: '弃牌',
    check: '过牌',
    call: '跟注',
    bet: '下注',
    raise: '加注到',
    allin: '全下',
    give: '划转',
  }
  const history = (obs.publicActions ?? []).slice(-14).map((a, i) => {
    const who = a.seatId === obs.mySeatId ? '我' : (a.nickname ?? a.seatId)
    const label = ACT_LABEL[a.type] ?? a.type
    const amt = a.amount ? ' ' + a.amount : ''
    // 盲注要区分大小麦，否则两人都显示「下盲注」看不出结构
    const role = a.type === 'blind' || a.type === 'blind_allin'
      ? (a.amount <= (obs.smallBlind ?? 0) ? '（小盲）' : '（大盲）')
      : ''
    return `  ${i + 1}. ${who} ${label}${role}${amt}`
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
    '【当前注额】本轮最高下注 ' + obs.currentBet +
      '，我已下 ' + obs.myBet +
      (obs.currentBet > obs.myBet ? '，还需补 ' + (obs.currentBet - obs.myBet) + ' 才能平注' : '，已平注'),
    '【我的后手】' + obs.mySeeds,
    '【其他玩家】（按座位顺序，小盲→大盲→…）',
    others || '  （无）',
    '【我的性格】' + personaText(persona),
    '【上一手】' + lastHandText(recentHands, obs.mySeatId),
    '【本手已发生的行动】（按发言顺序，含盲注）',
    history || '  （还没有人行动）',
    '',
    '【你可以做的动作】' + acts,
    '',
    '请按你的性格、位置和当前局面决定这一步。位置很重要：',
    '后位（靠近按钮）信息多、可以宽松些；前位（小盲/枪口）要谨慎。',
    '要注意当前注额结构：谁已经下注、下到多少、我还差多少才平注。',
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
 * @param {object} opts
 *   modelId   用哪个模型（默认第一个可用的）
 *   thinking  是否开深度思考（默认 false）
 *   search    是否联网搜索（默认 false；当前两家都不支持，预留）
 *
 * @returns {Promise<{action, reason, ms, degraded, error?, model?}>}
 *   任何失败都返回 degraded:true 且 action:null，由调用方退回本地策略。
 */
export async function llmDecide(obs, persona, recentHands, opts = {}) {
  const cfg = getModel(opts.modelId) ?? Object.values(MODELS).find((m) => m.key)
  if (!cfg?.key) {
    return { action: null, degraded: true, error: '模型未配置 key' }
  }

  const thinking = opts.thinking === true
  // 深度思考的实现方式各家不同：
  //   DeepSeek 换模型（deepseek-reasoner）
  //   StepFun  加 reasoning_effort 参数
  const model = thinking && cfg.thinkingModel ? cfg.thinkingModel : cfg.model
  const body = {
    model,
    messages: [{ role: 'user', content: buildPrompt(obs, persona, recentHands) }],
    temperature: 0.7,
    // ⚠️ StepFun 是推理模型，思考过程算在 max_tokens 里。
    //    给 200 会把额度全用光在思考上、content 是空的（finish_reason:length），
    //    实测踩过。所以它的下限给到 1200，够思考 + 输出 JSON。
    max_tokens: cfg.id === 'stepfun' ? 1200 : (thinking ? 800 : 200),
  }
  if (thinking && cfg.thinkingParam) {
    body[cfg.thinkingParam] = 'high'
  }

  const t0 = Date.now()
  const ctrl = new AbortController()
  // 思考模型慢得多，超时放宽
  const timer = setTimeout(() => ctrl.abort(), thinking ? TIMEOUT_MS * 3 : TIMEOUT_MS)
  try {
    const res = await fetch(cfg.base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.key,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      // 429/5xx 都算降级，不重试 —— 牌桌上等不起
      return {
        action: null, degraded: true, model: cfg.id,
        error: 'HTTP ' + res.status, ms: Date.now() - t0,
      }
    }
    const j = await res.json()
    const msg = j?.choices?.[0]?.message
    // content 为空时退回 reasoning_content —— 推理模型有时把答案写在思考里
    // （StepFun 实测：content 空、reasoning_content 有完整 JSON）
    const text = msg?.content?.trim()
      ? msg.content
      : (msg?.reasoning_content ?? msg?.reasoning ?? '')
    const act = parseDecision(text)
    if (!act) {
      return {
        action: null, degraded: true, model: cfg.id,
        error: '解析不出动作', ms: Date.now() - t0,
      }
    }
    return { action: act, reason: act.reason, degraded: false, model: cfg.id, ms: Date.now() - t0 }
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    return {
      action: null, degraded: true, model: cfg.id,
      error: aborted ? '超时' : (e?.message ?? String(e)),
      ms: Date.now() - t0,
    }
  } finally {
    clearTimeout(timer)
  }
}
