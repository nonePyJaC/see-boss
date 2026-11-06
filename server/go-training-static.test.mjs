import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-training-static-'))
const staticDir = path.join(temp, 'static')
fs.mkdirSync(path.join(staticDir, 'go-training'), { recursive: true })
fs.writeFileSync(path.join(staticDir, 'index.html'), 'hamster main')
fs.writeFileSync(path.join(staticDir, 'go-training/index.html'), 'go training')
fs.writeFileSync(path.join(staticDir, 'go-training/app.mjs'), 'export const go = true')
process.env.LISTEN = '0'
process.env.HAMSTER_DATA_DIR = path.join(temp, 'data')
process.env.HAMSTER_STATIC_DIR = staticDir
const { server } = await import('./index.js')
const { closeDb } = await import('./db.js')
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
test.after(() => { server.close(); closeDb() })
const base = `http://127.0.0.1:${server.address().port}`

test('围棋子应用独立入口、缓存更新和缺失资源不影响原站点', async () => {
  const redirect = await fetch(base + '/go-training', { redirect: 'manual' })
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.get('location'), '/go-training/')
  const go = await fetch(base + '/go-training/')
  assert.equal(go.status, 200)
  assert.equal(await go.text(), 'go training')
  const module = await fetch(base + '/go-training/app.mjs')
  assert.match(module.headers.get('content-type'), /javascript/)
  assert.equal(module.headers.get('cache-control'), 'no-cache')
  assert.equal((await fetch(base + '/go-training/missing.mjs')).status, 404)
  assert.equal(await (await fetch(base + '/')).text(), 'hamster main')
  assert.equal(await (await fetch(base + '/existing-spa-route')).text(), 'hamster main')
})
