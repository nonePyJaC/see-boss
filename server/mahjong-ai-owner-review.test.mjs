import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_TILES, maxCopies, isFlower } from '../shared/logic/mahjong/tiles.mjs'
import { applyOnlineAction } from '../shared/logic/mahjong/online-game.mjs'
import { createMahjongSession, setMahjongReady, startMahjongHand, validateMahjongSnapshot, buildMahjongObservation } from './mahjong-room.mjs'
import { buildCandidateStates, claimUncertainty } from './mahjong-ai-candidates.mjs'
import { decideMahjongV2, hypotheticalPayment, publicRisk } from './mahjong-ai-v2.mjs'

function fixture({ hand, hands = {}, discards = [[],[],[],[]], events = [], run = [], balances = [100,100,100,100], double = false, turn = 0, melds = [[],[],[],[]], flowers = [[],[],[],[]] }) {
  let session = createMahjongSession({ initialSeeds: 100 })
  for (let s = 0; s < 4; s++) session = setMahjongReady(session, s)
  session = startMahjongHand(session, { now: 1000 })
  const g = session.game, inventory = ALL_TILES.flatMap((tile) => Array(maxCopies(tile)).fill(tile))
  const take = (tile) => { const i = inventory.indexOf(tile); assert.notEqual(i, -1, `超张 ${tile}`); inventory.splice(i, 1); return tile }
  for (let s = 0; s < 4; s++) {
    const p = g.players[s]
    p.hand = []; p.flowers = flowers[s].slice(); p.melds = structuredClone(melds[s]); p.discards = discards[s].slice()
    p.ready = false; p.passedWin = false; p.passedPong = []; p.lastDraw = null; p.binding = null; p.sources = []
    for (const t of [...p.discards, ...p.flowers, ...p.melds.flatMap((m) => m.tiles)]) take(t)
  }
  for (let s = 0; s < 4; s++) for (const tile of s === turn ? hand : (hands[s] ?? [])) g.players[s].hand.push(take(tile))
  for (let s = 0; s < 4; s++) if (s !== turn && !hands[s]) while (g.players[s].hand.length < 13) {
    const tile = inventory.find((t) => !isFlower(t)); g.players[s].hand.push(take(tile))
  }
  g.wall = inventory.sort((a,b) => Number(isFlower(a)) - Number(isFlower(b)))
  g.wallLayout = null; g.phase = 'turn'; g.turn = turn; g.response = null; g.balances = balances.slice(); g.double = double
  g.events = structuredClone(events); g.discardRun = structuredClone(run); g.ledger = []; g.initialDealerTurn = false; g.drawContext = null
  validateMahjongSnapshot(session)
  return session
}

test('P2-1 本人第四次出牌的确定罚款进入候选并与引擎一致', () => {
  const discards = [['1m','1m','1m'], ['E','E','E'], ['S','S','S'], ['W','W','W']]
  const events = [0,1,2].flatMap((i) => discards.map((tiles, seat) => ({ type: 'discard', seat, tile: tiles[i] })))
  const run = [{seat:0,tile:'1m'}, {seat:1,tile:'E'}, {seat:2,tile:'S'}, {seat:3,tile:'W'}]
  const session = fixture({ hand:['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E','9p'], discards, events, run, flowers:[['Z'],[],[],[]] })
  const obs = buildMahjongObservation(session, 0), original = JSON.stringify(obs)
  assert.equal(obs.wallCount,78)
  const candidate = buildCandidateStates(obs).find((c) => c.action.tile === '1m')
  const actual = applyOnlineAction(session.game, 0, {type:'discard',tile:'1m'})
  validateMahjongSnapshot({ ...session, game:actual })
  assert.deepEqual(candidate.balances, actual.balances)
  assert.deepEqual(candidate.balances, [70,110,110,110]); assert.equal(candidate.immediate, -30)
  assert.equal(candidate.branch.success.discardResponse.sourceInGarden, false)
  const decision = decideMahjongV2(obs, { budgetMs:3000, randomize:false, identity:{style:'balanced',seed:1} })
  const scored = decision.diagnostic.candidates.find((c) => c.action.tile === '1m')
  assert.equal(scored.immediate, -30); assert.equal(scored.routes[0].immediateCredit, -4.5)
  const route = scored.routes.find((r) => r.route === 'normal')
  assert.deepEqual(route.reference.payment, hypotheticalPayment(candidate.observation, route.reference.flowers))
  assert.equal(JSON.stringify(obs), original)
})

