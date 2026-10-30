/** 南京麻将房间适配：只接受服务端认证后的座位，绝不返回引擎私有状态。 */
import { createOnlineGame, nextOnlineHand, legalOnlineActions, applyOnlineAction, calculateResponseActions } from '../shared/logic/mahjong/online-game.mjs'
import { randomUUID } from 'node:crypto'
import { ALL_TILES, NUMBER_TILES, countsOf, maxCopies } from '../shared/logic/mahjong/tiles.mjs'
import { safeMahjongAction } from './mahjong-ai.mjs'
import { wallLayoutStacks } from '../shared/logic/mahjong/online-wall.mjs'

const clone = (value) => structuredClone(value)

export function createMahjongSession({ initialSeeds = 100, dealer = 0 } = {}) {
  if (!Number.isSafeInteger(initialSeeds) || initialSeeds <= 0) throw new Error('初始瓜子必须是正整数')
  if (!Number.isInteger(dealer) || dealer < 0 || dealer > 3) throw new Error('庄家无效')
  return { version: 1, matchId: randomUUID(), initialSeeds, initialDealer: dealer, handId: 0, windowId: 0,
    game: null, ready: [false, false, false, false], deadlineAt: null, completed: [] }
}

function windowKey(game) {
  if (!game || game.phase === 'finished') return null
  if (game.phase === 'turn') return `turn:${game.turn}:${game.events.length}`
  if (game.phase === 'response') return `response:${game.response.kind}:${game.response.source}:${game.events.length}`
  if (game.phase === 'ready') return `ready:${game.dealer}`
  throw new Error('未知麻将阶段')
}

function setWindow(session, previous, now) {
  const key = windowKey(session.game)
  if (!key) { session.deadlineAt = null; return }
  if (key !== previous) {
    session.windowId++
    session.deadlineAt = now + (session.game.phase === 'turn' ? 30000 : 15000)
  }
}

export function setMahjongReady(session, seat, value = true) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= 4) throw new Error('座位无效')
  if (session.game && session.game.phase !== 'finished') throw new Error('本手进行中不能更改准备')
  if (session.game?.result?.matchOver) throw new Error('本场结束，请先重开')
  const next = clone(session); next.ready[seat] = !!value; return next
}

export function startMahjongHand(session, { now = Date.now(), rng, wall } = {}) {
  if (session.ready.length !== 4 || session.ready.some((r) => !r)) throw new Error('四位玩家均需准备')
  if (session.game && session.game.phase !== 'finished') throw new Error('本手进行中')
  if (session.game?.result?.matchOver) throw new Error('本场结束，请先重开')
  const next = clone(session)
  next.game = next.game ? nextOnlineHand(next.game, { rng, wall })
    : createOnlineGame({ dealer: next.initialDealer, balances: Array(4).fill(next.initialSeeds), rng, wall })
  next.handId++
  next.ready = [false, false, false, false]
  setWindow(next, null, now)
  return next
}

export function submitMahjongAction(session, seat, action, { matchId, handId, windowId, now = Date.now() } = {}) {
  if (matchId !== session.matchId || handId !== session.handId || windowId !== session.windowId) throw new Error('动作已过期')
  if (session.deadlineAt == null || now >= session.deadlineAt) throw new Error('行动时间已结束')
  const oldKey = windowKey(session.game)
  const next = clone(session)
  next.game = applyOnlineAction(next.game, seat, action)
  setWindow(next, oldKey, now)
  return next
}

/** 一次窗口过期时处理所有尚未响应的座位，行动只取引擎给出的合法选项。 */
export function expireMahjongWindow(session, { now = Date.now() } = {}) {
  if (session.deadlineAt == null || now < session.deadlineAt) return session
  const next = clone(session), oldKey = windowKey(next.game)
  for (let s = 0; s < 4 && windowKey(next.game) === oldKey; s++) {
    const legal = legalOnlineActions(next.game, s)
    if (!legal.length) continue
    const action = safeMahjongAction(buildMahjongObservation(next, s))
    next.game = applyOnlineAction(next.game, s, action)
  }
  setWindow(next, oldKey, now)
  if (next.deadlineAt === session.deadlineAt) throw new Error('超时后窗口没有推进')
  return next
}

/** 服务端超时托管：计算可在工作线程进行，最终仍从引擎合法动作中复核。 */
export async function expireMahjongWindowWithPolicy(session, choose, { now = Date.now() } = {}) {
  if (session.deadlineAt == null || now < session.deadlineAt) return session
  const next = clone(session), oldKey = windowKey(next.game)
  for (let seat = 0; seat < 4 && windowKey(next.game) === oldKey; seat++) {
    const legal = legalOnlineActions(next.game, seat)
    if (!legal.length) continue
    const decision = await choose(next, seat)
    const action = legal.find((a) => a.type === decision?.action?.type && (a.tile == null || a.tile === decision.action.tile))
      ?? legal.find((a) => a.type === 'pass') ?? legal.find((a) => a.type === 'discard') ?? legal[0]
    next.game = applyOnlineAction(next.game, seat, action)
    if (decision?.route) {
      if (next.localPolicy?.handId !== next.handId) next.localPolicy = { handId: next.handId, routes: {} }
      next.localPolicy.routes[seat] = decision.route
    }
  }
  setWindow(next, oldKey, Date.now())
  if (next.deadlineAt === session.deadlineAt) throw new Error('超时后窗口没有推进')
  return next
}

