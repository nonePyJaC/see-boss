import test from 'node:test'
import assert from 'node:assert/strict'
import { createMahjongSession, setMahjongReady, startMahjongHand, submitMahjongAction, expireMahjongWindow, projectMahjongSession, resetMahjongMatch, validateMahjongSnapshot } from './mahjong-room.mjs'
import { createWall } from '../shared/logic/mahjong/online-wall.mjs'
import { isFlower } from '../shared/logic/mahjong/tiles.mjs'
import { dealSeatSequence } from '../shared/logic/mahjong/online-game.mjs'

function seeded(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 } }
function start() {
  let s = createMahjongSession()
  for (let i = 0; i < 4; i++) s = setMahjongReady(s, i)
  return startMahjongHand(s, { now: 1000, rng: seeded(42) })
}
const ids = (s, now = 1001) => ({ matchId: s.matchId, handId: s.handId, windowId: s.windowId, now })

test('按座位生成安全投影，旁观者没有手牌、合法动作、牌墙和其他人的响应', () => {
  const s = start(), g = s.game
  const p = projectMahjongSession(s, 0), spectator = projectMahjongSession(s)
  assert.deepEqual(p.myHand, g.players[0].hand)
  assert.equal('myHand' in spectator, false)
  assert.equal('myActions' in spectator, false)
  assert.equal('wall' in spectator, false)
  assert.ok(spectator.players.every((x) => !('hand' in x)))
  assert.ok(!('readyPending' in spectator) && !('choices' in (spectator.response ?? {})))
  assert.equal('pastHands' in spectator, false)
  assert.equal('revealedHands' in p, false)
  assert.equal('revealedHands' in spectator, false)
  assert.deepEqual(spectator.wallLayout.dice, g.wallLayout.dice)
  assert.equal(spectator.wallLayout.stacks.flat().reduce((a, b) => a + b, 0), g.wall.length)
  assert.ok(spectator.wallLayout.stacks.flat().every((n) => Number.isInteger(n) && n >= 0 && n <= 2))
})
test('只在本手结束后向所有视角公开摊牌，投影不会改变房间数据', () => {
  const s = start()
  const hands = s.game.players.map((p) => p.hand.slice())
  s.game.phase = 'finished'; s.game.result = { type: 'draw', winners: [], matchOver: false }
  for (const seat of [null, 0, 1, 2, 3]) {
    const view = projectMahjongSession(s, seat)
    assert.deepEqual(view.revealedHands, hands)
    assert.equal('wall' in view, false)
    view.revealedHands[0].pop()
    assert.deepEqual(s.game.players.map((p) => p.hand), hands)
  }
})
test('手号、场号和窗口号校验，防重复和旧动作', () => {
  let s = start()
  assert.throws(() => submitMahjongAction(s, 0, { type: 'pass' }, { ...ids(s), matchId: 'old' }))
  const actor = [0, 1, 2, 3].find((i) => legalOnlineActionsFor(s, i).length)
  const action = legalOnlineActionsFor(s, actor)[0]
  const old = ids(s)
  s = submitMahjongAction(s, actor, action, old)
  assert.throws(() => submitMahjongAction(s, actor, action, old))
})
function legalOnlineActionsFor(s, i) { return projectMahjongSession(s, i).myActions }
test('行动限时拒绝过期请求，托管只选择合法动作并推进', () => {
  const s = start()
  const actor = [0, 1, 2, 3].find((i) => legalOnlineActionsFor(s, i).length)
  assert.throws(() => submitMahjongAction(s, actor, legalOnlineActionsFor(s, actor)[0], ids(s, s.deadlineAt)))
  assert.equal(expireMahjongWindow(s, { now: s.deadlineAt - 1 }), s)
  const after = expireMahjongWindow(s, { now: s.deadlineAt })
  assert.notEqual(after.windowId, s.windowId)
})
test('同一响应窗口允许不同座位先后操作，投影不透露其他人尚未裁定的选择', () => {
  let s = start()
  s.game.phase = 'ready'
  s.game.readyPending = [1, 2]
  s.game.events = []
  s.game.players[1].ready = false
  s.game.players[2].ready = false
  const old = ids(s)
  s = submitMahjongAction(s, 1, { type: 'ready' }, old)
  assert.equal(s.windowId, old.windowId)
  const spectator = projectMahjongSession(s)
  assert.equal(spectator.players[1].ready, null)
  assert.ok(!spectator.events.some((e) => e.type === 'ready'))
  assert.throws(() => submitMahjongAction(s, 1, { type: 'pass' }, old))
  s = submitMahjongAction(s, 2, { type: 'pass' }, old)
  assert.notEqual(s.windowId, old.windowId)
  assert.equal(projectMahjongSession(s).players[1].ready, true)
})
test('新场须在结束后重开，保留旧结果并生成新标识', () => {
  const s = start()
  assert.throws(() => resetMahjongMatch(s))
  s.game.phase = 'finished'; s.game.result = { type: 'matchEnd', matchOver: true, winners: [] }
  const r = resetMahjongMatch(s)
  assert.notEqual(r.matchId, s.matchId)
  assert.equal(r.completed.length, 1)
  assert.equal(r.game, null)
  assert.deepEqual(r.ready, [false, false, false, false])
})
test('快照往返恢复并拒绝缺牌或缺失截止时间的状态', () => {
  const s = JSON.parse(JSON.stringify(start()))
  assert.equal(validateMahjongSnapshot(s), true)
  const missingTile = structuredClone(s); missingTile.game.wall.pop()
  assert.throws(() => validateMahjongSnapshot(missingTile), /牌张/)
  const noDeadline = structuredClone(s); noDeadline.deadlineAt = null
  assert.throws(() => validateMahjongSnapshot(noDeadline), /截止时间/)
  const wrongWallPosition = structuredClone(s); wrongWallPosition.game.wallLayout.headTaken++
  assert.throws(() => validateMahjongSnapshot(wrongWallPosition), /牌墙位置/)
  const oldSnapshot = structuredClone(s); delete oldSnapshot.game.wallLayout
  assert.equal(validateMahjongSnapshot(oldSnapshot), true)
  assert.equal('wallLayout' in projectMahjongSession(oldSnapshot), false)
  const oldWall = structuredClone(s)
  delete oldWall.game.wallLayout.version
  oldWall.game.wallLayout.breakStack = 18 - oldWall.game.wallLayout.dice[0] - oldWall.game.wallLayout.dice[1]
  assert.equal(validateMahjongSnapshot(oldWall), true)
  assert.equal(projectMahjongSession(oldWall).wallLayout.stacks.flat().reduce((a, b) => a + b, 0), oldWall.game.wall.length)
})
function arrangedWall(dealerTiles) {
  const tiles = createWall(seeded(21))
  const dealer = dealerTiles.map((tile) => {
    const index = tiles.indexOf(tile)
    assert.ok(index >= 0)
    return tiles.splice(index, 1)[0]
  })
  const fill = (a, length) => { while (a.length < length) a.push(tiles.splice(tiles.findIndex((t) => !isFlower(t)), 1)[0]) }
  fill(dealer, 14)
  const others = [[], [], []]
  for (const hand of others) fill(hand, 13)
  const hands = [dealer, ...others]
  return [...dealSeatSequence(0).map((s) => hands[s].shift()), ...tiles]
}
test('起手花杠直接结束整场，尚无行动窗口的快照可恢复', () => {
  let s = createMahjongSession({ initialSeeds: 10 })
  for (let i = 0; i < 4; i++) s = setMahjongReady(s, i)
  s = startMahjongHand(s, { now: 1000, wall: arrangedWall(['f1', 'f2', 'f3', 'f4']) })
  assert.equal(s.game.phase, 'finished')
  assert.equal(s.game.result.matchOver, true)
  assert.equal(s.windowId, 0)
  assert.equal(validateMahjongSnapshot(JSON.parse(JSON.stringify(s))), true)
  assert.notEqual(resetMahjongMatch(s).matchId, s.matchId)
})
test('暗杠结束整场时清理摸牌标记，也兼容旧结束态快照', () => {
  let s = createMahjongSession()
  for (let i = 0; i < 4; i++) s = setMahjongReady(s, i)
  s = startMahjongHand(s, { now: 1000, wall: arrangedWall(['1m', '1m', '1m', '1m']) })
  while (s.game.phase === 'ready') s = submitMahjongAction(s, s.game.readyPending[0], { type: 'pass' }, ids(s))
  s.game.initialDealerTurn = false
  s.game.players[0].lastDraw = '1m'
  s.game.balances = [100, 5, 5, 100]
  s = submitMahjongAction(s, 0, { type: 'ankong', tile: '1m' }, ids(s))
  assert.equal(s.game.result.matchOver, true)
  assert.equal(s.game.players[0].lastDraw, null)
  assert.equal(validateMahjongSnapshot(JSON.parse(JSON.stringify(s))), true)
  const legacy = JSON.parse(JSON.stringify(s))
  legacy.game.players[0].lastDraw = '1m'
  assert.equal(validateMahjongSnapshot(legacy), true)
  assert.notEqual(resetMahjongMatch(legacy).matchId, legacy.matchId)
})
test('多人响应中恢复：已提交选择保密、其余座位保留原窗口', () => {
  const tiles = createWall(seeded(20))
  const take = (tile) => { const index = tiles.indexOf(tile); assert.ok(index >= 0); return tiles.splice(index, 1)[0] }
  const winning = ['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E'].map(take)
  const pong = ['E', 'E'].map(take)
  const dealer = [take('E')]
  const fill = (array, size) => { while (array.length < size) array.push(tiles.splice(tiles.findIndex((x) => !isFlower(x)), 1)[0]) }
  fill(dealer, 14); fill(pong, 13)
  const fourth = []; fill(fourth, 13)
  let s = createMahjongSession()
  for (let i = 0; i < 4; i++) s = setMahjongReady(s, i)
  const hands = [dealer, winning, pong, fourth]
  s = startMahjongHand(s, { now: 1000, wall: [...dealSeatSequence(0).map((seat) => hands[seat].shift()), ...tiles] })
  while (s.game.phase === 'ready') {
    const actor = s.game.readyPending[0]
    s = submitMahjongAction(s, actor, { type: 'pass' }, ids(s))
  }
  s.game.balances[0] = 0
  s = submitMahjongAction(s, 0, { type: 'discard', tile: 'E' }, ids(s))
  assert.equal(s.game.phase, 'response')
  assert.ok(projectMahjongSession(s, 1).myActions.some((a) => a.type === 'win'))
  assert.ok(projectMahjongSession(s, 2).myActions.some((a) => a.type === 'pong'))
  s = submitMahjongAction(s, 2, { type: 'pong' }, ids(s))
  const windowId = s.windowId
  s = JSON.parse(JSON.stringify(s))
  assert.equal(validateMahjongSnapshot(s), true)
  assert.equal(projectMahjongSession(s, 1).response.sourceInGarden, true)
  assert.equal('choices' in projectMahjongSession(s, 1).response, false)
  assert.equal(s.windowId, windowId)
  for (const key of Object.keys(s.game.response.options)) {
    const seat = Number(key)
    if (seat !== 1 && !s.game.response.choices[seat]) s = submitMahjongAction(s, seat, { type: 'pass' }, ids(s))
  }
  s = submitMahjongAction(s, 1, { type: 'win' }, ids(s))
  assert.equal(s.game.phase, 'finished')
  assert.equal(s.game.result.winners[0].seat, 1)
  assert.ok(s.game.balances[0] > 0)
})
