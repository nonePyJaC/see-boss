/**
 * 存储层 — SQLite
 *
 * 一台阿里云服务器跑一个 Node 进程，所有数据进一个 .db 文件：
 *   accounts       账号（account 名即身份，无密码）
 *   account_ledger 金瓜子往来账本
 *   history        每手结算记录
 *   room_snapshots 房间快照（重启恢复用）
 *
 * 用 node:sqlite（Node 22+ 内置），服务器零编译、零原生依赖。
 *
 * ── 账本规则（照 db/accounts.sql 的口径，但有两点修正）──
 *
 * 1. clearAccountLedgerRow 双方同时冲销。
 *    旧 PG 版只冲销发起方就把两边明细都删了，导致对方
 *    「金瓜子有数字、明细为空」。这是线上实际出过的事故。
 *
 * 2. 不再 DELETE count = 0 的行。
 *    旧版每次转账都无条件清掉全表归零行，把结清痕迹也抹了，
 *    于是「有数字没明细」。现在行留着，前端自己决定显不显示。
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 数据文件位置：server/data/hamster.db */
const DATA_DIR = process.env.HAMSTER_DATA_DIR || path.join(__dirname, 'data')
const DB_PATH = path.join(DATA_DIR, process.env.HAMSTER_DB || 'hamster.db')

let db = null

