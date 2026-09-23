import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import './styles/main.css'
import { initData, repo, usingCloud } from './data/repo.js'
import { userStore } from './stores/user.js'
import { historyStore } from './stores/history.js'

/**
 * 用 hash 路由而不是 history 路由。
 * 原因：CloudBase 静态托管的 SPA 回退要靠「4xx 错误页面填 index.html」实现，
 * 而默认域名有时会走 CDN 缓存，history 路由刷新可能 404。hash 路由最稳。
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/register' },
    { path: '/register', name: 'register', component: () => import('./views/RegisterView.vue') },
    { path: '/join/:roomNo', name: 'join', component: () => import('./views/JoinView.vue') },
    { path: '/history', name: 'history', component: () => import('./views/HistoryView.vue') },
    { path: '/lobby', name: 'lobby', component: () => import('./views/LobbyView.vue') },
    { path: '/profile', name: 'profile', component: () => import('./views/ProfileView.vue') },
    { path: '/room/offline', name: 'offline-room', component: () => import('./views/OfflineRoomView.vue') },
    { path: '/room/online', name: 'online-room', component: () => import('./views/OnlineRoomView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/register' },
  ],
})

/**
 * 启动流程：
 *   云端模式先完成匿名登录（拿到带真实 sub 的 token），
 *   否则后续所有 RLS 查询都会因缺 JWT 被拒。
 *   本地模式直接进，无网络依赖。
 */
async function bootstrap() {
  if (usingCloud) {
    try {
      const { uid } = await initData()
      console.info(`[data] 云端模式，匿名 uid = ${uid}`)

      // 拉账号档案（账号名即身份）。已登录则恢复昵称/头像/金瓜子，
      // 没登录也不拦启动——注册页会引导登录或注册。
      let accountProfile = null
      try {
        const me = await repo.myAccount()
        if (me?.loggedIn) {
          accountProfile = me
          console.info(`[user] 已登录账号 ${me.account}，金瓜子 ${me.goldenSeeds}`)
        }
      } catch (e) {
        console.warn('[user] 读取账号失败', e?.message ?? e)
      }

      // 账号档案优先，其次本地缓存的匿名档案
      if (accountProfile) {
        await userStore.adoptAccount(accountProfile)
      } else {
        await userStore.initFromCloud()
      }
      await historyStore.initFromCloud()
    } catch (e) {
      // 云端不可用不阻塞启动，降级到本地模式继续跑
      console.error('[data] 云端初始化失败，降级为本地模式', e)
    }
  } else {
    console.info('[data] 本地模式')
  }

  createApp(App).use(router).mount('#app')
}

bootstrap()
