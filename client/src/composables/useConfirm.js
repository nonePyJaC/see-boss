/**
 * 页面内确认框 —— 取代 window.confirm。
 *
 * 为什么不用原生 confirm：
 *   部分手机浏览器（iOS 微信 WebView、部分 Android WebView）会把
 *   window.confirm 渲染成系统级弹窗，按钮文案是「确定 / 离开页面」，
 *   看着像要跳出应用。用户实测遇到过，容易误点。
 *
 * 用法：
 *   const yes = await askConfirm({ title: '收池', msg: '...', okText: '收' })
 *   if (!yes) return
 */

import { ref } from 'vue'

const state = ref(null)

/**
 * 弹一个确认框，返回 Promise<boolean>。
 * 同时只会有一个人等待 —— 第二次调用会直接顶掉第一次（返回 false）。
 */
export function askConfirm({ title = '确认', msg = '', okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    if (state.value) {
      // 已有确认框在等：先把上一个结果掉，别让它永远 pending
      state.value.resolve(false)
    }
    state.value = {
      title, msg, okText, danger,
      resolve: (v) => {
        state.value = null
        resolve(v)
      },
    }
  })
}

export function useConfirm() {
  return {
    state,
    ok: () => state.value?.resolve(true),
    cancel: () => state.value?.resolve(false),
  }
}
