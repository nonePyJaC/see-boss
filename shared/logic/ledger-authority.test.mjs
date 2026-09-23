// 复现「金瓜子数字对不上」的口径 bug。
// 线上现象：房主显示 -2，房客显示 +2，房客视角房主是 0、房主视角房客是 +2。
//
// 根因不是数据库转了两次，而是前端把两套口径混用：
//   accounts.golden_seeds   权威总数（服务端 offline_settle 改这个）
//   account_ledger          往来明细（ON CONFLICT 累加，清零过的行被 DELETE）
// 旧 applyLedgerRows 把明细求和后覆盖 goldenSeeds，
// 一旦明细与总数口径不一致，界面数字就开始编故事。

import test from 'node:test'
import assert from 'node:assert/strict'

// 与 client/src/stores/user.js 中 applyLedgerRows 相同的纯逻辑副本。
// 改文件时这里要同步（测试就是为了钉住这个语义）。
function applyLedgerRowsOld(rows, user) {
  const next = {}
  for (const r of rows) {
    const key = r.peerUid ?? r.peer ?? r.peerAccount
    if (!key) return { ledger: null, user }        // ← 旧版：整表放弃
    next[key] = { nickname: r.peerName, avatar: r.peerAvatar ?? 1, count: r.count }
  }
  const total = Object.values(next).reduce((s, v) => s + v.count, 0)
  return { ledger: next, user: { ...user, goldenSeeds: total } }  // ← 旧版：覆盖
}

function applyLedgerRowsNew(rows, user) {
  const next = {}
  for (const r of rows) {
    const key = r.peerUid ?? r.peer ?? r.peerAccount ?? r.peer_uid
    if (!key) continue                             // ← 新版：跳过坏行
    next[key] = { nickname: r.peerName ?? String(key), avatar: r.peerAvatar ?? 1, count: r.count }
  }
  return { ledger: next, user }                    // ← 新版：不覆盖权威值
}

const user = { account: 'paytest', goldenSeeds: 0 }

test('旧逻辑：账本明细会把权威金瓜子覆盖掉', () => {
  // 房客账本：赢房主 2 粒（可能来自两局，或一局 + 一行历史残留）
  const rows = [{ peerUid: 'host', peerName: '房主', peerAvatar: 1, count: 2 }]
  const r = applyLedgerRowsOld(rows, user)
  // 旧版算出 2，与 accounts.golden_seeds=0 相冲 → 房客界面显示 +2
  assert.equal(r.user.goldenSeeds, 2)
  assert.notEqual(r.user.goldenSeeds, user.goldenSeeds)
})

test('新逻辑：账本不覆盖权威金瓜子', () => {
  const rows = [{ peerUid: 'host', peerName: '房主', peerAvatar: 1, count: 2 }]
  const r = applyLedgerRowsNew(rows, user)
  // 权威值仍是 my_account() 给的 0，明细另有其位
  assert.equal(r.user.goldenSeeds, 0)
  assert.deepEqual(r.ledger.host.count, 2)
})

test('旧逻辑：任一行缺 peer 就整表放弃，本地停在旧值', () => {
  const rows = [
    { peerUid: 'host', peerName: '房主', peerAvatar: 1, count: -1 },
    { peerName: '坏行', count: 5 },      // 缺 key
    { peerUid: 'other', peerName: '小李', peerAvatar: 2, count: 3 },
  ]
  const r = applyLedgerRowsOld(rows, user)
  // ledger 为 null 即「压根没赋值」，调用方界面不刷新
  assert.equal(r.ledger, null)
})

test('新逻辑：坏行被跳过，好行仍能显示', () => {
  const rows = [
    { peerUid: 'host', peerName: '房主', peerAvatar: 1, count: -1 },
    { peerName: '坏行', count: 5 },
    { peerUid: 'other', peerName: '小李', peerAvatar: 2, count: 3 },
  ]
  const r = applyLedgerRowsNew(rows, user)
  assert.deepEqual(Object.keys(r.ledger), ['host', 'other'])
  assert.equal(r.ledger.other.count, 3)
})

test('两套口径分家的场景下数字才能自洽', () => {
  // 服务端权威 0，账本明细 +2（清零过的另一行已被 DELETE，所以明细求和不等于总数）
  const serverGoldenSeeds = 0
  const rows = [{ peerUid: 'host', peerName: '房主', peerAvatar: 1, count: 2 }]
  const r = applyLedgerRowsNew(rows, { ...user, goldenSeeds: serverGoldenSeeds })
  // 界面取权威值
  assert.equal(r.user.goldenSeeds, serverGoldenSeeds)
  // 明细单独展示
  const detailSum = Object.values(r.ledger).reduce((s, v) => s + v.count, 0)
  assert.equal(detailSum, 2)
  // 两者不相等是正常的，因为口径不同；关键是界面只用权威值
  assert.notEqual(detailSum, r.user.goldenSeeds)
})
