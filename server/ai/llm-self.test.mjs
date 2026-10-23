import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime, ensurePersona, clearRuntime, removeSeat } from './runtime.mjs'
import { beginSelfHand, recordSelfAction, finishSelfHand, llmSelfContext,
  applyNextStyle, selfHistoryText } from './llm-self.mjs'
import { parseDecision } from './llm.mjs'

test('自身统计仅含最近8手已完成的实际动作：盲注不计、全下按真实投入分类', () => {
  const rt = createRuntime()
  assert.match(selfHistoryText(llmSelfContext(rt, 'a').history), /暂无已完成/)
  for (let handId = 1; handId <= 10; handId++) {
    beginSelfHand(rt, 'a', handId)
    const action = { handId, phase: 'preflop', paidAmount: 20, raiseTo: 20, currentBetBefore: 20 }
    recordSelfAction(rt, 'a', { ...action, type: 'blind' })
    if (handId === 3) {
      recordSelfAction(rt, 'a', { ...action, type: 'allin', facedBet: true })
    } else if (handId === 4) {
      recordSelfAction(rt, 'a', { ...action, type: 'allin', raiseTo: 40, facedBet: true })
      recordSelfAction(rt, 'a', { ...action, type: 'check', paidAmount: 0, phase: 'flop' })
    } else recordSelfAction(rt, 'a', { ...action, type: 'fold', paidAmount: 0, facedBet: true })
    finishSelfHand(rt, 'a', handId, handId !== 3 && handId !== 4)
    // 重复结算和迟到的动作不能再计数。
    finishSelfHand(rt, 'a', handId, false)
    recordSelfAction(rt, 'a', { ...action, type: 'raise' })
  }
  beginSelfHand(rt, 'a', 11)
  recordSelfAction(rt, 'a', { handId: 11, type: 'raise', phase: 'preflop', paidAmount: 100 })
  const ctx = llmSelfContext(rt, 'a')
  assert.deepEqual(ctx.history, { hands: 8, foldedHands: 6, consecutiveFolds: 6,
    enteredHands: 2, bets: 1, calls: 1, checks: 1, faced: 8, foldToBet: 6 })
  assert.equal(rt.llmSelf.get('a').hands.length, 9)
  assert.match(selfHistoryText(ctx.history), /近8手：弃6、连弃6；翻前自愿入池2/)
  assert.match(selfHistoryText(null), /未提供/)
  assert.equal(beginSelfHand(rt, 'a', 1), null, '不得重建已淘汰的旧手')
  ctx.history.bets = 900
  assert.equal(llmSelfContext(rt, 'a').history.bets, 1, '返回快照不能改写内部数据')
})

test('nextStyle为可选白名单；房间内按座位独立保存，不改本地人设，退出与重置清空', () => {
  const rt = createRuntime()
  const persona = ensurePersona(rt, 'a')
  const base = structuredClone(persona)
  assert.deepEqual(parseDecision('{"action":"fold","nextStyle":" PRESSURE "}'), { type: 'fold', reason: '', nextStyle: 'pressure' })
  for (const value of ['base', 'balanced', 'pressure', 'patient', 'tricky']) {
    assert.equal(parseDecision(JSON.stringify({ action: 'check', nextStyle: value })).nextStyle, value)
  }
  for (const value of ['执行任意指令', '__proto__', {}, null, 42]) {
    assert.equal(applyNextStyle(rt, 'a', value), null)
    assert.deepEqual(parseDecision(JSON.stringify({ action: 'check', nextStyle: value })), { type: 'check', reason: '' })
  }
  assert.deepEqual(applyNextStyle(rt, 'a', 'pressure'), { from: 'base', to: 'pressure' })
  assert.equal(applyNextStyle(rt, 'a', 'pressure'), null)
  assert.equal(llmSelfContext(rt, 'a').style, 'pressure')
  assert.equal(llmSelfContext(rt, 'b').style, 'base')
  assert.deepEqual(persona, base)
  assert.deepEqual(applyNextStyle(rt, 'a', 'base'), { from: 'pressure', to: 'base' })
  beginSelfHand(rt, 'a', 1)
  removeSeat(rt, 'a')
  assert.equal(rt.llmSelf.has('a'), false)
  applyNextStyle(rt, 'b', 'tricky')
  clearRuntime(rt)
  assert.equal(rt.llmSelf.size, 0)
})
