/**
 * 逻辑层 dev server —— 本地验证游戏逻辑的 HTTP 入口
 *
 * 用途：在数据层（PostgreSQL / 云函数）确定前，先用这个跑通「逻辑 → 状态」闭环，
 *       同时作为后续迁移到云函数时的接口蓝本。
 *
 * 端点：
 *   GET  /health          健康检查
 *   POST /api/hand/new    新建一局 {players, smallBlind, bigBlind, gameType, deck?}
 *   POST /api/hand/act    行动   {state, uid, type, amount}
 *   POST /api/hand/deal   发底牌 {state}
 *   POST /api/hand/show   摊牌   {state, holeCards}
 */

import { createServer } from 'node:http'
import {
  initHand,
  dealHoleCards,
  applyAction,
  availableActions,
  showdown,
} from './betting.mjs'
import { createShuffledDeck } from './cards.mjs'

const PORT = Number(process.env.LOGIC_PORT || 8787)

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

const server = createServer(async (req, res) => {
  // 预检
  if (req.method === 'OPTIONS') return json(res, 204, {})

  const url = new URL(req.url, `http://localhost:${PORT}`)

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, uptime: process.uptime() })
    }

    if (req.method === 'POST' && url.pathname === '/api/hand/new') {
      const body = await readBody(req)
      const state = initHand({
        players: body.players,
        smallBlind: body.smallBlind ?? 10,
        bigBlind: body.bigBlind ?? 20,
        gameType: body.gameType ?? 'long',
        dealerUid: body.dealerUid ?? null,
        roundNo: body.roundNo ?? 1,
        deck: body.deck ?? createShuffledDeck(body.gameType ?? 'long'),
      })
      return json(res, 200, { state })
    }

    if (req.method === 'POST' && url.pathname === '/api/hand/act') {
      const body = await readBody(req)
      const r = applyAction(body.state, { uid: body.uid, type: body.type, amount: body.amount })
      if (r.error) return json(res, 400, { error: r.error })
      return json(res, 200, {
        state: r.state,
        actions: r.state.turnUid ? availableActions(r.state, r.state.turnUid) : [],
        finished: r.state.finished,
      })
    }

    if (req.method === 'POST' && url.pathname === '/api/hand/deal') {
      const body = await readBody(req)
      // 注意：底牌是私密数据，真实环境应由服务端单独下发，绝不进广播
      return json(res, 200, { holeCards: dealHoleCards(body.state) })
    }

    if (req.method === 'POST' && url.pathname === '/api/hand/show') {
      const body = await readBody(req)
      const winnings = showdown(body.state, body.holeCards)
      return json(res, 200, { winnings })
    }

    return json(res, 404, { error: 'not found' })
  } catch (err) {
    return json(res, 500, { error: String(err?.message ?? err) })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[logic] dev server listening on http://localhost:${PORT}`)
})
