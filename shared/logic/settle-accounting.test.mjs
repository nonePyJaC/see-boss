// 复现线上现象：金瓜子 -2，但明细为空、对方 +2。
//
// 账号表 account_ledger 的列方向：
//   owner = 我, peer = 对方
//   count > 0  对方欠我（我收了对方 count 粒）
//   count < 0  我欠对方（我给了对方 |count| 粒）
//
// 但注意 account_seed_transfer 写入时：
//   付款方（from）那行 count = -amount   ← from 欠 to
//   收款方（to）那行   count = +amount   ← to 收 from
// 所以对 from 来说，他的明细里这一行是 -amount。
//
// 若 from 连输两局给同一个 to，明细应为 -2。但线上显示「没有记录」，
// 唯一的出路是：明细曾经存在过，然后被 DELETE 了。
// account_seed_transfer 末尾那句无条件的
//   DELETE FROM public.account_ledger WHERE count = 0;
// 会清掉所有 count=0 的行，但不该清掉 -2。
// 真正能清掉 -2 的只有 clear_account_ledger_row，它按 peer 删行。

import test from 'node:test'
import assert from 'node:assert/strict'

// ── account_ledger 累加语义（ON CONFLICT 累加）──
function addRow(rows, owner, peer, count) {
  const i = rows.findIndex((r) => r.owner === owner && r.peer === peer)
  const before = i >= 0 ? rows[i].count : 0
  const after = before + count
  if (i >= 0) rows[i].count = after
  else rows.push({ owner, peer, count: after })
  return { before, after }
}

// ── account_seed_transfer 的两行写入 + 末尾无条件 DELETE ──
function transfer(rows, seedMap, from, to, amount) {
  addRow(rows, from, to, -amount)   // 付款方：我欠你 amount
  addRow(rows, to, from, +amount)   // 收款方：你欠我 amount
  seedMap[from] -= amount
  seedMap[to] += amount
  // ⚠️ 线上这句是无条件的：清掉所有归零行，不只本次两方
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].count === 0) rows.splice(i, 1)
  }
}

// ── clear_account_ledger_row（长按某行「和解」）──
function clearRow(rows, seedMap, owner, peer) {
  const row = rows.find((r) => r.owner === owner && r.peer === peer)
  const delta = row ? row.count : null
  if (delta == null) return 0
  // v_delta > 0 表示对方欠我；和解后我放弃这笔债权
  seedMap[owner] -= delta
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if ((r.owner === owner && r.peer === peer) || (r.owner === peer && r.peer === owner)) {
      rows.splice(i, 1)
    }
  }
  return delta
}

test('两局连输给同一人：明细应为 -2，金瓜子应为 -2', () => {
  const rows = []
  const seeds = { host: 0, guest: 0 }
  transfer(rows, seeds, 'guest', 'host', 1)   // 第 1 局：guest 输 host
  transfer(rows, seeds, 'guest', 'host', 1)   // 第 2 局：guest 又输 host
  // 明细：guest 那行 -2
  const guestRow = rows.find((r) => r.owner === 'guest')
  assert.equal(guestRow.count, -2)
  // 金瓜子也是 -2
  assert.equal(seeds.guest, -2)
  // 这一致，所以不是本 bug
})

test('长按「清空」后：金瓜子留下 -2、明细消失 —— 与截图完全相符', () => {
  const rows = []
  const seeds = { guest: 0, host: 0 }
  transfer(rows, seeds, 'guest', 'host', 2)   // guest 一次输 2 粒
  assert.equal(seeds.guest, -2)
  assert.equal(rows.find((r) => r.owner === 'guest').count, -2)

  // guest 长按房主那行 → 清空
  const cleared = clearRow(rows, seeds, 'guest', 'host')
  // 清掉了 2
  assert.equal(cleared, -2)
  // guest 的金种子 = -2 - (-2) = 0 ✓ 正常
  assert.equal(seeds.guest, 0)
  // 但 host 那侧：host 的明细行被 DELETE，host 的 golden_seeds 仍是 +2 ❌
  assert.equal(rows.find((r) => r.owner === 'host'), undefined)
  assert.equal(seeds.host, 2)
  // 于是：host 有 +2 金瓜子但看不到任何明细 —— 正是你看到的现象（对侧版）
})

test('和解是单向的：只改发起方金瓜子，不对等冲销对方', () => {
  const rows = []
  const seeds = { host: 0, guest: 0 }
  transfer(rows, seeds, 'guest', 'host', 2)
  clearRow(rows, seeds, 'guest', 'host')
  // 双方金瓜子之和不再为 0，账本出现了净损益
  assert.equal(seeds.guest + seeds.host, 2)
})

test('无条件 DELETE count=0 会清掉无关账号的归零行', () => {
  const rows = [
    { owner: 'host', peer: 'guest', count: 0 },      // 不相关的已结清行
    { owner: 'guest', peer: 'host', count: -2 },
    { owner: 'x', peer: 'y', count: 0 },
  ]
  const seeds = { host: 0, guest: 0, x: 0, y: 0 }
  transfer(rows, seeds, 'guest', 'host', 1)
  // 两个无关归零行都被清了 —— 侧边影响，但不影响本次双方
  assert.equal(rows.filter((r) => r.count === 0).length, 0)
})
