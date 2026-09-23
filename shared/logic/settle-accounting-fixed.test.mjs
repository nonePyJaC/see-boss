// 修复后的行为测试 —— 对应 db/fix-ledger-accounting.sql
// 这些用例在旧代码下会失败，用来证明补丁真的改变了结果。

import test from 'node:test'
import assert from 'node:assert/strict'
import { transferFixed, clearFixed } from './_ledger-model-fixed.mjs'

test('修复：结算后金瓜子与明细永远一致', () => {
  const rows = []
  const seeds = { host: 0, guest: 0 }
  transferFixed(rows, seeds, 'guest', 'host', 1)
  transferFixed(rows, seeds, 'guest', 'host', 1)
  // guest 侧：数字 -2、明细 -2
  assert.equal(seeds.guest, -2)
  assert.equal(rows.find((r) => r.owner === 'guest').count, -2)
  // host 侧：数字 +2、明细 +2
  assert.equal(seeds.host, 2)
  assert.equal(rows.find((r) => r.owner === 'host').count, 2)
})

test('修复：长按清空后双方都归零，明细也清空', () => {
  const rows = []
  const seeds = { host: 0, guest: 0 }
  transferFixed(rows, seeds, 'guest', 'host', 2)

  clearFixed(rows, seeds, 'guest', 'host')

  // 双方都归零 —— 不再出现「对方有数字、没明细」
  assert.equal(seeds.guest, 0)
  assert.equal(seeds.host, 0)
  // 明细也清空
  assert.equal(rows.filter((r) => r.owner === 'guest' || r.owner === 'host').length, 0)
})

test('修复：和解后双方之和守恒', () => {
  const rows = []
  const seeds = { host: 0, guest: 0 }
  transferFixed(rows, seeds, 'guest', 'host', 2)
  const sumBefore = seeds.guest + seeds.host
  clearFixed(rows, seeds, 'guest', 'host')
  const sumAfter = seeds.guest + seeds.host
  assert.equal(sumAfter, sumBefore)
})

test('修复：不再误删其他账号的归零行', () => {
  const rows = [
    { owner: 'a', peer: 'b', count: 0 },          // 别的账号之间已结清
    { owner: 'guest', peer: 'host', count: -1 },  // 本次两方
  ]
  const seeds = { a: 0, b: 0, guest: 0, host: 0 }
  transferFixed(rows, seeds, 'guest', 'host', 1)
  // a-b 那行与本次无关，必须保留
  assert.ok(rows.find((r) => r.owner === 'a' && r.peer === 'b'))
})

test('修复：一键清空全部数据后可以从头再来，不残留旧数', () => {
  const rows = []
  const seeds = { host: 0, guest: 0 }
  transferFixed(rows, seeds, 'guest', 'host', 3)
  clearFixed(rows, seeds, 'guest', 'host')
  // 再来一局
  transferFixed(rows, seeds, 'host', 'guest', 1)
  assert.equal(seeds.host, -1)
  assert.equal(seeds.guest, 1)
  assert.equal(rows.find((r) => r.owner === 'guest').count, 1)
})
