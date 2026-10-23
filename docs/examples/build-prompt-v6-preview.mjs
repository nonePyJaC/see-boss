import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createTwoHandPreview } from './prompt-v6-two-hands.mjs'
import { cardText } from '../../server/ai/prompt-facts.mjs'

const root = new URL('../../', import.meta.url)
const baseline = '415e21fc59504f191edca23fca76e993e291d2f4'
const oldFile = name => execFileSync('git', ['show', baseline + ':' + name], { cwd: root, encoding: 'utf8' })
const asModule = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const oldFacts = oldFile('server/ai/prompt-facts.mjs')
  .replaceAll("'../../shared/logic/cards.mjs'", JSON.stringify(new URL('shared/logic/cards.mjs', root).href))
  .replaceAll("'../../shared/logic/hand-evaluator.mjs'", JSON.stringify(new URL('shared/logic/hand-evaluator.mjs', root).href))
const oldLlm = await import(asModule(oldFile('server/ai/llm.mjs').replace("'./prompt-facts.mjs'", JSON.stringify(asModule(oldFacts)))))
const preview = createTwoHandPreview()
const requests = preview.hands.flatMap(h => h.requests)
const chars = text => [...text].length
const total = messages => messages.reduce((n, m) => n + chars(m.content), 0)
const before = requests.reduce((n, r) => n + total(oldLlm.buildMessages(r.obs, r.persona, r.recentHands)), 0)
const after = requests.reduce((n, r) => n + total(r.messages), 0)
const metrics = { baseline, oldSystemCharacters: chars(oldLlm.LLM_SYSTEM_PROMPT), newSystemCharacters: chars(preview.system),
  sampleRequests: requests.length, oldInputCharacters: before, newInputCharacters: after,
  reduction: ((1 - after / before) * 100).toFixed(2) + '%' }
