import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnlineGame, dealSeatSequence, legalOnlineActions, applyOnlineAction, nextOnlineHand } from './online-game.mjs'
import { ALL_TILES, countsOf, maxCopies } from './tiles.mjs'
import { createWall } from './online-wall.mjs'

function seeded(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 } }
function conservation(g) {
  const all = [...g.wall, ...g.players.flatMap((p) => [...p.hand, ...p.flowers, ...p.discards, ...p.melds.flatMap((m) => m.tiles)])]
  const counts = countsOf(all)
  assert.equal(all.length, 144)
  assert.equal(g.wallLayout.headTaken + g.wallLayout.tailTaken + g.wall.length, 144)
  for (const t of ALL_TILES) assert.equal(counts[t], maxCopies(t), t)
}
function options(g) { return [0, 1, 2, 3].flatMap((s) => legalOnlineActions(g, s).map((a) => ({ s, a }))) }

test('庄家起按四张一组发三圈，再庄家两张其余各一张', () => {
  const order = dealSeatSequence(2)
  assert.deepEqual(order.slice(0, 16), [2,2,2,2,3,3,3,3,0,0,0,0,1,1,1,1])
  assert.deepEqual(order.slice(16, 32), order.slice(0, 16))
  assert.deepEqual(order.slice(32, 48), order.slice(0, 16))
  assert.deepEqual(order.slice(48), [2,2,3,0,1])
  assert.equal(order.length, 53)
})
test('开局实际按四张三圈和最后一轮分配牌，之后才补花', () => {
  const wall = createWall(() => .5), available = wall.filter((t) => !['Z', 'F', 'B'].includes(t) && !t.startsWith('f'))
  const initial = available.slice(0, 53), rest = wall.slice()
  for (const tile of initial) rest.splice(rest.indexOf(tile), 1)
  const expected = [[], [], [], []], seats = [2, 3, 0, 1]
  let index = 0
  for (let round = 0; round < 3; round++) for (const seat of seats) { expected[seat].push(...initial.slice(index, index + 4)); index += 4 }
  for (const seat of seats) { const count = seat === 2 ? 2 : 1; expected[seat].push(...initial.slice(index, index + count)); index += count }
  const game = createOnlineGame({ dealer: 2, wall: [...initial, ...rest] })
  assert.deepEqual(game.players.map((p) => p.hand), expected)
  assert.deepEqual(game.players.map((p) => p.hand.length), [13, 13, 14, 13])
  assert.equal(game.wallLayout.headTaken, 53)
  assert.equal(game.wallLayout.tailTaken, 0)
})
test('起手花及补到的花均自动从墙尾连续补牌', () => {
  const remaining = createWall(() => .5)
  const take = (tile) => remaining.splice(remaining.indexOf(tile), 1)[0]
  const initial = [take('f1')]
  while (initial.length < 53) {
    const index = remaining.findIndex((tile) => !['Z', 'F', 'B'].includes(tile) && !tile.startsWith('f'))
    initial.push(remaining.splice(index, 1)[0])
  }
  const flower = take('f2')
  const replacementIndex = remaining.findIndex((tile) => !['Z', 'F', 'B'].includes(tile) && !tile.startsWith('f'))
  const replacement = remaining.splice(replacementIndex, 1)[0]
  const game = createOnlineGame({ dealer: 0, wall: [...initial, ...remaining, replacement, flower] })
  assert.deepEqual(game.players[0].flowers, ['f1', 'f2'])
  assert.equal(game.players[0].hand.length, 14)
  assert.equal(game.wallLayout.headTaken, 53)
  assert.equal(game.wallLayout.tailTaken, 2)
  assert.equal(game.wall.length, 89)
})

test('完整摸打至流局，JSON 往返、牌张和余额始终守恒', () => {
  for (let seed = 1; seed <= 12; seed++) {
    let g = createOnlineGame({ dealer: seed % 4, rng: seeded(seed), balances: [1000, 1000, 1000, 1000] })
    const total = g.balances.reduce((a, b) => a + b, 0)
    let steps = 0
    while (g.phase !== 'finished' && steps++ < 1200) {
      conservation(g)
      assert.equal(g.balances.reduce((a, b) => a + b, 0), total)
      const choices = options(g)
      assert.ok(choices.length, `seed ${seed} phase ${g.phase}`)
      const choice = choices.find(({ a }) => a.type === 'pass') ?? choices.find(({ a }) => a.type === 'discard') ?? choices[0]
      const before = JSON.stringify(g)
      const newer = applyOnlineAction(g, choice.s, choice.a)
      assert.equal(JSON.stringify(g), before)
      g = JSON.parse(JSON.stringify(newer))
    }
    assert.equal(g.phase, 'finished', `seed ${seed} steps ${steps}`)
    conservation(g)
    assert.equal(g.balances.reduce((a, b) => a + b, 0), total)
  }
})

