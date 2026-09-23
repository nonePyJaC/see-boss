import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initHand, dealHoleCards, applyAction, availableActions, raiseOptions, showdown, PHASE } from './betting.mjs'
import { createShuffledDeck } from './cards.mjs'

/** 固定随机源，保证测试可复现 */
function seededDeck(gameType, seed = 42) {
  let s = seed
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  return createShuffledDeck(gameType, rand)
}

const PLAYERS = [
  { uid: 'a', nickname: '阿鼠', avatar: 1, seeds: 1000 },
  { uid: 'b', nickname: '小鼠', avatar: 2, seeds: 1000 },
  { uid: 'c', nickname: '仓仓', avatar: 3, seeds: 1000 },
]

function newGame(overrides = {}) {
  const cfg = {
    players: PLAYERS,
    smallBlind: 10,
    bigBlind: 20,
    gameType: 'long',
    dealerUid: null,
    roundNo: 1,
    deck: seededDeck('long'),
    ...overrides,
  }
  return initHand(cfg)
}

test('初始化：扣盲注并设定第一个行动者', () => {
  const s = newGame()
  // 3 人局，庄家 a，小盲 b，大盲 c，翻牌前从 a 开始
  assert.equal(s.dealerUid, 'a')
  const sb = s.seats.find((x) => x.uid === 'b')
  const bb = s.seats.find((x) => x.uid === 'c')
  assert.equal(sb.bet, 10)
  assert.equal(bb.bet, 20)
  assert.equal(sb.totalBet, 10)
  assert.equal(bb.totalBet, 20)
  assert.equal(s.pot, 30)
  assert.equal(s.currentBet, 20)
  assert.equal(s.turnUid, 'a', '翻牌前从庄家左手第三个 = 庄家自己')
})

test('初始化：双人局庄家是小盲', () => {
  const s = newGame({
    players: PLAYERS.slice(0, 2),
  })
  assert.equal(s.seats[0].uid, 'a')
  assert.equal(s.dealerUid, 'a')
  assert.equal(s.seats[0].bet, 10, '庄家 a 是小盲')
  assert.equal(s.seats[1].bet, 20, 'b 是大盲')
  assert.equal(s.turnUid, 'a', '双人局翻牌前庄家先行动')
})

test('初始化：盲注超过筹码时部分全下', () => {
  const s = newGame({
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 1000 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 5 }, // 不够小盲
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
    ],
  })
  const b = s.seats.find((x) => x.uid === 'b')
  assert.equal(b.bet, 5)
  assert.equal(b.allIn, true)
})

test('跟注推进到下一个玩家', () => {
  let s = newGame()
  assert.equal(s.turnUid, 'a')
  const r = applyAction(s, { uid: 'a', type: 'call' })
  assert.equal(r.error, undefined)
  s = r.state
  assert.equal(s.seats.find((x) => x.uid === 'a').bet, 20)
  assert.equal(s.turnUid, 'b', '轮到小盲')
})

test('不能越权行动', () => {
  let s = newGame()
  const r = applyAction(s, { uid: 'b', type: 'call' })
  assert.equal(r.error, '还没轮到你行动')
})

test('过牌在需要跟注时被拒绝', () => {
  let s = newGame()
  const r = applyAction(s, { uid: 'a', type: 'check' })
  assert.ok(r.error.includes('需要跟注'))
})

test('弃牌后该玩家不再参与', () => {
  let s = newGame()
  let r = applyAction(s, { uid: 'a', type: 'fold' })
  s = r.state
  assert.equal(s.seats.find((x) => x.uid === 'a').folded, true)
  assert.equal(s.turnUid, 'b')
  // 弃牌者不能再行动
  r = applyAction(s, { uid: 'a', type: 'call' })
  assert.ok(r.error)
})

test('一轮全部跟注后自动翻牌', () => {
  let s = newGame()
  s = applyAction(s, { uid: 'a', type: 'call' }).state
  s = applyAction(s, { uid: 'b', type: 'call' }).state // 小盲补到 20
  s = applyAction(s, { uid: 'c', type: 'check' }).state // 大盲无需跟注，过牌 → 翻牌
  assert.equal(s.phase, PHASE.FLOP, '翻牌前结束应进 flop')
  assert.equal(s.communityCards.length, 3, '应翻出 3 张公共牌')
  assert.equal(s.pot, 60, '三人各 20')
  // 重置下注额
  assert.equal(s.seats.every((x) => x.bet === 0), true)
  assert.equal(s.currentBet, 0)
})

