import { parentPort, workerData } from 'node:worker_threads'
import { decideMahjongV2 } from './mahjong-ai-v2.mjs'

try { parentPort.postMessage(decideMahjongV2(workerData.observation, workerData.options)) }
catch { parentPort.postMessage({ action: null, diagnostic: { version: 'nanjing-local-policy-v2', fallback: 'worker异常' }, route: null }) }
