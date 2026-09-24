/**
 * HTTP 客户端 — 前端只跟这一层打交道，所有 /api/* 请求都走这里。
 *
 * 设计约束：
 *   1. 同域部署：server/index.js 既吐静态页又吐 /api/*，所以默认 base 为空（相对路径），
 *      不用配 VITE_API_BASE。真要分开部署时再在 client/.env 里配。
 *   2. fetch 失败（服务端没起、连接被拒）绝不 throw —— 一律返回 { ok:false, error }。
 *      之前线上「加倍点了没反应」的真因就是 api() 没兜住异常，poll 链断掉后
 *      整个页面停在上一次渲染、按钮全死。宁可显示「连不上」，也不能让页面假死。
 *   3. 响应非 JSON（比如代理返回了 HTML 错误页）也不能 throw。
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? ''

async function request(path, body = {}) {
  try {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({ ok: false, error: '响应不是 JSON' }))
    return j
  } catch (e) {
    return { ok: false, error: e?.message === 'Failed to fetch' ? '连不上服务器' : (e?.message || '网络错误') }
  }
}

export { request }
