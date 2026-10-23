import fs from 'node:fs'
import path from 'node:path'
import { normalizeUsage } from './llm.mjs'
import { normalizeNextStyle } from './llm-self.mjs'

const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_RECORD_BYTES = 512 * 1024
const REVIEW_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl(?:\.1)?$/

/**
 * 用户要求的事后复盘：只写数据目录下的私有文件，绝不挂到 HTTP 或 /state。
 * 仅保留实际输入、解析动作、一句话依据和计量；不接收 Key、headers 或思考正文。
 * 保留7个日期，每天最多两个16MiB文件；记录失败不能中断牌局。
 */
export function writeDecisionReview(dataDir, { trace, input, result, execution = null, at = new Date() }) {
  if (!input) return false
  try {
    const timestamp = new Date(at).toISOString()
    const record = {
      version: 1, at: timestamp,
      room: trace.room, hand: trace.hand, turn: trace.turn, seat: trace.seat,
      nickname: trace.nickname ?? null, phase: trace.phase, model: trace.model,
      input: {
        model: input.model,
        messages: input.messages.filter((m) => m.role === 'system' || m.role === 'user')
          .map((m) => ({ role: m.role, content: m.content })),
        temperature: input.temperature, max_tokens: input.max_tokens,
        ...(input.reasoning_effort ? { reasoning_effort: input.reasoning_effort } : {}),
      },
      output: {
        action: result.action?.type ?? null, amount: result.action?.amount ?? null,
        briefReason: result.reason ?? result.action?.reason ?? null,
        error: result.error ?? null, ms: result.ms ?? null,
        providerModel: result.providerModel ?? null, requestId: result.requestId ?? null,
        finishReason: result.finishReason ?? null,
        nextStyle: normalizeNextStyle(result.action?.nextStyle),
      },
      usage: Object.fromEntries(Object.keys(normalizeUsage(null)).map((key) => [key,
        Number.isSafeInteger(result.usage?.[key]) && result.usage[key] >= 0 ? result.usage[key] : null])),
      execution: execution ? {
        status: execution.status, source: execution.source ?? null,
        action: execution.action ?? null, paidAmount: execution.paidAmount ?? null,
        betTotal: execution.betTotal ?? null, fallbackReason: execution.fallbackReason ?? null,
        styleChange: normalizeNextStyle(execution.styleChange?.from) && normalizeNextStyle(execution.styleChange?.to)
          ? { from: normalizeNextStyle(execution.styleChange.from), to: normalizeNextStyle(execution.styleChange.to) } : null,
      } : null,
    }
    const line = JSON.stringify(record) + '\n'
    const bytes = Buffer.byteLength(line)
    if (bytes > MAX_RECORD_BYTES) return false
    const dir = path.join(dataDir, 'ai-reviews')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    const cutoff = new Date(at)
    cutoff.setUTCDate(cutoff.getUTCDate() - 6)
    const cutoffDay = cutoff.toISOString().slice(0, 10)
    for (const name of fs.readdirSync(dir)) {
      if (REVIEW_FILE.test(name) && name.slice(0, 10) < cutoffDay) fs.unlinkSync(path.join(dir, name))
    }
    const file = path.join(dir, timestamp.slice(0, 10) + '.jsonl')
    if (fs.existsSync(file) && fs.statSync(file).size + bytes > MAX_FILE_BYTES) {
      if (fs.existsSync(file + '.1')) fs.unlinkSync(file + '.1')
      fs.renameSync(file, file + '.1')
    }
    fs.appendFileSync(file, line, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    return true
  } catch {
    return false
  }
}
