/** 策略计算不占用 HTTP 事件循环；超时或并发繁忙时立即安全回退。 */
import { Worker } from 'node:worker_threads'
import { estimateMahjongWin } from './mahjong-ai-v1.mjs'
const MAX_WORKERS = 2, TIMEOUT_MS = 700
let active = 0

export function fastLegalFallback(obs) {
  const actions = obs?.myActions ?? []
  const win = actions.find((a) => a.type === 'win')
  if (win) {
    try {
      const estimate = estimateMahjongWin(obs)
      const exposure = Math.min(obs.balances[obs.seat], Math.ceil((obs.wallCount ?? 0) / 12) * 10 * (obs.double ? 2 : 1))
      if (estimate.net >= 0 || -estimate.net <= exposure) return { ...win }
    } catch { return { ...win } }
  }
  return { ...(actions.find((a) => a.type === 'ready') ?? actions.find((a) => a.type === 'pass') ?? actions.find((a) => a.type === 'discard') ?? actions[0]) }
}

export function runMahjongPolicy(observation, options = {}) {
  const fallback = (reason) => ({ action: fastLegalFallback(observation), route: null,
    diagnostic: { version: 'nanjing-local-policy-v2', observationId: options.observationId ?? null, fallback: reason, candidates: [] } })
  if (active >= MAX_WORKERS) return Promise.resolve(fallback('并发预算繁忙'))
  active++
  return new Promise((resolve) => {
    let done = false, worker, timer
    function finish(result) {
      if (done) return
      done = true; active--; clearTimeout(timer)
      if (worker) void worker.terminate()
      resolve(result)
    }
    try {
      worker = new Worker(new URL('./mahjong-ai-worker.mjs', import.meta.url), { workerData: { observation, options } })
      timer = setTimeout(() => finish(fallback('计算超时')), TIMEOUT_MS)
      worker.once('message', (result) => {
        const legal = observation.myActions.some((a) => a.type === result.action?.type && (a.tile == null || a.tile === result.action?.tile))
        finish(legal ? result : fallback('工作线程结果无效'))
      })
      worker.once('error', () => finish(fallback('工作线程异常')))
      worker.once('exit', (code) => { if (!done && code !== 0) finish(fallback('工作线程退出')) })
    } catch { finish(fallback('工作线程启动失败')) }
  })
}
