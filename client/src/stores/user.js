/**
 * 用户档案 store — 本地优先 + 云端持久化
 *
 * 策略：
 *   注册/登录信息（uid/昵称/头像）写 localStorage，保证离线可用
 *   金瓜子与账本以云端为准，本地做缓存和乐观更新
 *
 * 云端模式：
 *   uid 来自 CloudBase 匿名登录的 sub（稳定，换设备会变）
 *   getProfile / upsertProfile 走 users 表
 *   transferSeeds / clearLedgerEntry 走 RPC（服务端单事务）
 */

import { ref, computed, readonly } from 'vue'
import { repo, usingCloud } from '../data/repo.js'
import { readIdentity, writeIdentity } from '../data/identity.js'

const STORAGE_KEY = 'hamster-poker:user'
const LEDGER_KEY = 'hamster-poker:seed-ledger'

const user = ref(null)
/** 账本：peerUid → { nickname, avatar, count } */
const ledger = ref({})
/** 云端同步状态 */
const syncing = ref(false)
const syncError = ref('')
/** 本次启动是否靠兜底记忆恢复了身份（用于给用户一个提示） */
const showRestored = ref(false)

// ── 本地缓存读写 ──
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) user.value = JSON.parse(raw)
    const rawLedger = localStorage.getItem(LEDGER_KEY)
    if (rawLedger) ledger.value = JSON.parse(rawLedger)
  } catch {
    user.value = null
    ledger.value = {}
  }
}

function persist() {
  if (user.value) localStorage.setItem(STORAGE_KEY, JSON.stringify(user.value))
  localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger.value))
}

load()

const isRegistered = computed(() => !!user.value)
const goldenSeeds = computed(() => user.value?.goldenSeeds ?? 0)

/** 账本列表（每仓鼠一行），按绝对值降序 */
const ledgerRows = computed(() =>
  Object.entries(ledger.value)
    .map(([uid, v]) => ({ uid, ...v }))
    .sort((a, b) => Math.abs(b.count) - Math.abs(a.count))
)

/**
 * 初始化：云端模式下拉取档案并覆盖本地缓存
 * 在 App 启动时调用（见 main.js → initData 之后）
 */
async function initFromCloud() {
  if (!usingCloud) return
  try {
    syncing.value = true
    syncError.value = ''
    const { uid: cloudUid } = await repo.signIn()
    if (!cloudUid) throw new Error('未拿到云端 uid')

    // 身份一致性校验：
    // 本地档案可能属于旧的匿名身份（缓存被清、换设备等）。
    // 若不一致，以云端 uid 为准重新建档，避免档案与数据脱节。
    if (user.value && user.value.uid !== cloudUid) {
      console.warn(
        `[user] 本地 uid(${user.value.uid}) 与云端(${cloudUid}) 不一致，改用云端身份`
      )
      user.value = { ...user.value, uid: cloudUid }
      persist()
    }

    // ⚠️ 金瓜子的唯一权威来源是 accounts 表，不是 users 表。
    // users 表是账号体系之前的旧账本，早就不写了，
    // 但 getProfile() 读的是它 —— 曾经靠 applyLedgerRows 的
    // 账本总和覆盖来纠偏，现在那处覆盖已按口径分家删掉，
    // 于是启动时再没人纠正本地值，localStorage 里的陈旧数字
    // （例如一次单向和解留下的 -2）就一路带着跑，刷新也不消失。
    //
    // 所以这里改成：账号用户一律以 my_account() 为准，
    // users 表只给游客身份兜底。
    const acct = await repo.myAccount()

    if (acct?.loggedIn) {
      // 账号用户：昵称头像取较新的一份，金瓜子/局数以 accounts 为准
      const profile = await repo.getProfile(cloudUid).catch(() => null)
      user.value = {
        uid: cloudUid,
        account: acct.account,
        nickname: acct.nickname ?? profile?.nickname ?? user.value?.nickname,
        avatar: acct.avatar ?? profile?.avatar ?? user.value?.avatar,
        goldenSeeds: Number(acct.goldenSeeds ?? 0),
        totalGames: Number(acct.totalGames ?? 0),
        createdAt: user.value?.createdAt ?? Date.now(),
      }
      persist()
      writeIdentity({ nickname: user.value.nickname, avatar: user.value.avatar })
    } else {
      // 游客身份：没有可归属账号，旧 users 表兜底
      const profile = await repo.getProfile(cloudUid)
      if (profile) {
        user.value = { uid: cloudUid, ...profile, createdAt: user.value?.createdAt ?? Date.now() }
        writeIdentity({ nickname: profile.nickname, avatar: profile.avatar })
      } else if (user.value?.uid === cloudUid) {
        // 本地有注册信息且 uid 一致但云端没有 → 上传
        await repo.upsertProfile({ ...user.value, uid: cloudUid })
        writeIdentity(user.value)
      } else {
        // 本地 uid 与云端不一致且云端无档案：
        // 典型场景是微信清了 localStorage 导致 uid 变了。
        // 有兜底记忆就直接用它重建档案，不再把用户打回注册页。
        const mem = readIdentity()
        if (mem) {
          console.info('[user] uid 已变，用兜底记忆自动恢复身份', mem.nickname)
          user.value = {
            uid: cloudUid,
            nickname: mem.nickname,
            avatar: mem.avatar ?? 1,
            goldenSeeds: 0,
            totalGames: 0,
            createdAt: Date.now(),
          }
          await repo.upsertProfile({ ...user.value })
          writeIdentity(mem)
          showRestored.value = true
        }
      }
    }

    // 拉账号账本（按账号名记账，换设备后仍在）
    if (user.value?.account) {
      try {
        const rows = await repo.getAccountLedger()
        applyLedgerRows(rows)
      } catch (e) {
        console.warn('[user] 账号账本拉取失败', e?.message ?? e)
      }
    } else {
      // 游客身份没有可归属账本，读旧的 users 账本兜底
      const rows = await repo.getLedger(cloudUid)
      applyLedgerRows(rows)
    }
  } catch (e) {
    syncError.value = e?.message ?? String(e)
    console.error('[user] 云端同步失败，使用本地缓存', e)
  } finally {
    syncing.value = false
  }
}

