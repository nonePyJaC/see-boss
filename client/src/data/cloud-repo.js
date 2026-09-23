/**
 * CloudBase PostgreSQL Repository
 *
 * 架构：PG 模式（PostgREST + RLS）
 *   读：app.rdb().from('table').select()  —— 前端直连，RLS 控制行级权限
 *   写：全部走云函数 RPC —— 服务端权威，防作弊
 *
 * 关键点：
 *   1. 必须 await auth.signInAnonymously()，否则所有玩家共享 sub="anon"，
 *      RLS 的 auth.uid() 无法按用户隔离
 *   2. Publishable Key 可安全暴露（role=anon，受 RLS 约束）
 *   3. 绝不用 API Key（service_role 有 BYPASSRLS，等于数据全裸）
 */

import { CB_CONFIG, assertCloudReady } from './index.js'
import { ensureApp, currentUid } from './cloud-repo-internal.js'
/** 懒初始化，返回 rdb 客户端 */
async function rdb() {
  const app = await ensureApp()
  return app.rdb() // PostgreSQL 专用入口（不是 app.database()）
}

const uid = currentUid

export const cloudRepo = {
  name: 'cloud-pg',

  // ── auth ──
  async signIn() {
    return { uid: await currentUid() }
  },

  // ── profile ──
  async getProfile(myUid) {
    const db = await rdb()
    const { data, error } = await db
      .from('users')
      .select('id, nickname, avatar, golden_seeds, total_games')
      .eq('id', myUid)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return null
    return {
      uid: data.id,
      nickname: data.nickname,
      avatar: data.avatar,
      goldenSeeds: data.golden_seeds,
      totalGames: data.total_games,
    }
  },

  async upsertProfile(p) {
    const db = await rdb()
    const { error } = await db.from('users').upsert(
      {
        id: p.uid,
        nickname: p.nickname,
        avatar: p.avatar,
        golden_seeds: p.goldenSeeds ?? 0,
        total_games: p.totalGames ?? 0,
      },
      { onConflict: 'id' }
    )
    if (error) throw new Error(error.message)
  },

  // ── ledger ──
  async getLedger(myUid) {
    const db = await rdb()
    const { data, error } = await db
      .from('seed_ledger')
      .select('peer_uid, peer_name, peer_avatar, count')
      .eq('user_id', myUid)
    if (error) throw new Error(error.message)
    return (data ?? []).map((r) => ({
      peerUid: r.peer_uid,
      peerName: r.peer_name,
      peerAvatar: r.peer_avatar,
      count: r.count,
    }))
  },

  /**
   * 批量取若干用户的金瓜子数 —— 房间卡片展示用。
   */
  async getGoldenSeeds(uids) {
    const list = (uids ?? []).filter(Boolean)
    if (!list.length) return {}
    const db = await rdb()
    const { data, error } = await db
      .from('users')
      .select('id, golden_seeds')
      .in('id', list)
    if (error) {
      console.warn('[repo] getGoldenSeeds 失败', error.message)
      return {}
    }
    const map = {}
    for (const r of data ?? []) map[r.id] = r.golden_seeds ?? 0
    return map
  },

  /** 收款后轮转大小麦 —— 仅房主。自动大小麦开启时会同时下注 */
  async rotateBlinds(roomNo) {
    const db = await rdb()
    const { data, error } = await db.rpc('rotate_blinds', { p_room_id: roomNo })
    if (error) throw new Error(error.message)
    return data
  },

  /**
   * 设置房间的自动大小麦开关（房间级，全员从快照读同一状态）
   * 仅房主可调，后端会校验 host_uid
   */
  async setAutoBlind(roomNo, on) {
    const db = await rdb()
    const { data, error } = await db.rpc('set_auto_blind', {
      p_room_id: roomNo,
      p_on: !!on,
    })
    if (error) throw new Error(error.message)
    return data
  },

  /** 关闭自动大小麦：退还已下注的筹码 */
  async resetBlinds(roomNo) {
    const db = await rdb()
    const { data, error } = await db.rpc('reset_blinds', { p_room_id: roomNo })
    if (error) throw new Error(error.message)
    return data
  },

  /** 房主手动指定大小麦 */
  async setBlinds(roomNo, sbUid, bbUid) {
    const db = await rdb()
    const { data, error } = await db.rpc('set_blinds', {
      p_room_id: roomNo,
      p_sb_uid: sbUid || null,
      p_bb_uid: bbUid || null,
    })
    if (error) throw new Error(error.message)
    return data
  },

  /** 房主拖拽调整座位顺序 */
  async reorderSeats(roomNo, uids) {
    const db = await rdb()
    const { data, error } = await db.rpc('reorder_seats', {
      p_room_id: roomNo,
      p_uids: uids,
    })
    if (error) throw new Error(error.message)
    return data
  },

  /** 读取我的账号账本（按账号名记账） */
  async getAccountLedger() {
    const db = await rdb()
    const { data, error } = await db.rpc('account_ledger_rows')
    if (error) throw new Error(error.message)
    return data?.rows ?? []
  },

  /** 与某人结清账本 */
  async clearAccountLedgerRow(peerAccount) {
    const db = await rdb()
    const { error } = await db.rpc('clear_account_ledger_row', { p_peer: peerAccount })
    if (error) throw new Error(error.message)
  },

  /**
   * 金瓜子转账（按账号记账）—— 走 account_seed_transfer RPC。
   *
   * 入参同样是 uid：函数内部查 accounts 表把 uid 换成账号名。
   * 任一方没绑账号时函数返回 skipped，不写任何数据。
   */
  async accountSeedTransfer(fromUid, toUid, amount = 1) {
    const db = await rdb()
    const { data, error } = await db.rpc('account_seed_transfer', {
      p_from_uid: fromUid,
      p_to_uid: toUid,
      p_amount: amount,
    })
    if (error) throw new Error(error.message)
    return data
  },

  /** 金瓜子转账 —— 走 RPC（服务端单事务双向记账） */
  async transferSeeds(fromUid, toUid, amount = 1) {
    const db = await rdb()
    const { error } = await db.rpc('transfer_seeds', {
      p_from_uid: fromUid,
      p_to_uid: toUid,
      p_amount: amount,
    })
    if (error) throw new Error(error.message)
  },

  async clearLedgerEntry(ownerUid, peerUid) {
    const db = await rdb()
    const { error } = await db.rpc('clear_seed_ledger_entry', {
      p_owner_uid: ownerUid,
      p_peer_uid: peerUid,
    })
    if (error) throw new Error(error.message)
  },

  // ── account ──
  /** 当前匿名 uid 绑定的账号；未登录返回 { loggedIn: false } */
  async myAccount() {
    const db = await rdb()
    const { data, error } = await db.rpc('my_account')
    if (error) throw new Error(error.message)
    return data
  },

  /** 账号名是否可用（注册前预检） */
  async accountAvailable(account) {
    const db = await rdb()
    const { data, error } = await db.rpc('account_available', { p_account: account })
    if (error) throw new Error(error.message)
    return data === true
  },

  /** 注册账号（账号名即身份，无密码） */
  async registerAccount(account, nickname, avatar) {
    const db = await rdb()
    const { data, error } = await db.rpc('register_account', {
      p_account: account,
      p_nickname: nickname,
      p_avatar: avatar,
    })
    if (error) throw new Error(error.message)
    return data
  },

  /** 登录账号：按账号名取档案并重绑到当前设备 */
  async loginAccount(account) {
    const db = await rdb()
    const { data, error } = await db.rpc('login_account', { p_account: account })
    if (error) throw new Error(error.message)
    return data
  },

  /** 修改昵称 / 头像 */
  async updateMyAccount(nickname, avatar) {
    const db = await rdb()
    const { data, error } = await db.rpc('update_my_account', {
      p_nickname: nickname ?? null,
      p_avatar: avatar ?? null,
    })
    if (error) throw new Error(error.message)
    return data
  },

  /** 退出登录（解绑，不删账号，金瓜子保留） */
  async logoutAccount() {
    const db = await rdb()
    const { error } = await db.rpc('logout_account')
    if (error) throw new Error(error.message)
  },

  // ── room ──
  async createRoom(cfg) {
    const db = await rdb()
    const myUid = await uid()
    const roomNo = String(Math.floor(100000 + Math.random() * 900000))

    const { error } = await db.from('rooms').insert({
      id: roomNo,
      mode: cfg.mode,
      game_type: cfg.gameType ?? 'long',
      host_uid: myUid,
      initial_seeds: cfg.initialSeeds,
      small_blind: cfg.smallBlind,
      big_blind: cfg.bigBlind,
      max_seats: cfg.maxSeats ?? 8,
      status: 'waiting',
    })
    if (error) throw new Error(error.message)

    // 确保 users 表有我这行。
    // room_members.user_id 外键指向 users(id)；账号体系上线后
    // users 可能没有当前 uid 的行（或被清理脚本清空），
    // 不先补这一行，占座会直接违反外键约束。
    //
    // 2.3：必须用 resolution=ignore-duplicates。
    // upsert({}, {onConflict:'id'}) 会覆盖所有已传列，
    // 以前顺带传 golden_seeds:0/total_games:0，
    // 结果每建一次房、每加入一次房，users 行的数据就被清一次。
    // 现在只传身份列，且冲突时完全不动已有行。
    const { error: uErr } = await db
      .from('users')
      .upsert(
        {
          id: myUid,
          nickname: cfg.me.nickname,
          avatar: cfg.me.avatar,
        },
        { onConflict: 'id', ignoreDuplicates: true }
      )
    if (uErr) console.warn('[createRoom] users 补行失败', uErr.message)

    // 房主占 1 号位。
    // 用 insert 而不是 upsert：upsert 在 RLS 下需要 SELECT 权限，
    // 会触发 members_select_room → is_room_member 的连锁检查。
    const { error: e2 } = await db.from('room_members').insert({
      room_id: roomNo,
      user_id: myUid,
      seat_no: 1,
      nickname: cfg.me.nickname,
      avatar: cfg.me.avatar,
      seeds: cfg.initialSeeds,
    })
    if (e2) throw new Error(e2.message)

    return { roomNo }
  },

  async joinRoom(roomNo, me) {
    // 用游客视角取快照：新成员还没进房，成员校验必然失败。
    // 游客视角只返回房间公开配置 + 已占座数，不泄露其他玩家信息。
    const snap = await this.roomSnapshot(roomNo, true)
    if (!snap) throw new Error('房间不存在')
    if (snap.isFull) throw new Error('房间已满')

    // 取正式快照判断自己是否已在房（房主/成员视角会成功，否则抛错）
    let full = null
    try {
      full = await this.roomSnapshot(roomNo, false)
    } catch {
      /* 还不是成员，正常，下面会占座 */
    }
    if (full?.seats?.some((s) => s.uid === full.myUid)) return full

    const db = await rdb()
    // 确保 users 有我这行：room_members.user_id 外键指向 users(id)，
    // 匿名用户首次加入时表里可能还没记录，FK 会先于 RLS 拦截。
    // 2.3：冲突时不动已有行，不再把 users 的金瓜子/局数清零。
    const { error: uErr } = await db
      .from('users')
      .upsert(
        {
          id: snap.myUid,
          nickname: me.nickname,
          avatar: me.avatar,
        },
        { onConflict: 'id', ignoreDuplicates: true }
      )
    // upsert 失败会让下面的占座违反外键约束，所以必须中止并告知
    if (uErr) throw new Error('身份初始化失败：' + uErr.message)

    const seatNo = snap.seatCount + 1
    // insert 而非 upsert：避免 upsert 的 SELECT 触发 RLS 连锁检查
    const { error } = await db.from('room_members').insert({
      room_id: roomNo,
      user_id: snap.myUid,
      seat_no: seatNo,
      nickname: me.nickname,
      avatar: me.avatar,
      seeds: snap.initialSeeds,
    })
    if (error) throw new Error(error.message)

    return this.roomSnapshot(roomNo)
  },

  /** 线上房间退出：删除房间，零留存 */
  async leaveRoom(roomNo) {
    const db = await rdb()
    const { error } = await db.rpc('leave_online_room', { p_room_id: roomNo })
    if (error) throw new Error(error.message)
  },

  /** 退出座位（线下模式用：不删房间，只移除自己） */
  async leaveSeat(roomNo) {
    const db = await rdb()
    const { error } = await db
      .from('room_members')
      .delete()
      .eq('room_id', roomNo)
      .eq('user_id', await uid())
    if (error) throw new Error(error.message)
  },

  /** 删除整个房间（线下模式下房主离开用：避免残留空房间） */
  async deleteRoom(roomNo) {
    const db = await rdb()
    const { error } = await db.from('rooms').delete().eq('id', roomNo)
    if (error) throw new Error(error.message)
  },

  /** 可加入的存活房间列表（服务端过滤，只暴露公开信息） */
  async listJoinableRooms(limit = 20) {
    const db = await rdb()
    const { data, error } = await db.rpc('list_joinable_rooms', { p_limit: limit })
    if (error) throw new Error(error.message)
    return data?.rooms ?? []
  },

  async getRoom(roomNo) {
    const db = await rdb()
    const { data: room, error: e1 } = await db
      .from('rooms')
      .select('*')
      .eq('id', roomNo)
      .maybeSingle()
    if (e1) throw new Error(e1.message)
    if (!room) return null

    const { data: members, error: e2 } = await db
      .from('room_members')
      .select('*')
      .eq('room_id', roomNo)
      .order('seat_no')
    if (e2) throw new Error(e2.message)

    return { room, members: members ?? [] }
  },

  /**
   * 房间快照 — 走 room_snapshot RPC
   * 比分别查 rooms / room_members 少一次往返，且统一做成员校验
   */
  /**
   * 轻量探针：一次查询拿到房间「指纹」，不拉 50 行流水。
   *
   * ⚠️ 历史教训：最初这里只读 rooms.updated_at，
   *    结果 joinRoom 只往 room_members 插行、不碰 rooms，
   *    房东的探针永远判定「没动静」，退避轮询就不拉全量，
   *    屏幕上就是看不到人加入。探针的覆盖面必须 >= 权威状态。
   *
   * 现在的指纹由服务端拼：updated_at + 成员数 + sum(seeds)
   *                       + sum(bet) + round_status + pot
   * 覆盖了加入/退出、出款/收款、结算重置、状态流转。
   */
  async getRoomFingerprint(roomNo) {
    const db = await rdb()
    const { data, error } = await db.rpc('get_room_fingerprint', {
      p_room_id: roomNo,
    })
    if (error) throw new Error(error.message)
    return data ?? ''
  },

  async roomSnapshot(roomNo, guest = false) {
    const db = await rdb()
    const { data, error } = await db.rpc('room_snapshot', {
      p_room_id: roomNo,
      p_guest: guest,
    })
    if (error) throw new Error(error.message)
    return data
  },

  /**
   * 出瓜子 / 收瓜子 — 走 move_pot RPC（单事务）
   * @param {string} roomNo
   * @param {number} amount >0 出瓜子（我的→公共池）；<0 收瓜子
   * @returns {{pot:number, mySeeds:number, delta:number}}
   */
  async movePot(roomNo, amount) {
    const db = await rdb()
    const { data, error } = await db.rpc('move_pot', {
      p_room_id: roomNo,
      p_amount: amount,
    })
    if (error) throw new Error(error.message)
    return data
  },

  /**
   * 线下结算 — 走 offline_settle RPC
   * @param {string} roomNo
   * @param {Array<{fromUid,toUid,amount}>} transfers 金瓜子转账
   * @param {boolean} saveHistory 是否写历史
   */
  async offlineSettle(roomNo, transfers = [], saveHistory = true) {
    const db = await rdb()
    const { data, error } = await db.rpc('offline_settle', {
      p_room_id: roomNo,
      p_transfers: transfers,
      p_save_history: saveHistory,
    })
    if (error) throw new Error(error.message)
    return data
  },

  /**
   * 实时订阅房间变更。
   *
   * 优先 Postgres CDC（官方文档对新版 PG 模式已支持，但旧迁移页说不行，
   * 需实测）。CDC 不可用时降级为轮询。
   *
   * 注意：CDC 的 poller 会持续产生数据库处理，可能触发
   * 「共享实例按使用计费」—— 每个 5 分钟窗口都算有使用。
   * 若在意免费额度，改用 Broadcast 或轮询。
   */
  subscribeRoom(roomNo, cb) {
    let channel = null
    let pollTimer = null
    let closed = false

    ;(async () => {
      try {
        const app = await ensureApp()
        const realtime = app.realtime()
        channel = realtime.channel(`room-${roomNo}`, {
          config: { postgres_changes_options: { wait: true, timeout: 10000 } },
        })

        channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'rooms',
            filter: `id=eq.${roomNo}` },
          async () => {
            if (closed) return
            const snapshot = await this.getRoom(roomNo)
            if (snapshot) cb(snapshot)
          }
        )

        channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'room_members',
            filter: `room_id=eq.${roomNo}` },
          async () => {
            if (closed) return
            const snapshot = await this.getRoom(roomNo)
            if (snapshot) cb(snapshot)
          }
        )

        channel.subscribe((status) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            // CDC 不可用 → 降级轮询
            startPolling()
          }
        })
      } catch {
        startPolling()
      }
    })()

    function startPolling() {
      if (pollTimer || closed) return
      pollTimer = setInterval(async () => {
        if (closed) return
        const snapshot = await cloudRepo.getRoom(roomNo)
        if (snapshot) cb(snapshot)
      }, 2000)
    }

    return () => {
      closed = true
      if (pollTimer) clearInterval(pollTimer)
      if (channel) channel.unsubscribe?.()
    }
  },

  // ── history ──
  async listHistory() {
    const db = await rdb()
    const myUid = await uid()
    const { data, error } = await db
      .from('history')
      .select('*')
      .eq('created_by', myUid)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw new Error(error.message)
    return (data ?? []).map((r) => ({
      id: String(r.id),
      at: new Date(r.created_at).getTime(),
      roomNo: r.room_no,
      roundNo: r.round_no,
      initialSeeds: r.initial_seeds,
      smallBlind: r.small_blind,
      bigBlind: r.big_blind,
      players: r.players,
      seedsMoves: r.seeds_moves,
    }))
  },

  async addHistory(game) {
    const db = await rdb()
    const myUid = await uid()
    const { error } = await db.from('history').insert({
      room_no: game.roomNo,
      mode: game.mode,
      round_no: game.roundNo,
      initial_seeds: game.initialSeeds,
      small_blind: game.smallBlind,
      big_blind: game.bigBlind,
      players: game.players,
      seeds_moves: game.seedsMoves ?? [],
      created_by: myUid,
    })
    if (error) throw new Error(error.message)
  },

  async clearHistory() {
    // RLS 只允许删自己的；这里需要一个 RPC 更稳妥，
    // 但 history 目前只读 + 云函数写，暂不提供前端删除
    console.warn('[cloudRepo] 云端历史清空需走云函数，暂未实现')
  },
}
