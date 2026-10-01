import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.LISTEN = '0'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-online-ai-regressions-'))
process.env.HAMSTER_DATA_DIR = dataDir
process.env.HAMSTER_ONLINE_CREATE_CODE = '111111'

const { server, rooms } = await import('../server/index.js')
const { closeDb } = await import('../server/db.js')
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const code = '111111'
const config = { mode: 'online', gameType: 'long', initialSeeds: 3200, smallBlind: 10, bigBlind: 20 }
const hosts = new Map()
let identitySequence = 0

async function api(route, body = {}) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200, `${route} 返回 HTTP ${response.status}`)
  return response.json()
}

async function register(name) {
  const sequence = ++identitySequence
  const uid = `online-v2-${process.pid}-${sequence}`
  const account = `v2${process.pid.toString(36)}${sequence}`.slice(0, 16)
  const response = await api('/api/account/login', { uid, account, nickname: name })
  assert.equal(response.ok, true, response.error)
  return uid
}

async function createRoom(names, stacks, { previousDealerIndex, aiObserver = false } = {}) {
  const hostUid = await register(names[0])
  const created = await api('/api/room/create', {
    uid: hostUid,
    me: { nickname: names[0], avatar: 1 },
    createCode: code,
    cfg: config,
  })
  assert.equal(created.ok, true, created.error)
  const host = {
    uid: hostUid,
    roomId: created.data.id,
    seatId: created.data.seatId,
    seatToken: created.data.seatToken,
  }
  hosts.set(host.roomId, host)
  const players = [host]

  for (const name of names.slice(1)) {
    const uid = await register(name)
    const joined = await api('/api/room/join', {
      uid,
      roomId: host.roomId,
      me: { nickname: name, avatar: 1 },
    })
    assert.equal(joined.ok, true, joined.error)
    players.push({
      uid,
      roomId: host.roomId,
      seatId: joined.data.seatId,
      seatToken: joined.data.seatToken,
    })
  }

  const room = rooms.get(host.roomId)
  assert.ok(room, '建房成功后房间必须存在')
  let observer
  if (aiObserver) {
    const added = await api('/api/room/add-ai', {
      uid: host.uid,
      roomId: host.roomId,
      seatId: host.seatId,
      seatToken: host.seatToken,
    })
    assert.equal(added.ok, true, added.error)
    observer = room.seats.find((seat) => seat.kind === 'ai')
    assert.ok(observer)
    observer.seeds = 0
  }

  for (let i = 0; i < players.length; i++) {
    room.seats.find((seat) => seat.uid === players[i].seatId).seeds = stacks[i]
  }
  if (previousDealerIndex !== undefined) room.dealerUid = players[previousDealerIndex].seatId

  const started = await api('/api/room/start', {
    uid: host.uid,
    roomId: host.roomId,
    seatId: host.seatId,
    seatToken: host.seatToken,
  })
  assert.equal(started.ok, true, started.error)
  return { host, players, room, observer, state: started.data }
}

async function act(roomHost, player, state, type, amount) {
  const body = {
    uid: player.uid,
    roomId: roomHost.roomId,
    seatId: player.seatId,
    seatToken: player.seatToken,
    handId: state.handId,
    turnSeq: state.turnSeq,
    type,
  }
  if (amount !== undefined) body.amount = amount
  const response = await api('/api/room/action', body)
  assert.equal(response.ok, true, `${type}: ${response.error}`)
  return response.data
}

async function closeRoom(host) {
  if (!host || !hosts.has(host.roomId)) return
  const response = await api('/api/room/leave', {
    uid: host.uid,
    roomId: host.roomId,
    seatId: host.seatId,
    seatToken: host.seatToken,
  })
  assert.ok(response.ok || response.code === 'ROOM_NOT_FOUND', response.error)
  hosts.delete(host.roomId)
}

function setCards(room, players, holeCards, board) {
  const holes = Object.fromEntries(players.map((player, i) => [player.seatId, holeCards[i]]))
  const reserved = new Set([...board, ...Object.values(holes).flat()])
  const dealt = room.state.dealt
  const prefix = room.state.deck.slice(0, dealt)
  const tail = room.state.deck.slice(dealt).filter((card) => !reserved.has(card))
  room.state.deck = [...prefix, ...board, ...tail]
  room.hands = holes
}