/**
 * 重新拉一次「我的」档案：金瓜子、局数。
 *
 * 用途：结算后服务端已把 accounts.total_games +1，
 *       这里把最新值读回来，界面立刻跟上，且刷新后仍在。
 *
 * 为什么不能依赖 repo.getProfile：它查的是 users 表，
 * 账号体系上线后金瓜子和局数都迁到了 accounts 表。
 */
async function refreshMyProfile() {
  if (!usingCloud) return user.value
  const uid = user.value?.uid
  if (!uid) return user.value
  try {
    // 账号用户：读 accounts（金瓜子 + 局数都在这里）
    const acct = await repo.myAccount()
    if (acct?.loggedIn) {
      user.value = {
        ...user.value,
        account: acct.account,
        nickname: acct.nickname ?? user.value.nickname,
        avatar: acct.avatar ?? user.value.avatar,
        goldenSeeds: Number(acct.goldenSeeds ?? 0),
        totalGames: Number(acct.totalGames ?? 0),
      }
    } else {
      // 游客身份：旧 users 表兜底
      const profile = await repo.getProfile(uid)
      if (profile) user.value = { ...user.value, ...profile }
    }
    persist()
  } catch (e) {
    console.warn('[user] 刷新档案失败', e?.message ?? e)
  }
  return user.value
}

/**
 * 用云端账号档案覆盖本地（启动时自动登录）
 * @param {{account,nickname,avatar,goldenSeeds,totalGames}} profile
 */
async function adoptAccount(profile) {
  const { uid: cloudUid } = await repo.signIn()
  if (!cloudUid) throw new Error('未拿到云端 uid')

  // ⚠️ 金瓜子/局数必须以服务端 accounts 表为准，
  //    不能用调用方传进来的 profile —— 那个值常常是从
  //    localStorage 读的陈旧缓存。
  //
  // 线上事故：用户显示金瓜子 -2，服务端 accounts 与 account_ledger
  // 查询都是空的（即权威值为 0）。原因是启动走了
  //   main.js: if (accountProfile) adoptAccount(accountProfile)
  // 而不是 initFromCloud()，而 accountProfile 来自本地缓存，
  // 里面的 -2 被原样写回 store，刷新多少次都不消失
  // （initFromCloud 里那套 accounts 优先的逻辑压根没执行到）。
  let goldenSeeds = Number(profile.goldenSeeds ?? 0)
  let totalGames = Number(profile.totalGames ?? 0)
  let nickname = profile.nickname
  let avatar = profile.avatar
  try {
    const acct = await repo.myAccount()
    if (acct?.loggedIn && acct.account === profile.account) {
      goldenSeeds = Number(acct.goldenSeeds ?? 0)
      totalGames = Number(acct.totalGames ?? 0)
      nickname = acct.nickname ?? nickname
      avatar = acct.avatar ?? avatar
    }
  } catch (e) {
    console.warn('[user] adoptAccount 拉取权威档案失败，用传入值', e?.message ?? e)
  }

  user.value = {
    uid: cloudUid,
    account: profile.account,
    nickname,
    avatar,
    goldenSeeds,
    totalGames,
    createdAt: Date.now(),
  }
  persist()
  // 兜底记忆同步刷一遍
  writeIdentity({ nickname, avatar })

  // 账本也以服务端为准，顺手把本地的陈旧行覆盖掉
  if (usingCloud) {
    try {
      applyLedgerRows(await repo.getAccountLedger())
    } catch (e) {
      console.warn('[user] adoptAccount 拉账本失败', e?.message ?? e)
    }
  }
}

