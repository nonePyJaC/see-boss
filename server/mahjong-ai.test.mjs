import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createMahjongSession, setMahjongReady, startMahjongHand, buildMahjongObservation, submitMahjongAction, expireMahjongWindow } from './mahjong-room.mjs'
import { mahjongShanten, mahjongEffectiveTiles, mahjongVisibleCounts, safeMahjongAction, estimateMahjongWin } from './mahjong-ai.mjs'
import { analyzeHand } from '../shared/logic/mahjong/hand.mjs'

const readyHand = ['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E']
const seven = ['1m','1m','2m','2m','3p','3p','4p','4p','5s','5s','E','E','W']
const doubleSeven = ['1m','1m','1m','1m','2m','2m','3p','3p','4p','4p','5s','5s','E','E']
const seeded = (seed) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }

test('标准型、含副露、七对和双七对向听距离', () => {
  assert.equal(mahjongShanten(readyHand), 0)
  assert.equal(mahjongShanten([...readyHand, 'E']), -1)
  assert.equal(mahjongShanten(['1m','2m','3m','1p','2p','3p','1s','2s','3s','E'], 1), 0)
  assert.equal(mahjongShanten(seven), 0)
  assert.equal(mahjongShanten([...seven, 'W']), -1)
  assert.equal(mahjongShanten(doubleSeven), -1)
  assert.equal(mahjongShanten(doubleSeven.slice(0, -1)), 0)
})

