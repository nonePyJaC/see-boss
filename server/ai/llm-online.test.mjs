import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 真账号/HTTP/房间/引擎，仅替换外部模型；绝不消耗真实 Key。
process.env.LISTEN = '0'
process.env.HAMSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-online-'))
process.env.HAMSTER_ONLINE_CREATE_CODE = '111111'
process.env.DEEPSEEK_API_KEY = ''
process.env.STEPFUN_API_KEY = ''
const { server, rooms, onAiTurn, setAiDelayRange } = await import('../index.js')
const { closeDb } = await import('../db.js')
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
setAiDelayRange(600000, 600000)
const realFetch = globalThis.fetch
const realInfo = console.info
let requests = []
let audit = []
console.info = (...items) => audit.push(items.join(' '))
let respond
let seq = 0
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith(base)) return realFetch(url, opts)
  assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
  assert.equal(opts.headers.Authorization, 'Bearer test-only-key')
  const body = JSON.parse(opts.body)
  requests.push({ body, signal: opts.signal })
  return respond(body, opts)
}
const reply = (decision) => Response.json({ choices: [{ message: { content: JSON.stringify(decision) } }] })
const passive = (body) => reply({ action: body.messages[0].content.includes('还需补') ? 'call' : 'check' })

async function api(route, body) {
  const res = await fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const json = await res.json()
  assert.equal(json.ok, true, `${route}: ${json.error}`)
  return json.data
}

async function fixture(aiCount = 2) {
  const n = ++seq
  const uid = `llm-test-${n}`
  await api('/api/account/register', { uid, account: `llmtest${n}`, nickname: `测模型${n}` })
  await api('/api/llm/keys', { uid, deepseekKey: 'test-only-key' })
  const created = await api('/api/room/create', {
    uid, createCode: '111111', me: { nickname: `测模型${n}` },
    cfg: { mode: 'online', gameType: 'long', initialSeeds: 3200, smallBlind: 10, bigBlind: 20,
      useLLM: true, llmModel: 'deepseek' },
  })
  const host = { uid, roomId: created.id, seatId: created.seatId, seatToken: created.seatToken }
  for (let i = 0; i < aiCount; i++) await api('/api/room/add-ai', host)
  const room = rooms.get(host.roomId)
  // 三人局翻前房主先动；弃牌后由两名 AI 打完。
  await api('/api/room/start', host)
  if (room.state.turnUid === host.seatId) {
    await api('/api/room/action', { ...host, handId: room.handId, turnSeq: room.turnSeq, type: 'fold' })
  }
  return { room, host }
}

function captured(room) {
  return { roomId: room.id, handId: room.handId, turnSeq: room.turnSeq, turnSeatId: room.state.turnUid }
}

test.beforeEach(() => { requests = []; audit = []; respond = passive })
test.afterEach(async () => {
  for (const room of rooms.values()) {
    const host = room.seats.find((s) => s.uid === room.hostUid)
    await api('/api/room/leave', { uid: host.accountUid, roomId: room.id, seatId: host.uid, seatToken: host.seatToken })
  }
})
test.after(async () => {
  globalThis.fetch = realFetch
  console.info = realInfo
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(process.env.HAMSTER_DATA_DIR, { recursive: true, force: true })
})

test('在线房主配置的账号 Key 真正发送模型输入，并应用模型输出', async () => {
  const { room, host } = await fixture()
  assert.notEqual(room.hostUid, host.uid)
  respond = () => reply({ action: 'raise', amount: 80 })
  const before = captured(room)
  for (const [uid, cards] of Object.entries(room.hands)) {
    if (uid !== before.turnSeatId) cards.splice(0, 2, 'PRIVATE_OPPONENT_1', 'PRIVATE_OPPONENT_2')
  }
  await onAiTurn(before)
  assert.equal(requests.length, 1, '必须请求外部模型，不能静默走本地策略')
  assert.equal(requests[0].body.model, 'deepseek-chat')
  const prompt = requests[0].body.messages[0].content
  assert.match(prompt, /raise（加注到 40 ~ 3200）/)
  assert.ok(!prompt.includes('PRIVATE_OPPONENT'))
  assert.equal(room.state.actionLog.at(-1).betTotal, 80)
  assert.equal(room.state.actionLog.at(-1).uid, before.turnSeatId)
  assert.equal(room.aiStats.llmUsed, 1)
  assert.ok(audit.some((line) => line.startsWith('[ai] llm_request ')))
  assert.ok(audit.some((line) => line.includes('"status":"ok"')))
  assert.ok(audit.some((line) => line.includes('"source":"llm"') && line.includes('"applied":true')))
  assert.ok(!audit.join('\n').match(/test-only-key|PRIVATE_OPPONENT|【我的底牌】|"reason"/))
})

