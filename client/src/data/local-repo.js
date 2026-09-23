/**
 * 本地 Repository — 基于 localStorage
 *
 * 用于：
 *   1. 开发阶段无云端时跑通全流程
 *   2. 单机演示（bot 对战）
 *   3. 云端不可用时的降级
 *
 * 限制：多设备不同步（这是云端 repository 的职责）
 */

const K = {
  user: 'hamster-poker:user',
  ledger: 'hamster-poker:seed-ledger',
  history: 'hamster-poker:history',
  rooms: 'hamster-poker:rooms',
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function write(key, val) {
  localStorage.setItem(key, JSON.stringify(val))
}

/** 生成稳定 uid（本地环境没有匿名登录） */
function ensureUid() {
  let uid = localStorage.getItem('hamster-poker:uid')
  if (!uid) {
    uid = 'local_' + Math.random().toString(36).slice(2, 12)
    localStorage.setItem('hamster-poker:uid', uid)
  }
  return uid
}

export const localRepo = {
  name: 'local',

  // ── auth ──
  async signIn() {
    return { uid: ensureUid() }
  },

  // ── profile ──
  async getProfile(uid) {
    const u = read(K.user, null)
    return u && u.uid === uid ? u : null
  },

  async upsertProfile(profile) {
    write(K.user, profile)
  },

  // ── ledger ──
  async getLedger(uid) {
    const led = read(K.ledger, {})
    return Object.entries(led).map(([peerUid, v]) => ({ peerUid, ...v }))
  },

  async transferSeeds(fromUid, toUid, amount = 1) {
    if (fromUid === toUid) return
    const led = read(K.ledger, {})
    const users = read(K.rooms + ':users', {}) // 演示用：缓存 bot 档案

    const fromCount = led[toUid]?.count ?? 0
    const toCount = led[fromUid]?.count ?? 0

    led[toUid] = {
      nickname: users[toUid]?.nickname ?? '好友',
      avatar: users[toUid]?.avatar ?? 1,
      count: fromCount - amount,
    }
    led[fromUid] = {
      nickname: users[fromUid]?.nickname ?? '好友',
      avatar: users[fromUid]?.avatar ?? 1,
      count: toCount + amount,
    }

    // 清理归零条目
    for (const [k, v] of Object.entries(led)) {
      if (v.count === 0) delete led[k]
    }

    write(K.ledger, led)

    // 同步 goldenSeeds 总数
    const u = read(K.user, null)
    if (u) {
      const total = Object.values(led).reduce((s, v) => s + v.count, 0)
      write(K.user, { ...u, goldenSeeds: total })
    }
  },

  async clearLedgerEntry(ownerUid, peerUid) {
    const led = read(K.ledger, {})
    const ownerCount = led[peerUid]?.count ?? 0
    delete led[peerUid]
    write(K.ledger, led)

    const u = read(K.user, null)
    if (u) {
      const total = Object.values(led).reduce((s, v) => s + v.count, 0)
      write(K.user, { ...u, goldenSeeds: total })
    }
    return ownerCount
  },

  // ── room ──
  async createRoom(cfg) {
    const roomNo = String(Math.floor(100000 + Math.random() * 900000))
    const rooms = read(K.rooms, {})
    rooms[roomNo] = {
      id: roomNo,
      ...cfg,
      pot: 0,
      roundNo: 1,
      status: 'waiting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    write(K.rooms, rooms)
    return { roomNo }
  },

  async joinRoom(roomNo) {
    const rooms = read(K.rooms, {})
    const room = rooms[roomNo]
    if (!room) throw new Error('房间不存在')
    return { room, seats: [] }
  },

  async getGoldenSeeds(uids) {
    // 单机 mock：本地只存自己的金瓜子，其他成员显示 0
    const list = (uids ?? []).filter(Boolean)
    const me = read(K.user, null)
    const map = {}
    for (const uid of list) map[uid] = me?.uid === uid ? (me.goldenSeeds ?? 0) : 0
    return map
  },

  async rotateBlinds() {
    // 单机 mock：无服务端轮转
    return { ok: true }
  },

  async setAutoBlind() {
    return { ok: true }
  },

  async resetBlinds() {
    return { ok: true }
  },

  async setBlinds() {
    return { ok: true }
  },

  async reorderSeats() {
    return { ok: true }
  },

  async leaveRoom(roomNo) {
    const rooms = read(K.rooms, {})
    delete rooms[roomNo]
    write(K.rooms, rooms)
  },

  async leaveSeat() {
    // 本地演示无真实座位概念
  },

  async deleteRoom() {
    // 本地演示无真实房间概念
  },

  // ── account（本地演示：用 localStorage 模拟） ──
  async myAccount() {
    const raw = localStorage.getItem('hamster-poker:account')
    if (!raw) return { ok: true, loggedIn: false }
    const a = JSON.parse(raw)
    return {
      ok: true, loggedIn: true,
      account: a.account, nickname: a.nickname, avatar: a.avatar,
      goldenSeeds: a.goldenSeeds ?? 0, totalGames: a.totalGames ?? 0,
    }
  },

  async accountAvailable(account) {
    const raw = localStorage.getItem('hamster-poker:accounts')
    const all = raw ? JSON.parse(raw) : {}
    return !all[account]
  },

  async registerAccount(account, nickname, avatar) {
    const raw = localStorage.getItem('hamster-poker:accounts')
    const all = raw ? JSON.parse(raw) : {}
    if (all[account]) throw new Error('账号名已被占用')
    all[account] = { account, nickname, avatar, goldenSeeds: 0, totalGames: 0 }
    localStorage.setItem('hamster-poker:accounts', JSON.stringify(all))
    localStorage.setItem('hamster-poker:account', JSON.stringify(all[account]))
    return all[account]
  },

  async loginAccount(account) {
    const raw = localStorage.getItem('hamster-poker:accounts')
    const all = raw ? JSON.parse(raw) : {}
    if (!all[account]) throw new Error('账号不存在，请先注册')
    localStorage.setItem('hamster-poker:account', JSON.stringify(all[account]))
    return all[account]
  },

  async updateMyAccount(nickname, avatar) {
    const cur = await this.myAccount()
    if (!cur.loggedIn) throw new Error('尚未登录账号')
    const raw = localStorage.getItem('hamster-poker:accounts')
    const all = raw ? JSON.parse(raw) : {}
    const a = all[cur.account]
    if (nickname) a.nickname = nickname
    if (avatar) a.avatar = avatar
    all[cur.account] = a
    localStorage.setItem('hamster-poker:accounts', JSON.stringify(all))
    localStorage.setItem('hamster-poker:account', JSON.stringify(a))
    return a
  },

  async getAccountLedger() {
    const me = await this.myAccount()
    if (!me?.loggedIn) return []
    const all = JSON.parse(localStorage.getItem('hamster-poker:account-ledger') || '{}')
    return (all[me.account] || []).map((r) => ({
      peerUid: r.peer, peerName: r.peerName, peerAvatar: r.peerAvatar, count: r.count,
    }))
  },

  async clearAccountLedgerRow(peer) {
    const me = await this.myAccount()
    if (!me?.loggedIn) return
    const key = 'hamster-poker:account-ledger'
    const all = JSON.parse(localStorage.getItem(key) || '{}')
    all[me.account] = (all[me.account] || []).filter((r) => r.peer !== peer)
    localStorage.setItem(key, JSON.stringify(all))
  },

  async logoutAccount() {
    localStorage.removeItem('hamster-poker:account')
  },

  /** 可加入的存活房间列表（服务端过滤，只暴露公开信息） */
  async listJoinableRooms() {
    // 本地模式没有"别人的房间"，返回空列表。
    // 2.4：这里原来误调了云端的 rdb()（未导入 → ReferenceError）
    //      还引用了不存在的 limit 变量，点加入页签必炸。
    return []
  },

  /** 本地模式：房间就在内存里，指纹用哈希即可 */
  async getRoomFingerprint(roomNo) {
    const r = K.rooms?.[roomNo]
    if (!r) return 'gone'
    const seats = (r.seats ?? []).map((s) => s.seeds + ':' + (s.bet ?? 0)).join(',')
    return [r.pot, seats, r.roundNo ?? 1, r.status ?? ''].join('|')
  },

  /** 本地模式账号账本不存在，转账由本地记账承担 */
  async accountSeedTransfer() {
    return { ok: true, skipped: true, reason: '本地模式不走账号账本' }
  },

  async getRoom(roomNo) {
    const rooms = read(K.rooms, {})
    return rooms[roomNo] ?? null
  },

  async roomSnapshot(roomNo) {
    const rooms = read(K.rooms, {})
    const room = rooms[roomNo]
    if (!room) return null
    return {
      id: roomNo,
      mode: room.mode,
      status: room.status,
      initialSeeds: room.initialSeeds,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      roundNo: room.roundNo ?? 1,
      pot: room.pot ?? 0,
      seats: [],
    }
  },

  async movePot(roomNo, amount) {
    const rooms = read(K.rooms, {})
    const room = rooms[roomNo]
    if (!room) throw new Error('房间不存在')
    room.pot = (room.pot ?? 0) + amount
    room.updatedAt = Date.now()
    write(K.rooms, rooms)
    return { pot: room.pot, delta: amount }
  },

  async offlineSettle(roomNo, transfers = [], saveHistory = true) {
    const rooms = read(K.rooms, {})
    const room = rooms[roomNo]
    if (!room) throw new Error('房间不存在')

    // 本地：逐条转金瓜子
    for (const t of transfers) {
      await this.transferSeeds(t.fromUid, t.toUid, t.amount ?? 1)
    }

    room.pot = 0
    room.roundNo = (room.roundNo ?? 1) + 1
    room.status = 'waiting'
    write(K.rooms, rooms)

    if (saveHistory) {
      await this.addHistory({
        roomNo,
        mode: room.mode,
        roundNo: room.roundNo - 1,
        initialSeeds: room.initialSeeds,
        smallBlind: room.smallBlind,
        bigBlind: room.bigBlind,
        players: [],
        seedsMoves: transfers,
      })
    }

    return { ok: true, roundNo: room.roundNo }
  },

  /**
   * 本地环境没有真正的实时推送。
   * 用 storage 事件实现跨标签页同步（同一浏览器多标签可互通），
   * 并保留轮询兜底。
   */
  subscribeRoom(roomNo, cb) {
    const onStorage = (e) => {
      if (e.key === K.rooms) {
        const rooms = read(K.rooms, {})
        if (rooms[roomNo]) cb({ room: rooms[roomNo], members: [] })
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  },

  // ── history ──
  async listHistory() {
    const h = read(K.history, { games: [] })
    return h.games ?? []
  },

  async addHistory(game) {
    const h = read(K.history, { games: [] })
    h.games = [{ ...game, id: `g_${Date.now()}` }, ...(h.games ?? [])].slice(0, 100)
    write(K.history, h)
  },

  async clearHistory() {
    localStorage.removeItem(K.history)
  },
}
