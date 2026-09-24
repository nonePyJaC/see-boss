import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import './styles/main.css'
import { accountRepo } from './data/account-repo.js'

/**
 * hash 路由。
 * 原来是 CloudBase 静态托管的 SPA 回退问题才选的 hash；
 * 现在 server/index.js 自己管静态页，history 路由也能回退，
 * 但 hash 已经能让扫码链接稳定工作，没必要改。
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
    { path: '/room/offline/entry', name: 'offline-entry', component: () => import('./views/OfflineEntryView.vue') },
    { path: '/room/online', name: 'online-room', component: () => import('./views/OnlineRoomView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/register' },
  ],
})

/**
 * 启动流程：查一下本机 uid 有没有绑账号。
 * 没绑也不拦启动，注册页会引导登录/注册。
 */
async function bootstrap() {
  try {
    const m = await accountRepo.me()
    if (m.ok && m.data?.loggedIn) {
      console.info(`[account] 已登录 ${m.data.account}，金瓜子 ${m.data.goldenSeeds}`)
    }
  } catch (e) {
    // 服务端没起不阻塞启动，页面会显示「连不上」
    console.warn('[account] 读取身份失败', e?.message ?? e)
  }

  createApp(App).use(router).mount('#app')
}

bootstrap()