const phaseName = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' }
const actionName = { check: '过牌', call: '跟注', fold: '弃牌', raise: '下注/加注' }
const table = (heads, rows) => '| ' + heads.join(' | ') + ' |\n| ' + heads.map(() => '---').join(' | ') + ' |\n' + rows.map(row => '| ' + row.join(' | ') + ' |').join('\n')
const lines = [
  '# v6两手三人桌提示词预览', '',
  '**本地待确认，尚未部署。全部牌局和输出由人工构造，未调用模型；示例不是模型实测结果，也不是唯一最优打法。**', '',
  '1名玩家＋2名AI，盲注50/100，初始各5000。AI甲风格偏紧稳健，AI乙风格偏松主动；第二手继续第一手的筹码并轮转按钮。概览展示全桌底牌只供审阅，每条模型输入只含决策AI自己的底牌。', '',
  '产品调整：优先牌力、对手公开行动、价格/位置，再参考风格；补清实际踢脚来源与超对。上一手仅一句公共结果，不加入跨手统计，不发送上一手牌面或详细流水；当前手历史仍完整。', '',
  `固定system：${metrics.oldSystemCharacters}→${metrics.newSystemCharacters}字符。两手17个请求总输入：${before}→${after}字符，减少${metrics.reduction}。这是同局面的字符对比，不冒充供应商token或缓存计量。`, '',
  '[打开逐决策输入预览](D:/newPoker/docs/examples/prompt-v6-preview.html)：可选择两手中17个AI决策，查看实际构建的完整user消息、固定system和人工示范JSON。', '',
]
for (const h of preview.hands) {
  lines.push(`## 第${h.number}手：${h.title}`, '',
    table(['玩家', '底牌', '开局筹码', '结算后筹码'], ['human', 'ai-a', 'ai-b'].map((id, i) => [
      ['玩家', 'AI甲（稳健）', 'AI乙（主动）'][i], cardText(h.holes[id]), h.initialSeeds[id], h.nextSeeds[id],
    ])), '', `公共牌依次为：${cardText(h.board.slice(0, 3))} → ${cardText(h.board.slice(3, 4))} → ${cardText(h.board.slice(4))}。`, '',
    table(['轮次', '完整行动顺序'], Object.keys(phaseName).map(p => [phaseName[p], h.steps.filter(s => s.phase === p)
      .map(s => s.actor + actionName[s.action] + (s.amount != null ? '到' + s.amount : '')).join(' → ')])), '',
    table(['轮次/序号', 'AI', '人工示例输出'], h.requests.map(r => [phaseName[r.phase] + '/' + r.sequence, r.actor,
      '`' + JSON.stringify(r.illustrativeOutput) + '`'])), '',
    '河牌后公开记录：', '', '```text', h.resultSummary, '```', '',
  )
  if (h.number === 1) lines.push('这句记录就是第二手所有请求的上一手输入。不包含弃牌AI的牌型、上一手完整历史、私牌或对手统计；6850是分池额，非净赚。', '')
  else lines.push('AI甲河牌跟注后输给玩家的A对子，示范的是按范围与价格进行防守，不能把“最后输了”自动解释成决策错误。AI乙转牌弃牌后不再产生河牌请求。', '')
}
lines.push('## 上一手无人跟注的记录口径', '',
  '例如公开记录确认座1河牌下注后两人弃牌，会写成“座1（河牌圈下注后2人弃牌，未摊牌，分池900）”。未摊牌时不猜测其高牌或诈唬；只有公开摊牌结果明确牌型，才填写一对、两对等。未匹配下注退回不计入分池。', '',
  '## 固定system原文', '', '```text', preview.system, '```', '',
  '## 保留边界', '',
  '模型、温度、token预算、超时、JSON输出格式、日志、本地回退与引擎均不改。完整本手历史与共享追加前缀继续保留。只做直接输入控制和这两手固定示例，不做全量或真实牌局模拟，不调用付费模型。已知引擎收街问题仍未修复。', '',
  '生成命令：`node docs/examples/build-prompt-v6-preview.mjs`。构造与校验代码不属于生产决策路径。', '',
)
fs.writeFileSync(new URL('../AI提示词v6两手预览.md', import.meta.url), lines.join('\n'))
const pageData = {
  version: preview.version, system: preview.system, metrics,
  hands: preview.hands.map(h => ({ number: h.number, title: h.title, board: cardText(h.board), resultSummary: h.resultSummary,
    seats: ['human', 'ai-a', 'ai-b'].map((id, i) => ({ name: ['玩家', 'AI甲（稳健）', 'AI乙（主动）'][i], cards: cardText(h.holes[id]),
      before: h.initialSeeds[id], after: h.nextSeeds[id] })),
    rounds: Object.keys(phaseName).map(p => ({ phase: p, name: phaseName[p], actions: h.steps.filter(s => s.phase === p)
      .map(s => s.actor + actionName[s.action] + (s.amount != null ? '到' + s.amount : '')).join(' → ') })),
    requests: h.requests.map(r => ({ phase: r.phase, sequence: r.sequence, actor: r.actor, board: cardText(r.board),
      potBefore: r.potBefore, user: r.messages[1].content, output: JSON.stringify(r.illustrativeOutput),
      historyActions: r.obs.publicActions.length, characters: total(r.messages) })),
  })),
}
const dataJson = JSON.stringify(pageData).replaceAll('<', '\\u003c')
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>v6两手三人桌 · 待确认</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#202a31;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1200px;margin:auto;padding:28px 22px 60px}h1{font-size:27px;margin:0 0 8px}h2{font-size:21px;margin:0 0 12px}h3{font-size:16px;margin:0 0 8px}.muted{color:#63717c}.notice{background:#fff4d6;border:1px solid #e5c76d;border-radius:12px;padding:14px 18px;margin:18px 0}.card{background:white;border:1px solid #dfe4e7;border-radius:14px;padding:20px;margin-top:18px}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}button,select{font:inherit;padding:9px 14px;border:1px solid #bac7cd;border-radius:8px;background:white;color:#25383c}button{cursor:pointer}button.active{background:#0f6261;color:white;border-color:#0f6261}button:focus-visible,select:focus-visible{outline:3px solid #b3d9d0}button:disabled{opacity:.4;cursor:default}.seats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.seat{padding:13px;background:#f3f7f6;border-radius:9px}.cards{font-size:20px;letter-spacing:1px}.round{border-bottom:1px solid #e4e8eb;padding:10px 0}.round:last-child{border:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:14px/1.8 Consolas,"Microsoft YaHei",monospace}details summary{cursor:pointer;font-weight:600}.meta{display:flex;gap:22px;flex-wrap:wrap;font-size:14px;color:#567}.output{background:#edf7f1;border-color:#9dc9ad}.tag{font-size:13px;padding:3px 8px;border-radius:5px;background:#e7f0ef;color:#235753}a{color:#0f6261}@media(max-width:650px){main{padding:18px 13px}.seats{grid-template-columns:1fr}h1{font-size:23px}}
</style><main>
<h1>v6 两手三人桌提示词预览</h1><div class="muted">一名玩家＋两个AI · 逐街查看输入与简短输出 · 本地待确认</div>
<div class="notice"><strong>人工构造示例，未调用模型，尚未部署。</strong><br>所有动作由人工指定，并经现有引擎校验顺序、金额与筹码守恒；输出用于检查表达和输入结构，不能证明真实模型会这样打。全桌底牌仅在概览供你审阅，每次模型只收到自己的底牌。</div>
<div class="card"><div class="row"><button id="hand1">第一手</button><button id="hand2">第二手</button><span class="tag">poker-facts-v6</span></div><h2 id="title" style="margin-top:16px"></h2><div class="seats" id="seats"></div><p id="board"></p><div id="rounds"></div><p id="result"></p></div>
<div class="card"><h2>选择AI决策</h2><div class="row"><label>轮次 <select id="phase"><option value="all">全部轮次</option><option value="preflop">翻牌前</option><option value="flop">翻牌</option><option value="turn">转牌</option><option value="river">河牌</option></select></label><select id="decision" aria-label="具体AI决策"></select><button id="previous">上一次</button><button id="next">下一次</button></div><p class="meta" id="meta"></p><div class="output card"><h3>人工示范输出（一行JSON）</h3><pre id="output"></pre></div></div>
<div class="card"><h2>本次实际构建的 user 输入</h2><p class="muted">完整保留截至该时点的本手公开行动。上一手只保留一句结果；风格位于牌力、价格和对手状态之后。</p><pre id="user"></pre></div>
<div class="card"><details><summary>查看固定 system 原文</summary><p class="muted" id="metrics"></p><pre id="system"></pre></details></div>
<p class="muted">没有模型调用或付费token消耗。字符数对比不是供应商token计量。当前引擎收街问题仍单独保留，本示例不验证或修复它。</p>
</main><script>const DATA=${dataJson};
let handIndex=0,requestIndex=0;const $=id=>document.getElementById(id);const phaseName={preflop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌'};
const filtered=()=>DATA.hands[handIndex].requests.filter(r=>$('phase').value==='all'||r.phase===$('phase').value);
function renderHand(){const h=DATA.hands[handIndex];$('hand1').className=handIndex===0?'active':'';$('hand2').className=handIndex===1?'active':'';$('title').textContent=h.title;$('seats').replaceChildren();for(const s of h.seats){const el=document.createElement('div');el.className='seat';const n=document.createElement('strong');n.textContent=s.name;const c=document.createElement('div');c.className='cards';c.textContent=s.cards;const p=document.createElement('div');p.textContent=s.before+' → '+s.after+' 瓜子';el.append(n,c,p);$('seats').append(el)}$('board').textContent='完整公共牌：'+h.board;$('rounds').replaceChildren();for(const round of h.rounds){const d=document.createElement('div');d.className='round';const b=document.createElement('strong');b.textContent=round.name+'：';d.append(b,document.createTextNode(round.actions));$('rounds').append(d)}$('result').textContent='结算后下一手仅保留：'+h.resultSummary;renderList()}
function renderList(){requestIndex=0;const rs=filtered();$('decision').replaceChildren();for(const [i,r]of rs.entries()){const o=document.createElement('option');o.value=i;o.textContent='第'+r.sequence+'步 · '+phaseName[r.phase]+' · '+r.actor;$('decision').append(o)}renderRequest()}
function renderRequest(){const rs=filtered(),r=rs[requestIndex];$('decision').value=requestIndex;$('previous').disabled=requestIndex===0;$('next').disabled=requestIndex===rs.length-1;if(!r)return;$('meta').textContent='当时公共牌：'+r.board+' ｜ 决策前底池：'+r.potBefore+' ｜ 完整历史：'+r.historyActions+'条 ｜ 输入：'+r.characters+'字符';$('user').textContent=r.user;$('output').textContent=r.output}
$('hand1').onclick=()=>{handIndex=0;renderHand()};$('hand2').onclick=()=>{handIndex=1;renderHand()};$('phase').onchange=renderList;$('decision').onchange=()=>{requestIndex=Number($('decision').value);renderRequest()};$('previous').onclick=()=>{requestIndex--;renderRequest()};$('next').onclick=()=>{requestIndex++;renderRequest()};$('system').textContent=DATA.system;$('metrics').textContent='固定规则 '+DATA.metrics.oldSystemCharacters+' → '+DATA.metrics.newSystemCharacters+'字符；17次总输入 '+DATA.metrics.oldInputCharacters+' → '+DATA.metrics.newInputCharacters+'字符，减少'+DATA.metrics.reduction+'。实际token和缓存以供应商usage为准。';renderHand();</script></html>`
fs.writeFileSync(new URL('prompt-v6-preview.html', import.meta.url), html)
console.log(JSON.stringify({ ...metrics, documents: ['docs/AI提示词v6两手预览.md', 'docs/examples/prompt-v6-preview.html'] }, null, 2))
