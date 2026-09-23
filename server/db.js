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
  `)
}

// ── 账号 ────────────────────────────────────────────────

/** 账号名合法性：3-16 位字母数字下划线/中文 */
const NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,16}$/

function normAccount(name) {
  return String(name ?? '').trim()
}

/**
 * 注册或登录。
 *
 * 朋友局设计：知道账号名即可登录，不设密码。
 * 已存在 → 直接登（并把 uid 绑到当前设备）；
 * 不存在 → 新建。
 *
 * @returns {{ok:true, account, isNew, goldenSeeds, totalGames} | {ok:false, error}}
 */
export function loginAccount(name, uid, profile = {}) {
  const account = normAccount(name)
  if (!NAME_RE.test(account)) {
    return { ok: false, error: '账号名需 3-16 位，可用字母/数字/下划线/中文' }
  }
  if (!uid) return { ok: false, error: '缺少设备身份' }

  const d = getDb()
  const existing = d.prepare('SELECT * FROM accounts WHERE account = ?').get(account)

  if (existing) {
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

  // 新账号：占一个 uid。若这个 uid 已绑过别的账号（本机注册过第二个），
  // 先把旧绑定解掉，否则 UNIQUE(uid) 会冲突。
  d.prepare('DELETE FROM accounts WHERE uid = ?').run(uid)

  d.prepare(
    `INSERT INTO accounts (account, uid, nickname, avatar)
     VALUES (?, ?, ?, ?)`
  ).run(account, uid, profile.nickname || account, profile.avatar ?? 1)

  return {
    ok: true, account, isNew: true,
    nickname: profile.nickname || account, avatar: profile.avatar ?? 1,
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

/** 退出登录：解绑 uid，让别人可以在这台设备上用这个账号名 */
export function logoutAccount(uid) {
  if (!uid) return { ok: true }
  getDb().prepare('DELETE FROM accounts WHERE uid = ?').run(uid)
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
    // 我方：放弃这笔净影响。delta>0 是对方欠我，冲销即减掉
    d.prepare('UPDATE accounts SET golden_seeds = golden_seeds - ?, updated_at = datetime(\'now\') WHERE account = ?')
      .run(mine.delta, owner)
    // 对方同理（theirs.delta 与 mine.delta 等值反号，同样用减号）
    if (theirs) {
      d.prepare('UPDATE accounts SET golden_seeds = golden_seeds - ?, updated_at = datetime(\'now\') WHERE account = ?')
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

export { DB_PATH }