test('转牌翻 1 张，河牌翻 1 张', () => {
  let s = newGame()
  // 翻牌前：a 跟 20，b 补到 20，c 过牌
  s = applyAction(s, { uid: 'a', type: 'call' }).state
  s = applyAction(s, { uid: 'b', type: 'call' }).state
  s = applyAction(s, { uid: 'c', type: 'check' }).state
  assert.equal(s.phase, PHASE.FLOP)
  assert.equal(s.communityCards.length, 3)
  // flop 圈从庄家左手第一个未弃牌玩家开始 = b
  assert.equal(s.turnUid, 'b')

  // flop 圈：b → c → a 全过牌
  s = applyAction(s, { uid: 'b', type: 'check' }).state
  s = applyAction(s, { uid: 'c', type: 'check' }).state
  s = applyAction(s, { uid: 'a', type: 'check' }).state
  assert.equal(s.phase, PHASE.TURN)
  assert.equal(s.communityCards.length, 4, '转牌 1 张')
  assert.equal(s.turnUid, 'b')

  // turn 圈全过牌
  s = applyAction(s, { uid: 'b', type: 'check' }).state
  s = applyAction(s, { uid: 'c', type: 'check' }).state
  s = applyAction(s, { uid: 'a', type: 'check' }).state
  assert.equal(s.phase, PHASE.RIVER)
  assert.equal(s.communityCards.length, 5, '河牌 1 张')

  // river 圈全过牌 → 摊牌
  s = applyAction(s, { uid: 'b', type: 'check' }).state
  s = applyAction(s, { uid: 'c', type: 'check' }).state
  s = applyAction(s, { uid: 'a', type: 'check' }).state
  assert.equal(s.phase, PHASE.SHOWDOWN, '河牌圈结束应摊牌')
  assert.equal(s.finished, true)
  assert.equal(s.turnUid, null)
})

test('加注后其他人必须重新行动', () => {
  let s = newGame()
  s = applyAction(s, { uid: 'a', type: 'call' }).state
  s = applyAction(s, { uid: 'b', type: 'raise', amount: 60 }).state // 小盲从 10 加到 60
  assert.equal(s.currentBet, 60)
  assert.equal(s.turnUid, 'c', '加注后轮到大盲')
  // c 必须行动
  const acts = availableActions(s, 'c')
  assert.ok(acts.some((x) => x.type === 'call'))
  assert.equal(s.seats.find((x) => x.uid === 'a').bet, 20, 'a 已下 20 未重来')
  // c 跟注后轮到 a（a 需回应加注）
  s = applyAction(s, { uid: 'c', type: 'call' }).state
  assert.equal(s.turnUid, 'a', 'a 需回应加注')
})

test('加注必须达到最小加注额', () => {
  let s = newGame()
  const r = applyAction(s, { uid: 'a', type: 'raise', amount: 25 }) // currentBet=20, minRaise=20 → 至少要 40
  assert.ok(r.error.includes('最小加注额'))
})

test('筹码不足时不能加注，只能跟注或全下', () => {
  let s = newGame({
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 30 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 1000 },
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
    ],
  })
  // a 有 30，需跟 20 剩 10，无法加注
  const acts = availableActions(s, 'a')
  assert.ok(acts.some((x) => x.type === 'call'))
  assert.equal(acts.some((x) => x.type === 'raise'), false, '筹码不足不能加注')
})

test('全下扣除全部剩余筹码', () => {
  let s = newGame({
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 100 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 1000 },
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
    ],
  })
  const r = applyAction(s, { uid: 'a', type: 'allin' })
  assert.equal(r.error, undefined)
  s = r.state
  const a = s.seats.find((x) => x.uid === 'a')
  assert.equal(a.seeds, 0)
  assert.equal(a.allIn, true)
  assert.equal(a.totalBet, 100)
})

test('其他人都弃牌时直接结束，无需摊牌', () => {
  let s = newGame()
  s = applyAction(s, { uid: 'a', type: 'fold' }).state
  s = applyAction(s, { uid: 'b', type: 'fold' }).state
  assert.equal(s.phase, PHASE.SHOWDOWN)
  assert.equal(s.finished, true)
  assert.equal(s.communityCards.length, 0, '无人跟注不发公共牌')
})