test('动作由合法列表复核，不接受非当前座位和不在手中的牌', () => {
  let g = createOnlineGame({ rng: seeded(44) })
  while (g.phase === 'ready') g = applyOnlineAction(g, g.readyPending[0], { type: 'pass' })
  assert.throws(() => applyOnlineAction(g, (g.turn + 1) % 4, { type: 'discard', tile: g.players[g.turn].hand[0] }))
  assert.throws(() => applyOnlineAction(g, g.turn, { type: 'discard', tile: 'f1' }))
})

test('报听状态只能打摸入的牌，不允许碰或手牌杠', () => {
  const g = createOnlineGame({ rng: seeded(2) })
  g.phase = 'turn'; g.turn = 1; g.initialDealerTurn = false
  g.players[1].ready = true; g.players[1].hand = ['1m', '1m', '1m', '1m', '2m']; g.players[1].lastDraw = '2m'
  const actions = legalOnlineActions(g, 1)
  assert.deepEqual(actions.filter((a) => a.type === 'discard'), [{ type: 'discard', tile: '2m' }])
  assert.ok(!actions.some((a) => a.type === 'ankong' || a.type === 'bukong'))
})
test('第四张花自动花杠，补一张并计一次硬花与杠钱', () => {
  const initial = responseFixture()
  initial.players[0].hand = ['9p']
  initial.players[1].hand = []
  initial.players[1].flowers = ['f1', 'f2', 'f3']
  initial.players[2].hand = []
  initial.wall = ['f4', '1m']
  const g = applyOnlineAction(initial, 0, { type: 'discard', tile: '9p' })
  assert.equal(g.turn, 1)
  assert.deepEqual(g.players[1].flowers, [])
  assert.deepEqual(g.players[1].melds[0].tiles, ['f1', 'f2', 'f3', 'f4'])
  assert.deepEqual(g.players[1].hand, ['1m'])
  assert.equal(g.wall.length, 0)
  assert.equal(g.hadFlowerKong, true)
  assert.deepEqual(g.balances, [990, 1030, 990, 990])
})
test('地胡报听后仍自动花杠，摸入后只能摸打或胡', () => {
  const initial = responseFixture()
  initial.players[0].hand = ['9p']
  initial.players[1].hand = []
  initial.players[1].ready = true
  initial.players[1].flowers = ['f1', 'f2', 'f3']
  initial.players[2].hand = []
  initial.wall = ['f4', '1m']
  const g = applyOnlineAction(initial, 0, { type: 'discard', tile: '9p' })
  assert.equal(g.players[1].ready, true)
  assert.equal(g.players[1].melds[0].type, 'huagang')
  assert.deepEqual(legalOnlineActions(g, 1).filter((a) => a.type === 'discard'), [{ type: 'discard', tile: '1m' }])
})

test('花杠后流局保留杠钱并让下一手翻倍', () => {
  let g = createOnlineGame({ rng: seeded(9) })
  g.phase = 'turn'; g.turn = 0; g.wall = []; g.hadFlowerKong = true
  g.players[0].hand = ['1m']; g.players.forEach((p, i) => { if (i !== 0) p.hand = [] })
  g = applyOnlineAction(g, 0, { type: 'discard', tile: '1m' })
  assert.equal(g.phase, 'finished')
  assert.equal(g.result.type, 'draw')
  assert.equal(g.nextDouble, true)
  const nextHand = nextOnlineHand(g, { rng: seeded(7) })
  assert.equal(nextHand.dealer, g.dealer)
  assert.equal(nextHand.double, true)
})