function assertSettlement(state, players, invested, gross, expectedPot, initialStacksTotal) {
  assert.equal(state.finished, true)
  assert.ok(state.result)
  assert.equal(state.result.pot, expectedPot)
  assert.equal(state.pot, 0)
  assert.deepEqual(
    Object.fromEntries(state.result.hands.map((hand) => [hand.uid, hand.totalBet])),
    invested,
  )
  assert.deepEqual(
    Object.fromEntries(state.result.hands.map((hand) => [hand.uid, hand.won])),
    gross,
  )
  assert.equal(state.result.hands.reduce((sum, hand) => sum + hand.totalBet, 0), expectedPot)
  assert.equal(state.result.hands.reduce((sum, hand) => sum + hand.won, 0), expectedPot)
  assert.equal(state.result.winnings.reduce((sum, win) => sum + win.amount, 0), expectedPot)
  assert.equal(state.result.potLayers.reduce((sum, layer) => sum + layer.amount, 0), expectedPot)
  assert.equal(state.seats.reduce((sum, seat) => sum + seat.seeds, 0), initialStacksTotal)
  assert.equal(
    state.result.hands.reduce((sum, hand) => sum + hand.won - hand.totalBet, 0),
    0,
    '本手淨盈亏总和必须为 0',
  )
  assert.equal(players.length, Object.keys(invested).length)
}

function summarizeLayer(layer) {
  return {
    amount: layer.amount,
    contributors: [...layer.contributorUids].sort(),
    eligible: [...layer.eligibleUids].sort(),
    awards: Object.fromEntries(layer.awards.map(({ uid, amount }) => [uid, amount])),
    isUncalledReturn: layer.isUncalledReturn,
  }
}

test('HTTP实际金额：已下注20、对手全下到180，跟注只支付160', async () => {
  let fixture
  try {
    fixture = await createRoom(['成本短测', '全下短测'], [1000, 180])
    setCards(fixture.room, fixture.players, [['Qs', 'Jd'], ['Ts', '9h']], ['Kh', 'Kc', '3d', '3c', 'Ah'])
    let state = await act(fixture.host, fixture.players[0], fixture.state, 'call')
    state = await act(fixture.host, fixture.players[1], state, 'allin')
    assert.deepEqual(
      (({ type, amount, betTotal }) => ({ type, amount, betTotal }))(state.actionLog.at(-1)),
      { type: 'allin', amount: 160, betTotal: 180 },
    )
    const ownState = await api('/api/room/state', {
      roomId: fixture.host.roomId,
      seatId: fixture.players[0].seatId,
      seatToken: fixture.players[0].seatToken,
    })
    assert.equal(ownState.data.avail.find((action) => action.type === 'call').amount, 160)
    state = await act(fixture.host, fixture.players[0], state, 'call')
    assert.deepEqual(
      (({ type, amount, betTotal }) => ({ type, amount, betTotal }))(state.actionLog.at(-1)),
      { type: 'call', amount: 160, betTotal: 180 },
    )
  } finally {
    await closeRoom(fixture?.host)
  }
})

test('HTTP实际金额：只剩177时，超额待跟只支付177', async () => {
  let fixture
  try {
    fixture = await createRoom(['剩余短测', '深码短测'], [197, 1000], { previousDealerIndex: 0 })
    assert.equal(fixture.state.turnUid, fixture.players[1].seatId)
    let state = await act(fixture.host, fixture.players[1], fixture.state, 'allin')
    const ownState = await api('/api/room/state', {
      roomId: fixture.host.roomId,
      seatId: fixture.players[0].seatId,
      seatToken: fixture.players[0].seatToken,
    })
    assert.equal(ownState.data.avail.find((action) => action.type === 'call').amount, 177)
    state = await act(fixture.host, fixture.players[0], state, 'call')
    assert.deepEqual(
      (({ type, amount, betTotal }) => ({ type, amount, betTotal }))(state.actionLog.at(-1)),
      { type: 'call', amount: 177, betTotal: 197 },
    )
  } finally {
    await closeRoom(fixture?.host)
  }
})