test('底牌每人 2 张且不重复', () => {
  const s = newGame()
  const hands = dealHoleCards(s)
  assert.equal(hands.a.length, 2)
  assert.equal(hands.b.length, 2)
  assert.equal(hands.c.length, 2)
  const all = [...hands.a, ...hands.b, ...hands.c]
  assert.equal(new Set(all).size, 6, '6 张牌不能重复')
  assert.equal(s.dealt, 6)
})

test('短牌牌堆 36 张，发牌不越界', () => {
  const s = newGame({
    gameType: 'short',
    deck: seededDeck('short'),
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 1000 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 1000 },
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
      { uid: 'd', nickname: 'D', avatar: 4, seeds: 1000 },
    ],
  })
  assert.equal(s.deck.length, 36)
  const hands = dealHoleCards(s)
  assert.equal(s.dealt, 8)
})

test('庄家位每局轮转', () => {
  // 第一局 dealerUid=null → 默认 seats[0]（a）当庄
  const s1 = newGame()
  assert.equal(s1.dealerUid, 'a')
  // 第二局传入上局庄家 a → 应轮到 b
  const s2 = newGame({ dealerUid: 'a' })
  assert.equal(s2.dealerUid, 'b', '庄家位应从 a 轮到 b')
  // 第三局
  const s3 = newGame({ dealerUid: 'b' })
  assert.equal(s3.dealerUid, 'c')
  // 循环回 a
  const s4 = newGame({ dealerUid: 'c' })
  assert.equal(s4.dealerUid, 'a')
})

test('applyAction 不修改原状态（纯函数）', () => {
  const s = newGame()
  const snapshot = JSON.stringify(s)
  applyAction(s, { uid: 'a', type: 'call' })
  assert.equal(JSON.stringify(s), snapshot, '原状态不应被修改')
})

test('applyAction 兼容 Vue reactive 代理对象（回归）', () => {
  // 前端会把 state 放在 ref() 里再传进来，代理对象无法被 structuredClone 处理
  const s = newGame()
  const proxy = new Proxy(s, {
    get(t, k) {
      const v = t[k]
      // 模拟 reactive：嵌套对象也包一层代理
      return v && typeof v === 'object' ? new Proxy(v, this) : v
    },
  })
  const r = applyAction(proxy, { uid: 'a', type: 'call' })
  assert.equal(r.error, undefined, `代理对象不应报错: ${r.error}`)
  assert.equal(r.state.seats.find((x) => x.uid === 'a').bet, 20)
})

test('applyAction 兼容 JSON 往返后的状态（数据库场景）', () => {
  // 云端存取会把 state 序列化，反序列化后应同样可用
  const s = JSON.parse(JSON.stringify(newGame()))
  const r = applyAction(s, { uid: 'a', type: 'call' })
  assert.equal(r.error, undefined)
  assert.equal(r.state.turnUid, 'b')
})

// ── 行动流水 ──

test('行动流水记录每个动作', () => {
  let s = newGame()
  s = applyAction(s, { uid: 'a', type: 'call' }).state
  s = applyAction(s, { uid: 'b', type: 'raise', amount: 60 }).state

  const log = s.actionLog
  assert.equal(log.length, 2)

  assert.equal(log[0].uid, 'a')
  assert.equal(log[0].type, 'call')
  assert.equal(log[0].amount, 20, 'a 补足到 20，投入 20')
  assert.equal(log[0].betTotal, 20)
  assert.equal(log[0].phase, 'preflop')

  assert.equal(log[1].uid, 'b')
  assert.equal(log[1].type, 'raise')
  assert.equal(log[1].amount, 50, 'b 从 10 加到 60，投入 50')
  assert.equal(log[1].nickname, '小鼠')
})

test('弃牌和过牌记录金额为 0', () => {
  let s = newGame()
  s = applyAction(s, { uid: 'a', type: 'fold' }).state
  assert.equal(s.actionLog[0].type, 'fold')
  assert.equal(s.actionLog[0].amount, 0)
})

test('失败的动作不写入流水', () => {
  const s = newGame()
  const r = applyAction(s, { uid: 'b', type: 'call' }) // 不是 b 的回合
  assert.ok(r.error)
  // 返回的 state 不存在，原状态也不应有流水
  assert.equal(s.actionLog.length, 0)
})

