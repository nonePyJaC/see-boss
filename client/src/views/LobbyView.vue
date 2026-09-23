<script setup>
import { computed, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { hamsterDataURI, getHamster } from '@shared/assets/hamsters.mjs'
import { goldenSeedSVG, svgToDataURI } from '@shared/assets/visuals.mjs'
import { useUser } from '../stores/user.js'
import { repo } from '../data/repo.js'
import { clearIdentity } from '../data/identity.js'

const router = useRouter()
const { user, goldenSeeds, logout } = useUser()

const avatarURI = computed(() => hamsterDataURI(getHamster(user.value?.avatar ?? 1), 80))
const goldURI = svgToDataURI(goldenSeedSVG(18))

/** 账号名显示 */
const accountLabel = computed(() => user.value?.account || '游客')

/** 退出登录：解绑账号，回登录页 */
async function onLogout() {
  if (!confirm('退出后可用账号名重新登录，金瓜子不会丢。确定退出？')) return
  try {
    await repo.logoutAccount()
  } catch (e) {
    console.warn('[logout] 服务端解绑失败', e)
  }
  logout()
  clearIdentity()
  router.replace('/register')
}

// 未注册则回注册页
if (!user.value) router.replace('/register')

/**
 * 被 KeepAlive 恢复时也要校验登录态。
 * App.vue 用 <keep-alive include="LobbyView"> 缓存了本组件，
 * 从房间退出后 replace('/lobby') 会直接恢复缓存实例、
 * 不重跑 setup —— 上面那行守卫就不会执行，
 * 表现为「点了退出但页面像没动」。这里补上。
 */
onActivated(() => {
  if (!user.value) router.replace('/register')
})
</script>

<template>
  <div v-if="user" class="page lobby">
    <!-- 顶部：我的信息 -->
    <header class="lobby-head card">
      <div class="row">
        <div class="avatar avatar--me">
          <img :src="avatarURI" :alt="user.nickname" />
        </div>
        <div class="grow">
          <div class="me-name">
            {{ user.nickname }}
            <span v-if="accountLabel !== '游客'" class="account-tag">@{{ accountLabel }}</span>
          </div>
          <div class="row" style="gap: 6px">
            <span class="gold-badge">
              <img :src="goldURI" class="inline-gold" alt="" />
              {{ goldenSeeds }}
            </span>
            <span class="text-sm text-light">已玩 {{ user.totalGames }} 局</span>
          </div>
        </div>        <div class="row" style="gap: 6px">
          <button class="btn btn--ghost btn--sm" @click="router.push('/profile')">
            我的
          </button>
          <button class="btn btn--ghost btn--sm" @click="router.push('/history')">
            历史
          </button>
          <button class="btn btn--ghost btn--sm" @click="onLogout">退出</button>
        </div>
      </div>
    </header>

    <!-- 两种模式 -->
    <div class="mode-list">
      <button class="mode-card card" @click="router.push('/room/offline')">
        <div class="mode-icon mode-icon--offline">
          <span>🃏</span>
        </div>
        <div class="mode-info">
          <h2>线下计分</h2>
          <p>实体牌玩，手机当筹码计分器</p>
          <div class="mode-tags">
            <span>创建房间</span>
            <span>加入房间</span>
          </div>
        </div>
        <div class="mode-arrow">›</div>
      </button>

      <button class="mode-card card" @click="router.push('/room/online')">
        <div class="mode-icon mode-icon--online">
          <span>🎰</span>
        </div>
        <div class="mode-info">
          <h2>线上对局</h2>
          <p>线上发牌，完整德州扑克对局</p>
          <div class="mode-tags">
            <span>长牌</span>
            <span>短牌</span>
            <span>扫码加入</span>
          </div>
        </div>
        <div class="mode-arrow">›</div>
      </button>
    </div>

    <footer class="lobby-foot text-center text-sm text-light">
      3-5 个好友，扫码即可开局
    </footer>
  </div>
</template>

<style scoped>
.lobby {
  padding: calc(16px + var(--sat)) 16px calc(16px + var(--sab));
  gap: 16px;
}

.avatar--me {
  width: 56px;
  height: 56px;
}

.me-name {
  font-size: 18px;
  font-weight: 800;
  margin-bottom: 4px;
}

.inline-gold {
  width: 14px;
  height: 14px;
  vertical-align: -2px;
}

.account-tag {
  font-size: 11px;
  font-weight: 600;
  color: var(--c-text-light);
  margin-left: 4px;
}

.mode-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.mode-card {
  display: flex;
  align-items: center;
  gap: 14px;
  text-align: left;
  cursor: pointer;
  border: 2px solid var(--c-border);
  transition: transform 0.1s;
  width: 100%;
  padding: 18px;
  font-family: inherit;
}

.mode-card:active {
  transform: scale(0.98);
}

.mode-icon {
  width: 60px;
  height: 60px;
  border-radius: 18px;
  display: grid;
  place-items: center;
  font-size: 30px;
  flex-shrink: 0;
}

.mode-icon--offline {
  background: linear-gradient(160deg, #FFE0B2, #FFCC80);
}

.mode-icon--online {
  background: linear-gradient(160deg, #FFCCBC, #FFAB91);
}

.mode-info {
  flex: 1;
  min-width: 0;
}

.mode-info h2 {
  margin: 0 0 4px;
  font-size: 19px;
  color: var(--c-text);
}

.mode-info p {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--c-text-light);
}

.mode-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.mode-tags span {
  font-size: 11px;
  background: var(--c-bg);
  color: var(--c-text-light);
  padding: 2px 8px;
  border-radius: 8px;
  border: 1px solid var(--c-border);
}

.mode-arrow {
  font-size: 28px;
  color: var(--c-border);
  flex-shrink: 0;
}

.lobby-foot {
  margin-top: auto;
}
</style>