test('HTTP结算：177/3177完全同牌力，双方净盈亏为0', async () => {
  let fixture
  try {
    fixture = await createRoom(['短码平局', '深码平局'], [177, 3177])
    const [short, deep] = fixture.players
    setCards(fixture.room, fixture.players, [['Qs', 'Jd'], ['Ts', '9h']], ['Kh', 'Kc', '3d', '3c', 'Ah'])
    let state = await act(fixture.host, short, fixture.state, 'call')
    state = await act(fixture.host, deep, state, 'allin')
    state = await act(fixture.host, short, state, 'call')
    assertSettlement(
      state,
      fixture.players,
      { [short.seatId]: 177, [deep.seatId]: 3177 },
      { [short.seatId]: 177, [deep.seatId]: 3177 },
      3354,
      3354,
    )
    assert.deepEqual(state.result.potLayers.map((layer) => layer.amount), [354, 3000])
    assert.deepEqual(state.result.potLayers.map((layer) => layer.isUncalledReturn), [false, true])
  } finally {
    await closeRoom(fixture?.host)
  }
})

test('HTTP结算：同为两对时按踢脚分胜负', async () => {
  let fixture
  try {
    fixture = await createRoom(['短码踢脚', '深码踢脚'], [177, 3177])
    const [short, deep] = fixture.players
    setCards(fixture.room, fixture.players, [['Ts', '9h'], ['Qs', 'Jd']], ['Kh', 'Kc', '3d', '3c', '2h'])
    let state = await act(fixture.host, short, fixture.state, 'call')
    state = await act(fixture.host, deep, state, 'allin')
    state = await act(fixture.host, short, state, 'call')
    assertSettlement(
      state,
      fixture.players,
      { [short.seatId]: 177, [deep.seatId]: 3177 },
      { [short.seatId]: 0, [deep.seatId]: 3354 },
      3354,
      3354,
    )
    const hands = new Map(state.result.hands.map((hand) => [hand.uid, hand]))
    assert.equal(hands.get(short.seatId).hand.name, '两对')
    assert.equal(hands.get(deep.seatId).hand.name, '两对')
    assert.notDeepEqual(hands.get(short.seatId).hand.kickers, hands.get(deep.seatId).hand.kickers)
    assert.deepEqual(state.result.potLayers.map((layer) => layer.isUncalledReturn), [false, true])
  } finally {
    await closeRoom(fixture?.host)
  }
})

async function runFoldedDeadMoneyCase(foldedContribution) {
  let fixture
  try {
    fixture = await createRoom(['超短码', '深码', '死钱玩家'], [177, 3177, 300])
    const [short, deep, folded] = fixture.players
    setCards(fixture.room, fixture.players, [['Qs', 'Jd'], ['Ts', '9h'], ['2s', '4d']], ['Kh', 'Kc', '3d', '3c', 'Ah'])
    let state = await act(fixture.host, short, fixture.state, 'call')
    state = await act(fixture.host, deep, state, 'call')
    state = await act(fixture.host, folded, state, 'check')
    assert.equal(state.phase, 'flop')
    state = await act(fixture.host, deep, state, 'check')
    state = await act(fixture.host, folded, state, 'raise', foldedContribution - 20)
    state = await act(fixture.host, short, state, 'call')
    state = await act(fixture.host, deep, state, 'allin')
    state = await act(fixture.host, folded, state, 'fold')
    state = await act(fixture.host, short, state, 'call')

    const expectedPot = 177 + 3177 + foldedContribution
    const layers = state.result.potLayers.map(summarizeLayer)
    if (foldedContribution === 100) {
      assertSettlement(
        state,
        fixture.players,
        { [short.seatId]: 177, [deep.seatId]: 3177, [folded.seatId]: 100 },
        { [short.seatId]: 227, [deep.seatId]: 3227, [folded.seatId]: 0 },
        expectedPot,
        177 + 3177 + 300,
      )
      assert.deepEqual(layers.map((layer) => layer.amount), [300, 154, 3000])
      assert.deepEqual(layers.map((layer) => layer.isUncalledReturn), [false, false, true])
      assert.deepEqual(layers[0].eligible, [short.seatId, deep.seatId].sort())
      assert.equal(layers[0].contributors.includes(folded.seatId), true)
      assert.deepEqual(layers[0].awards, { [short.seatId]: 150, [deep.seatId]: 150 })
      assert.deepEqual(layers[1].awards, { [short.seatId]: 77, [deep.seatId]: 77 })
    } else {
      const remainderWinner = [short, deep].sort((a, b) => a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0)[0]
      const other = remainderWinner === short ? deep : short
      const expectedGross = {
        [remainderWinner.seatId]: 228 + (remainderWinner === deep ? 3000 : 0),
        [other.seatId]: 227 + (other === deep ? 3000 : 0),
        [folded.seatId]: 0,
      }
      assert.equal(expectedPot, 3455)
      assertSettlement(
        state,
        fixture.players,
        { [short.seatId]: 177, [deep.seatId]: 3177, [folded.seatId]: 101 },
        expectedGross,
        3455,
        177 + 3177 + 300,
      )
      assert.deepEqual(layers.map((layer) => layer.amount), [303, 152, 3000])
      assert.deepEqual(layers.map((layer) => layer.isUncalledReturn), [false, false, true])
      assert.equal(layers[0].awards[remainderWinner.seatId], 152)
      assert.equal(layers[0].awards[other.seatId], 151)
    }
    assert.equal(state.result.hands.find((hand) => hand.uid === folded.seatId).folded, true)
    assert.deepEqual(state.result.hands.find((hand) => hand.uid === folded.seatId).hole, [])
  } finally {
    await closeRoom(fixture?.host)
  }
}

