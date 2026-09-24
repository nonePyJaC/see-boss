/**
 * 用户档案 store —— 只读服务端，本地不留副本。
 *
 * 2026-09-24 重写：原版是「本地优先 + 云端同步」的双源设计，
 * 金瓜子/账本在 localStorage 和 CloudBase 各存一份，改的时候容易双账
 * （spec 修缮清单 2.2 记着这个坑）。现在 CloudBase 整个退役，
 * 账号、金瓜子、账本、历史全部由服务端 SQLite 持有，
 * 这里只包一层响应式缓存，供模板直接用。
 *
 * 身份凭据 = localStorage 里的 uid（account-repo.getUid 生成并长期保存）。
 */

import { ref, computed } from 'vue'
import { accountRepo } from '../data/account-repo.js'
import { readIdentity, writeIdentity, clearIdentity } from '../data/identity.js'

const user = ref(null)
const ledger = ref([])
const history = ref([])
const loading = ref(false)

const isRegistered = computed(() => !!user.value?.loggedIn)
const goldenSeeds = computed(() => user.value?.goldenSeeds ?? 0)
const nickname = computed(() => user.value?.nickname ?? '')
const accountName = computed(() => user.value?.account ?? '')

/** 拉账号档案 + 账本 + 历史，一次拉全 */
async function refresh() {
  loading.value = true
  try {
    const m = await accountRepo.me()
    user.value = m.ok ? m.data : null
    if (m.ok && m.data?.loggedIn) {
      const [l, h] = await Promise.all([accountRepo.ledger(), accountRepo.history()])
      ledger.value = l.ok ? l.data?.rows ?? l.data ?? [] : []
      history.value = h.ok ? h.data?.rows ?? h.data ?? [] : []
    }
  } finally {
    loading.value = false
  }
  return user.value
}

/** 登录 / 注册：账号名即身份 */
async function signInWithAccount(a, b) {
  // 两种调用方式都支持：signInWithAccount(profile) 或 signInWithAccount(account, nickname)
  const acct = typeof a === 'string' ? a : a?.account
  const nick = typeof a === 'string' ? b : a?.nickname
  const r = await accountRepo.login(acct, nick)
  if (!r.ok) throw new Error(r.error || '登录失败')
  user.value = r.data
  writeIdentity({ nickname: r.data?.nickname || acct, avatar: r.data?.avatar })
  await refresh()
  return r.data
}

/** 改昵称 / 头像 */
async function updateProfile(patch) {
  const r = await accountRepo.updateProfile(patch)
  if (!r.ok) throw new Error(r.error || '更新失败')
  await refresh()
  return r.data
}

async function logout() {
  await accountRepo.logout()
  user.value = null
  ledger.value = []
  history.value = []
}

/**
 * 账本行 → 档案页行。
 * uid 位放的是对手「账号名」（peerAccount）—— 长按清行时原样传回服务端；
 * 昵称/头像用转账时记下的快照，没有就退回账号名。
 */
const ledgerRows = computed(() => ledger.value.map((r) => ({
  uid: r.peerAccount,
  nickname: r.peerName ?? r.peerAccount,
  avatar: r.peerAvatar ?? 1,
  count: r.count,
})))

/** 长按清一行：服务端双向冲销（双方账本同时清），再刷新本页数据 */
async function clearLedgerRow(peerAccount) {
  const r = await accountRepo.clear(peerAccount)
  if (!r.ok) throw new Error(r.error || '清空失败')
  await refresh()
  return r.data
}

/** 清空全部数据：退出登录 + 抹掉本机身份（uid / 昵称缓存），回到注册页。
 *  金瓜子绑在账号名上，之后用同名账号还能登回来。 */
async function resetAll() {
  try { await accountRepo.logout() } catch {}
  clearIdentity()
  accountRepo.clearUid()
  user.value = null
  ledger.value = []
  history.value = []
}

/** 兜底记忆（iOS 微信 WebView 清 localStorage 时至少不用重输昵称） */
const cached = () => readIdentity()

export function useUser() {
  return {
    user, ledger, ledgerRows, history, loading,
    isRegistered, goldenSeeds, nickname, accountName,
    refresh, signInWithAccount, updateProfile, logout,
    clearLedgerRow, resetAll, cached,
  }
}