function responseFixture() {
  const g = createOnlineGame({ rng: seeded(41), balances: [1000, 1000, 1000, 1000] })
  g.phase = 'turn'; g.turn = 0; g.initialDealerTurn = false; g.drawContext = null
  for (const p of g.players) { p.hand = []; p.flowers = []; p.melds = []; p.discards = []; p.ready = false; p.passedWin = false; p.passedPong = []; p.lastDraw = null }
  g.players[0].hand = ['E']
  g.players[1].hand = ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', '4s', '5s', '6s', 'E']
  g.players[2].hand = ['E', 'E']
  return g
}
test('胡优先于碰，必须等响应完毕且不可重复提交', () => {
  let g = applyOnlineAction(responseFixture(), 0, { type: 'discard', tile: 'E' })
  assert.equal(g.phase, 'response')
  assert.ok(legalOnlineActions(g, 1).some((a) => a.type === 'win'))
  assert.ok(legalOnlineActions(g, 2).some((a) => a.type === 'pong'))
  g = applyOnlineAction(g, 2, { type: 'pong' })
  assert.equal(g.phase, 'response')
  g = JSON.parse(JSON.stringify(g))
  assert.throws(() => applyOnlineAction(g, 2, { type: 'pong' }))
  g = applyOnlineAction(g, 1, { type: 'win' })
  assert.equal(g.phase, 'finished')
  assert.equal(g.result.winners[0].seat, 1)
  assert.equal(g.players[2].melds.length, 0)
})
test('牌墙耗尽后仍能碰最后弃牌，不能直杠', () => {
  const initial = responseFixture()
  initial.wall = []
  initial.players[1].hand = []
  initial.players[2].hand = ['E','E','E','1m','2m','4m','6m','1p','2p','4p','6p','1s','9s']
  let g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
  const actions = legalOnlineActions(g, 2)
  assert.ok(actions.some((a) => a.type === 'pong'))
  assert.ok(!actions.some((a) => a.type === 'kong'))
  g = applyOnlineAction(g, 2, { type: 'pong' })
  assert.equal(g.phase, 'turn')
  assert.equal(g.turn, 2)
  assert.ok(legalOnlineActions(g, 2).some((a) => a.type === 'discard'))
})
test('手中三张时可碰、杠或过；碰后保留一张并可选择补杠或继续出牌', () => {
  const initial = responseFixture()
  initial.players[1].hand = []
  initial.players[2].hand = ['E','E','E','1m','2m','3m','4m','5m','6m','1p','2p','3p','9s']
  let g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
  assert.deepEqual(legalOnlineActions(g, 2).map((a) => a.type).sort(), ['kong', 'pass', 'pong'])
  g = applyOnlineAction(g, 2, { type: 'pong' })
  assert.equal(g.players[2].hand.filter((t) => t === 'E').length, 1)
  assert.equal(g.players[2].melds[0].type, 'pong')
  assert.ok(legalOnlineActions(g, 2).some((a) => a.type === 'bukong' && a.tile === 'E'))
  assert.ok(legalOnlineActions(g, 2).some((a) => a.type === 'discard' && a.tile === '1m'))
  g = applyOnlineAction(g, 2, { type: 'discard', tile: '1m' })
  g.phase = 'turn'; g.turn = 2
  g.players[2].hand.push('9p')
  assert.ok(legalOnlineActions(g, 2).some((a) => a.type === 'bukong' && a.tile === 'E'))
})
test('同张牌两家胡，等待所有胡家并按付款人余额比例分配', () => {
  const initial = responseFixture()
  initial.players[2].hand = initial.players[1].hand.slice()
  initial.balances[0] = 30
  let g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
  g = applyOnlineAction(g, 1, { type: 'win' })
  assert.equal(g.phase, 'response')
  g = applyOnlineAction(g, 2, { type: 'win' })
  assert.equal(g.result.winners.length, 2)
  assert.equal(g.balances[0], 0)
  assert.equal(g.balances[1], 1015)
  assert.equal(g.balances[2], 1015)
})
test('放过胡与碰产生各自限制，园子来源不新增过水', () => {
  for (const garden of [false, true]) {
    const initial = responseFixture()
    if (garden) initial.balances[0] = 0
    initial.players[1].hand = ['1m', '2m', '3m', '1p', '2p', '3p', '1s', '2s', '3s', 'E', 'E', 'E', '4s']
    // 不使用该手作胡资格：独立验证碰的过碰。
    let g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
    assert.ok(legalOnlineActions(g, 2).some((a) => a.type === 'pong'))
    g = applyOnlineAction(g, 2, { type: 'pass' })
    assert.ok(g.players[2].passedPong.includes('E'))
  }
  for (const garden of [false, true]) {
    const initial = responseFixture()
    if (garden) initial.balances[0] = 0
    let g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
    g = applyOnlineAction(g, 1, { type: 'pass' })
    assert.equal(g.players[1].passedWin, !garden)
  }
})
test('自摸可胡但选择出牌，其他人出牌前保持过水', () => {
  const initial = responseFixture()
  initial.players[0].hand = [...initial.players[1].hand, 'E']
  initial.players[0].lastDraw = 'E'
  initial.players[1].hand = []
  initial.players[2].hand = []
  assert.ok(legalOnlineActions(initial, 0).some((a) => a.type === 'win'))
  const g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
  assert.equal(g.players[0].passedWin, true)
})

