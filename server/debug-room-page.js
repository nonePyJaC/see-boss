/**
 * 真实数据调试页 —— 读 /api/room/* 渲染房间。
 *
 * 这是 room-repo 接上之前的中转：先验证「服务端数据 → 界面」通不通，
 * 再动 OfflineRoomView 那个 2531 行的大文件。
 *
 * 用法：
 *   1. node scripts/seed-demo-room.mjs       造一个 4 人局
 *   2. 浏览器开 http://127.0.0.1:8080/?uid=<uid>&room=<roomNo>
 *   3. 每人用自己的 uid 打开，看到各自的视角
 *
 * 页面每 2s 拉一次 /api/room/state（先不做退避，验证阶段要准）。
 */

import { hamsterDataURI, getHamster } from '../shared/assets/hamsters.mjs'

/** 6 只真仓鼠的 dataURI，启动时算一次，注入页面用 */
const AVATARS = [1, 2, 3, 4, 5, 6].map((id) => hamsterDataURI(getHamster(id), 96))

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>仓鼠聚会 — 房间</title>
<script>window.__AVATARS = ${JSON.stringify(AVATARS)}</script>
<style>
:root{
  --c-bg:#FFF8E7;--c-bg-deep:#FFE9C4;--c-primary:#F6A623;--c-primary-dark:#E08900;
  --c-secondary:#FF8A65;--c-accent:#FFD54F;--c-gold:#FFC107;--c-text:#5D4037;
  --c-text-light:#8D6E63;--c-card:#FFFFFF;--c-border:#F0DCC0;--c-danger:#EF5350;
  --c-success:#66BB6A;--sat:env(safe-area-inset-top,0px);--sab:env(safe-area-inset-bottom,0px);
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%;margin:0}
body{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;
  color:var(--c-text);background:var(--c-bg);user-select:none;-webkit-user-select:none;overscroll-behavior:none}
#app{height:100%}
.page{min-height:100dvh;display:flex;flex-direction:column;padding:var(--sat) 0 var(--sab);
  background:linear-gradient(160deg,var(--c-bg) 0%,var(--c-bg-deep) 100%);max-width:480px;margin:0 auto}

.topbar{flex:0 0 auto;height:52px;display:flex;align-items:center;gap:8px;padding:0 12px}
.back{width:38px;height:38px;border:none;border-radius:50%;background:var(--c-card);color:var(--c-text);
  font-size:22px;line-height:1;cursor:pointer;box-shadow:0 2px 0 var(--c-border)}
