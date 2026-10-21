import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeDecisionReview } from './decision-review.mjs'

function record(at = '2026-10-21T08:30:00Z') {
  return { at, trace: { room: '123456', hand: 2, turn: 25, seat: 'ai-test', phase: 'flop', model: 'deepseek',
    seatToken: 'SECRET_TOKEN' },
  input: { model: 'deepseek-chat', messages: [{ role: 'system', content: '固定规则' }, { role: 'user', content: '最新输入' }],
    temperature: 0.7, max_tokens: 200, Authorization: 'SECRET_KEY' },
  result: { action: { type: 'call' }, reason: '成本合适，选择跟注',
    usage: { promptTokens: 1000, cacheHitTokens: 0, cacheMissTokens: 1000, secret: 'SECRET_USAGE' },
    reasoning_content: 'RAW_REASONING', userKeys: { deepseek: 'SECRET_KEY' } },
  execution: { status: 'applied', source: 'llm', action: 'call', paidAmount: 60, betTotal: 120 } }
}

test('私有文件字段白名单及权限；缺失计量仍为未知', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-test-'))
  try {
    assert.equal(writeDecisionReview(dir, record()), true)
    const file = path.join(dir, 'ai-reviews', '2026-10-21.jsonl')
    const body = fs.readFileSync(file, 'utf8')
    const r = JSON.parse(body)
    assert.equal(r.output.briefReason, '成本合适，选择跟注')
    assert.equal(r.usage.cacheHitTokens, 0)
    assert.equal(r.usage.completionTokens, null)
    assert.ok(!body.match(/SECRET_|RAW_REASONING|Authorization|seatToken|userKeys/))
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('复盘文件保留最近7个日期，超出16MiB轮换，其他文件不删除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-test-'))
  try {
    writeDecisionReview(dir, record('2026-10-13T08:30:00Z'))
    const reviews = path.join(dir, 'ai-reviews')
    fs.writeFileSync(path.join(reviews, 'keep.txt'), 'keep')
    writeDecisionReview(dir, record())
    assert.ok(!fs.existsSync(path.join(reviews, '2026-10-13.jsonl')))
    assert.equal(fs.readFileSync(path.join(reviews, 'keep.txt'), 'utf8'), 'keep')
    const file = path.join(reviews, '2026-10-21.jsonl')
    fs.truncateSync(file, 16 * 1024 * 1024)
    assert.equal(writeDecisionReview(dir, record()), true)
    assert.equal(fs.statSync(file + '.1').size, 16 * 1024 * 1024)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).turn, 25)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('写入失败/超大输入不抛异常，也不影响决策', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-test-'))
  try {
    const blocked = path.join(dir, 'file')
    fs.writeFileSync(blocked, 'occupied')
    assert.equal(writeDecisionReview(blocked, record()), false)
    const tooLarge = record()
    tooLarge.input.messages[1].content = 'x'.repeat(600 * 1024)
    assert.equal(writeDecisionReview(dir, tooLarge), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