test('流水跨阶段保留，可按 phase 筛选', () => {
  let s = newGame()
  s = applyAction(s, { uid: 'a', type: 'call' }).state
  s = applyAction(s, { uid: 'b', type: 'call' }).state
  s = applyAction(s, { uid: 'c', type: 'check' }).state // → flop

  assert.equal(s.phase, PHASE.FLOP)
  assert.equal(s.actionLog.filter((a) => a.phase === 'preflop').length, 3)
  assert.equal(s.actionLog.filter((a) => a.phase === 'flop').length, 0)

  s = applyAction(s, { uid: 'b', type: 'check' }).state
  assert.equal(s.actionLog.filter((a) => a.phase === 'flop').length, 1)
})

// ── 动态加注档位 ──

test('加注档位随 currentBet 变化', () => {
  let s = newGame()
  // currentBet=20, minRaise=20 → 档位应为 40/70/120/...
  const opts = raiseOptions(s, 'a')
  const targets = opts.map((o) => o.targetTotal)
  assert.equal(targets[0], 40, '最小加注档 = currentBet + minRaise')
  assert.ok(targets.includes(40))
  assert.ok(targets.includes(70))
  assert.ok(targets.includes(120))
})

test('小于最小加注额的档位被过滤', () => {
  let s = newGame()
  // minRaise=20，所以 +5 和 +10 不该出现
  const opts = raiseOptions(s, 'a')
  const incs = opts.map((o) => o.increment)
  assert.equal(incs.includes(5), false)
  assert.equal(incs.includes(10), false)
  assert.equal(incs.includes(20), true)
})

test('筹码不足的档位标记为不可用', () => {
  let s = newGame({
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 30 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 1000 },
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
    ],
  })
  // a 有 30，已下 0，最多到 30；currentBet=20 → +20 到 40 需要 40，不可用
  const opts = raiseOptions(s, 'a')
  const big = opts.find((o) => o.increment === 500)
  assert.ok(big)
  assert.equal(big.affordable, false, '500 档应不可用')
})

test('自动追加全下档位', () => {
  let s = newGame({
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 137 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 1000 },
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
    ],
  })
  const opts = raiseOptions(s, 'a')
  const allIn = opts.find((o) => o.isAllIn)
  assert.ok(allIn, '应有全下档位')
  assert.equal(allIn.targetTotal, 137, '全下目标 = 我的全部筹码')
  assert.equal(allIn.affordable, true)
})

test('全下档位不重复添加', () => {
  // 筹码正好等于某个档位目标时，不该出现两个相同 targetTotal
  let s = newGame({
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 120 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 1000 },
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
    ],
  })
  const opts = raiseOptions(s, 'a')
  const targets = opts.map((o) => o.targetTotal)
  assert.equal(new Set(targets).size, targets.length, '档位不应重复')
})

test('加注档位产出的目标额都能通过 applyAction', () => {
  let s = newGame()
  for (const o of raiseOptions(s, 'a')) {
    if (!o.affordable) continue
    const r = applyAction(s, { uid: 'a', type: 'raise', amount: o.targetTotal })
    assert.equal(r.error, undefined, `档位 +${o.increment} 应可执行: ${r.error}`)
  }
})

test('自定义加注：任意合法金额都能通过', () => {
  const s = newGame()
  // currentBet=20, minRaise=20 → 合法范围 [40, 1000]
  for (const v of [40, 55, 77, 123, 500, 999]) {
    const r = applyAction(s, { uid: 'a', type: 'raise', amount: v })
    assert.equal(r.error, undefined, `加注到 ${v} 应可执行: ${r.error}`)
  }
})

test('自定义加注：低于最小加注额被拒', () => {
  const s = newGame()
  const r = applyAction(s, { uid: 'a', type: 'raise', amount: 35 }) // 需要 >= 40
  assert.ok(r.error?.includes('最小加注额'))
})

test('自定义加注：超过自己筹码被拒', () => {
  const s = newGame({
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 50 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 1000 },
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
    ],
  })
  const r = applyAction(s, { uid: 'a', type: 'raise', amount: 200 })
  assert.ok(r.error?.includes('筹码不足'))
})

// ── check 校验 ──

test('上家加注后，下家不能过牌', () => {
  let s = newGame()
  s = applyAction(s, { uid: 'a', type: 'call' }).state
  s = applyAction(s, { uid: 'b', type: 'raise', amount: 60 }).state
  // 现在 currentBet=60，轮到 c，c 需要跟 60，不能过牌
  const acts = availableActions(s, 'c')
  assert.equal(acts.some((a) => a.type === 'check'), false, '有注额时不应提供过牌')
  assert.ok(acts.some((a) => a.type === 'call'), '应提供跟注')
  assert.ok(acts.some((a) => a.type === 'fold'), '应提供弃牌')

  // 即使前端伪造请求，applyAction 也要拒绝
  const r = applyAction(s, { uid: 'c', type: 'check' })
  assert.ok(r.error, '伪造的过牌请求必须被拒绝')
  assert.ok(r.error.includes('需要跟注'))
})

