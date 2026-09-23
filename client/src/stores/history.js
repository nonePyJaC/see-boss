/**
 * 线下对局历史记录 store
 *
 * 只记录线下模式（实体牌 + 手机计分器）的赛果。
 * 线上模式零留存，不写这里。
 *
 * 云端：history 表（RLS 限创建者读，写入走 repo）
 * 本地：localStorage
 */

import { ref, readonly } from 'vue'
import { repo, usingCloud } from '../data/repo.js'

const STORAGE_KEY = 'hamster-poker:history'
const MAX_GAMES = 100

const games = ref([])
const loaded = ref(false)

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      games.value = Array.isArray(parsed?.games) ? parsed.games : []
    }
  } catch {
    games.value = []
  }
}

load()

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ games: games.value }))
}

/** 启动时拉云端历史（本地缓存先渲染，避免白屏） */
async function initFromCloud() {
  if (!usingCloud || loaded.value) return
  try {
    const rows = await repo.listHistory()
    games.value = rows
    loaded.value = true
    persist()
  } catch (e) {
    console.error('[history] 云端拉取失败，用本地缓存', e)
  }
}

/** 记录一局线下对局 */
async function addGame(rec) {
  const game = {
    ...rec,
    id: `g_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  }
  // 乐观更新：先上本地，立即可见
  games.value = [game, ...games.value].slice(0, MAX_GAMES)
  persist()

  if (usingCloud) {
    try {
      await repo.addHistory(rec)
    } catch (e) {
      console.error('[history] 云端写入失败', e)
    }
  }
}

async function clearAll() {
  games.value = []
  localStorage.removeItem(STORAGE_KEY)
  if (usingCloud) {
    try {
      await repo.clearHistory()
    } catch (e) {
      console.error('[history] 云端清空失败', e)
    }
  }
}

/** 汇总统计 */
function stats() {
  const total = games.value.length
  const rounds = games.value.reduce((s, g) => s + (g.roundNo ?? 0), 0)
  const moves = games.value.reduce((s, g) => s + (g.seedsMoves?.length ?? 0), 0)
  return { totalGames: total, totalRounds: rounds, totalSeedMoves: moves }
}

export function useHistory() {
  return {
    games: readonly(games),
    stats,
    initFromCloud,
    addGame,
    clearAll,
  }
}

/** 单例导出 — 供 main.js 等非组件上下文使用 */
export const historyStore = {
  initFromCloud,
  addGame,
  clearAll,
  get games() {
    return games.value
  },
  get stats() {
    return stats()
  },
}
