import { parentPort, workerData } from 'node:worker_threads'
import { decideMahjongV2, POLICY_VERSION } from './mahjong-ai-v2.mjs'

try { parentPort.postMessage(decideMahjongV2(workerData.observation, workerData.options)) }
catch { parentPort.postMessage({ action: null, diagnostic: { version: POLICY_VERSION, fallback: 'worker异常' }, route: null }) }