test('P2-2 原出牌者不是本次碰杠竞争者，但补杠的三家仍是抢胡者', () => {
  const players = Array.from({length:4}, () => ({ready:false,melds:[]}))
  const obs = { seat:0, response:{kind:'discard', source:1, tile:'1m'}, wallCount:45, players }
  const baseline = claimUncertainty(obs, 'pong').points
  const discardRisk = publicRisk(obs, '2m')
  players[1].ready = true
  assert.equal(claimUncertainty(obs, 'pong').points, baseline)
  assert.equal(claimUncertainty(obs, 'kong').points, baseline)
  players[1].melds.push({type:'pong',tiles:['E','E','E']})
  assert.equal(claimUncertainty(obs, 'pong').points, baseline)
  assert.equal(claimUncertainty(obs, 'kong').points, baseline)
  assert.ok(claimUncertainty(obs, 'bukong').points > 1.5)
  assert.ok(publicRisk(obs, '2m') > discardRisk, '来源仍可胡碰后的新弃牌')
  players[2].ready = true
  assert.ok(claimUncertainty(obs, 'pong').points > baseline)
  for (const seat of [1,2,3]) {
    const testObs = { ...obs, players:Array.from({length:4}, () => ({ready:false,melds:[]})) }
    const cost = claimUncertainty(testObs, 'bukong').points
    testObs.players[seat].ready = true
    assert.ok(claimUncertainty(testObs, 'bukong').points > cost, `座 ${seat} 可抢杠`)
  }
})

test('第四张翻倍与余额不足按引擎封顶，罚后归零不改变出牌前园子快照', () => {
  const discards = [['1m','1m','1m'],[],[],[]]
  const events = discards[0].map((tile) => ({type:'discard',seat:0,tile}))
  const winner = ['2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E','E']
  const session = fixture({ hand:['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E','9p'],
    hands:{1:winner,2:[],3:[]}, discards, events, run:[{seat:0,tile:'1m'}], balances:[20,100,100,100], double:true })
  const obs = buildMahjongObservation(session,0)
  const c = buildCandidateStates(obs).find((x) => x.action.tile === '1m')
  let actual = applyOnlineAction(session.game,0,{type:'discard',tile:'1m'})
  assert.deepEqual(c.balances, actual.balances); assert.equal(c.immediate,-20)
  assert.ok(c.discardPayment.transfers.every((t) => t.amount === 20))
  validateMahjongSnapshot({ ...session, game:actual })
  assert.equal(c.branch.success.discardResponse.sourceInGarden,false)
  assert.equal(actual.phase,'response'); assert.equal(actual.response.sourceInGarden,false)
  assert.equal(c.terminal,false, '有响应时不能因罚后余额提前结束')
  assert.ok(actual.response.options[1].some((a) => a.type === 'win'))
  const winnerBefore = actual.balances[1]
  actual = applyOnlineAction(actual,1,{type:'win'})
  assert.equal(actual.result.kind,'discard'); assert.equal(actual.balances[1],winnerBefore)
  assert.ok(!actual.ledger.flatMap((e) => e.transfers).some((t) => t.reason === '园子点炮反付'))
})