test('HTTP结算：死钱进入主池，投入100的弃牌玩家不具备资格', async () => {
  await runFoldedDeadMoneyCase(100)
})

test('HTTP结算：奇数平分余数只多派1，净和仍为0', async () => {
  await runFoldedDeadMoneyCase(101)
})

test('HTTP结算：多出资人但仅一名合格赢家不是退款', async () => {
  let fixture
  try {
    fixture = await createRoom(['弃牌方', '唯一赢家'], [500, 500])
    const [folded, winner] = fixture.players
    let state = await act(fixture.host, folded, fixture.state, 'call')
    state = await act(fixture.host, winner, state, 'raise', 100)
    state = await act(fixture.host, folded, state, 'fold')
    assertSettlement(
      state,
      fixture.players,
      { [folded.seatId]: 20, [winner.seatId]: 100 },
      { [folded.seatId]: 0, [winner.seatId]: 120 },
      120,
      1000,
    )
    const layers = state.result.potLayers.map(summarizeLayer)
    assert.deepEqual(layers.map((layer) => layer.amount), [40, 80])
    assert.deepEqual(layers.map((layer) => layer.isUncalledReturn), [false, true])
    assert.deepEqual(layers[0].contributors, [folded.seatId, winner.seatId].sort())
    assert.deepEqual(layers[0].eligible, [winner.seatId])
    assert.deepEqual(layers[0].awards, { [winner.seatId]: 40 })
    assert.deepEqual(layers[1].contributors, [winner.seatId])
    assert.deepEqual(layers[1].awards, { [winner.seatId]: 80 })
  } finally {
    await closeRoom(fixture?.host)
  }
})

