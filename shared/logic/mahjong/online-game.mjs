/** 南京麻将服务端规则核心。所有状态均可 JSON 序列化，输入不会被修改。 */
import { createWall, createWallLayout, openWall } from './online-wall.mjs'
import { ALL_TILES, NUMBER_TILES, isFlower, countsOf, maxCopies } from './tiles.mjs'
import { analyzeHand } from './hand.mjs'
import { scoreHand } from './score.mjs'
import { applyPayments, settleOnlineKong, settleOnlineWin } from './online-payments.mjs'

const seats = [0, 1, 2, 3]
const next = (s) => (s + 1) % 4
const dist = (from, to) => (to - from + 4) % 4
const copy = (v) => structuredClone(v)
const count = (a, tile) => a.filter((x) => x === tile).length
const player = () => ({ hand: [], flowers: [], melds: [], discards: [], passedWin: false, passedPong: [], ready: false, sources: [], binding: null, lastDraw: null })

function validateWall(wall) {
  if (!Array.isArray(wall) || wall.length !== 144 || wall.some((t) => !ALL_TILES.includes(t))) throw new Error('牌墙必须包含144张有效牌')
  const counts = countsOf(wall)
  if (ALL_TILES.some((t) => counts[t] !== maxCopies(t))) throw new Error('牌墙张数不正确')
}
function validateSeat(s) { if (!Number.isInteger(s) || s < 0 || s > 3) throw new Error('座位无效') }
/** 庄家起逆时针发牌：每家四张三圈，末轮庄两张、其他各一张。 */
export function dealSeatSequence(dealer) {
  validateSeat(dealer)
  const order = []
  for (let round = 0; round < 3; round++) for (let offset = 0; offset < 4; offset++) {
    for (let i = 0; i < 4; i++) order.push((dealer + offset) % 4)
  }
  for (let offset = 0; offset < 4; offset++) for (let i = 0; i < (offset === 0 ? 2 : 1); i++) order.push((dealer + offset) % 4)
  return order
}
function addLedger(g, event, result) {
  g.balances = result.balances
  g.ledger.push({ event, transfers: result.transfers })
}
function autoFlowers(g, s, tile) {
  const p = g.players[s]
  p.flowers.push(tile)
  g.events.push({ type: 'flower', seat: s, tile })
  const group = ['Z', 'F', 'B'].includes(tile) ? [tile, tile, tile, tile]
    : ['f1', 'f2', 'f3', 'f4'].includes(tile) ? ['f1', 'f2', 'f3', 'f4'] : ['f5', 'f6', 'f7', 'f8']
  const need = countsOf(group)
  if (Object.entries(need).every(([t, n]) => count(p.flowers, t) >= n)) {
    for (const t of group) p.flowers.splice(p.flowers.indexOf(t), 1)
    p.melds.push({ type: 'huagang', tiles: group })
    g.hadFlowerKong = true
    addLedger(g, '花杠', settleOnlineKong({ balances: g.balances, seat: s, type: 'hua', double: g.double }))
    g.events.push({ type: 'flowerKong', seat: s, tiles: group })
  }
}
function finishDraw(g) {
  const stays = true
  g.nextDealer = g.dealer
  g.nextDouble = g.hadFlowerKong || (g.double && stays)
  g.phase = 'finished'
  g.result = { type: 'draw', winners: [], dealer: g.nextDealer, double: g.nextDouble, matchOver: g.balances.filter((n) => n === 0).length >= 2 }
  g.events.push({ type: 'draw' })
}
function finishMatchIfNeeded(g) {
  if (g.balances.filter((n) => n === 0).length < 2) return false
  g.phase = 'finished'
  g.result = { type: 'matchEnd', winners: [], matchOver: true }
  g.events.push({ type: 'matchEnd' })
  return true
}
/** 返回 false 时牌墙耗尽，牌局已经结束。 */
function draw(g, s, direction, reason = 'normal') {
  let flower = false
  let from = direction
  for (;;) {
    if (!g.wall.length) { finishDraw(g); return false }
    const tile = from === 'head' ? g.wall.shift() : g.wall.pop()
    if (g.wallLayout) g.wallLayout[from === 'head' ? 'headTaken' : 'tailTaken']++
    const p = g.players[s]
    p.passedWin = false
    p.passedPong = []
    if (isFlower(tile)) {
      flower = true
      autoFlowers(g, s, tile)
      if (finishMatchIfNeeded(g)) return false
      from = 'tail'
      continue
    }
    p.hand.push(tile)
    p.lastDraw = tile
    g.drawContext = { reason, flower, kongSource: g.drawContext?.kongSource ?? null }
    g.events.push({ type: 'drawTile', seat: s, flowerCount: flower ? 1 : 0 })
    return true
  }
}
function handInput(p, tile = null) {
  return { concealed: tile == null ? p.hand.slice() : [...p.hand, tile], melds: p.melds, flowers: p.flowers, winTile: tile ?? p.lastDraw }
}
function scoreFor(g, s, tile, kind) {
  const p = g.players[s]
  const flags = { tianhu: kind === 'selfDraw' && s === g.dealer && g.initialDealerTurn,
    dihu: p.ready, huakai: kind === 'selfDraw' && g.drawContext?.flower && g.drawContext?.reason !== 'kong',
    gangkai: kind === 'selfDraw' && g.drawContext?.reason === 'kong' }
  return scoreHand(handInput(p, tile), flags)
}
function canWin(g, s, tile = null, kind = 'discard', ignorePassed = false) {
  const p = g.players[s]
  if (p.passedWin && !ignorePassed) return false
  const score = scoreFor(g, s, tile, kind)
  return score.info.valid && (score.isBigWin || score.info.meldsConcealed || score.info.hardCount >= 4)
}
function canReady(g, s) {
  const p = g.players[s]
  return NUMBER_TILES.some((t) => count([...p.hand, ...p.melds.flatMap((m) => m.tiles), ...p.flowers], t) < 4 && canWin(g, s, t, 'discard', true))
}
function updateBinding(p, source) {
  p.sources.push(source)
  const a = p.sources
  if (p.binding == null && a.length >= 3 && a.slice(-3).every((v) => v === source)) p.binding = source
}
function bindings(g) { return Object.fromEntries(g.players.map((p, i) => [i, p.binding]).filter(([, v]) => v != null)) }
function finishWin(g, winners, kind, source = null, sourceInGarden = false, tile = null) {
  const scores = winners.map((s) => ({ seat: s, hand: handInput(g.players[s], kind === 'selfDraw' ? null : tile), score: scoreFor(g, s, kind === 'selfDraw' ? null : tile, kind) }))
  const result = settleOnlineWin({ balances: g.balances, winners: scores.map(({ seat, score }) => ({ seat, share: score.flowers.total * (g.double ? 2 : 1) })),
    source, kind, sourceInGarden, bindings: bindings(g), kongSource: kind === 'selfDraw' && g.drawContext?.reason === 'kong' ? g.drawContext.kongSource : null })
  addLedger(g, '胡牌', result)
  const big = scores.some((v) => v.score.isBigWin)
  const stays = winners.includes(g.dealer) || big
  g.nextDealer = stays ? g.dealer : next(g.dealer)
  g.nextDouble = big || g.hadFlowerKong || (g.double && stays)
  g.phase = 'finished'
  g.result = { type: 'win', kind, source, tile, winners: scores, dealer: g.nextDealer, double: g.nextDouble, matchOver: g.balances.filter((n) => n === 0).length >= 2 }
  g.events.push({ type: 'win', seats: winners, source, kind })
}
export function calculateResponseActions(g, kind, s, tile) {
  const options = {}
  for (const target of seats.filter((x) => x !== s)) {
    const p = g.players[target]
    const actions = []
    if (canWin(g, target, tile, kind)) actions.push({ type: 'win' })
    if (kind === 'discard' && !p.ready) {
      if (count(p.hand, tile) >= 3 && g.wall.length) actions.push({ type: 'kong' })
      if (count(p.hand, tile) >= 2 && !p.passedPong.includes(tile)) actions.push({ type: 'pong' })
    }
    if (actions.length) options[target] = actions
  }
  return options
}
function startResponse(g, kind, s, tile, sourceInGarden = g.balances[s] === 0) {
  const options = calculateResponseActions(g, kind, s, tile)
  g.phase = 'response'
  g.response = { kind, source: s, tile, sourceInGarden, options, choices: {} }
  if (!Object.keys(options).length) resolveResponse(g)
}
function applyKong(g, s, type, from = null) {
  addLedger(g, '杠', settleOnlineKong({ balances: g.balances, seat: s, type, from, double: g.double }))
  if (finishMatchIfNeeded(g)) return
  g.drawContext = { reason: 'kong', kongSource: type === 'ming' ? from : null }
  g.phase = 'turn'; g.turn = s
  draw(g, s, 'tail', 'kong')
}
function resolveResponse(g) {
  const r = g.response
  for (const s of Object.keys(r.choices).map(Number).sort((a, b) => dist(r.source, a) - dist(r.source, b))) {
    g.events.push({ type: 'response', seat: s, source: r.source, action: r.choices[s] })
  }
  const winners = Object.keys(r.choices).map(Number).filter((s) => r.choices[s] === 'win').sort((a, b) => dist(r.source, a) - dist(r.source, b))
  if (winners.length) { finishWin(g, winners, r.kind === 'robKong' ? 'robKong' : 'discard', r.source, r.sourceInGarden, r.tile); g.response = null; return }
  if (r.kind === 'robKong') {
    const p = g.players[r.source]
    const meld = p.melds.find((m) => m.type === 'pong' && m.tiles[0] === r.tile)
    p.hand.splice(p.hand.indexOf(r.tile), 1); meld.type = 'pongkong'; meld.tiles.push(r.tile)
    p.lastDraw = null
    g.events.push({ type: 'bukong', seat: r.source, tile: r.tile })
    p.passedWin = false; g.response = null
    if (!finishMatchIfNeeded(g)) applyKong(g, r.source, 'bu')
    return
  }
  const claims = Object.keys(r.choices).map(Number).filter((s) => ['kong', 'pong'].includes(r.choices[s]))
    .sort((a, b) => (r.choices[a] === r.choices[b] ? 0 : r.choices[a] === 'kong' ? -1 : 1) || dist(r.source, a) - dist(r.source, b))
  if (claims.length) {
    const s = claims[0], type = r.choices[s], p = g.players[s]
    for (let i = 0; i < (type === 'kong' ? 3 : 2); i++) p.hand.splice(p.hand.indexOf(r.tile), 1)
    g.players[r.source].discards.pop()
    p.melds.push({ type: type === 'kong' ? 'kong' : 'pong', tiles: Array(type === 'kong' ? 4 : 3).fill(r.tile), from: r.source })
    g.events.push({ type, seat: s, tile: r.tile, from: r.source })
    updateBinding(p, r.source); p.passedWin = false; p.lastDraw = null
    g.discardRun = []; g.response = null
    if (finishMatchIfNeeded(g)) return
    if (type === 'kong') applyKong(g, s, 'ming', r.source)
    else { g.phase = 'turn'; g.turn = s; g.drawContext = null }
    return
  }
  g.response = null
  if (finishMatchIfNeeded(g)) return
  g.phase = 'turn'; g.turn = next(r.source); g.drawContext = null
  draw(g, g.turn, 'head')
}

