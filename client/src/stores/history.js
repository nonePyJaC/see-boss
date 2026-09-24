/**
 * 线下对局历史记录 store
 *
 * 只记录线下模式（实体牌 + 手机计分器）的赛果。线上模式零留存，不写这里。
 *
 * 2026-09-24：从 localStorage 改成服务端 /api/account/history。
 * 服务端在结算时已经写了 history 表，前端这里只负责拉。
 */

import { ref } from 'vue'
import { accountRepo } from '../data/account-repo.js'

const MAX_GAMES = 100

const games = ref([])
const loaded = ref(false)
const loading = ref(false)

async function refresh() {
  loading.value = true
  try {
    const r = await accountRepo.history()
    if (r.ok) {
      const rows = r.data?.rows ?? r.data ?? []
      games.value = Array.isArray(rows) ? rows.slice(0, MAX_GAMES) : []
    }
  } finally {
    loading.value = false
    loaded.value = true
  }
  return games.value
}

/** 兼容旧调用名。历史由服务端结算时写，前端不提供本地 add。 */
async function initFromCloud() { return refresh() }

export function useHistory() {
  return { games, loaded, loading, refresh, initFromCloud }
}