/** 打开（或新建）数据库并建表 */
export function openDb(file = DB_PATH) {
  if (db) return db
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')      // 读写不互斥，重启恢复更稳
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

export function getDb() {
  if (!db) return openDb()
  return db
}

/** 测试用：换一个内存库或临时文件 */
export function openTestDb(file = ':memory:') {
  db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

/** 测试用：直接拿当前连接（造数据用） */
export function rawDb() {
  return db
}

export function closeDb() {
  if (db) { db.close(); db = null }
}

function migrate(d) {
  d.exec(`
  -- ── 账号 ──
  -- account 名即身份（3-16 字符），uid 是游客身份锚点。
  -- 一个 uid 只能绑一个账号；一个账号也只能绑一个 uid，
  -- 否则同设备两次登录会出现两份账。
  CREATE TABLE IF NOT EXISTS accounts (
    account      TEXT PRIMARY KEY,
    uid          TEXT NOT NULL UNIQUE,
    nickname     TEXT NOT NULL DEFAULT '',
    avatar       INTEGER NOT NULL DEFAULT 1,
    golden_seeds INTEGER NOT NULL DEFAULT 0 CHECK (golden_seeds >= 0),
    total_games  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── 金瓜子账本 ──
  -- owner / peer 都是账号名。delta > 0 = 对方欠我，< 0 = 我欠对方。
  -- (owner, peer) 唯一，累加；不再有「归零就删行」。
  CREATE TABLE IF NOT EXISTS account_ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner      TEXT NOT NULL,
    peer       TEXT NOT NULL,
    delta      INTEGER NOT NULL,
    peer_name  TEXT NOT NULL DEFAULT '',
    peer_avatar INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (owner, peer),
    FOREIGN KEY (owner) REFERENCES accounts(account) ON DELETE CASCADE,
    FOREIGN KEY (peer)  REFERENCES accounts(account) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_owner ON account_ledger(owner);

  -- ── 历史 ──
  CREATE TABLE IF NOT EXISTS history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    room_no    TEXT NOT NULL,
    mode       TEXT NOT NULL DEFAULT 'offline',
    round_no   INTEGER NOT NULL DEFAULT 1,
    payload    TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);

  -- ── 房间快照 ──
  -- state 是整个房间的 JSON（seats/pot/turnUid/stage/…）。
  -- 每次动作后 upsert；进程启动时载回 → pm2 restart 自动恢复对局。
  CREATE TABLE IF NOT EXISTS room_snapshots (
    room_id    TEXT PRIMARY KEY,
    mode       TEXT NOT NULL DEFAULT 'offline',
    state      TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── 用户自配的模型 key ──
  -- 存在库里而不是环境变量，这样用户能在应用内自己填，不用登服务器改 pm2。
  -- account 是主键：一个账号一套 key，换设备登录也能用上。
  -- ⚠️ 明文存储。朋友局自用可接受；真要上公网得改成加密列。
  CREATE TABLE IF NOT EXISTS llm_keys (
    account      TEXT PRIMARY KEY,
    deepseek_key TEXT NOT NULL DEFAULT '',
    stepfun_key  TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `)
}

// ── 账号 ────────────────────────────────────────────────

/** 账号名合法性：3-16 位字母数字下划线/中文 */
/**
 * 账号名：6-18 位，仅英文 + 数字。
 * 昵称：2-8 位，中英文 + 数字。
 *
 * 2026-09-24 改版（用户口径）：
 *   · 账号名从「3-16 位含中文下划线」收紧成「6-18 位纯英文数字」——
 *     中文账号名在扫码链接里要编码，URL 又长又容易出错。
 *   · 登录和注册拆开：login 不再自动建号，账号不存在就报 NOT_FOUND，
 *     由前端切到注册 tab。之前登录即注册，打错一个字就静默建个新号。
 */
const NAME_RE = /^[A-Za-z0-9]{6,18}$/
const NICK_RE = /^[A-Za-z0-9\u4e00-\u9fa5]{2,8}$/

function normAccount(name) {
  return String(name ?? '').trim()
}

/**
 * 登录：账号必须已存在。
 *
 * 不再「登录即注册」—— 打错一个字符就静默建新号，桌上会出现两个
 * 同名但不是同一个人的账号（实测踩过）。账号不存在返回
 * { ok:false, code:'NOT_FOUND' }，由前端切到注册 tab。
 *
 * 朋友局设计：知道账号名即可登录，不设密码。
 *
 * @returns {{ok:true, account, isNew:false, nickname, avatar, goldenSeeds, totalGames}
 *           | {ok:false, error, code}}
 */
export function loginAccount(name, uid, profile = {}) {
  const account = normAccount(name)
  if (!NAME_RE.test(account)) {
    return { ok: false, error: '账号名需 6-18 位英文或数字' }
  }
  if (!uid) return { ok: false, error: '缺少设备身份' }

  const d = getDb()
  const existing = d.prepare('SELECT * FROM accounts WHERE account = ?').get(account)
  if (!existing) {
    return { ok: false, code: 'NOT_FOUND', error: '账号不存在，请先注册' }
  }

  // 已存在 → 登录。如果这个账号被别的 uid 占着，允许接管
  // （朋友局同一账号名即同一人，换设备也要能登）。
  if (existing.uid !== uid) {
    d.prepare(
      `UPDATE accounts
       SET uid = ?, nickname = COALESCE(NULLIF(?, ''), nickname),
           avatar = COALESCE(?, avatar),
           updated_at = datetime('now')
       WHERE account = ?`
    ).run(uid, profile.nickname ?? '', profile.avatar ?? 0, account)
  } else if (profile.nickname || profile.avatar) {
    d.prepare(
      `UPDATE accounts
       SET nickname = COALESCE(NULLIF(?, ''), nickname),
           avatar = COALESCE(?, avatar),
           updated_at = datetime('now')
       WHERE account = ?`
    ).run(profile.nickname ?? '', profile.avatar ?? 0, account)
  }
  const row = d.prepare('SELECT * FROM accounts WHERE account = ?').get(account)
  return {
    ok: true, account, isNew: false,
    nickname: row.nickname, avatar: row.avatar,
    goldenSeeds: row.golden_seeds, totalGames: row.total_games,
  }
}

/**
 * 注册：账号必须不存在。
 *
 * 昵称也查重 —— 桌上两个「小明」分不清是谁。
 * 账号名已存在返回 { ok:false, code:'TAKEN' }，前端提示换一个。
 *
 * @returns {{ok:true, account, isNew:true, nickname, avatar, goldenSeeds, totalGames}
 *           | {ok:false, error, code}}
 */
export function registerAccount(name, uid, profile = {}) {
  const account = normAccount(name)
  if (!NAME_RE.test(account)) {
    return { ok: false, error: '账号名需 6-18 位英文或数字' }
  }
  const nickname = String(profile.nickname ?? '').trim()
  if (!NICK_RE.test(nickname)) {
    return { ok: false, error: '昵称需 2-8 位中英文或数字' }
  }
  if (!uid) return { ok: false, error: '缺少设备身份' }

  const d = getDb()
  if (d.prepare('SELECT 1 FROM accounts WHERE account = ?').get(account)) {
    return { ok: false, code: 'TAKEN', error: '账号名已被占用' }
  }
  if (d.prepare('SELECT 1 FROM accounts WHERE nickname = ?').get(nickname)) {
    return { ok: false, code: 'NICK_TAKEN', error: '昵称已被占用，换一个' }
  }

  // 新账号占一个 uid。若这个 uid 已绑过别的账号（本机注册过第二个），
  // 只解绑不删行 —— DELETE 会顺着 FK CASCADE 把对方账本里
  // 所有引用这个账号的行一起抹掉（金瓜子 + 账本双蒸发）。
  d.prepare(`UPDATE accounts SET uid = 'unbound:' || account WHERE uid = ?`).run(uid)

  d.prepare(
    `INSERT INTO accounts (account, uid, nickname, avatar)
     VALUES (?, ?, ?, ?)`
  ).run(account, uid, nickname, profile.avatar ?? 1)

  return {
    ok: true, account, isNew: true,
    nickname, avatar: profile.avatar ?? 1,
    goldenSeeds: 0, totalGames: 0,
  }
}

/** 按 uid 查当前登录的账号 */
export function accountByUid(uid) {
  if (!uid) return null
  const row = getDb().prepare('SELECT * FROM accounts WHERE uid = ?').get(uid)
  if (!row) return null
  return {
    account: row.account, nickname: row.nickname, avatar: row.avatar,
    goldenSeeds: row.golden_seeds, totalGames: row.total_games,
  }
}

/** 改昵称 / 头像 */
export function updateMyAccount(uid, patch = {}) {
  const me = accountByUid(uid)
  if (!me) return { ok: false, error: '尚未登录账号' }
  const d = getDb()
  const nickname = patch.nickname != null ? String(patch.nickname).trim().slice(0, 32) : me.nickname
  const avatar = patch.avatar != null ? Number(patch.avatar) : me.avatar
  d.prepare(
    `UPDATE accounts SET nickname = ?, avatar = ?, updated_at = datetime('now')
     WHERE account = ?`
  ).run(nickname || me.account, Number.isFinite(avatar) ? avatar : me.avatar, me.account)
  return { ok: true, ...accountByUid(uid) }
}

/**
 * 退出登录：解绑 uid（不是删号）。
 * DELETE 会顺着 account_ledger 的 FK CASCADE 把双向账本行全抹掉 ——
 * 这里只把 uid 换成 tombstone，账号数据原样保留，重新登录即可找回。
 */
export function logoutAccount(uid) {
  if (!uid) return { ok: true }
  getDb().prepare(`UPDATE accounts SET uid = 'unbound:' || account WHERE uid = ?`).run(uid)
  return { ok: true }
}

// ── 金瓜子 ──────────────────────────────────────────────

/**
 * 金瓜子转账（单事务，双方记账）。
 *
 * @param {string} fromAccount  付款方账号名
 * @param {string} toAccount    收款方账号名
 * @param {number} amount       正数
 */
export function accountSeedTransfer(fromAccount, toAccount, amount = 1) {
  const from = normAccount(fromAccount)
  const to = normAccount(toAccount)
  const amt = Math.floor(Number(amount))
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: '数量无效' }
  if (!from || !to) return { ok: false, error: '账号不能为空' }
  if (from === to) return { ok: true, skipped: true, reason: '自己转自己' }

  const d = getDb()
  const a = d.prepare('SELECT * FROM accounts WHERE account = ?').get(from)
  const b = d.prepare('SELECT * FROM accounts WHERE account = ?').get(to)
  if (!a || !b) return { ok: true, skipped: true, reason: '任一方未注册账号' }

  // 余额不足不转。之前 PG 版允许扣成负数，界面上出现 -2 查不到来源。
  if (a.golden_seeds < amt) {
    return { ok: false, error: `金瓜子不足（有 ${a.golden_seeds}，需 ${amt}）` }
  }

  const run = d.prepare.bind(d)
  const tx = () => {
    d.prepare('UPDATE accounts SET golden_seeds = golden_seeds - ?, updated_at = datetime(\'now\') WHERE account = ?').run(amt, from)
    d.prepare('UPDATE accounts SET golden_seeds = golden_seeds + ?, updated_at = datetime(\'now\') WHERE account = ?').run(amt, to)
    upsertLedger(d, from, to, -amt, b.nickname, b.avatar)
    upsertLedger(d, to, from, +amt, a.nickname, a.avatar)
  }

  // node:sqlite 有 exec 级事务：包一起，任何一步失败整体回滚
  d.exec('BEGIN IMMEDIATE')
  try {
    tx()
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }

  return { ok: true, from, to, amount: amt }
}

/** 累加一行账本；行不存在则插入 */
function upsertLedger(d, owner, peer, delta, peerName, peerAvatar) {
  d.prepare(
    `INSERT INTO account_ledger (owner, peer, delta, peer_name, peer_avatar)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner, peer) DO UPDATE SET
       delta = delta + excluded.delta,
       peer_name = excluded.peer_name,
       peer_avatar = excluded.peer_avatar,
       updated_at = datetime('now')`
  ).run(owner, peer, delta, peerName || peer, peerAvatar ?? 1)
}

/** 我的账本明细 */
export function accountLedgerRows(ownerAccount) {
  const owner = normAccount(ownerAccount)
  if (!owner) return []
  return getDb().prepare(
    `SELECT peer AS peerAccount, peer_name AS peerName, peer_avatar AS peerAvatar, delta AS count
     FROM account_ledger WHERE owner = ? ORDER BY ABS(delta) DESC`
  ).all(owner)
}

/**
 * 与某人结清账本（双方同时冲销）。
 *
 * 这是 -2/+2 事故的修复点：旧实现只改发起方就把两边行都删了，
 * 留下「对方有数字、没明细」且双方之和不再守恒。
 */
export function clearAccountLedgerRow(ownerAccount, peerAccount) {
  const owner = normAccount(ownerAccount)
  const peer = normAccount(peerAccount)
  if (!owner || !peer || owner === peer) return { ok: false, error: '对手账号不正确' }

  const d = getDb()
  const mine = d.prepare('SELECT delta FROM account_ledger WHERE owner = ? AND peer = ?').get(owner, peer)
  if (!mine) return { ok: true, cleared: 0 }

  const theirs = d.prepare('SELECT delta FROM account_ledger WHERE owner = ? AND peer = ?').get(peer, owner)

  d.exec('BEGIN IMMEDIATE')
  try {
    // 我方：冲销这笔净影响。delta>0 是对方欠我（我当时已收过），结清即退回；
    // delta<0 是我欠对方，减负等于加钱。两边都按「golden_seeds - delta」统一。
    // MAX(0,·) 防 CHECK 约束：赢来的金瓜子可能已花掉，结清不能扣成负数报错。
    d.prepare(`UPDATE accounts SET golden_seeds = MAX(0, golden_seeds - ?), updated_at = datetime('now') WHERE account = ?`)
      .run(mine.delta, owner)
    if (theirs) {
      d.prepare(`UPDATE accounts SET golden_seeds = MAX(0, golden_seeds - ?), updated_at = datetime('now') WHERE account = ?`)
        .run(theirs.delta, peer)
    }
    d.prepare('DELETE FROM account_ledger WHERE (owner = ? AND peer = ?) OR (owner = ? AND peer = ?)')
      .run(owner, peer, peer, owner)
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
  return { ok: true, cleared: mine.delta, peerCleared: theirs?.delta ?? 0 }
}

/** 局数 +1（结算时调） */
export function bumpTotalGames(accountNames = []) {
  const d = getDb()
  const stmt = d.prepare(
    `UPDATE accounts SET total_games = total_games + 1, updated_at = datetime('now')
     WHERE account = ?`
  )
  d.exec('BEGIN IMMEDIATE')
  try {
    for (const n of accountNames) { const a = normAccount(n); if (a) stmt.run(a) }
    d.exec('COMMIT')
  } catch (e) { d.exec('ROLLBACK'); throw e }
}

/** 我的金瓜子总数 */
export function goldenSeedsOf(account) {
  const row = getDb().prepare('SELECT golden_seeds FROM accounts WHERE account = ?').get(normAccount(account))
  return row?.golden_seeds ?? 0
}

// ── 历史 ────────────────────────────────────────────────

export function addHistory({ roomNo, mode, roundNo, payload, createdBy }) {
  const r = getDb().prepare(
    `INSERT INTO history (room_no, mode, round_no, payload, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    String(roomNo ?? ''), mode ?? 'offline', Number(roundNo) || 1,
    JSON.stringify(payload ?? {}), createdBy ?? ''
  )
  return r.lastInsertRowid
}

export function listHistory(limit = 50, account = null) {
  const d = getDb()
  const rows = account
    ? d.prepare(
        `SELECT * FROM history WHERE created_by = ? OR payload LIKE ?
         ORDER BY created_at DESC, id DESC LIMIT ?`
      ).all(normAccount(account), `%"${normAccount(account)}%`, Number(limit) || 50)
    : d.prepare('SELECT * FROM history ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(Number(limit) || 50)
  return rows.map((r) => ({ ...r, payload: safeJson(r.payload) }))
}

function safeJson(s) { try { return JSON.parse(s) } catch { return {} } }

/**
 * 删除某个房间的全部历史行。
 *
 * 线下游玩不留记录（房主口径）：房间销毁（房主离开 / 结算解散）时
 * 连同快照一起清掉，只有金瓜子账本（account_ledger）保留。
 */
export function deleteRoomHistory(roomNo) {
  // 麻将战绩跨房间存续，房号可能被不同玩法复用；只清理原先随房间删除的记录。
  getDb().prepare("DELETE FROM history WHERE room_no = ? AND mode <> 'mahjong'").run(String(roomNo))
}

// ── 房间快照 ────────────────────────────────────────────

export function saveRoomSnapshot(roomId, mode, state) {
  getDb().prepare(
    `INSERT INTO room_snapshots (room_id, mode, state, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(room_id) DO UPDATE SET
       mode = excluded.mode,
       state = excluded.state,
       updated_at = datetime('now')`
  ).run(String(roomId), mode ?? 'offline', JSON.stringify(state ?? {}))
}

export function loadRoomSnapshot(roomId) {
  const row = getDb().prepare('SELECT * FROM room_snapshots WHERE room_id = ?').get(String(roomId))
  if (!row) return null
  return { roomId: row.room_id, mode: row.mode, state: safeJson(row.state), updatedAt: row.updated_at }
}

/** 启动时把所有快照载回（供 server/index.js 恢复内存态） */
export function loadAllRoomSnapshots() {
  return getDb().prepare('SELECT * FROM room_snapshots').all().map((r) => ({
    roomId: r.room_id, mode: r.mode, state: safeJson(r.state), updatedAt: r.updated_at,
  }))
}

export function deleteRoomSnapshot(roomId) {
  getDb().prepare('DELETE FROM room_snapshots WHERE room_id = ?').run(String(roomId))
}

// ── 用户自配的模型 key ──────────────────────────────────

/**
 * 存/改用户自配的模型 key。
 *
 * 只更新传了的那一项 —— 传 { deepseekKey } 不动 stepfun，
 * 这样前端可以分两个输入框各自保存，不会互相覆盖。
 * 传空字符串等于清掉该项。
 *
 * @param {string} uid 设备 uid（会解析成账号名）
 */
export function saveUserLlmKeys(uid, patch = {}) {
  const me = accountByUid(uid)
  if (!me) return { ok: false, error: '尚未登录账号' }
  const d = getDb()
  const cur = d.prepare('SELECT * FROM llm_keys WHERE account = ?').get(me.account)
  const deepseek = patch.deepseekKey != null
    ? String(patch.deepseekKey).trim().slice(0, 200)
    : (cur?.deepseek_key ?? '')
  const stepfun = patch.stepfunKey != null
    ? String(patch.stepfunKey).trim().slice(0, 200)
    : (cur?.stepfun_key ?? '')

  d.prepare(
    `INSERT INTO llm_keys (account, deepseek_key, stepfun_key, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(account) DO UPDATE SET
       deepseek_key = excluded.deepseek_key,
       stepfun_key  = excluded.stepfun_key,
       updated_at   = datetime('now')`
  ).run(me.account, deepseek, stepfun)
  return { ok: true }
}

/**
 * 读用户自配的 key。只返回「有没有配」的布尔，不返回 key 本身 ——
 * key 一旦写出去就收不回来了，前端只需要知道状态来显示「已配置」。
 */
export function userLlmKeyStatus(uid) {
  const me = accountByUid(uid)
  if (!me) return { ok: false, error: '尚未登录账号' }
  const row = getDb().prepare('SELECT * FROM llm_keys WHERE account = ?').get(me.account)
  return {
    ok: true,
    deepseek: Boolean(row?.deepseek_key),
    stepfun: Boolean(row?.stepfun_key),
  }
}

/** 读用户自配的 key 原文（只给服务端内部用，不走 HTTP 出去） */
export function userLlmKeys(uid) {
  const me = accountByUid(uid)
  if (!me) return null
  const row = getDb().prepare('SELECT * FROM llm_keys WHERE account = ?').get(me.account)
  if (!row) return null
  return {
    deepseek: row.deepseek_key || '',
    stepfun: row.stepfun_key || '',
  }
}

// ── 维护：清数据 ────────────────────────────────────────

/**
 * 清掉所有业务数据（表结构保留）。
 *
 * 实测一段时间会攒下一堆垃圾：临时账号、测试房间、历史战绩。
 * 这是给人手动用的口子，不做定时 —— 误清是灾难级的，
 * 必须由人显式触发。
 *
 * 按外键依赖顺序删：account_ledger 引用 accounts，
 * 先删子表再删父表，否则 CASCADE 之外的残留会打架。
 *
 * @param {{accounts?:boolean, ledger?:boolean, history?:boolean, rooms?:boolean}} what
 *        不给就全清。 rooms 还会顺带清掉内存里的 Map。
 * @returns {object} 每张表删了几行
 */
export function wipeData(what = {}) {
  const db = getDb()
  const all = Object.keys(what).length === 0
  const want = {
    accounts: all || what.accounts === true,
    ledger: all || what.ledger === true,
    history: all || what.history === true,
    rooms: all || what.rooms === true,
  }
  const out = {}

  // 子表先删
  if (want.ledger) out.ledger = db.prepare('DELETE FROM account_ledger').run().changes
  if (want.history) out.history = db.prepare('DELETE FROM history').run().changes
  // 清历史/账本时顺带把自增计数归零，否则删完 id 还是从几千开始跳
  if (want.history) {
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('history','account_ledger')").run()
  }
  if (want.accounts) out.accounts = db.prepare('DELETE FROM accounts').run().changes
  if (want.rooms) out.rooms = db.prepare('DELETE FROM room_snapshots').run().changes

  // VACUUM 不能在有未结事务时跑；这里都没开事务，直接压
  if (want.accounts || want.rooms || want.history) {
    try { db.exec('VACUUM') } catch { /* 只影响体积，失败不阻塞清理 */ }
  }
  return out
}

/** 各表当前行数，给清理前确认用 */
export function dataCounts() {
  const db = getDb()
  const one = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
  return {
    accounts: one('accounts'),
    ledger: one('account_ledger'),
    history: one('history'),
    rooms: one('room_snapshots'),
  }
}

export { DB_PATH }