test('两组和三组四张都按双七对计算成牌、听牌和有效进张', () => {
  for (const hand of [
    ['1m','1m','1m','1m','2p','2p','2p','2p','4s','4s','6s','6s','E','E'],
    ['1m','1m','1m','1m','2p','2p','2p','2p','4s','4s','4s','4s','E','E'],
  ]) {
    assert.equal(mahjongShanten(hand), -1)
    for (const missing of new Set(hand)) {
      const ready = hand.slice(); ready.splice(ready.indexOf(missing), 1)
      const visible = mahjongVisibleCounts({ myHand: ready, players: [] })
      assert.equal(mahjongShanten(ready), 0)
      assert.ok(mahjongEffectiveTiles(ready, 0, visible).draws.some((d) => d.tile === missing && d.left === 5 - hand.filter((t) => t === missing).length))
    }
    const players = Array.from({ length: 4 }, () => ({ discards: [], flowers: [], melds: [], binding: null, ready: false }))
    const waiting = [...hand.slice(0, -1), '9p']
    const action = safeMahjongAction({ seat: 0, phase: 'turn', myHand: waiting, players,
      balances: [1000,1000,1000,1000], wallCount: 50,
      myActions: [...new Set(waiting)].map((tile) => ({ type: 'discard', tile })) })
    assert.deepEqual(action, { type: 'discard', tile: '9p' })
  }
})
test('只统计未见进张，已见弃牌、明杠和暗杠均按公开张数计', () => {
  const players = Array.from({ length: 4 }, () => ({ discards: [], flowers: [], melds: [] }))
  players[1].discards = ['E', 'E']
  players[2].melds = [{ type: 'ankong', tiles: ['W','W','W','W'] }]
  const visible = mahjongVisibleCounts({ myHand: readyHand, players })
  assert.equal(visible.E, 3)
  assert.equal(visible.W, 4)
  const result = mahjongEffectiveTiles(readyHand, 0, visible)
  assert.deepEqual(result.draws, [{ tile: 'E', left: 1 }])
})
test('抢补杠时第四张虽仍在对方手里，公开后也计入已见牌', () => {
  const players = Array.from({ length: 4 }, () => ({ discards: [], flowers: [], melds: [] }))
  players[0].melds = [{ type: 'pong', tiles: ['E','E','E'] }]
  const obs = { seat: 1, myHand: ['1m'], players, response: { kind: 'robKong', source: 0, tile: 'E' } }
  assert.equal(mahjongVisibleCounts(obs).E, 4)
  assert.equal(mahjongVisibleCounts({ ...obs, seat: 0, myHand: ['E'] }).E, 4)
})
test('只对引擎合法动作做选择，异常输入也能返回合法回退', () => {
  const actions = [{ type: 'discard', tile: 'E' }, { type: 'discard', tile: '1m' }]
  assert.deepEqual(safeMahjongAction({ myActions: actions }), actions[0])
  assert.equal(safeMahjongAction({ myActions: [] }), null)
})
test('观察对象不包含对手暗牌、牌墙次序、未裁定响应或令牌', () => {
  let s = createMahjongSession()
  for (let i = 0; i < 4; i++) s = setMahjongReady(s, i)
  s = startMahjongHand(s, { rng: seeded(5) })
  const before = buildMahjongObservation(s, 0)
  const alternate = structuredClone(s)
  ;[alternate.game.players[1].hand, alternate.game.players[2].hand] = [alternate.game.players[2].hand, alternate.game.players[1].hand]
  alternate.game.wall.reverse()
  const after = buildMahjongObservation(alternate, 0)
  assert.deepEqual(after, before)
  assert.ok(!('wall' in before) && before.players.every((p) => !('hand' in p)))
  assert.ok(!JSON.stringify(before).includes('seatToken'))
  alternate.game.phase = 'response'
  alternate.game.response = { kind: 'discard', source: 3, tile: 'E', sourceInGarden: false,
    options: { 0: [{ type: 'pong' }], 1: [{ type: 'win' }] }, choices: { 1: 'win' } }
  const first = buildMahjongObservation(alternate, 0)
  alternate.game.response.choices[1] = 'pass'
  assert.deepEqual(buildMahjongObservation(alternate, 0), first)
})
test('园子点炮和园子补杠按不同付款方向评估，而不是隐藏合法胡', () => {
  const players = Array.from({ length: 4 }, () => ({ discards: [], flowers: [], melds: [], binding: null, ready: false }))
  const obs = { seat: 1, phase: 'response', myHand: readyHand, players, balances: [0,1000,1000,1000], double: false,
    wallCount: 1, myActions: [{ type:'win' }, { type:'pass' }], response: { kind:'discard', source:0, tile:'E', sourceInGarden:true } }
  const ordinary = estimateMahjongWin(obs)
  assert.ok(ordinary.net < 0)
  assert.equal(ordinary.transfers.length, 1)
  const rob = estimateMahjongWin({ ...obs, response: { ...obs.response, kind:'robKong' } })
  assert.equal(rob.transfers.length, 3)
  assert.equal(rob.net, ordinary.net * 3)
  assert.equal(safeMahjongAction(obs).type, 'pass')
  assert.equal(safeMahjongAction({ ...obs, wallCount: 100 }).type, 'win')
})
test('碰、直杠、暗杠和补杠均按局面与合法列表参与决策', () => {
  const players = Array.from({ length: 4 }, () => ({ discards: [], flowers: [], melds: [], binding: null, ready: false }))
  players[1].flowers = ['Z','Z','Z','Z']
  const base = { seat: 1, players, balances: [100,100,100,100], double: false, wallCount: 60 }
  const pong = { ...base, phase:'response', myHand:['E','E','1m','2m','3m','1p','2p','3p','1s','2s','3s','9m','9p'],
    response:{kind:'discard',source:0,tile:'E',sourceInGarden:false}, myActions:[{type:'pong'},{type:'pass'}] }
  assert.equal(safeMahjongAction(pong).type, 'pong')
  const kong = { ...pong, myHand:['E','E','E','1m','2m','3m','1p','2p','3p','1s','2s','3s','9m'], myActions:[{type:'kong'},{type:'pass'}] }
  assert.equal(safeMahjongAction(kong).type, 'kong')
  const hidden = { ...base, phase:'turn', myHand:['E','E','E','E','1m','2m','3m','1p','2p','3p','1s','2s','3s','W'],
    myActions:[{type:'ankong',tile:'E'}, {type:'discard',tile:'W'}] }
  assert.equal(safeMahjongAction(hidden).type, 'ankong')
  const opened = structuredClone(base)
  opened.players[1].melds = [{type:'pong',tiles:['E','E','E'],from:0}]
  const added = { ...opened, phase:'turn', myHand:['E','1m','2m','3m','1p','2p','3p','1s','2s','3s','W'],
    myActions:[{type:'bukong',tile:'E'},{type:'discard',tile:'E'}] }
  assert.equal(safeMahjongAction(added).type, 'bukong')
})
test('超时托管使用麻将策略，舍弃孤张保留已听牌形', () => {
  let s = createMahjongSession()
  for (let i = 0; i < 4; i++) s = setMahjongReady(s, i)
  s = startMahjongHand(s, { now: 1000, rng: seeded(11) })
  s.game.phase = 'turn'; s.game.turn = 0; s.game.initialDealerTurn = false
  s.game.players[0].hand = [...readyHand, '9p']
  s.game.players[0].melds = []; s.game.players[0].lastDraw = '9p'
  const next = expireMahjongWindow(s, { now: s.deadlineAt })
  assert.ok(next.game.events.some((e) => e.type === 'discard' && e.seat === 0 && e.tile === '9p'))
})
test('成牌与听牌的向听计算和规则引擎一致', () => {
  const random = seeded(9182)
  let checked = 0
  for (let trial = 0; trial < 1000 && checked < 100; trial++) {
    const hand = []
    for (let i = 0; i < 4; i++) {
      const suit = ['m','p','s'][Math.floor(random() * 3)], start = 1 + Math.floor(random() * 7)
      hand.push(`${start}${suit}`, `${start + 1}${suit}`, `${start + 2}${suit}`)
    }
    const pair = ['E','S','W','N'][Math.floor(random() * 4)]
    hand.push(pair, pair)
    if (!analyzeHand({ concealed: hand }).valid) continue
    assert.equal(mahjongShanten(hand), -1)
    assert.equal(mahjongShanten(hand.slice(0, -1)), 0)
    checked++
  }
  assert.equal(checked, 100)
})
test('决策性能：典型出牌在有限时间内返回合法动作', () => {
  let s = createMahjongSession()
  for (let i = 0; i < 4; i++) s = setMahjongReady(s, i)
  s = startMahjongHand(s, { rng: seeded(11) })
  while (s.game.phase === 'ready') s = submitMahjongAction(s, s.game.readyPending[0], { type: 'pass' }, s)
  const obs = buildMahjongObservation(s, s.game.turn)
  const start = performance.now(), action = safeMahjongAction(obs), elapsed = performance.now() - start
  assert.ok(obs.myActions.some((a) => a.type === action.type && (a.tile == null || a.tile === action.tile)))
  assert.ok(elapsed < 5000, `耗时 ${elapsed.toFixed(0)}ms`)
})
test('四个本地策略多局对战始终选择合法动作并完成', (t) => {
  let decisions = 0, maxMs = 0, totalMs = 0
  for (let seed = 30; seed < 38; seed++) {
    let session = createMahjongSession({ initialSeeds: 200 })
    for (let i = 0; i < 4; i++) session = setMahjongReady(session, i)
    session = startMahjongHand(session, { now: 1000, rng: seeded(seed) })
    let steps = 0
    while (session.game.phase !== 'finished' && steps++ < 1200) {
      const seat = [0,1,2,3].find((i) => buildMahjongObservation(session, i).myActions.length)
      assert.notEqual(seat, undefined, `seed ${seed} phase ${session.game.phase}`)
      const obs = buildMahjongObservation(session, seat)
      const begin = performance.now()
      const action = safeMahjongAction(obs)
      const elapsed = performance.now() - begin
      maxMs = Math.max(maxMs, elapsed); totalMs += elapsed
      assert.ok(obs.myActions.some((a) => a.type === action?.type && (a.tile == null || a.tile === action.tile)))
      session = submitMahjongAction(session, seat, action, { matchId: session.matchId, handId: session.handId, windowId: session.windowId, now: 1001 })
      decisions++
    }
    assert.equal(session.game.phase, 'finished', `seed ${seed}`)
    assert.equal(session.game.balances.reduce((a, b) => a + b, 0), 800)
  }
  assert.ok(decisions > 100)
  assert.ok(maxMs < 5000, `最慢决策 ${maxMs.toFixed(0)}ms`)
  t.diagnostic(`决策 ${decisions} 次，平均 ${(totalMs / decisions).toFixed(1)}ms，最慢 ${maxMs.toFixed(1)}ms`)
})
