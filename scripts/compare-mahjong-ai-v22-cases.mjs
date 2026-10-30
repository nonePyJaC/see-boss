/** 同一组人工合成观察及随机输入；不含用户牌谱。 */
import fs from 'node:fs'
import { decideMahjongV2 as oldPolicy } from '../server/mahjong-ai-v21.mjs'
import { decideMahjongV2, effectiveProgressScore } from '../server/mahjong-ai-v2.mjs'
const cases = JSON.parse(fs.readFileSync(new URL('../docs/handovers/nanjing-mahjong-local-ai-v22-diagnostic-cases.json', import.meta.url))).cases
const output = { kind: 'synthetic-fixed-observation', effectivePoints: Object.fromEntries([0,3,7,30,53,60,90].map((n) => [n,effectiveProgressScore(n)])), cases: [] }
for (const c of cases) {
  const prior = oldPolicy(c.observation, c.options)
  const current = decideMahjongV2(c.observation, { ...c.options, includeVariants: true })
  const oldCandidates = prior.diagnostic.candidates ?? []
  const oldTarget = c.id === 'C01' ? oldCandidates.filter((x) => ['1p','2m'].includes(x.action.tile)) : oldCandidates.filter((x) => x.action.type === (c.id === 'C04' ? 'bukong' : 'pong'))
  const newTarget = (current.diagnostic.candidateVariants ?? []).filter((x) => c.id === 'C01' ? ['1p','2m'].includes(x.action.tile) : c.id === 'C02' ? x.action.type === 'pong' && x.projectedDiscard === '2p' : c.id === 'C03' ? x.action.type === 'pong' && x.projectedDiscard === '9p' : x.action.type === 'bukong')
  output.cases.push({ id: c.id, old: { action: prior.action, pool: prior.diagnostic.randomPool, candidates: oldTarget }, current: { action: current.action, pool: current.diagnostic.randomPool, candidates: newTarget } })
}
console.log(JSON.stringify(output, null, 2))