/** 注册 / 更新资料 */
async function register(data) {  // uid 必须来自云端匿名身份，不能随机生成 ——
  // 随机 uid 在云端没有对应身份，RLS 会拒绝所有读写
  const uid = data.uid ?? user.value?.uid
  if (!uid) throw new Error('注册失败：未拿到用户身份')

  user.value = {
    uid,
    nickname: data.nickname,
    avatar: data.avatar,
    goldenSeeds: data.goldenSeeds ?? 0,
    totalGames: data.totalGames ?? 0,
    createdAt: Date.now(),
  }
  persist()
  // 记住昵称 + 头像，uid 丢失时能自动恢复，不必重新注册
  writeIdentity({ nickname: data.nickname, avatar: data.avatar })

  if (usingCloud) {
    try {
      await repo.upsertProfile(user.value)
    } catch (e) {
      console.error('[user] 档案上传失败', e)
    }
  }
}

function update(patch) {
  if (!user.value) return
  user.value = { ...user.value, ...patch }
  persist()
}

/** 本地调整金瓜子（不改账本，仅用于展示兜底） */
function addGoldenSeeds(delta) {
  if (!user.value) return
  user.value = { ...user.value, goldenSeeds: user.value.goldenSeeds + delta }
  persist()
}

/**
 * 记一笔账（双向）
 *
 * 云端模式走 RPC transfer_seeds（服务端单事务改双方账本），
 * 本地同时乐观更新，保证 UI 立即响应。
 *
 * @param {string} peerUid
 * @param {{nickname:string, avatar:number}} peer
 * @param {number} count >0 他给你；<0 你给他
 */
async function recordSeed(peerUid, peer, count) {
  if (count === 0) return

  if (usingCloud && user.value) {
    try {
      // 云端：我是收款方(count>0) → 从 peer 转给我
      //       我是付款方(count<0) → 我从 peer 转出
      //
      // 2.2：账号用户必须走账号名转账。
      //       repo.transferSeeds 写的是旧 users.golden_seeds / seed_ledger
      //       （uid 键），结算走的是 accounts / account_ledger（账号名键）。
      //       两表脱节，导致「写了读不回」。
      //       account_seed_transfer 接收账号名，peer 对象需带 account 字段。
      //
      // account_seed_transfer 的入参是 uid（函数内部自己查 accounts 表
      // 换成账号名），所以这里继续传 uid —— 前端拿不到对方的账号名。
      // 任一方没绑账号时函数会返回 skipped，不会写坏数据。
      const amount = Math.abs(count)
      const mine = user.value.uid
      if (count > 0) await repo.accountSeedTransfer(peerUid, mine, amount)
      else await repo.accountSeedTransfer(mine, peerUid, amount)

      // 云端成功后重拉账本，保证与权威数据一致
      if (user.value?.account) {
        const rows = await repo.getAccountLedger()
        applyLedgerRows(rows)
      } else {
        const rows = await repo.getLedger(user.value.uid)
        applyLedgerRows(rows)
      }
      return
    } catch (e) {
      console.error('[user] 云端转账失败，回退本地记账', e)
      syncError.value = e?.message ?? String(e)
    }
  }

  // 本地记账
  const cur = ledger.value[peerUid]
  const next = (cur?.count ?? 0) + count
  if (next === 0) {
    delete ledger.value[peerUid]
  } else {
    ledger.value[peerUid] = { nickname: peer.nickname, avatar: peer.avatar, count: next }
  }
  addGoldenSeeds(count)
  persist()
}

