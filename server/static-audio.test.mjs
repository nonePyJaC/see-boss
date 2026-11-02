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

test('iOS 音频分段请求返回正确的数据和响应头', async () => {
  const url = `http://127.0.0.1:${server.address().port}/stone.wav`
  for (const [range, expected, contentRange] of [
    ['bytes=0-1', 'RI', 'bytes 0-1/9'],
    ['bytes=5-', 'test', 'bytes 5-8/9'],
    ['bytes=-4', 'test', 'bytes 5-8/9'],
    ['bytes=7-99', 'st', 'bytes 7-8/9'],
  ]) {
    const r = await fetch(url, { headers: { range } })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('accept-ranges'), 'bytes')
    assert.equal(r.headers.get('content-range'), contentRange)
    assert.equal(Number(r.headers.get('content-length')), expected.length)
    assert.equal(await r.text(), expected)
  }
  for (const range of ['bytes=100-', 'bytes=4-2', 'bytes=-0']) {
    const r = await fetch(url, { headers: { range } })
    assert.equal(r.status, 416)
    assert.equal(r.headers.get('content-range'), 'bytes */9')
  }
  const full = await fetch(url)
  assert.equal(full.headers.get('content-length'), '9')
  assert.equal(await full.text(), 'RIFF test')
  const head = await fetch(url, { method: 'HEAD', headers: { range: 'bytes=0-1' } })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), '9')
})
