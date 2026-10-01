/**
 * 性能脚本控制对（review C-R3 / F-I5）：
 *   - 正常真实 AI 决策 → 脚本 exit 0
 *   - 注入决策异常（persona.params 读取抛错，全程安全降级）→ 脚本必须 nonzero
 *
 * 两个子进程各自在隔离数据目录起服务，跑 1 手 × 2 房。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-online-ai-perf.mjs')

function runPerf(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '1'], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, out }))
  })
}

test('控制对-正常：真实 AI 决策跑完 2 房各 1 手，exit 0', { timeout: 120000 }, async () => {
  const r = await runPerf()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /AI 决策：\d+ 次/)
})

test('控制对-异常：persona.params 抛错导致全程降级时，exit 非零', { timeout: 120000 }, async () => {
  const r = await runPerf({ AI_PERF_FAULT: 'persona-params' })
  assert.notEqual(r.code, 0, `决策全程降级仍 exit 0，输出：\n${r.out}`)
  assert.match(r.out, /降级/)
})