test('四家跟同牌时首家付款，出牌者实际收到分配；翻倍及不足额一致', () => {
  const run = [{seat:1,tile:'1m'},{seat:2,tile:'1m'},{seat:3,tile:'1m'}]
  const events = run.map((e) => ({type:'discard', ...e}))
  const session = fixture({hand:['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E','9p'],
    hands:{1:[],2:[],3:[]}, discards:[[],['1m'],['1m'],['1m']], events, run, balances:[100,17,100,100], double:true})
  const c = buildCandidateStates(buildMahjongObservation(session,0)).find((x) => x.action.tile === '1m')
  const actual = applyOnlineAction(session.game,0,{type:'discard',tile:'1m'})
  assert.deepEqual(c.balances,actual.balances); assert.deepEqual(c.balances,[105,0,106,106])
  assert.equal(c.immediate,5); assert.deepEqual(c.discardPayment.payers,[1])
  const decision = decideMahjongV2(buildMahjongObservation(session,0),{budgetMs:3000,randomize:false,identity:{style:'balanced',seed:1}})
  assert.equal(decision.diagnostic.candidates.find((x) => x.action.tile === '1m').routes[0].immediateCredit,.75)
})

test('碰后计划出牌清空跟牌链，仍按历史出牌次数计算第四张罚款', () => {
  const initial = fixture({ turn:1, hand:['2m'], hands:{0:['2m','2m','1m','3m','4m','5m','1p','2p','3p','1s','2s','3s','E'],2:[],3:[]},
    discards:[['1m','1m','1m'],[],[],[]], events:[{type:'discard',seat:0,tile:'1m'},{type:'discard',seat:0,tile:'1m'},{type:'discard',seat:0,tile:'1m'}],
    run:[{seat:0,tile:'1m'},{seat:0,tile:'1m'},{seat:0,tile:'1m'}] })
  let g = applyOnlineAction(initial.game,1,{type:'discard',tile:'2m'})
  const session = { ...initial, game:g }; validateMahjongSnapshot(session)
  const obs = buildMahjongObservation(session,0)
  const candidate = buildCandidateStates(obs).find((x) => x.action.type === 'pong' && x.projectedDiscard === '1m')
  assert.ok(candidate); assert.equal(candidate.immediate,0); assert.equal(candidate.conditionalGain,-30)
  const decision = decideMahjongV2(obs,{budgetMs:3000,includeVariants:true,randomize:false,identity:{style:'balanced',seed:1}})
  const scored = decision.diagnostic.candidateVariants.find((x) => x.action.type === 'pong' && x.projectedDiscard === '1m')
  assert.equal(scored.conditionalGain,-30); assert.ok(Math.abs(scored.routes[0].immediateCredit - (-2.925)) < 1e-9)
  assert.deepEqual(candidate.discardPayment.payers,[0])
  g = applyOnlineAction(g,0,{type:'pong'})
  assert.equal(g.phase,'turn'); assert.equal(g.turn,0)
  g = applyOnlineAction(g,0,{type:'discard',tile:'1m'})
  assert.deepEqual(candidate.balances,g.balances); assert.deepEqual(candidate.balances,[70,110,110,110])
  validateMahjongSnapshot({ ...session, game:g })
})

test('公开历史不完整时标记罚款未知；碰杠会清空连续弃牌链但不抹历史次数', () => {
  const c = fixture({hand:['1m','2m','3m','1p','2p','3p','1s','2s','3s','4s','5s','6s','E','9p'],hands:{1:[],2:[],3:[]}})
  const obs = buildMahjongObservation(c,0); delete obs.events
  assert.equal(buildCandidateStates(obs).find((x) => x.action.tile === '1m').discardPayment.known,false)
  obs.events = [{type:'discard',seat:1,tile:'1m'},{type:'discard',seat:2,tile:'1m'},
    {type:'pong',seat:3,tile:'2p',from:2},{type:'discard',seat:3,tile:'1m'}]
  assert.deepEqual(buildCandidateStates(obs).find((x) => x.action.tile === '1m').discardPayment.payers,[])
  obs.events[2].type = 'kong'
  assert.deepEqual(buildCandidateStates(obs).find((x) => x.action.tile === '1m').discardPayment.payers,[])
})