test('本轮无注时才能过牌', () => {
  let s = newGame()
  s = applyAction(s, { uid: 'a', type: 'call' }).state
  s = applyAction(s, { uid: 'b', type: 'call' }).state
  s = applyAction(s, { uid: 'c', type: 'check' }).state // 大盲无需跟注 → 翻牌
  // flop 圈无注，所有人都能过牌
  assert.equal(s.currentBet, 0)
  const acts = availableActions(s, s.turnUid)
  assert.ok(acts.some((a) => a.type === 'check'))
  assert.equal(acts.some((a) => a.type === 'call'), false, '无注额时不应提供跟注')
})

test('跟注后下注额对齐，下一轮恢复可过牌', () => {
  let s = newGame()
  s = applyAction(s, { uid: 'a', type: 'raise', amount: 60 }).state
  s = applyAction(s, { uid: 'b', type: 'call' }).state
  s = applyAction(s, { uid: 'c', type: 'call' }).state
  assert.equal(s.phase, PHASE.FLOP)
  assert.equal(s.currentBet, 0, '新阶段重置注额')
  assert.ok(availableActions(s, s.turnUid).some((a) => a.type === 'check'))
})

// ── 部分跟注（all-in call）──

test('筹码不足全额跟注时仍提供跟注入口', () => {
  let s = newGame({
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 30 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 1000 },
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
    ],
  })
  // a 有 30，currentBet=20，toCall=20 <= 30，正常跟注
  let acts = availableActions(s, 'a')
  assert.ok(acts.some((a) => a.type === 'call' && a.label === '跟注 20'))

  // a 跟注后剩 10；b 加注到 60 → a 只剩 10，不够跟 60
  s = applyAction(s, { uid: 'a', type: 'call' }).state
  s = applyAction(s, { uid: 'b', type: 'raise', amount: 60 }).state
  s = applyAction(s, { uid: 'c', type: 'call' }).state
  assert.equal(s.turnUid, 'a', 'a 需回应加注')

  acts = availableActions(s, 'a')
  assert.equal(acts.some((a) => a.type === 'fold'), true, '必须能弃牌')
  assert.ok(
    acts.some((a) => a.type === 'call'),
    '筹码不足也必须提供跟注（部分跟注）'
  )
  const callBtn = acts.find((a) => a.type === 'call')
  assert.equal(callBtn.label, '跟注 10', '应提示实际能跟的金额')
})

test('部分跟注后玩家全下', () => {
  let s = newGame({
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 30 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 1000 },
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
    ],
  })
  s = applyAction(s, { uid: 'a', type: 'call' }).state
  s = applyAction(s, { uid: 'b', type: 'raise', amount: 60 }).state
  s = applyAction(s, { uid: 'c', type: 'call' }).state

  const r = applyAction(s, { uid: 'a', type: 'call' })
  assert.equal(r.error, undefined)
  const a = r.state.seats.find((x) => x.uid === 'a')
  assert.equal(a.seeds, 0, '筹码应清零')
  assert.equal(a.allIn, true, '应标记全下')
  assert.equal(a.totalBet, 30, '累计投入 = 初始 30')
})

// ── 摊牌返回牌型 ──