test('HTTP结算：加注者弃牌离场后，未匹配层按权威awards退回出资人', async () => {
  let fixture
  try {
    fixture = await createRoom(['留守房主', '离桌访客'], [500, 500])
    const [host, guest] = fixture.players
    let state = await act(fixture.host, host, fixture.state, 'call')
    state = await act(fixture.host, guest, state, 'raise', 300)
    const left = await api('/api/room/leave', {
      uid: guest.uid,
      roomId: fixture.host.roomId,
      seatId: guest.seatId,
      seatToken: guest.seatToken,
    })
    assert.equal(left.ok, true, left.error)
    const view = await api('/api/room/state', {
      roomId: fixture.host.roomId,
      seatId: host.seatId,
      seatToken: host.seatToken,
    })
    state = view.data
    // 离场者已不在 state.seats 视图中，守恒断言落在 result 层：投入 = 获奖 = 池
    assert.equal(state.finished, true)
    assert.ok(state.result)
    assert.equal(state.result.pot, 320)
    assert.equal(state.pot, 0)
    assert.deepEqual(
      Object.fromEntries(state.result.hands.map((hand) => [hand.uid, hand.totalBet])),
      { [host.seatId]: 20, [guest.seatId]: 300 },
    )
    assert.deepEqual(
      Object.fromEntries(state.result.hands.map((hand) => [hand.uid, hand.won])),
      { [host.seatId]: 40, [guest.seatId]: 280 },
      '离场的加注者必须按权威分配拿回未匹配的 280',
    )
    assert.equal(state.result.winnings.reduce((sum, win) => sum + win.amount, 0), 320)
    assert.equal(
      state.result.hands.reduce((sum, hand) => sum + hand.won - hand.totalBet, 0),
      0,
      '本手净盈亏总和必须为 0',
    )
    const layers = state.result.potLayers.map(summarizeLayer)
    assert.deepEqual(layers.map((layer) => layer.amount), [40, 280])
    assert.deepEqual(layers[1].contributors, [guest.seatId])
    assert.deepEqual(layers[1].eligible, [])
    assert.equal(layers[1].isUncalledReturn, true)
    assert.deepEqual(layers[1].awards, { [guest.seatId]: 280 }, '退回金额必须落在权威 awards 里')
    const guestHand = state.result.hands.find((hand) => hand.uid === guest.seatId)
    assert.equal(guestHand.folded, true)
    assert.deepEqual(guestHand.hole, [])
  } finally {
    await closeRoom(fixture?.host)
  }
})

test('HTTP结算：多人已匹配死钱层归底池胜者，不退弃牌者也不标退款', async () => {
  let fixture
  try {
    fixture = await createRoom(['短码全下', '离桌者', '弃牌者'], [50, 500, 500])
    const [a, b, c] = fixture.players
    let state = await act(fixture.host, a, fixture.state, 'allin')
    state = await act(fixture.host, b, state, 'call')
    state = await act(fixture.host, c, state, 'raise', 100)
    state = await act(fixture.host, b, state, 'call')
    assert.equal(state.phase, 'flop')
    const left = await api('/api/room/leave', {
      uid: b.uid,
      roomId: fixture.host.roomId,
      seatId: b.seatId,
      seatToken: b.seatToken,
    })
    assert.equal(left.ok, true, left.error)
    const view = await api('/api/room/state', {
      roomId: fixture.host.roomId,
      seatId: a.seatId,
      seatToken: a.seatToken,
    })
    assert.equal(view.data.turnUid, c.seatId)
    state = await act(fixture.host, c, view.data, 'fold')

    assert.equal(state.finished, true)
    assert.ok(state.result)
    assert.equal(state.result.pot, 250)
    assert.equal(state.pot, 0)
    assert.deepEqual(
      Object.fromEntries(state.result.hands.map((hand) => [hand.uid, hand.totalBet])),
      { [a.seatId]: 50, [b.seatId]: 100, [c.seatId]: 100 },
    )
    assert.deepEqual(
      Object.fromEntries(state.result.hands.map((hand) => [hand.uid, hand.won])),
      { [a.seatId]: 250, [b.seatId]: 0, [c.seatId]: 0 },
      '死钱层归底池胜者 a，b/c 的已匹配筹码不得退回',
    )
    assert.equal(state.result.winnings.reduce((sum, win) => sum + win.amount, 0), 250)
    assert.equal(
      state.result.hands.reduce((sum, hand) => sum + hand.won - hand.totalBet, 0),
      0,
      '本手净盈亏总和必须为 0',
    )
    const layers = state.result.potLayers.map(summarizeLayer)
    assert.deepEqual(layers.map((layer) => layer.amount), [150, 100])
    assert.deepEqual(layers[0].eligible, [a.seatId])
    assert.deepEqual(layers[0].awards, { [a.seatId]: 150 })
    assert.deepEqual(layers[1].contributors, [b.seatId, c.seatId].sort())
    assert.deepEqual(layers[1].eligible, [])
    assert.equal(layers[1].isUncalledReturn, false, '多出资人层不得标为未匹配退回')
    assert.deepEqual(layers[1].awards, { [a.seatId]: 100 }, '死钱 100 须记为胜者到账而非退款')
    for (const uid of [b.seatId, c.seatId]) {
      const hand = state.result.hands.find((h) => h.uid === uid)
      assert.equal(hand.folded, true)
      assert.deepEqual(hand.hole, [])
    }
  } finally {
    await closeRoom(fixture?.host)
  }
})