export function resetMahjongMatch(session, { dealer = session.initialDealer } = {}) {
  if (!session.game?.result?.matchOver) throw new Error('本场尚未结束')
  const next = createMahjongSession({ initialSeeds: session.initialSeeds, dealer })
  next.completed = [...(session.completed ?? []), { matchId: session.matchId, result: clone(session.game.result),
    balances: session.game.balances.slice(), ledger: clone(session.game.ledger), pastHands: clone(session.game.pastHands) }]
  return next
}

/** 恢复前验证，不尝试修复损坏的牌局或重新发牌。 */
export function validateMahjongSnapshot(session) {
  if (!session || session.version !== 1 || typeof session.matchId !== 'string' || !session.matchId ||
      !Number.isSafeInteger(session.handId) || session.handId < 0 || !Number.isSafeInteger(session.windowId) || session.windowId < 0 ||
      !Array.isArray(session.ready) || session.ready.length !== 4 || session.ready.some((v) => typeof v !== 'boolean')) throw new Error('麻将房间快照无效')
  const g = session.game
  if (g == null) {
    if (session.handId !== 0 || session.deadlineAt !== null) throw new Error('等待阶段快照无效')
    return true
  }
  const endedBeforeFirstWindow = session.handId === 1 && session.windowId === 0 && g.phase === 'finished' && g.result?.matchOver === true
  if (g.version !== 'nanjing-online-v1' || session.handId < 1 || (session.windowId < 1 && !endedBeforeFirstWindow) || !['ready', 'turn', 'response', 'finished'].includes(g.phase) ||
      !Array.isArray(g.players) || g.players.length !== 4 || !Array.isArray(g.wall) || !Array.isArray(g.balances) ||
      g.balances.length !== 4 || g.balances.some((x) => !Number.isSafeInteger(x) || x < 0) ||
      !Number.isInteger(g.dealer) || g.dealer < 0 || g.dealer > 3 || !Array.isArray(g.events) || !Array.isArray(g.ledger) || !Array.isArray(g.pastHands)) throw new Error('麻将牌局快照无效')
  const tiles = g.wall.slice()
  for (const p of g.players) {
    if (!Array.isArray(p.hand) || !Array.isArray(p.flowers) || !Array.isArray(p.discards) || !Array.isArray(p.melds) || !Array.isArray(p.passedPong) ||
        typeof p.passedWin !== 'boolean' || typeof p.ready !== 'boolean' ||
        (p.lastDraw != null && (!NUMBER_TILES.includes(p.lastDraw) || (g.phase !== 'finished' && !p.hand.includes(p.lastDraw)))) ||
        p.melds.some((m) => !Array.isArray(m.tiles))) throw new Error('麻将座位快照无效')
    tiles.push(...p.hand, ...p.flowers, ...p.discards, ...p.melds.flatMap((m) => m.tiles))
  }
  const counts = countsOf(tiles)
  if (tiles.length !== 144 || tiles.some((t) => !ALL_TILES.includes(t)) || ALL_TILES.some((t) => counts[t] !== maxCopies(t))) throw new Error('麻将牌张快照无效')
  if (g.wallLayout != null) {
    const w = g.wallLayout, dice = w.dice
    if (!Array.isArray(dice) || dice.length !== 2 || dice.some((n) => !Number.isInteger(n) || n < 1 || n > 6) ||
        (w.version != null && w.version !== 2) || w.breakSeat !== (g.dealer + dice[0] + dice[1] - 1) % 4 ||
        w.breakStack !== (w.version === 2 ? 17 - Math.min(...dice) : 18 - dice[0] - dice[1]) ||
        !Number.isInteger(w.headTaken) || !Number.isInteger(w.tailTaken) || w.headTaken < 0 || w.tailTaken < 0 ||
        w.headTaken + w.tailTaken + g.wall.length !== 144) throw new Error('牌墙位置快照无效')
  }
  if (g.phase === 'turn' && (!Number.isInteger(g.turn) || g.turn < 0 || g.turn > 3)) throw new Error('行动座位快照无效')
  if (g.phase === 'ready' && (!Array.isArray(g.readyPending) || !g.readyPending.length || new Set(g.readyPending).size !== g.readyPending.length ||
      g.readyPending.some((s) => !Number.isInteger(s) || s < 0 || s > 3 || s === g.dealer))) throw new Error('报听快照无效')
  if (g.phase === 'response' && (!g.response || !['discard', 'robKong'].includes(g.response.kind) ||
      !Number.isInteger(g.response.source) || g.response.source < 0 || g.response.source > 3 || !g.response.options || !g.response.choices ||
      typeof g.response.sourceInGarden !== 'boolean')) throw new Error('响应窗口快照无效')
  if (g.phase === 'response') {
    const r = g.response
    if (!ALL_TILES.includes(r.tile) || (r.kind === 'discard' && g.players[r.source].discards.at(-1) !== r.tile) ||
        (r.kind === 'robKong' && (!g.players[r.source].hand.includes(r.tile) || !g.players[r.source].melds.some((m) => m.type === 'pong' && m.tiles[0] === r.tile)))) throw new Error('响应牌源快照无效')
    const keys = Object.keys(r.options)
    const choices = Object.keys(r.choices)
    if (!keys.length || keys.some((k) => !/^[0-3]$/.test(k) || Number(k) === r.source || !Array.isArray(r.options[k]) || !r.options[k].length ||
        r.options[k].some((a) => !['win', 'pong', 'kong'].includes(a.type) || (r.kind === 'robKong' && a.type !== 'win'))) ||
        choices.some((k) => !keys.includes(k) || (r.choices[k] !== 'pass' && !r.options[k].some((a) => a.type === r.choices[k]))) || choices.length >= keys.length) throw new Error('响应选择快照无效')
    const calculated = calculateResponseActions(g, r.kind, r.source, r.tile)
    if (keys.filter((k) => !choices.includes(k)).some((k) => JSON.stringify(r.options[k]) !== JSON.stringify(calculated[k]))) throw new Error('响应资格快照无效')
  }
  if (g.phase === 'finished' ? session.deadlineAt !== null : !Number.isFinite(session.deadlineAt)) throw new Error('截止时间快照无效')
  return true
}