/** 用云端返回的账本覆盖本地 */
function applyLedgerRows(rows) {
  const next = {}
  for (const r of rows) {
    // 账号账本（account_ledger）的 key 是对方账号名，字段名也不同
    const key = r.peerUid ?? r.peer ?? r.peerAccount ?? r.peer_uid
    // 必须是 continue：坏一行就 return 的话，整个账本和总数都不更新。
    if (!key) continue
    const nickname = r.peerName ?? r.peer_name ?? r.peer_nickname ?? String(key)
    const avatar = r.peerAvatar ?? r.peer_avatar ?? 1
    next[key] = { nickname, avatar, count: r.count }
  }
  ledger.value = next
  // ⚠️ 不要在这里用账本总和覆盖 goldenSeeds。
  // accounts.golden_seeds 才是权威口径；account_ledger 只是往来明细，
  // 汇总是个片段口径（清零过的行会被 DELETE），两者迟早对不上。
  // 数字由 refreshMyProfile() → my_account() 读回。
  persist()
}

/**
 * 清空账本某一行（双方同时清，避免坏账）
 *
 * 云端走 RPC clear_seed_ledger_entry（单事务冲销双方账面）。
 *
 * @returns {Promise<number>} 我方原账目数
 */
async function clearLedgerRow(peerUid) {
  const row = ledger.value[peerUid]
  if (!row) return 0
  const ownerCount = row.count

  if (usingCloud && user.value) {
    try {
      // 2.2：账号用户的账本行 key 是「账号名」，不是 uid。
      //       clear_seed_ledger_entry（uid 版）清不到账号账本，按钮等于无效。
      if (user.value?.account) {
        await repo.clearAccountLedgerRow(peerUid)
        const rows = await repo.getAccountLedger()
        applyLedgerRows(rows)
      } else {
        await repo.clearLedgerEntry(user.value.uid, peerUid)
        const rows = await repo.getLedger(user.value.uid)
        applyLedgerRows(rows)
      }
      return ownerCount
    } catch (e) {
      console.error('[user] 云端清账失败，回退本地', e)
      syncError.value = e?.message ?? String(e)
    }
  }

  delete ledger.value[peerUid]
  addGoldenSeeds(-ownerCount)
  persist()
  return ownerCount
}

/** 清空全部数据（需求要求支持清空） */
function resetAll() {
  user.value = null
  ledger.value = {}
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(LEDGER_KEY)
}

export function useUser() {
  return {
    user: readonly(user),
    ledger: readonly(ledger),
    isRegistered,
    goldenSeeds,
    ledgerRows,
    syncing: readonly(syncing),
    syncError: readonly(syncError),
    initFromCloud,
    adoptAccount,
    // 账号相关方法定义在 userStore 上，这里转发引用，保证同一份实现
    signInWithAccount: userStore.signInWithAccount,
    logout: userStore.logout,
    rememberIdentity: userStore.rememberIdentity,
    register,
    update,
    addGoldenSeeds,
    recordSeed,
    clearLedgerRow,
    refreshMyProfile,
    resetAll,
  }
}

/**
 * store 内部状态是模块级 ref，先定义再导出，
 * 这样 useUser() 和 userStore 拿到的是同一份实现。
 */
const userStore = {
  initFromCloud,
  adoptAccount,
  refreshMyProfile,
  /**
   * 登录 / 注册成功后调用：把账号档案写进本地并同步
   * @param {{account,nickname,avatar,goldenSeeds,totalGames}} profile
   */
  async signInWithAccount(profile) {
    const uid = (await repo.signIn()).uid
    user.value = {
      uid,
      account: profile.account,
      nickname: profile.nickname,
      avatar: profile.avatar,
      goldenSeeds: profile.goldenSeeds ?? 0,
      totalGames: profile.totalGames ?? 0,
      createdAt: Date.now(),
    }
    persist()
    writeIdentity({ nickname: profile.nickname, avatar: profile.avatar })
    return user.value
  },
  get user() {
    return user.value
  },
  get goldenSeeds() {
    return goldenSeeds.value
  },
  get ledgerRows() {
    return ledgerRows.value
  },
  get syncing() {
    return syncing.value
  },
  get syncError() {
    return syncError.value
  },
  /** 本次是否靠兜底记忆恢复了身份 */
  get showRestored() {
    return showRestored.value
  },
  /** 退出登录：只清本地，服务端解绑由调用方负责 */
  logout() {
    user.value = null
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {}
  },
  /** 写入兜底身份（注册 / 改昵称头像时调用） */
  rememberIdentity(data) {
    writeIdentity(data)
  },
}

export { userStore }
