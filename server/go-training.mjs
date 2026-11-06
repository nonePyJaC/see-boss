import crypto from 'node:crypto'
import { getDb } from './db.js'
const MAX = 8 * 1024 * 1024
const limits = new Map()
let schemaDb
function db() {
  const d = getDb()
  if (schemaDb !== d) {
    d.exec(`CREATE TABLE IF NOT EXISTS go_training_progress (
      token_hash TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    schemaDb = d
  }
  return d
}
function validState(s) {
  if (!s || s.schema !== 1 || !Number.isInteger(s.book) || s.book < 0 || s.book > 7 || !Array.isArray(s.profiles) || s.profiles.length !== 8) return false
  for (const p of s.profiles) {
    if (!p || typeof p.name !== 'string' || p.name.length > 30 || !Number.isInteger(p.lastId) || p.lastId < 0 || p.lastId >= 6124 || !p.results || typeof p.results !== 'object' || Array.isArray(p.results)) return false
    const entries = Object.entries(p.results)
    if (entries.length > 6124) return false
    for (const [id, r] of entries) if (!/^\d+$/.test(id) || +id >= 6124 || !r || typeof r !== 'object' || ['tries', 'correct', 'wrong'].some(k => !Number.isSafeInteger(r[k]) || r[k] < 0)) return false
    if (!Array.isArray(p.history) || p.history.length > 10000 || !Array.isArray(p.certificates) || p.certificates.length > 10000) return false
  }
  return true
}
function allowed(key, max, window) {
  const now = Date.now(); let bucket = limits.get(key)
  if (!bucket && limits.size >= 4096) { for (const [k,v] of limits) if (v.until < now) limits.delete(k); if (limits.size >= 4096) return false }
  if (!bucket || bucket.until < now) { bucket = { count: 0, until: now + window }; limits.set(key, bucket) }
  if (limits.size > 2048) for (const [k, v] of limits) if (v.until < now) limits.delete(k)
  return ++bucket.count <= max
}
export async function handleGoTraining(req, res) {
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)) }
  if (req.method !== 'POST') return send(405, { error: '仅支持 POST' })
  const ip = req.socket.remoteAddress || 'unknown'
  if (!allowed('request:' + ip, 180, 60000)) return send(429, { error: '同步请求过于频繁，请稍后再试。' })
  let body
  try {
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > MAX) return send(413, { error: '进度超过 8MiB，请先导出备份。' }); chunks.push(chunk) }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch { return send(400, { error: '同步数据格式无效。' }) }
  if (!body || typeof body !== 'object' || !/^[a-f0-9]{48}$/.test(body.token || '')) return send(400, { error: '同步码格式不正确。' })
  const hash = crypto.createHash('sha256').update(body.token).digest('hex')
  try {
    const d = db()
    if (body.operation === 'create') {
      if (!validState(body.state)) return send(400, { error: '进度格式不正确。' })
      if (!allowed('create:' + ip, 6, 3600000)) return send(429, { error: '同步码创建次数过多，请稍后再试。' })
      if (d.prepare('SELECT count(*) AS n FROM go_training_progress').get().n >= 64) return send(503, { error: '服务器暂不接受新的同步码，请使用已有同步码或导出进度。' })
      d.prepare('INSERT INTO go_training_progress (token_hash,state) VALUES (?,?)').run(hash, JSON.stringify(body.state))
      return send(201, { version: 1 })
    }
    const row = d.prepare('SELECT version,state,updated_at FROM go_training_progress WHERE token_hash=?').get(hash)
    if (!row) return send(404, { error: '找不到这份进度，请核对同步码。' })
    if (body.operation === 'load') return send(200, { version: row.version, state: JSON.parse(row.state), updatedAt: row.updated_at })
    if (body.operation !== 'save') return send(400, { error: '未知同步操作。' })
    if (!validState(body.state) || !Number.isSafeInteger(body.version) || body.version < 1) return send(400, { error: '进度或版本无效。' })
    if (body.version !== row.version) return send(409, { error: '另一台设备已更新进度。', version: row.version, state: JSON.parse(row.state) })
    const result = d.prepare(`UPDATE go_training_progress SET state=?,version=version+1,updated_at=datetime('now') WHERE token_hash=? AND version=?`).run(JSON.stringify(body.state), hash, body.version)
    if (!result.changes) return send(409, { error: '另一台设备已更新进度，请重新同步。' })
    return send(200, { version: row.version + 1 })
  } catch { return send(500, { error: '服务器暂时未能保存，进度仍保留在本机。' }) }
}
