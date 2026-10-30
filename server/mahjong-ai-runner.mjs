/** 策略计算不占用 HTTP 事件循环；超时或并发繁忙时立即安全回退。 */
import { Worker } from 'node:worker_threads'
import { boundedFallback } from './mahjong-ai-fallback.mjs'
import { POLICY_VERSION } from './mahjong-ai-v2.mjs'
const MAX_WORKERS = 2, TIMEOUT_MS = 700
let active = 0

export function fastLegalFallback(obs) {
  try { return boundedFallback(obs).action } catch { return emergencyLegalAction(obs) }
}

function emergencyLegalAction(obs) {
  const actions = obs?.myActions ?? []
  const legal = actions.find((a) => a.type === 'pass') ?? actions.find((a) => a.type === 'discard') ?? actions[0]
  return legal ? { ...legal } : null
}

export function runMahjongPolicy(observation, options = {}, { timeoutMs = TIMEOUT_MS } = {}) {
  const fallback = (reason) => {
    let result
    try { result = boundedFallback(observation) }
    catch { result = { action: emergencyLegalAction(observation), evaluated: 0, exhausted: false, method: 'invalid-observation' } }
    return { action: result.action, route: null, diagnostic: { version: POLICY_VERSION, observationId: options.observationId ?? null,
      fallback: reason, fallbackDetail: { evaluated: result.evaluated, exhausted: result.exhausted, method: result.method }, candidates: [] } }
  }
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
      timer = setTimeout(() => finish(fallback('计算超时')), timeoutMs)
      worker.once('message', (result) => {
        const legal = observation.myActions.some((a) => a.type === result.action?.type && (a.tile == null || a.tile === result.action?.tile))
        finish(legal ? result : fallback('工作线程结果无效'))
      })
      worker.once('error', () => finish(fallback('工作线程异常')))
      worker.once('exit', (code) => { if (!done && code !== 0) finish(fallback('工作线程退出')) })
    } catch { finish(fallback('工作线程启动失败')) }
  })
}
