import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-audio-test-'))
const staticDir = path.join(temp, 'static')
fs.mkdirSync(staticDir)
fs.writeFileSync(path.join(staticDir, 'stone.wav'), Buffer.from('RIFF test'))
process.env.LISTEN = '0'
process.env.HAMSTER_DATA_DIR = path.join(temp, 'data')
process.env.HAMSTER_STATIC_DIR = staticDir
const { server } = await import('./index.js')
const { closeDb } = await import('./db.js')
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
test.after(() => { server.close(); closeDb() })
test('静态 WAV 音效以音频类型提供', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/stone.wav`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'audio/wav')
  assert.equal(await response.text(), 'RIFF test')
})