/** viewerSeat 由房间认证结果确定；null 为旁观者。 */
export function projectMahjongSession(session, viewerSeat = null) {
  if (viewerSeat != null && (!Number.isInteger(viewerSeat) || viewerSeat < 0 || viewerSeat > 3)) throw new Error('座位无效')
  const g = session.game
  const out = { matchId: session.matchId, handId: session.handId, windowId: session.windowId,
    deadlineAt: session.deadlineAt, initialSeeds: session.initialSeeds, ready: session.ready.slice(), phase: g?.phase ?? 'waiting' }
  if (!g) return out
  out.dealer = g.dealer; out.turn = g.phase === 'turn' ? g.turn : null
  out.double = g.double; out.wallCount = g.wall.length; out.balances = g.balances.slice()
  if (g.wallLayout) out.wallLayout = { version: g.wallLayout.version, dice: g.wallLayout.dice.slice(), breakSeat: g.wallLayout.breakSeat,
    breakStack: g.wallLayout.breakStack, headTaken: g.wallLayout.headTaken, tailTaken: g.wallLayout.tailTaken,
    stacks: wallLayoutStacks(g.wallLayout) }
  out.players = g.players.map((p) => ({ handCount: p.hand.length, flowers: p.flowers.slice(),
    melds: clone(p.melds), discards: p.discards.slice(), ready: g.phase === 'ready' ? null : p.ready, binding: p.binding }))
  // events 中的 skipReady 暗示玩家起手听牌，仅公开已经决定报听的事实。
  out.events = clone(g.events.filter((e) => e.type !== 'skipReady' && !(g.phase === 'ready' && e.type === 'ready')))
  out.ledger = g.ledger.map((entry, eventIndex) => ({ ...clone(entry), transfers: entry.transfers.map((transfer, transferIndex) => ({
    ...clone(transfer), id: `${session.matchId}:${session.handId}:${eventIndex}:${transferIndex}` })) }))
  if (g.phase === 'response') out.response = { kind: g.response.kind, source: g.response.source,
    tile: g.response.tile, sourceInGarden: g.response.sourceInGarden }
  if (viewerSeat != null) {
    out.myHand = g.players[viewerSeat].hand.slice()
    out.myActions = legalOnlineActions(g, viewerSeat)
    if (g.phase === 'turn' && g.turn === viewerSeat) out.myContext = {
      initialDealerTurn: g.initialDealerTurn && g.dealer === viewerSeat,
      lastDraw: g.players[viewerSeat].lastDraw,
      draw: g.drawContext ? { reason: g.drawContext.reason, flower: g.drawContext.flower, kongSource: g.drawContext.kongSource } : null,
    }
  }
  if (g.phase === 'finished') {
    out.result = clone(g.result)
    // 只在本手已结束时公开各家手牌，供摊牌展示；牌墙及进行中的暗牌仍不公开。
    out.revealedHands = g.players.map((p) => p.hand.slice())
  }
  return out
}

/** 从权限投影构造本地策略输入，不传入完整房间、其他人暗牌或牌墙顺序。 */
export function buildMahjongObservation(session, seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat > 3 || !session.game) throw new Error('麻将观察座位无效')
  const view = projectMahjongSession(session, seat)
  return { seat, phase: view.phase, dealer: view.dealer, double: view.double, wallCount: view.wallCount,
    balances: view.balances, players: view.players, myHand: view.myHand, myActions: view.myActions,
    myContext: view.myContext ?? null, response: view.response ?? null, events: view.events }
}