test('showdown 返回每人的牌型与赢得的瓜子', () => {
  // 构造一个确定性牌局：直接改 state 到河牌结束
  let s = newGame()
  // 走完全部过牌到摊牌
  s = applyAction(s, { uid: 'a', type: 'call' }).state
  s = applyAction(s, { uid: 'b', type: 'call' }).state
  s = applyAction(s, { uid: 'c', type: 'check' }).state
  s = applyAction(s, { uid: 'b', type: 'check' }).state
  s = applyAction(s, { uid: 'c', type: 'check' }).state
  s = applyAction(s, { uid: 'a', type: 'check' }).state
  s = applyAction(s, { uid: 'b', type: 'check' }).state
  s = applyAction(s, { uid: 'c', type: 'check' }).state
  s = applyAction(s, { uid: 'a', type: 'check' }).state
  s = applyAction(s, { uid: 'b', type: 'check' }).state
  s = applyAction(s, { uid: 'c', type: 'check' }).state
  s = applyAction(s, { uid: 'a', type: 'check' }).state

  assert.equal(s.finished, true)

  const hole = dealHoleCards(s)
  // 注意：此时 dealt 已被 showdow 前的发牌推进，重新发会不同
  // 用一个干净的方式：手工造 hole
  const fakeHole = {
    a: ['As', 'Ah'],
    b: ['Ks', 'Kh'],
    c: ['Qs', 'Qh'],
  }
  const r = showdown(s, fakeHole)

  assert.equal(r.pot, 60)
  assert.equal(r.hands.length, 3, '应返回所有玩家的牌况')

  for (const h of r.hands) {
    assert.ok(h.hand, '每人应有牌型')
    assert.ok(h.hand.name.length > 0)
    assert.equal(h.cards.length, 5, '牌型应由 5 张牌构成')
    assert.equal(h.hole.length, 2, '每人 2 张底牌')
  }

  // 赢家字段
  const winners = r.hands.filter((h) => h.isWinner)
  assert.ok(winners.length >= 1, '至少一个赢家')
  const total = r.hands.reduce((sum, h) => sum + h.won, 0)
  assert.equal(total, 60, '赢得的瓜子之和应等于奖池')
})

test('弃牌者摊牌时标记 folded 且无牌型', () => {
  let s = newGame()
  s = applyAction(s, { uid: 'a', type: 'fold' }).state
  s = applyAction(s, { uid: 'b', type: 'fold' }).state
  assert.equal(s.finished, true)

  const r = showdown(s, { a: ['2c', '3d'], b: ['4c', '5d'], c: ['As', 'Ks'] })
  const folded = r.hands.filter((h) => h.folded)
  assert.equal(folded.length, 2)
  assert.equal(folded[0].hand, null, '弃牌者不评估牌型')
  assert.equal(folded[0].won, 0)
  // c 通吃
  assert.equal(r.hands.find((h) => h.uid === 'c').won, 30)
})

test('筹码守恒：任意操作序列后，池 + 各玩家筹码 === 初始总和', () => {
  let s = newGame()
  const initial = 3000

  // 走一串操作：根据当前是否需要跟注自动选 call 或 check
  const script = [
    { uid: 'a', type: 'raise', amount: 100 },
    { uid: '*' },
    { uid: '*' },
    { uid: '*' },
  ]

  for (const step of script) {
    if (s.finished) break
    const uid = step.uid === '*' ? s.turnUid : step.uid
    // 需要跟注就 call，否则 check；无法 call 时全下
    const seat = s.seats.find((x) => x.uid === uid)
    const toCall = s.currentBet - seat.bet
    const type = toCall <= 0 ? 'check' : toCall >= seat.seeds ? 'allin' : 'call'
    const r = applyAction(s, { uid, type })
    assert.equal(r.error, undefined, `操作 ${uid} ${type} 失败: ${r.error}`)
    s = r.state
  }

  const sum = s.pot + s.seats.reduce((acc, x) => acc + x.seeds, 0)
  assert.equal(sum, initial, `筹码应守恒：pot=${s.pot} seeds=${s.seats.reduce((a, x) => a + x.seeds, 0)}`)
})

test('全下对局：筹码守恒（多人全下场景）', () => {
  let s = newGame({
    players: [
      { uid: 'a', nickname: 'A', avatar: 1, seeds: 100 },
      { uid: 'b', nickname: 'B', avatar: 2, seeds: 50 },
      { uid: 'c', nickname: 'C', avatar: 3, seeds: 1000 },
    ],
  })
  const initial = 1150
  let guard = 0
  while (!s.finished && guard++ < 50) {
    const uid = s.turnUid
    if (!uid) break
    const seat = s.seats.find((x) => x.uid === uid)
    const toCall = s.currentBet - seat.bet
    const type = toCall <= 0 ? 'check' : toCall >= seat.seeds ? 'allin' : 'call'
    const r = applyAction(s, { uid, type })
    assert.equal(r.error, undefined, `${uid} ${type}: ${r.error}`)
    s = r.state
  }
  const sum = s.pot + s.seats.reduce((acc, x) => acc + x.seeds, 0)
  assert.equal(sum, initial, `筹码应守恒：${sum} != ${initial}`)
  assert.equal(s.finished, true, '应走到终局')
})
