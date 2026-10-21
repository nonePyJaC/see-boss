import { ACTION_LABEL } from '../../../shared/logic/betting.mjs'

/**
 * 行动流水文案（人工试玩修复 2026-10-02）。
 *
 * 全下跟注在引擎里与普通跟注同型（type='call'），只靠金额看不出是全下——
 * 实测「跟注 100」面对 500 下注会被当成少跟 bug。流水带 allIn 标记后，
 * 全下动作统一加「全下」前缀，`allin` 类型保持原有「全下 X」。
 */
export function actionLabel(a) {
  const base = ACTION_LABEL[a.type] ?? a.type
  if (a.type === 'fold' || a.type === 'check') return base
  if (a.allIn && a.type !== 'allin') return `全下${base} ${a.amount}`
  return `${base} ${a.amount}`
}