test('河牌输入保留整手超过 20 条动作、四轮街名及真实加注总额', async () => {
  const { room } = await fixture()
  let count = 0
  const streetTurns = new Map()
  respond = (body) => {
    const phase = room.state.phase
    const n = streetTurns.get(phase) ?? 0
    streetTurns.set(phase, n + 1)
    return n < 6 ? reply({ action: 'raise', amount: room.state.currentBet + room.state.minRaise }) : passive(body)
  }
  while (room.state.phase !== 'river' && !room.state.finished && count++ < 40) await onAiTurn(captured(room))
  assert.equal(room.state.phase, 'river')
  const history = structuredClone(room.state.actionLog)
  assert.ok(history.length > 20)
  respond = () => reply({ action: 'raise', amount: 60 })
  await onAiTurn(captured(room))
  history.push(structuredClone(room.state.actionLog.at(-1)))
  respond = passive
  await onAiTurn(captured(room))
  const prompt = requests.at(-1).body.messages[0].content
  const historyText = prompt.split('【本手已发生的行动】')[1].split('【你可以做的动作】')[0]
  assert.equal((historyText.match(/^\s+\d+\./gm) ?? []).length, history.length)
  for (const label of ['翻牌前', '翻牌圈', '转牌圈', '河牌圈']) assert.ok(historyText.includes(label), label)
  for (const a of history.filter((a) => a.type === 'raise')) assert.ok(historyText.includes(`加注到 ${a.betTotal}`))
})

test('模型失败或返回非法加注时安全降级，并区分请求数和采用数', async () => {
  const { room } = await fixture()
  respond = () => new Response('', { status: 429 })
  let before = room.turnSeq
  await onAiTurn(captured(room))
  assert.equal(room.turnSeq, before + 1)
  assert.equal(room.aiStats.llmAttempts, 1)
  assert.equal(room.aiStats.llmFails, 1)
  assert.equal(room.aiStats.llmUsed, 0)
  respond = () => reply({ action: 'raise', amount: 1 })
  before = room.turnSeq
  await onAiTurn(captured(room))
  assert.equal(room.turnSeq, before + 1)
  assert.equal(room.aiStats.llmAttempts, 2)
  assert.equal(room.aiStats.llmUsed, 0)
  assert.equal(room.aiStats.degraded, 2)
})

