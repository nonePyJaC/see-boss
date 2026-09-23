<script setup>
/**
 * 历史记录页 —— 只记录线下对局
 *
 * 线上模式零留存，不出现在这里。
 */
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { hamsterDataURI, getHamster } from '@shared/assets/hamsters.mjs'
import { useHistory } from '../stores/history.js'
import { useUser } from '../stores/user.js'

const router = useRouter()
const { user } = useUser()
const { games, stats, clearAll } = useHistory()

if (!user.value) router.replace('/register')

const confirmClear = ref(false)

function avatarURI(id) {
  return hamsterDataURI(getHamster(id), 48)
}

function fmtTime(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 一局里赢得最多的人 */
function topWinner(g) {
  return [...g.players].sort((a, b) => b.delta - a.delta)[0]
}

const hasGames = computed(() => games.value.length > 0)

function doClear() {
  clearAll()
  confirmClear.value = false
}
</script>

<template>
  <div class="page history" v-if="user">
    <header class="head">
      <button class="back-btn" @click="router.back()">‹</button>
      <h1>历史记录</h1>
      <div class="head-space"></div>
    </header>

    <!-- 汇总 -->
    <div class="card stats-card" v-if="hasGames">
      <div class="stat">
        <span class="stat-num">{{ stats().totalGames }}</span>
        <span class="stat-label">对局</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ stats().totalRounds }}</span>
        <span class="stat-label">局数</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ stats().totalSeedMoves }}</span>
        <span class="stat-label">金瓜子流转</span>
      </div>
    </div>

    <p v-else class="empty text-light">还没有线下对局记录</p>

    <!-- 对局列表 -->
    <div class="game-list" v-if="hasGames">
      <div v-for="g in games" :key="g.id" class="card game-card">
        <div class="row row--between">
          <div>
            <div class="g-room">房间 {{ g.roomNo }}</div>
            <div class="g-meta text-sm text-light">
              第 {{ g.roundNo }} 局 · 初始 {{ g.initialSeeds }} · 盲注 {{ g.smallBlind }}/{{ g.bigBlind }}
            </div>
          </div>
          <div class="g-time text-sm text-light">{{ fmtTime(g.at) }}</div>
        </div>

        <!-- 玩家结果 -->
        <div class="g-players">
          <div v-for="p in g.players" :key="p.uid" class="g-player">
            <div class="avatar avatar--xs">
              <img :src="avatarURI(p.avatar)" :alt="p.nickname" />
            </div>
            <span class="g-name">{{ p.nickname }}</span>
            <span class="g-delta" :class="p.delta > 0 ? 'up' : p.delta < 0 ? 'down' : ''">
              {{ p.delta > 0 ? '+' : '' }}{{ p.delta }}
            </span>
          </div>
        </div>

        <!-- 金瓜子流转 -->
        <div class="g-moves" v-if="g.seedsMoves.length">
          <span class="move-title">金瓜子</span>
          <span v-for="(m, i) in g.seedsMoves" :key="i" class="move-item">
            {{ m.fromName }} → {{ m.toName }}
          </span>
        </div>
      </div>
    </div>

    <div class="foot" v-if="hasGames">
      <button class="btn btn--ghost btn--sm" @click="confirmClear = true">清空历史记录</button>
    </div>

    <!-- 清空确认 -->
    <div v-if="confirmClear" class="mask" @click.self="confirmClear = false">
      <div class="dialog">
        <h3 class="dlg-title">确认清空历史记录？</h3>
        <p class="text-sm text-light">只清对局历史，不影响金瓜子账本。</p>
        <div class="row" style="margin-top: 18px">
          <button class="btn btn--ghost grow" @click="confirmClear = false">取消</button>
          <button class="btn btn--danger grow" @click="doClear">确认清空</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history {
  padding: calc(12px + var(--sat)) 14px calc(14px + var(--sab));
  gap: 12px;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.head h1 {
  font-size: 19px;
  margin: 0;
  flex: 1;
}

.head-space {
  width: 36px;
}

.back-btn {
  width: 36px;
  height: 36px;
  border: 2px solid var(--c-border);
  border-radius: 50%;
  background: #fff;
  font-size: 22px;
  line-height: 1;
  color: var(--c-text-light);
  cursor: pointer;
}

.stats-card {
  display: flex;
  justify-content: space-around;
  padding: 14px;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.stat-num {
  font-size: 22px;
  font-weight: 800;
  color: var(--c-primary-dark);
}

.stat-label {
  font-size: 11px;
  color: var(--c-text-light);
}

.empty {
  text-align: center;
  padding: 40px 0;
  font-size: 14px;
}

.game-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.game-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
}

.g-room {
  font-size: 15px;
  font-weight: 800;
}

.g-meta {
  margin-top: 2px;
}

.g-players {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.g-player {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--c-bg);
  border-radius: 10px;
  padding: 3px 8px 3px 3px;
}

.avatar--xs {
  width: 22px;
  height: 22px;
  border-width: 1px;
}

.g-name {
  font-size: 12px;
  font-weight: 700;
}

.g-delta {
  font-size: 12px;
  font-weight: 800;
  color: var(--c-text-light);
}

.g-delta.up {
  color: var(--c-success);
}

.g-delta.down {
  color: var(--c-danger);
}

.g-moves {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px dashed var(--c-border);
}

.move-title {
  font-size: 10px;
  font-weight: 800;
  color: #6d4c41;
  background: linear-gradient(180deg, #fff59d, #ffd54f);
  border: 1px solid #ffb300;
  border-radius: 7px;
  padding: 1px 6px;
}

.move-item {
  font-size: 11px;
  color: var(--c-text-light);
}

.foot {
  text-align: center;
  padding: 8px 0;
}

.dlg-title {
  margin: 0 0 8px;
  font-size: 17px;
}
</style>
