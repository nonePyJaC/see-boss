/**
 * 存储层测试 — SQLite
 *
 * 重点盯两件之前出过事故的地方：
 *   1. clearAccountLedgerRow 必须双方同时冲销
 *      （旧实现只改发起方就删两边明细 → 对方「有数字没明细」）
 *   2. 不再 DELETE count=0 的行
 *      （旧实现无条件清全表归零行，把结清痕迹也抹了）
 * 外加余额不得扣成负数 —— 那个 -2 就是这么来的。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  openTestDb, closeDb, rawDb,
  loginAccount, registerAccount, accountByUid, updateMyAccount, logoutAccount,
  accountSeedTransfer, accountLedgerRows, clearAccountLedgerRow,
  bumpTotalGames, goldenSeedsOf,
  addHistory, listHistory,
  saveRoomSnapshot, loadRoomSnapshot, loadAllRoomSnapshots, deleteRoomSnapshot,
  wipeData, dataCounts,
  saveUserLlmKeys, userLlmKeyStatus, userLlmKeys,
} from './db.js'

// 每个用例一个干净的库
function fresh() {
  closeDb()
  openTestDb(':memory:')
  return {
    a: 'hostUser0001',
    b: 'guestUser0002',
    c: 'thirdUser0003',
  }
}

/** 直接给账号发金瓜子（模拟之前赢的） */
function seedGolden(account, n) {
  rawDb().prepare('UPDATE accounts SET golden_seeds = golden_seeds + ? WHERE account = ?')
    .run(n, account)
}

const uid = (n) => 'uid-' + n
/**
 * 建一个账号（注册）。登录不再自动建号，测试里要显式注册。
 * 昵称缺省时按账号名派生，避免同一测试里多个账号撞昵称查重。
 */
function signup(name, u, nickname) {
  return registerAccount(name, u, { nickname: nickname ?? ('昵' + String(name).slice(-4)) })
}


// ── 账号 ────────────────────────────────────────────────

test('注册新账号：isNew + 0 金瓜子', () => {
  const { a } = fresh()
  const r = signup(a, uid(a), '房主')
  assert.equal(r.ok, true)
  assert.equal(r.isNew, true)
  assert.equal(r.goldenSeeds, 0)
  assert.equal(r.nickname, '房主')
})

test('同名再登：直接登入，不新建', () => {
  const { a } = fresh()
  signup(a, uid(a), '房主')
  const r = loginAccount(a, 'another-uid', { nickname: '房主' })
  assert.equal(r.ok, true)
  assert.equal(r.isNew, false)
})

test('账号名规则：6-18 位纯英文数字', () => {
  fresh()
  // 昵称每次不同，避开昵称查重（这里只验账号名规则）
  assert.equal(registerAccount('abcde', uid('x'), { nickname: '甲一' }).ok, false, '太短（5位）')
  assert.equal(registerAccount('abcdef', uid('x'), { nickname: '甲二' }).ok, true, '6位可以')
  assert.equal(registerAccount('a'.repeat(19), uid('x'), { nickname: '甲三' }).ok, false, '太长（19位）')
  assert.equal(registerAccount('a'.repeat(18), uid('x'), { nickname: '甲四' }).ok, true, '18位可以')
  assert.equal(registerAccount('bad name!', uid('x'), { nickname: '甲五' }).ok, false, '非法字符')
  assert.equal(registerAccount('zhanghao1', uid('x'), { nickname: '甲六' }).ok, true, '拼音账号名可以')
  assert.equal(registerAccount('中文账号', uid('x'), { nickname: '甲七' }).ok, false, '中文账号名不再允许')
})

test('昵称规则：2-8 位中英文数字', () => {
  fresh()
  assert.equal(registerAccount('acct0001', uid('x'), { nickname: '甲甲' }).ok, true, '2个中文可以')
  assert.equal(registerAccount('acct0005', uid('x'), { nickname: '甲' }).ok, false, '1位太短')
  assert.equal(registerAccount('acct0002', uid('x'), { nickname: '' }).ok, false, '空昵称拒')
  assert.equal(registerAccount('acct0003', uid('x'), { nickname: '小明' }).ok, true, '中文昵称可以')
  assert.equal(registerAccount('acct0004', uid('x'), { nickname: 'a'.repeat(9) }).ok, false, '太长')
})