test('逐次请求动态更新：翻牌携带翻前全员动作，后续各轮累积历史，下一手重新开始', async () => {
  const { room, host } = await fixture()
  const frames = []
  const phaseNames = { preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈' }
  const phaseTurns = new Map()
  respond = (body) => {
    const st = room.state
    const prompt = body.messages[0].content
    const historyText = prompt.split('【本手已发生的行动】')[1].split('【你可以做的动作】')[0]
    const lines = historyText.split('\n').filter((line) => /^\s+\d+\./.test(line))
    // 对每一次真正发给模型的内容校验，而不只看最后一份河牌提示词。
    assert.match(prompt, new RegExp('【当前阶段】' + phaseNames[st.phase]))
    assert.ok(prompt.includes('【公共池】' + st.pot + '\n'))
    assert.equal(lines.length, st.actionLog.length)
    for (const [i, action] of st.actionLog.entries()) {
      const who = action.uid === st.turnUid ? '我' : action.nickname
      assert.ok(lines[i].startsWith(`  ${i + 1}. ${who} `))
      assert.ok(lines[i].includes(`[${phaseNames[action.phase]}`))
      if (action.type === 'raise' || action.type === 'bet') {
        assert.ok(lines[i].includes(`到 ${action.betTotal}（本次投入 ${action.amount}）`))
      }
    }
    frames.push({ handId: room.handId, phase: st.phase, prompt,
      history: structuredClone(st.actionLog), board: [...st.communityCards] })
    const key = `${room.handId}:${st.phase}`
    const n = phaseTurns.get(key) ?? 0
    phaseTurns.set(key, n + 1)
    return n === 0 ? reply({ action: 'raise', amount: 60 }) : passive(body)
  }
  const firstHandId = room.handId
  for (let i = 0; i < 16 && !room.state.finished; i++) await onAiTurn(captured(room))
  assert.equal(room.state.finished, true)
  assert.deepEqual([...new Set(frames.map((frame) => frame.phase))], ['preflop', 'flop', 'turn', 'river'])
  let earlier = []
  for (const [phase, cardCount] of [['preflop', 0], ['flop', 3], ['turn', 4], ['river', 5]]) {
    const frame = frames.find((item) => item.phase === phase)
    assert.equal(frame.board.length, cardCount)
    assert.deepEqual(frame.history.slice(0, earlier.length), earlier, `${phase} 应保留前序完整历史`)
    earlier = frame.history
  }
  assert.notEqual(frames[0].prompt, frames.find((frame) => frame.phase === 'flop').prompt)
  const preflopFrames = frames.filter((frame) => frame.phase === 'preflop')
  assert.ok(preflopFrames[1].history.length > preflopFrames[0].history.length, '同一轮内下一次决策也包含刚发生的动作')
  await api('/api/room/start', host)
  assert.equal(room.handId, firstHandId + 1)
  await onAiTurn(captured(room))
  const nextHand = frames.at(-1)
  assert.equal(nextHand.handId, room.handId)
  assert.equal(nextHand.phase, 'preflop')
  assert.equal(nextHand.board.length, 0)
  assert.deepEqual(nextHand.history.map((action) => action.type), ['blind', 'blind'])
  assert.ok(!nextHand.history.some((action) => action.phase !== 'preflop'))
})

test('关闭大模型或缺少对应 Key 不发送请求；缺 Key 的回退可观测', async () => {
  const first = await fixture()
  first.room.useLLM = false
  await onAiTurn(captured(first.room))
  assert.equal(requests.length, 0)
  await api('/api/room/leave', first.host)
  const { room, host } = await fixture()
  await api('/api/llm/keys', { uid: host.uid, deepseekKey: '' })
  room.useLLM = true
  await onAiTurn(captured(room))
  assert.equal(requests.length, 0)
  assert.equal(room.aiStats.llmSkipped, 1)
})

test('同一回合并发回调只请求一次，过期回复不执行', async () => {
  const { room } = await fixture()
  let release
  respond = () => new Promise((resolve) => { release = resolve })
  const turn = captured(room)
  const pending = onAiTurn(turn)
  assert.equal(requests.length, 1)
  await onAiTurn(turn)
  assert.equal(requests.length, 1)
  // 即使同一座位再次轮到，也不能使用旧 turnSeq 的结果。
  room.turnSeq += 2
  const before = room.state.actionLog.length
  release(reply({ action: 'raise', amount: 200 }))
  await pending
  assert.equal(room.state.actionLog.length, before)
  assert.equal(room.aiStats.decisions, 0)
})

test('弃牌/全下/失格/非本手/非当前行动者不生成模型请求', async () => {
  const { room } = await fixture()
  const turn = captured(room)
  const seat = room.state.seats.find((s) => s.uid === turn.turnSeatId)
  for (const field of ['folded', 'allIn']) {
    seat[field] = true
    await onAiTurn(turn)
    seat[field] = false
  }
  room.inactiveThisHand.add(turn.turnSeatId)
  await onAiTurn(turn)
  room.inactiveThisHand.clear()
  room.handParticipants.delete(turn.turnSeatId)
  await onAiTurn(turn)
  room.handParticipants.add(turn.turnSeatId)
  await onAiTurn({ ...turn, turnSeatId: room.hostUid })
  assert.equal(requests.length, 0)
})

test('房主退出会取消进行中的模型请求，迟到回复不修改房间', async () => {
  const { room, host } = await fixture()
  let release
  respond = () => new Promise((resolve) => { release = resolve })
  const pending = onAiTurn(captured(room))
  assert.equal(requests.length, 1)
  const length = room.state.actionLog.length
  await api('/api/room/leave', host)
  assert.equal(requests[0].signal.aborted, true)
  release(reply({ action: 'raise', amount: 80 }))
  await pending
  assert.equal(room.state.actionLog.length, length)
  assert.equal(room.aiStats.decisions, 0)
})

test('两名 AI 河牌连续投入120是累计加注；最后跟平立即摊牌，无下一次模型调用', async () => {
  const { room } = await fixture()
  let count = 0
  while (room.state.phase !== 'river' && !room.state.finished && count++ < 20) await onAiTurn(captured(room))
  assert.equal(room.state.phase, 'river')
  for (const amount of [60, 120, 180, 240]) {
    respond = () => reply({ action: 'raise', amount })
    await onAiTurn(captured(room))
    assert.equal(room.state.finished, false)
    assert.equal(room.state.currentBet, amount)
  }
  assert.deepEqual(room.state.actionLog.slice(-3).map((a) => [a.type, a.amount, a.betTotal]),
    [['raise', 120, 120], ['raise', 120, 180], ['raise', 120, 240]])
  const lastTurn = captured(room)
  respond = () => reply({ action: 'call' })
  await onAiTurn(lastTurn)
  assert.equal(room.state.finished, true)
  assert.equal(room.state.phase, 'showdown')
  assert.equal(room.state.turnUid, null)
  assert.equal(room.aiTimer, null)
  assert.ok(room.state.result)
  const calls = requests.length
  await onAiTurn(lastTurn)
  await onAiTurn(captured(room))
  assert.equal(requests.length, calls)
})