/** 创建一手，wall 仅用于服务端确定性测试，表示已开墙后的取牌顺序，不能由客户端提供。 */
export function createOnlineGame({ dealer = 0, balances = [100, 100, 100, 100], double = false, rng, wall = null } = {}) {
  validateSeat(dealer)
  if (!Array.isArray(balances) || balances.length !== 4 || balances.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('余额无效')
  const shuffled = wall ? wall.slice() : createWall(rng)
  validateWall(shuffled)
  const wallLayout = createWallLayout(dealer, rng)
  const deck = wall ? shuffled : openWall(shuffled, wallLayout)
  const g = { version: 'nanjing-online-v1', phase: 'deal', dealer, turn: dealer, balances: balances.slice(), double: !!double,
    wall: deck, wallLayout, players: seats.map(player), events: [], ledger: [], response: null, drawContext: null,
    hadFlowerKong: false, initialDealerTurn: true, discardRun: [], result: null, pastHands: [] }
  for (const s of dealSeatSequence(dealer)) { g.players[s].hand.push(g.wall.shift()); g.wallLayout.headTaken++ }
  for (let offset = 0; offset < 4; offset++) {
    const s = (dealer + offset) % 4, p = g.players[s]
    while (p.hand.some(isFlower)) {
      const i = p.hand.findIndex(isFlower), tile = p.hand.splice(i, 1)[0]
      autoFlowers(g, s, tile)
      if (finishMatchIfNeeded(g)) return g
      if (!draw(g, s, 'tail', 'initial')) return g
    }
    p.lastDraw = null
  }
  g.drawContext = null
  if (finishMatchIfNeeded(g)) return g
  g.phase = 'ready'; g.readyPending = seats.filter((s) => s !== dealer && canReady(g, s))
  if (!g.readyPending.length) { g.phase = 'turn'; g.turn = dealer }
  return g
}

export function legalOnlineActions(g, s) {
  validateSeat(s)
  if (g.phase === 'ready') return g.readyPending.includes(s) ? [{ type: 'ready' }, { type: 'pass' }] : []
  if (g.phase === 'response') return g.response.options[s] && !g.response.choices[s] ? [...copy(g.response.options[s]), { type: 'pass' }] : []
  if (g.phase !== 'turn' || g.turn !== s) return []
  const p = g.players[s], actions = []
  if ((p.lastDraw != null || (s === g.dealer && g.initialDealerTurn)) && canWin(g, s, null, 'selfDraw')) actions.push({ type: 'win' })
  if (!p.ready && g.wall.length) {
    for (const t of new Set(p.hand)) if (count(p.hand, t) === 4) actions.push({ type: 'ankong', tile: t })
    for (const m of p.melds) if (m.type === 'pong' && p.hand.includes(m.tiles[0])) actions.push({ type: 'bukong', tile: m.tiles[0] })
  }
  for (const t of new Set(p.ready ? [p.lastDraw].filter(Boolean) : p.hand)) actions.push({ type: 'discard', tile: t })
  return actions
}

export function applyOnlineAction(state, s, action) {
  validateSeat(s)
  const legal = legalOnlineActions(state, s)
  if (!action || !legal.some((a) => a.type === action.type && (a.tile == null || a.tile === action.tile))) throw new Error('动作不合法或已过期')
  const g = copy(state), p = g.players[s]
  if (g.phase === 'turn' && action.type !== 'win' && legal.some((a) => a.type === 'win')) p.passedWin = true
  if (g.phase === 'ready') {
    p.ready = action.type === 'ready'; g.readyPending = g.readyPending.filter((i) => i !== s)
    g.events.push({ type: action.type === 'ready' ? 'ready' : 'skipReady', seat: s })
    if (!g.readyPending.length) { g.phase = 'turn'; g.turn = g.dealer }
  } else if (g.phase === 'response') {
    const r = g.response, opts = r.options[s]
    if (action.type !== 'win' && opts.some((a) => a.type === 'win') && !r.sourceInGarden) p.passedWin = true
    if (action.type !== 'pong' && opts.some((a) => a.type === 'pong')) p.passedPong.push(r.tile)
    r.choices[s] = action.type
    if (Object.keys(r.choices).length === Object.keys(r.options).length) resolveResponse(g)
  } else if (action.type === 'win') finishWin(g, [s], 'selfDraw')
  else if (action.type === 'ankong') {
    for (let i = 0; i < 4; i++) p.hand.splice(p.hand.indexOf(action.tile), 1)
    p.lastDraw = null
    p.melds.push({ type: 'ankong', tiles: Array(4).fill(action.tile) }); p.passedWin = false
    g.events.push({ type: 'ankong', seat: s, tile: action.tile })
    g.initialDealerTurn = false; applyKong(g, s, 'an')
  } else if (action.type === 'bukong') {
    g.events.push({ type: 'bukongAttempt', seat: s, tile: action.tile })
    g.initialDealerTurn = false; startResponse(g, 'robKong', s, action.tile)
  } else {
    const sourceInGarden = g.balances[s] === 0
    p.hand.splice(p.hand.indexOf(action.tile), 1); p.discards.push(action.tile); p.lastDraw = null
    g.events.push({ type: 'discard', seat: s, tile: action.tile })
    g.discardRun.push({ seat: s, tile: action.tile }); if (g.discardRun.length > 4) g.discardRun.shift()
    const amount = 10 * (g.double ? 2 : 1)
    const penalties = []
    if (g.discardRun.length === 4 && new Set(g.discardRun.map((x) => x.seat)).size === 4 && g.discardRun.every((x) => x.tile === action.tile)) penalties.push(g.discardRun[0].seat)
    if (g.events.filter((e) => e.type === 'discard' && e.seat === s && e.tile === action.tile).length === 4) penalties.push(s)
    for (const payer of penalties) addLedger(g, '同牌罚', applyPayments(g.balances, seats.filter((x) => x !== payer).map((to) => ({ from: payer, to, amount, reason: '同牌罚' }))))
    g.initialDealerTurn = false; g.drawContext = null; startResponse(g, 'discard', s, action.tile, sourceInGarden)
  }
  return g
}

/** 开始下一手，整场结束时必须由房间层创建新场。 */
export function nextOnlineHand(state, { rng, wall = null } = {}) {
  if (state.phase !== 'finished' || !state.result || state.result.matchOver) throw new Error('当前不能开始下一手')
  const nextHand = createOnlineGame({ dealer: state.nextDealer, balances: state.balances, double: state.nextDouble, rng, wall })
  nextHand.pastHands = [...(state.pastHands ?? []), { dealer: state.dealer, double: state.double, result: copy(state.result), ledger: copy(state.ledger), events: copy(state.events) }]
  return nextHand
}