.room-tag{display:flex;align-items:center;gap:6px}
.room-tag .no{font-size:17px;font-weight:900}
.room-tag .host{font-size:10px;font-weight:800;color:#fff;background:var(--c-primary);padding:2px 7px;border-radius:7px}
.topbar .spacer{flex:1}
.iconbtn{width:38px;height:38px;border:none;border-radius:50%;font-size:17px;cursor:pointer;
  background:var(--c-card);box-shadow:0 2px 0 var(--c-border)}
.iconbtn.locked{color:var(--c-success)}
.iconbtn.unlocked{color:var(--c-text-light)}
.roundbar{flex:0 0 auto;text-align:center;font-size:12px;color:var(--c-text-light);padding:2px 0 8px}
.roundbar b{color:var(--c-text)}

.pool{flex:0 0 auto;margin:0 14px 12px;padding:14px 16px 16px;background:var(--c-card);
  border-radius:22px;cursor:pointer;box-shadow:0 4px 0 var(--c-border),0 8px 20px rgba(224,137,0,.07)}
.pool-head{display:flex;align-items:baseline;justify-content:center;gap:9px}
.pool-head .nut{font-size:24px}
.pool-head .num{font-size:32px;font-weight:900;color:var(--c-primary-dark);line-height:1}
.pool-head .lbl{font-size:13px;color:var(--c-text-light)}
.peanuts{display:flex;justify-content:center;gap:6px;margin-top:9px;height:12px}
.peanut{width:11px;height:11px;border-radius:50%;border:2px solid var(--c-border)}
.peanut.on{background:var(--c-gold);border-color:var(--c-primary-dark)}
.bets{margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:6px 16px}
.bet-row{display:flex;align-items:center;gap:6px;font-size:12px}
.bet-row .dot{width:7px;height:7px;border-radius:50%;background:var(--c-border)}
.bet-row .dot.sb{background:var(--c-gold)}
.bet-row .dot.bb{background:var(--c-secondary)}
.bet-row .nm{color:var(--c-text-light)}
.bet-row .val{font-weight:800;margin-left:auto}
.bet-row.folded{opacity:.4}
.paused{text-align:center;font-size:12px;font-weight:800;color:var(--c-danger);
  background:#FFEBEE;border-radius:8px;padding:4px 8px;margin-top:10px}

.table{flex:1 1 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:8px 0;
  padding:4px 8px 10px;align-content:start;overflow-y:auto;min-height:0}
.seat{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer}
.locked .seat:active .avatar{transform:scale(.93)}
.avatar{width:58px;height:58px;border-radius:50%;border:3px solid var(--c-border);background:var(--c-card);
  display:flex;align-items:center;justify-content:center;
  transition:transform .12s,border-color .2s,box-shadow .2s}
.avatar img{width:100%;height:100%;border-radius:50%;display:block}
.seat.me .avatar{border-color:var(--c-accent);box-shadow:0 0 0 3px rgba(255,213,79,.28)}
.seat.turn .avatar{border-color:var(--c-danger);animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(239,83,80,.5)}
  50%{transform:scale(1.07);box-shadow:0 0 0 9px rgba(239,83,80,0)}}
.seat.folded .avatar{opacity:.45;filter:grayscale(1)}
.seat-name{font-size:12px;font-weight:700;max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
.seat-nums{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--c-text-light)}
.seat-nums .g{display:flex;align-items:center;gap:3px}
.seat-nums .i{width:9px;height:9px;border-radius:50%}
.seat-nums .i.gold{background:var(--c-gold)}
.seat-nums .i.seed{background:#C9AE85}
.seat-nums .s{font-weight:800;color:var(--c-text);font-size:12px}
.tag{position:absolute;font-size:9px;font-weight:800;padding:1.5px 6px;border-radius:6px;white-space:nowrap}
.tag.me{left:50%;transform:translateX(-50%);bottom:46px;background:var(--c-accent);color:#7A5B00}
.tag.host{top:-3px;right:8px;font-size:14px;background:none}
.tag.sb{left:6px;bottom:46px;background:var(--c-primary);color:#fff}
.tag.bb{left:6px;bottom:46px;background:var(--c-secondary);color:#fff}
.seat.turn::after{content:"决策中";position:absolute;top:-3px;left:50%;transform:translateX(-50%);
  background:var(--c-danger);color:#fff;font-size:9px;font-weight:800;padding:1.5px 6px;border-radius:6px}

.actionbar{flex:0 0 auto;display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:7px;padding:6px 14px 16px}
.actionbar button{height:60px;border:none;border-radius:50%;font-size:15px;font-weight:800;cursor:pointer;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
  transition:transform .08s,box-shadow .08s}
.actionbar button:active{transform:translateY(3px);box-shadow:none}
.actionbar button:disabled{opacity:.4}
.actionbar button.collect{background:linear-gradient(180deg,var(--c-primary) 0%,var(--c-primary-dark) 100%);
  color:#fff;box-shadow:0 4px 0 #C77A00}
.actionbar button.mid{background:var(--c-card);color:var(--c-primary-dark);box-shadow:0 4px 0 var(--c-border)}
.actionbar button.raise{background:linear-gradient(180deg,#FFD54F 0%,#FFB300 100%);color:#7A5B00;box-shadow:0 4px 0 #D89B00}
.actionbar button.fold{background:#E8DCC4;color:var(--c-text-light);box-shadow:0 4px 0 #CDBE9E}

.toast{position:fixed;left:50%;bottom:104px;transform:translateX(-50%);background:rgba(93,64,55,.94);
  color:#fff;font-size:13px;padding:9px 16px;border-radius:12px;opacity:0;transition:opacity .2s;
  pointer-events:none;z-index:30;max-width:78%}
.toast.show{opacity:1}

.mask{position:fixed;inset:0;background:rgba(93,64,55,.5);display:none;align-items:flex-end;justify-content:center;z-index:20}
.mask.show{display:flex}
.sheet{width:100%;max-width:480px;background:var(--c-bg);border-radius:26px 26px 0 0;
  padding:20px 18px 24px;animation:up .22s ease-out}
@keyframes up{from{transform:translateY(30px);opacity:.3}to{transform:none;opacity:1}}
.sheet h3{margin:0 0 6px;font-size:17px;text-align:center}
.sheet .need{text-align:center;font-size:13px;color:var(--c-text-light);margin-bottom:6px}
.sheet .need b{color:var(--c-danger);font-size:19px}
.preview{text-align:center;font-size:14px;font-weight:900;color:var(--c-primary-dark);margin-bottom:16px}
.preview.allin{color:var(--c-danger)}
.preview.allin::after{content:" · All in"}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}
.grid button{height:56px;border:2px solid var(--c-border);border-radius:16px;background:var(--c-card);
  font-weight:900;font-size:17px;cursor:pointer;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:2px;color:var(--c-text)}
.grid button .x{font-size:10px;font-weight:700;color:var(--c-text-light)}
.grid button:active{transform:translateY(2px)}
.grid button.allin{border-color:var(--c-danger);color:var(--c-danger)}
.grid button.allin.hot{background:var(--c-danger);color:#fff;animation:blink 1s infinite}
.grid button.allin.hot .x{color:rgba(255,255,255,.9)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.7}}
.row{display:flex;gap:11px;margin-top:16px;align-items:center}
.row input{flex:1;height:48px;border:2px solid var(--c-border);border-radius:14px;padding:0 14px;
  font-size:17px;font-weight:900;background:var(--c-card);text-align:center;color:var(--c-text)}
.row input.hot{border-color:var(--c-danger);color:var(--c-danger)}
.row .ok{height:48px;padding:0 26px;border:none;background:linear-gradient(180deg,var(--c-primary) 0%,var(--c-primary-dark) 100%);
  color:#fff;border-radius:14px;font-weight:800;font-size:15px;cursor:pointer;box-shadow:0 3px 0 #C77A00}
.cancel{width:100%;margin-top:12px;height:44px;border:none;background:none;color:var(--c-text-light);
  font-size:14px;font-weight:700;cursor:pointer}

.settle{position:fixed;inset:0;background:rgba(93,64,55,.5);display:none;align-items:center;justify-content:center;z-index:25;padding:24px}
.settle.show{display:flex}
.settle .box{width:100%;max-width:340px;background:var(--c-bg);border-radius:22px;padding:22px 20px}
.settle h3{margin:0 0 8px;font-size:18px;text-align:center}
.settle .who{font-align:center;text-align:center;font-size:13px;color:var(--c-text-light);margin-bottom:18px}
.settle .who b{color:var(--c-danger)}
.settle button{width:100%;height:50px;border:none;border-radius:14px;font-size:15px;font-weight:800;
  cursor:pointer;margin-bottom:10px}
.settle .b1{background:linear-gradient(180deg,var(--c-primary) 0%,var(--c-primary-dark) 100%);color:#fff;box-shadow:0 3px 0 #C77A00}
.settle .b2{background:#E8DCC4;color:var(--c-text-light)}
.settle .b3{background:var(--c-card);color:var(--c-text-light);box-shadow:0 3px 0 var(--c-border)}

.gate{height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px}
.gate h2{margin:0;font-size:20px}
.gate p{margin:0;font-size:13px;color:var(--c-text-light);text-align:center;line-height:1.6}
.gate input{width:240px;height:46px;border:2px solid var(--c-border);border-radius:12px;
  padding:0 14px;font-size:15px;text-align:center;background:var(--c-card)}
.gate button{width:240px;height:48px;border:none;border-radius:24px;font-size:16px;font-weight:800;
  color:#fff;background:linear-gradient(180deg,var(--c-primary) 0%,var(--c-primary-dark) 100%);
  box-shadow:0 4px 0 #C77A00;cursor:pointer}
.log{position:fixed;left:0;right:0;bottom:0;max-height:120px;overflow:auto;background:rgba(93,64,55,.9);
  color:#fff;font-size:10px;padding:6px 10px;z-index:50;font-family:ui-monospace,monospace;display:none}
</style>
</head>
<body>
<div id="app"></div>
<div class="toast" id="toast"></div>
<div class="log" id="log"></div>

<script>
const q = new URLSearchParams(location.search)
const UID = q.get('uid') || ''
const ROOM = q.get('room') || ''
const API = location.origin

const $ = id => document.getElementById(id)
const log = (...a) => { const el = $('log'); el.style.display='block'; el.textContent += a.join(' ') + '\\n'; el.scrollTop = el.scrollHeight; console.log(...a) }

const S = {
  me: null, room: null, locked: true, smallBlind: 100,
  timer: null, lastRev: 0, settleShown: false,
}

async function api(path, body = {}) {
  const r = await fetch(API + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: UID, ...body }),
  })
  const j = await r.json().catch(() => ({ ok: false, error: '响应不是 JSON' }))
  if (!j.ok) log('API ' + path + ' -> ' + (j.error || 'fail'))
  return j
}

function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1900) }

// ── 仓鼠头像：用项目里 6 只真仓鼠（带围巾/眼睛款式）──
// dataURI 由服务端注入 window.__AVATARS，页面直接用
const AVATARS = window.__AVATARS || []
function avatarOf(p) {
  const i = (Number(p.avatar) || 1) - 1
  return AVATARS[((i % AVATARS.length) + AVATARS.length) % AVATARS.length] || ''
}

const PEANUTS = { preflop: 0, flop: 3, turn: 4, river: 5 }

// ── 渲染 ──
function render(r) {
  const d = r.data
  const me = d.seats.find(s => s.uid === UID)
  const isHost = d.hostUid === UID
  const myActs = d.avail || []
  const has = t => myActs.some(a => a.type === t)

  $('app').innerHTML =
    '<div class="page ' + (S.locked ? 'locked' : '') + '">' +
      '<div class="topbar">' +
        '<button class="back">←</button>' +
        '<div class="room-tag"><span class="no">' + d.id + '</span>' + (isHost ? '<span class="host">房主</span>' : '') + '</div>' +
        '<div class="spacer"></div>' +
        (isHost ? '<button class="iconbtn ' + (S.locked ? 'locked' : 'unlocked') + '" id="lockBtn">' + (S.locked ? '🔒' : '🔓') + '</button>' : '') +
      '</div>' +
      '<div class="roundbar">第 ' + d.roundNo + ' 局 · 小麦 <b>' + d.smallBlind + '</b> / 大麦 <b>' + d.bigBlind + '</b></div>' +

      '<div class="pool" id="pool">' +
        '<div class="pool-head"><span class="nut">🥜</span><span class="num">' + d.pot + '</span><span class="lbl">公共池</span></div>' +
        '<div class="peanuts">' + [0,1,2,3,4].map(i =>
          '<i class="peanut' + (i < (PEANUTS[d.stage] ?? 0) ? ' on' : '') + '"></i>').join('') + '</div>' +
        '<div class="bets">' + d.seats.map(s =>
          '<div class="bet-row' + (s.folded ? ' folded' : '') + '">' +
          '<i class="dot ' + (s.blind === 'sb' ? 'sb' : s.blind === 'bb' ? 'bb' : '') + '"></i>' +
          '<span class="nm">' + s.nickname + '</span><span class="val">' + s.bet + '</span></div>').join('') + '</div>' +
        (d.paused ? '<div class="paused">已暂停 · 等待房主操作</div>' : '') +
      '</div>' +

      '<div class="table" id="table">' + d.seats.map((s, i) =>
        '<div class="seat' + (s.uid === UID ? ' me' : '') + (s.uid === d.turnUid ? ' turn' : '') + (s.folded ? ' folded' : '') + '" data-uid="' + s.uid + '">' +
          '<div class="avatar"><img src="' + avatarOf(s) + '" alt=""/></div>' +
          (s.uid === UID ? '<span class="tag me">我</span>' : '') +
          (s.uid === d.hostUid ? '<span class="tag host">👑</span>' : '') +
          (s.blind === 'sb' ? '<span class="tag sb">小麦</span>' : '') +
          (s.blind === 'bb' ? '<span class="tag bb">大麦</span>' : '') +
          '<div class="seat-name">' + s.nickname + '</div>' +
          '<div class="seat-nums">' +
            '<span class="g" title="金瓜子"><i class="i gold"></i>' + s.goldSeeds + '</span>' +
            '<span class="g" title="筹码"><i class="i seed"></i><span class="s">' + s.seeds + '</span></span>' +
          '</div>' +
        '</div>').join('') + '</div>' +

      '<div class="actionbar">' +
        '<button class="collect" data-act="collect"' + (has('collect') ? '' : ' disabled') + '>收</button>' +
        '<button class="mid" data-act="' + (d.toCall > 0 ? 'call' : 'check') + '"' + (has(d.toCall > 0 ? 'call' : 'check') ? '' : ' disabled') + '>' +
          (d.toCall > 0 ? '跟 ' + d.toCall : '过') + '</button>' +
        '<button class="raise" data-act="raise" id="btnRaise"' + (has('raise') ? '' : ' disabled') + '>加倍</button>' +
        '<button class="fold" data-act="fold"' + (has('fold') ? '' : ' disabled') + '>弃牌</button>' +
      '</div>' +
    '</div>'

  // 绑定
  if (isHost && $('lockBtn')) $('lockBtn').onclick = () => { S.locked = !S.locked; toast(S.locked ? '已开锁：点玩家设小麦位' : '已关锁'); render(r) }
  if ($('pool')) $('pool').onclick = () => showLogSheet(r)
  document.querySelectorAll('.seat').forEach(el => {
    el.onclick = () => {
      if (!S.locked) return toast('先开锁才能设置小麦位')
      if (!isHost) return toast('只有房主能设置')
      const i = d.seats.findIndex(s => s.uid === el.dataset.uid)
      api('/api/room/start', { roomId: ROOM, sbIndex: i }).then(() => toast('小麦位已设置'))
    }
  })
  document.querySelectorAll('.actionbar button').forEach(b => {
    b.onclick = () => {
      const act = b.dataset.act
      // 加倍：单击/长按都开弹窗。不提供「直接下 1 倍小麦」的
      // 快捷，避免误触（用户明确要求两种手势都给弹窗）。
      if (act === 'raise') return openSheet(r)
      // 收池：二次确认防误触。收掉本手就结束，不可撤回。
      if (act === 'collect') return confirmCollect(r)
      if (act === 'check') { toast('过牌'); return api('/api/room/action', { roomId: ROOM, type: 'check' }).then(pull) }
      if (act === 'call') return api('/api/room/action', { roomId: ROOM, type: 'call' }).then(pull)
      if (act === 'fold') { if (confirm('确定弃牌？')) api('/api/room/action', { roomId: ROOM, type: 'fold' }).then(pull) }
    }
  })
}

/** 收池二次确认。桌上常见「手滑点到」，收回不可逆，必须先问。 */
function confirmCollect(r) {
  const d = r.data
  const zeroed = d.seats.filter(s => s.seeds <= 0).map(s => s.nickname)
  let msg = '收走公共池 ' + d.pot + ' 瓜子？\n收掉后本手结束'
  if (zeroed.length) msg += '，并触发结算（' + zeroed.join('、') + ' 已归零）'
  if (!confirm(msg)) return
  api('/api/room/action', { roomId: ROOM, type: 'collect' })
    .then((x) => { toast(x.ok ? '已收 ' + d.pot + ' 瓜子' : x.error) })
    .then(pull)
}

function showLogSheet(r) {
  const rows = r.data.actionLog || []
  toast(rows.length ? rows.slice(-4).map(x => (x.nickname || '') + ' ' + x.type).join(' / ') : '本手还没有下注')
}

// ── 加注弹窗 ──
function openSheet(r) {
  const d = r.data
  const sb = d.smallBlind
  const max = (me ? me.seeds : 0) - d.toCall
  const need = d.toCall
  const presets = [1, 2, 5, 10, 20].map(x => ({ x, v: sb * x }))

  $('app').insertAdjacentHTML('beforeend',
    '<div class="mask show" id="mask"><div class="sheet">' +
      '<h3>' + (need > 0 ? '跟注 + 加注' : '加注') + '</h3>' +
      '<div class="need">' + (need > 0 ? '需跟 <b>' + need + '</b>，再加注下列数额' : '当前已平注，直接加注') + '</div>' +
      '<div class="preview" id="pv"></div>' +
      '<div class="grid" id="pg">' + presets.map((p, i) =>
        '<button data-i="' + i + '">' + p.v + '<span class="x">' + p.x + '倍</span></button>').join('') +
        '<button class="allin" id="btnAll">All in<span class="x">' + Math.max(0, max) + '</span></button></div>' +
      '<div class="row"><input id="ci" type="number" placeholder="自定义追加"/><button class="ok" id="cok">确定</button></div>' +
      '<button class="cancel" id="cx">取消</button>' +
    '</div></div>')

  const pv = $('pv')
  const upd = (extra, forced) => {
    const allin = forced || extra >= max
    pv.textContent = '共下 ' + Math.min(need + extra, me ? me.seeds : 0)
    pv.classList.toggle('allin', allin)
    $('btnAll').classList.toggle('hot', allin)
    $('ci').classList.toggle('hot', allin)
  }
  upd(presets[0].v)

  $('pg').querySelectorAll('button[data-i]').forEach(b => {
    b.onclick = () => doRaise(Number(presets[b.dataset.i].v), presets[b.dataset.i].x + '倍')
  })
  $('btnAll').onclick = () => doRaise(max, 'All in')
  $('ci').oninput = e => {
    const raw = Number(e.target.value)
    let v = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    const clamped = v > max
    if (clamped) { v = max; e.target.value = max }
    upd(v, clamped)
  }
  $('cok').onclick = () => { const v = Number($('ci').value); if (!Number.isFinite(v) || v <= 0) return toast('请输入有效数额'); doRaise(v, v >= max ? 'All in' : '自定义') }
  $('cx').onclick = () => $('mask').remove()
  $('mask').onclick = e => { if (e.target === $('mask')) $('mask').remove() }

  function doRaise(extra, label) {
    const e2 = Math.min(extra, max)
    if (e2 <= 0) return toast('至少加 1 倍小麦')
    $('mask').remove()
    api('/api/room/action', { roomId: ROOM, type: 'raise', amount: e2 })
      .then(x => { if (x.ok) toast('跟 ' + need + ' + 加 ' + e2 + ' = ' + (need + e2) + '（' + label + '）'); else toast(x.error) })
      .then(pull)
  }
}

// ── 结算弹窗 ──
function showSettle(r) {
  if (S.settleShown) return
  S.settleShown = true
  const isHost = r.data.hostUid === UID
  const zeroed = r.data.seats.filter(s => s.seeds <= 0).map(s => s.nickname).join('、')
  $('app').insertAdjacentHTML('beforeend',
    '<div class="settle show" id="st">' + '<div class="box">' +
      '<h3>本局结束</h3>' +
      '<div class="who">' + zeroed + ' 瓜子归零</div>' +
      (isHost
        ? '<button class="b1" id="stRe">结算并重开</button>' +
          '<button class="b2" id="stDi">结算并解散</button>' +
          '<button class="b3" id="stPa">暂停</button>'
        : '<button class="b2" disabled>等待房主结算…</button>') +
    '</div></div>')
  const rm = () => { const el = $('st'); if (el) el.remove(); S.settleShown = false }
  if (isHost) {
    $('stRe').onclick = () => api('/api/room/settle', { roomId: ROOM, action: 'restart' }).then(rm).then(pull)
    $('stDi').onclick = () => api('/api/room/settle', { roomId: ROOM, action: 'disband' }).then(rm)
    $('stPa').onclick = () => api('/api/room/settle', { roomId: ROOM, action: 'pause' }).then(rm).then(pull)
  }
}

// ── 轮询 ──
async function pull() {
  const r = await api('/api/room/state', { roomId: ROOM })
  if (!r.ok) { $('app').innerHTML = '<div class="gate"><h2>房间不在了</h2><p>' + r.error + '</p></div>'; return }
  render(r)
  if (r.data.settlePending) showSettle(r)
  S.lastRev = r.data.rev
}

function boot() {
  if (!UID || !ROOM) {
    $('app').innerHTML = '<div class="gate"><h2>缺少参数</h2><p>URL 需要 ?uid=xxx&room=123456</p></div>'
    return
  }
  api('/api/account/me').then(m => {
    if (!m.data.loggedIn) { $('app').innerHTML = '<div class="gate"><h2>未登录</h2><p>这个 uid 没绑定账号</p></div>'; return }
    S.me = m.data
    log('已登录 ' + m.data.account + ' 金瓜子 ' + m.data.goldenSeeds)
    pull()
    S.timer = setInterval(pull, 2000)
  })
}
boot()
<\/script>
</body>
</html>`

// ── 路由：/ 返回调试页，其余走静态 ──
export function debugPage() { return PAGE }