test('三嘴责任人胡被绑定者点炮，仍由点炮者付一份', () => {
  const initial = responseFixture()
  initial.players[0].binding = 1
  let g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
  g = applyOnlineAction(g, 2, { type: 'pass' })
  g = applyOnlineAction(g, 1, { type: 'win' })
  const share = g.result.winners[0].score.flowers.total
  assert.deepEqual(g.balances, [1000 - share, 1000 + share, 1000, 1000])
})
test('碰其他牌解除过水但保留已有过碰', () => {
  const initial = responseFixture()
  initial.players[1].hand = []
  initial.players[2].passedWin = true
  initial.players[2].passedPong = ['5m']
  let g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
  g = applyOnlineAction(g, 2, { type: 'pong' })
  assert.equal(g.players[2].passedWin, false)
  assert.deepEqual(g.players[2].passedPong, ['5m'])
})
test('可抢补杠收齐响应，抢胡后补杠不成立且没有杠钱', () => {
  const initial = responseFixture()
  initial.players[0].hand = ['E']
  initial.players[0].melds = [{ type: 'pong', tiles: ['E', 'E', 'E'], from: 3 }]
  initial.players[2].hand = []
  let g = applyOnlineAction(initial, 0, { type: 'bukong', tile: 'E' })
  assert.equal(g.phase, 'response')
  assert.equal(g.response.kind, 'robKong')
  g = applyOnlineAction(g, 1, { type: 'win' })
  assert.equal(g.result.kind, 'robKong')
  assert.equal(g.players[0].melds[0].type, 'pong')
  assert.equal(g.ledger.filter((x) => x.event === '杠').length, 0)
})
test('抢园子玩家补杠由胡家向其余三人各付，仍是合法胡', () => {
  const initial = responseFixture()
  initial.players[0].melds = [{ type: 'pong', tiles: ['E', 'E', 'E'], from: 3 }]
  initial.players[2].hand = []
  initial.balances = [0, 1000, 1000, 1000]
  let g = applyOnlineAction(initial, 0, { type: 'bukong', tile: 'E' })
  assert.ok(legalOnlineActions(g, 1).some((a) => a.type === 'win'))
  g = applyOnlineAction(g, 1, { type: 'win' })
  const share = g.result.winners[0].score.flowers.total
  assert.deepEqual(g.balances, [share, 1000 - 3 * share, 1000 + share, 1000 + share])
  assert.equal(g.players[0].melds[0].type, 'pong')
})
test('直杠后补到花再胡，保留点杠责任且只计杠开', () => {
  const initial = responseFixture()
  initial.players[0].hand = ['1m']
  initial.players[1].hand = ['1m','1m','1m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E']
  initial.players[2].hand = []
  initial.wall = ['E', 'Z']
  let g = applyOnlineAction(initial, 0, { type: 'discard', tile: '1m' })
  g = applyOnlineAction(g, 1, { type: 'kong' })
  assert.equal(g.phase, 'turn')
  assert.equal(g.drawContext.kongSource, 0)
  assert.equal(g.drawContext.flower, true)
  assert.equal(g.players[1].flowers[0], 'Z')
  assert.ok(legalOnlineActions(g, 1).some((a) => a.type === 'win'))
  g = applyOnlineAction(g, 1, { type: 'win' })
  assert.equal(g.result.winners[0].score.flowers.gangkai, 10)
  assert.equal(g.result.winners[0].score.flowers.huakai, 0)
  assert.ok(g.ledger.at(-1).transfers.some((x) => x.from === 0 && x.reason === '点杠包胡'))
})
test('第四次同牌先罚后胡，园子身份使用出牌前快照', () => {
  const initial = responseFixture()
  initial.balances = [20, 1000, 1000, 1000]
  initial.events = [0, 1, 2].map(() => ({ type: 'discard', seat: 0, tile: 'E' }))
  let g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
  assert.equal(g.balances[0], 0)
  assert.equal(g.response.sourceInGarden, false)
  g = applyOnlineAction(g, 2, { type: 'pass' })
  const before = g.balances.slice()
  g = applyOnlineAction(g, 1, { type: 'win' })
  assert.deepEqual(g.balances, before)
})
test('非门清小胡四硬花门槛只数硬花', () => {
  for (const flowerCount of [3, 4]) {
    const initial = responseFixture()
    initial.players[1].hand = ['1m','2m','3m','1p','2p','3p','1s','2s','3s','E']
    initial.players[1].melds = [{ type: 'pong', tiles: ['4m', '4m', '4m'], from: 3 }]
    initial.players[1].flowers = ['Z', 'Z', 'F', 'F'].slice(0, flowerCount)
    const g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
    assert.equal(legalOnlineActions(g, 1).some((a) => a.type === 'win'), flowerCount === 4)
  }
})
test('明杠和暗杠不破门清，小胡不受四硬花门槛限制', () => {
  for (const type of ['kong', 'ankong']) for (const flowerCount of [3, 4]) {
    const initial = responseFixture()
    initial.players[1].hand = ['1m','2m','3m','1p','2p','3p','1s','2s','3s','E']
    initial.players[1].melds = [{ type, tiles: ['4m','4m','4m','4m'], ...(type === 'kong' ? { from: 3 } : {}) }]
    initial.players[1].flowers = ['Z','Z','F','F'].slice(0, flowerCount)
    const g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
    assert.equal(legalOnlineActions(g, 1).some((a) => a.type === 'win'), true)
  }
})
test('翻倍局闲家小胡，下手由原庄下家坐庄并恢复一倍', () => {
  const initial = responseFixture()
  initial.double = true
  initial.players[1].hand = ['1m','2m','3m','1p','2p','3p','1s','2s','3s','E']
  initial.players[1].melds = [{ type: 'pong', tiles: ['4m', '4m', '4m'], from: 3 }]
  initial.players[1].flowers = ['Z', 'Z', 'F', 'F']
  let g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
  g = applyOnlineAction(g, 2, { type: 'pass' })
  g = applyOnlineAction(g, 1, { type: 'win' })
  assert.equal(g.result.winners[0].score.isBigWin, false)
  assert.equal(g.nextDealer, 1)
  assert.equal(g.nextDouble, false)
  const newHand = nextOnlineHand(g, { rng: seeded(80) })
  assert.equal(newHand.dealer, 1)
  assert.equal(newHand.double, false)
  assert.deepEqual(newHand.balances, g.balances)
  assert.equal(newHand.pastHands.length, 1)
  assert.equal(newHand.pastHands[0].result.winners[0].hand.concealed.length, 11)
  assert.deepEqual(newHand.pastHands[0].ledger, g.ledger)
})
test('同张牌响应结束后两人园子结束本场，不能直接进入下一手', () => {
  const initial = responseFixture()
  initial.balances = [0, 1000, 0, 1000]
  let g = applyOnlineAction(initial, 0, { type: 'discard', tile: 'E' })
  assert.equal(g.phase, 'response')
  g = applyOnlineAction(g, 1, { type: 'pass' })
  g = applyOnlineAction(g, 2, { type: 'pass' })
  assert.equal(g.phase, 'finished')
  assert.equal(g.result.matchOver, true)
  assert.throws(() => nextOnlineHand(g))
})

test('随机完整对局含碰杠胡和园子，持续保持守恒并能推进', () => {
  for (let seed = 31; seed < 111; seed++) {
    const random = seeded(seed * 17)
    const amount = seed % 2 ? 100 : 1000
    let g = createOnlineGame({ rng: seeded(seed), balances: [amount, amount, amount, amount] })
    let steps = 0
    while (g.phase !== 'finished' && steps++ < 1500) {
      conservation(g)
      const actions = options(g)
      assert.ok(actions.length, `seed ${seed}: ${g.phase}`)
      const win = actions.find((x) => x.a.type === 'win')
      const choice = win ?? actions[Math.floor(random() * actions.length)]
      g = applyOnlineAction(g, choice.s, choice.a)
      assert.equal(g.balances.reduce((a, b) => a + b, 0), amount * 4)
    }
    assert.equal(g.phase, 'finished', `seed ${seed}`)
    conservation(g)
  }
})