test('HTTP结算：零投入唯一存活者接手已匹配死钱，总到账守恒', async () => {
  let fixture
  try {
    fixture = await createRoom(['零投入庄家', '小盲离桌', '大盲离桌', '先弃牌'], [500, 500, 500, 500])
    const [a, b, c, d] = fixture.players
    assert.equal(fixture.state.turnUid, d.seatId, '四人桌首个行动者是 D')
    let state = await act(fixture.host, d, fixture.state, 'fold')
    for (const player of [b, c]) {
      const left = await api('/api/room/leave', {
        uid: player.uid,
        roomId: fixture.host.roomId,
        seatId: player.seatId,
        seatToken: player.seatToken,
      })
      assert.equal(left.ok, true, left.error)
    }
    const view = await api('/api/room/state', {
      roomId: fixture.host.roomId,
      seatId: a.seatId,
      seatToken: a.seatToken,
    })
    state = view.data
    assert.equal(state.finished, true)
    assert.ok(state.result)
    assert.equal(state.result.pot, 30)
    assert.equal(state.pot, 0)
    assert.deepEqual(
      Object.fromEntries(state.result.hands.map((hand) => [hand.uid, hand.totalBet])),
      { [a.seatId]: 0, [b.seatId]: 10, [c.seatId]: 20, [d.seatId]: 0 },
    )
    assert.deepEqual(
      Object.fromEntries(state.result.hands.map((hand) => [hand.uid, hand.won])),
      { [a.seatId]: 20, [b.seatId]: 0, [c.seatId]: 10, [d.seatId]: 0 },
      '死钱 20 归唯一存活者 a，c 未匹配 10 退回，b/d 为 0',
    )
    assert.equal(state.result.winnings.reduce((sum, win) => sum + win.amount, 0), 30)
    assert.equal(
      state.result.hands.reduce((sum, hand) => sum + hand.won - hand.totalBet, 0),
      0,
      '本手净盈亏总和必须为 0',
    )
    const layers = state.result.potLayers.map(summarizeLayer)
    assert.deepEqual(layers.map((layer) => layer.amount), [20, 10])
    assert.deepEqual(layers[0].contributors, [b.seatId, c.seatId].sort())
    assert.deepEqual(layers[0].eligible, [])
    assert.equal(layers[0].isUncalledReturn, false, '多出资人已匹配层不得标为退款')
    assert.deepEqual(layers[0].awards, { [a.seatId]: 20 }, '死钱 20 须记为存活者到账')
    assert.deepEqual(layers[1].contributors, [c.seatId])
    assert.equal(layers[1].isUncalledReturn, true)
    assert.deepEqual(layers[1].awards, { [c.seatId]: 10 }, '未匹配 10 原路退回 c')
  } finally {
    await closeRoom(fixture?.host)
  }
})

test('HTTP AI学习：全押跟注不算加注，盲注不算VPIP，同手VPIP只计一次', async () => {
  let fixture
  try {
    fixture = await createRoom(['学习房主', '学习小盲', '学习大盲'], [180, 180, 1000], { aiObserver: true })
    const [host, smallBlind, bigBlind] = fixture.players
    let state = await act(fixture.host, host, fixture.state, 'call')
    state = await act(fixture.host, smallBlind, state, 'allin')
    state = await act(fixture.host, bigBlind, state, 'fold')
    state = await act(fixture.host, host, state, 'allin')
    assert.equal(state.finished, true)

    const byTarget = fixture.room.aiRuntime.models.get(fixture.observer.uid)
    const hostStats = byTarget.get(host.seatId)
    const smallBlindStats = byTarget.get(smallBlind.seatId)
    const bigBlindStats = byTarget.get(bigBlind.seatId)
    assert.equal(hostStats.calls, 2)
    assert.equal(hostStats.raises, 0)
    assert.equal(hostStats.vpipEnter, 1)
    assert.equal(smallBlindStats.raises, 1)
    assert.equal(smallBlindStats.vpipEnter, 1)
    assert.equal(bigBlindStats.vpipEnter, 0, '自动大盲加上弃牌不能算自愿入池')
  } finally {
    await closeRoom(fixture?.host)
  }
})

test.after(async () => {
  for (const host of [...hosts.values()]) await closeRoom(host)
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