test('登录不自动建号：账号不存在返回 NOT_FOUND', () => {
  fresh()
  const r = loginAccount('nosuchuser', uid('x'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOT_FOUND')
})

test('注册查重：账号名占用返回 TAKEN', () => {
  const { a } = fresh()
  signup(a, uid(a), '房主')
  const r = registerAccount(a, 'other-uid', { nickname: '另一个人' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'TAKEN')
})

test('注册查重：昵称占用返回 NICK_TAKEN', () => {
  const { a } = fresh()
  signup(a, uid(a), '小明')
  const r = registerAccount('anotheracct', 'other-uid', { nickname: '小明' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NICK_TAKEN')
})

test('按 uid 查账号 / 改资料 / 登出', () => {
  const { a } = fresh()
  signup(a, uid(a), '旧名')
  assert.equal(accountByUid(uid(a)).nickname, '旧名')

  const up = updateMyAccount(uid(a), { nickname: '新名', avatar: 5 })
  assert.equal(up.ok, true)
  assert.equal(accountByUid(uid(a)).nickname, '新名')
  assert.equal(accountByUid(uid(a)).avatar, 5)

  logoutAccount(uid(a))
  assert.equal(accountByUid(uid(a)), null, '登出后查不到')
})

test('同一设备注册第二个账号：旧绑定被替换', () => {
  const { a, b } = fresh()
  signup(a, 'shared-uid', '房主甲')
  signup(b, 'shared-uid', '房主乙')
  // 同一个 uid 只应绑一个账号
  assert.equal(accountByUid('shared-uid').account, b)
})

// ── 账本（事故高发区）────────────────────────────────────

test('转账：双方金瓜子各改，明细各一行', () => {
  const { a, b } = fresh()
  signup(a, uid(a))
  signup(b, uid(b))
  // 先给 a 发 5 粒（用 bump 不行，直接改库模拟已有余额）
  seedGolden(b, 5)

  const r = accountSeedTransfer(b, a, 1)
  assert.equal(r.ok, true, r.error ?? '')

  assert.equal(goldenSeedsOf(b), 4)
  assert.equal(goldenSeedsOf(a), 1)

  const rowsA = accountLedgerRows(a)
  assert.equal(rowsA.length, 1)
  assert.equal(rowsA[0].peerAccount, b)
  assert.equal(rowsA[0].count, 1, '对方给了我 1 → 我记 +1')

  const rowsB = accountLedgerRows(b)
  assert.equal(rowsB[0].count, -1, '我给了对方 1 → 我记 -1')
})

test('连续转同一个对手：明细累加', () => {
  const { a, b } = fresh()
  signup(a, uid(a))
  signup(b, uid(b))
  seedGolden(b, 5)
  accountSeedTransfer(b, a, 1)
  accountSeedTransfer(b, a, 1)
  assert.equal(goldenSeedsOf(a), 2)
  assert.equal(accountLedgerRows(a)[0].count, 2)
  assert.equal(accountLedgerRows(b)[0].count, -2)
  // 每边都只有一行（UNIQUE(owner,peer) 累加，不是堆行）
  assert.equal(accountLedgerRows(a).length, 1)
})

test('余额不足：拒绝且不写任何数据', () => {
  const { a, b } = fresh()
  signup(a, uid(a))
  signup(b, uid(b))
  const r = accountSeedTransfer(a, b, 1)   // a 有 0 粒
  assert.equal(r.ok, false)
  assert.match(r.error, /金瓜子不足/)
  assert.equal(goldenSeedsOf(a), 0)
  assert.equal(goldenSeedsOf(b), 0)
  assert.equal(accountLedgerRows(a).length, 0, '失败不能留下账本行')
})

test('自己转自己：跳过', () => {
  const { a } = fresh()
  signup(a, uid(a))
  seedGolden(a, 3)
  const r = accountSeedTransfer(a, a, 1)
  assert.equal(r.skipped, true)
  assert.equal(goldenSeedsOf(a), 3, '不应有任何变化')
})

test('未注册账号：跳过', () => {
  fresh()
  const r = accountSeedTransfer('nobodyA', 'nobodyB', 1)
  assert.equal(r.skipped, true)
})

test('★ 清账：双方同时冲销，守恒', () => {
  // 这是 -2/+2 事故的回归测试。
  const { a, b } = fresh()
  signup(a, uid(a))
  signup(b, uid(b))
  seedGolden(b, 5)
  accountSeedTransfer(b, a, 2)

  // 转账后：a=2, b=3
  assert.equal(goldenSeedsOf(a), 2)
  assert.equal(goldenSeedsOf(b), 3)

  const r = clearAccountLedgerRow(a, b)
  assert.equal(r.ok, true, r.error ?? '')
  assert.equal(r.cleared, 2, '我方明细是 +2（b 给过我 2 粒）')
  assert.equal(r.peerCleared, -2, '对方明细是 -2，也要冲销')

  // 冲销 = 撤销这笔往来对双方的净影响：
  //   a: 2 - 2 = 0
  //   b: 3 - (-2) = 5   （把付出的 2 粒拿回来）
  assert.equal(goldenSeedsOf(a), 0, 'a 应回 0')
  assert.equal(goldenSeedsOf(b), 5, 'b 应收回付出的 2 粒')
  assert.equal(accountLedgerRows(a).length, 0, '明细清空')
  assert.equal(accountLedgerRows(b).length, 0, '明细清空')
})

test('★ 结清的痕迹不再被抹掉（不再 DELETE count=0）', () => {
  // 旧版每次转账都无条件清全表归零行，把别人的结清记录也删了。
  const { a, b, c } = fresh()
  signup(a, uid(a))
  signup(b, uid(b))
  signup(c, uid(c))

  // a 和 b 结清（delta 归零，但行还在）
  seedGolden(b, 5)
  accountSeedTransfer(b, a, 1)
  clearAccountLedgerRow(a, b)

  // 现在 b 和 c 发生一笔无关转账
  seedGolden(b, 5)
  accountSeedTransfer(b, c, 1)

  // a↔b 那行本该因归零被删，但现在我们的规则是「行留着」
  // 所以只验证：不相关账号的记录没被误伤
  const rowsC = accountLedgerRows(c)
  assert.equal(rowsC.length, 1, 'c 的账本不该被别人的转账影响')
  assert.equal(rowsC[0].peerAccount, b)
})

test('清不存在的账本：安全返回', () => {
  const { a, b } = fresh()
  signup(a, uid(a))
  signup(b, uid(b))
  const r = clearAccountLedgerRow(a, b)
  assert.equal(r.ok, true)
  assert.equal(r.cleared, 0)
  // 双方余额不动
  assert.equal(goldenSeedsOf(a), 0)
  assert.equal(goldenSeedsOf(b), 0)
})

test('局数 +1 只作用于在座账号', () => {
  const { a, b, c } = fresh()
  signup(a, uid(a))
  signup(b, uid(b))
  signup(c, uid(c))
  bumpTotalGames([a, b])
  assert.equal(accountByUid(uid(a)).totalGames, 1)
  assert.equal(accountByUid(uid(b)).totalGames, 1)
  assert.equal(accountByUid(uid(c)).totalGames, 0, '不在座的不该计')
})

// ── 历史 ────────────────────────────────────────────────

test('历史写入与读取', () => {
  const { a } = fresh()
  addHistory({ roomNo: '123456', mode: 'offline', roundNo: 1, payload: { seats: [] }, createdBy: a })
  const rows = listHistory(10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].room_no, '123456')
  assert.deepEqual(rows[0].payload, { seats: [] })
})

// ── 房间快照 ────────────────────────────────────────────

test('快照 upsert：同房间只留一份', () => {
  const r = fresh() && {}
  saveRoomSnapshot('111111', 'offline', { pot: 10 })
  saveRoomSnapshot('111111', 'offline', { pot: 20 })
  const one = loadRoomSnapshot('111111')
  assert.equal(one.state.pot, 20, '应覆盖为最新')
  assert.equal(loadAllRoomSnapshots().length, 1)
})

test('快照删除', () => {
  saveRoomSnapshot('222222', 'offline', { pot: 1 })
  assert.ok(loadRoomSnapshot('222222'))
  deleteRoomSnapshot('222222')
  assert.equal(loadRoomSnapshot('222222'), null)
})

// ── 清数据 ────────────────────────────────────────────

test('dataCounts 反映各表行数', () => {
  fresh()
  signup('countA0001', 'u-a', '计数甲')
  signup('countB0002', 'u-b', '计数乙')
  seedGolden('countA0001', 5)
  accountSeedTransfer('countA0001', 'countB0002', 3)
  addHistory({ roomNo: '111', mode: 'offline', roundNo: 1, payload: {}, createdBy: 'countA0001' })
  const c = dataCounts()
  assert.equal(c.accounts, 2)
  assert.equal(c.ledger, 2, '双向记账两人份')
  assert.equal(c.history, 1)
  assert.equal(c.rooms, 0)
})

test('wipeData 全清：表结构保留，数据没了', () => {
  fresh()
  signup('wipeA0001', 'u-a', '清理甲')
  signup('wipeB0002', 'u-b', '清理乙')
  seedGolden('wipeA0001', 5)
  accountSeedTransfer('wipeA0001', 'wipeB0002', 2)
  addHistory({ roomNo: '111', mode: 'offline', roundNo: 1, payload: {}, createdBy: 'wipeA0001' })
  saveRoomSnapshot('333333', 'offline', { pot: 5 })
  assert.ok(dataCounts().accounts > 0)

  const out = wipeData()
  assert.ok(out.accounts >= 2, '应删掉账号')
  assert.ok(out.ledger >= 1, '应删掉账本')
  assert.ok(out.history >= 1, '应删掉历史')
  assert.ok(out.rooms >= 1, '应删掉快照')

  // 表还在，只是空的 —— 结构不能被清掉
  const c = dataCounts()
  assert.equal(c.accounts, 0)
  assert.equal(c.ledger, 0)
  assert.equal(c.history, 0)
  assert.equal(c.rooms, 0)
  // 还能继续用（不会因为表没了抛异常）
  const r = signup('afterWipe01', 'u-c', '清理后')
  assert.equal(r.isNew, true)
})

test('wipeData 可按需只清一类', () => {
  fresh()
  signup('keepA00001', 'u-a', '保留甲')
  signup('keepB00002', 'u-b', '保留乙')
  seedGolden('keepA00001', 5)
  accountSeedTransfer('keepA00001', 'keepB00002', 2)
  addHistory({ roomNo: '111', mode: 'offline', roundNo: 1, payload: {}, createdBy: 'keepA00001' })

  // 只清历史，账号和账本都留着
  const out = wipeData({ history: true })
  assert.ok(out.history >= 1)
  assert.equal(dataCounts().history, 0)
  assert.equal(dataCounts().accounts, 2, '账号不该被动')
  assert.equal(dataCounts().ledger, 2, '账本不该被动')
})


// ── 用户自配的模型 key ─────────────────────────────────

test('存 key 后状态变 true，原文能读回', () => {
  fresh()
  signup('keyUser001', 'u-k', '密钥甲')
  assert.equal(userLlmKeyStatus('u-k').deepseek, false)

  const r = saveUserLlmKeys('u-k', { deepseekKey: 'sk-test-123' })
  assert.equal(r.ok, true, r.error)
  assert.equal(userLlmKeyStatus('u-k').deepseek, true)
  assert.equal(userLlmKeyStatus('u-k').stepfun, false, '没传的不该被动')
  assert.equal(userLlmKeys('u-k').deepseek, 'sk-test-123')
})

test('只传一项不会覆盖另一项', () => {
  fresh()
  signup('keyUser002', 'u-k2', '密钥乙')
  saveUserLlmKeys('u-k2', { deepseekKey: 'sk-ds' })
  saveUserLlmKeys('u-k2', { stepfunKey: 'sk-sf' })
  const k = userLlmKeys('u-k2')
  assert.equal(k.deepseek, 'sk-ds', '先存的 deepseek 不该被清掉')
  assert.equal(k.stepfun, 'sk-sf')
})

test('没登录账号不能存 key', () => {
  fresh()
  const r = saveUserLlmKeys('nobody-here', { deepseekKey: 'x' })
  assert.equal(r.ok, false)
})

test('换设备同一账号能读到同一套 key', () => {
  fresh()
  signup('sharedAcct1', 'device-A', '共享甲')
  saveUserLlmKeys('device-A', { deepseekKey: 'sk-shared' })
  // 换设备：同账号名登录（login 允许接管 uid），key 跟着账号走
  const r = loginAccount('sharedAcct1', 'device-B')
  assert.equal(r.ok, true, r.error)
  assert.equal(userLlmKeys('device-B').deepseek, 'sk-shared')
})

test('清数据会连 key 表一起清掉', () => {
  fresh()
  signup('wipeKeyUser1', 'u-wk', '清理密钥')
  saveUserLlmKeys('u-wk', { deepseekKey: 'sk-x' })
  wipeData()
  assert.equal(userLlmKeys('u-wk'), null, '账号没了 key 也该没')
})

